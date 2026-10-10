import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { simplify } from '../../collector/lib/shapes.js';
import {
  clusters,
  composeCluster,
  findCluster,
  postCrossBunching,
  stoppedVehicles,
} from '../features/crossBunching.js';
import { linkDetectionPosts } from '../features/detections.js';
import { buildRollupThread, maybePostGhostRollups } from '../features/ghosts.js';
import { createDryRunClient } from '../lib/bluesky.js';
import { recordObservations } from '../lib/observations.js';
import { graphemeLength } from '../lib/text.js';
import { createBasemap } from '../map/basemap.js';
import { planRouteMap, renderRouteMap } from '../map/routeMap.js';
import { detectionIncident, fakeShapes, NOW, testPoster, vehicle } from './helpers.js';

const HOUR = 3_600_000;
const hourStart = Math.floor(NOW / HOUR) * HOUR;

function ghost(id, route, missing, firstSeen) {
  return detectionIncident({
    id,
    source: 'ghost',
    route,
    firstSeen,
    details: { scheduled: 9, tracked: 9 - missing, missing },
  });
}

describe('ghost rollups', () => {
  it('splits long rollups into a thread, footer on the first post', () => {
    const lines = Array.from(
      { length: 12 },
      (_, i) => `🚌 Route ${i + 1} · 2 of 9 buses on the tracker (78% missing)`,
    );
    const posts = buildRollupThread('👻 Missing buses, past hour', lines, { footer: 'Footer.' });
    expect(posts.length).toBeGreaterThan(1);
    expect(posts.every((p) => graphemeLength(p.text) <= 300)).toBe(true);
    expect(posts[0].text.endsWith('Footer.')).toBe(true);
    expect(posts[1].text.startsWith('👻 Missing buses, past hour (cont.)')).toBe(true);
    expect(posts.flatMap((p) => p.lines)).toEqual(lines.map((_, i) => i));
  });

  it("posts the hour's new ghosts once, worst first, and links each to the rollup", async () => {
    const t = testPoster();
    const incidents = new Map(
      [
        ghost('ghost-a', '47', 3, hourStart - 30 * 60_000),
        ghost('ghost-b', '23', 6, hourStart - 20 * 60_000),
        ghost('ghost-old', '33', 5, hourStart - 3 * HOUR),
      ].map((i) => [i.id, i]),
    );
    const at = hourStart + 8 * 60_000;
    expect(
      await maybePostGhostRollups({
        incidents,
        poster: t.poster,
        db: t.db,
        now: hourStart + 2 * 60_000,
      }),
    ).toBeNull();
    const stats = await maybePostGhostRollups({ incidents, poster: t.poster, db: t.db, now: at });
    expect(stats).toEqual({ posts: 1, routes: 2 });
    expect(t.client.posts[0].account).toBe('bus');
    expect(t.client.posts[0].opts.text.split('\n\n')[1].split('\n')).toEqual([
      '🚌 Route 23 · 3 of 9 buses on the tracker (67% missing)',
      '🚌 Route 47 · 6 of 9 buses on the tracker (33% missing)',
    ]);
    expect(
      await maybePostGhostRollups({ incidents, poster: t.poster, db: t.db, now: at + 60_000 }),
    ).toBeNull();
    expect(linkDetectionPosts(incidents, t.poster)).toBe(2);
    expect(incidents.get('ghost-b').detections[0].post_url).toBe(
      t.client.posts[0].opts && 'https://bsky.app/profile/did:plc:bus/post/p1',
    );
    expect(incidents.get('ghost-old').detections[0].post_url).toBeNull();
  });
});

describe('cross-route clusters', () => {
  const at = (i, over = {}) =>
    vehicle({
      label: `v${i}`,
      lat: 39.9526 + i * 0.0002,
      lon: -75.1652,
      nextStopSequence: 15,
      ...over,
    });

  it('finds stopped vehicles from the last few minutes of positions', () => {
    const { db } = testPoster();
    for (let m = 6; m >= 0; m--) {
      recordObservations(db, NOW - m * 60_000, {
        vehicles: [
          { id: 'still', mode: 'bus', route: '17', lat: 39.95, lon: -75.16 },
          { id: 'moving', mode: 'bus', route: '17', lat: 39.95 + m * 0.002, lon: -75.16 },
        ],
      });
    }
    expect([...stoppedVehicles(db, NOW)]).toEqual(['still']);
  });

  it('clusters by proximity and requires several routes and stopped vehicles', () => {
    const vs = [
      at(0, { route: '17' }),
      at(1, { route: '17' }),
      at(2, { route: '33' }),
      at(3, { route: '48' }),
      at(40, { route: '2' }),
    ];
    expect(
      clusters(vs, 200)
        .map((g) => g.length)
        .sort(),
    ).toEqual([1, 4]);
    const stopped = new Set(['v0', 'v1', 'v2']);
    expect(
      findCluster({ vehicles: vs, stopped, schedule: null, now: NOW })
        .map((v) => v.label)
        .sort(),
    ).toEqual(['v0', 'v1', 'v2', 'v3']);
    expect(
      findCluster({ vehicles: vs, stopped: new Set(['v0']), schedule: null, now: NOW }),
    ).toBeNull();
    const oneRoute = vs.map((v) => ({ ...v, route: '17' }));
    expect(findCluster({ vehicles: oneRoute, stopped, schedule: null, now: NOW })).toBeNull();
    // Laying over at the start of a trip doesn't count.
    const layover = vs.map((v) => ({ ...v, nextStopSequence: 1 }));
    expect(findCluster({ vehicles: layover, stopped, schedule: null, now: NOW })).toBeNull();
  });

  it('posts a cluster once per place within its cooldown', async () => {
    const t = testPoster();
    const vs = [
      at(0, { route: '17', nextStopName: 'Broad & Walnut' }),
      at(1, { route: '17', nextStopName: 'Broad & Walnut' }),
      at(2, { route: '33' }),
      at(3, { route: '48' }),
    ];
    for (let m = -10; m <= 6; m++) recordObservations(t.db, NOW - m * 60_000, { vehicles: vs });
    const args = {
      vehicles: vs,
      schedule: null,
      db: t.db,
      poster: t.poster,
      shapes: fakeShapes(),
      basemap: createBasemap(),
      now: NOW,
    };
    expect(await postCrossBunching(args)).toMatchObject({ posted: 1, vehicles: 4 });
    expect(t.client.posts[0].opts.text).toMatch(
      /^🚍 4 buses from 3 routes stopped together near Broad & Walnut right now/,
    );
    expect(t.client.posts[0].opts.text).toContain('Route 17: #v0 (1️⃣), #v1 (2️⃣)');
    expect(await postCrossBunching({ ...args, now: NOW + 10 * 60_000 })).toEqual({
      skipped: 'cooldown',
    });
  });

  it('leaves out frozen trolleys: the tunnel is not the portal', async () => {
    // Four vehicles from three routes at one spot, all stopped for ten minutes; the three trolleys
    // among them are repeating the last fix before the tunnel.
    const t = testPoster();
    const car = (i, route, over = {}) =>
      at(i, { route, mode: 'metro', nextStopName: '40th St Portal', ...over });
    const fresh = [car(0, 't2'), car(1, 't3'), car(2, 't4'), at(3, { route: '40' })];
    for (let m = -10; m <= 6; m++) recordObservations(t.db, NOW - m * 60_000, { vehicles: fresh });
    const args = {
      schedule: null,
      db: t.db,
      poster: t.poster,
      shapes: fakeShapes(),
      basemap: createBasemap(),
      now: NOW,
    };
    const frozen = [car(0, 't2'), car(1, 't3'), car(2, 't4')].map((v) => ({ ...v, frozen: true }));
    // Not frozen, they are a stopped cluster (the control)...
    expect(await postCrossBunching({ ...args, vehicles: fresh })).toMatchObject({ posted: 1 });
    // ...frozen, they are not: one bus left, and no cluster.
    const t2 = testPoster();
    for (let m = -10; m <= 6; m++) recordObservations(t2.db, NOW - m * 60_000, { vehicles: fresh });
    expect(
      await postCrossBunching({
        ...args,
        db: t2.db,
        poster: t2.poster,
        vehicles: [...frozen, at(3, { route: '40' })],
      }),
    ).toBeNull();
    expect(t2.client.posts).toHaveLength(0);
  });

  it('colors each route and numbers vehicles across the cluster', () => {
    const vs = [at(0, { route: '17' }), at(1, { route: '33' }), at(2, { route: '17' })];
    const { plan } = composeCluster(
      vs,
      { name: null, lat: 39.95, lon: -75.16, key: 'k' },
      fakeShapes(),
    );
    expect(plan.markers.map((m) => m.tag)).toEqual(['1', '2', '3']);
    expect(plan.markers[0].color).toBe(plan.markers[1].color);
    expect(plan.markers[0].color).not.toBe(plan.markers[2].color);
  });
});

describe('route maps and shapes', () => {
  it('simplifies shapes to a few meters', () => {
    const line = Array.from({ length: 101 }, (_, i) => [
      40 + i * 0.0001,
      -75.17 + (i % 2) * 0.00001,
    ]);
    const out = simplify(line, 6);
    expect(out.length).toBe(2);
    expect(out[0]).toEqual(line[0]);
    expect(out.at(-1)).toEqual(line.at(-1));
  });

  it('renders markers over a route at 1200×1200', async () => {
    const plan = planRouteMap({
      routes: [{ points: fakeShapes().shape('23'), color: '#00c2e0' }],
      markers: [
        { lat: 40.0, lon: -75.17, tag: 'L' },
        { lat: 40.0001, lon: -75.17, tag: 'N' },
      ],
      stretch: {
        points: [
          [40.0, -75.17],
          [40.01, -75.17],
        ],
      },
      title: '⚠ Route 23 · ~25 min gap',
    });
    const jpg = await renderRouteMap(plan, { basemap: createBasemap() });
    expect(await sharp(jpg).metadata()).toMatchObject({
      format: 'jpeg',
      width: 1200,
      height: 1200,
    });
  });
});

describe('dry-run threads', () => {
  it('continue across a restart from the recorded posts', async () => {
    const t = testPoster(createDryRunClient({ assetsDir: '/nonexistent' }));
    const first = await t.poster.post({
      account: 'bus',
      kind: 'detection',
      subject: 's',
      text: 'one',
    });
    // A fresh dry-run client knows nothing of earlier posts.
    const restarted = testPoster(createDryRunClient({ assetsDir: '/nonexistent' }));
    restarted.db.exec('DELETE FROM posts');
    for (const row of t.db.prepare('SELECT * FROM posts').all()) {
      restarted.db
        .prepare(
          'INSERT INTO posts (account, kind, subject, uri, cid, url, root_uri, root_cid, parent_uri, ts, text, dry_run) VALUES (@account, @kind, @subject, @uri, @cid, @url, @root_uri, @root_cid, @parent_uri, @ts, @text, @dry_run)',
        )
        .run(row);
    }
    await restarted.poster.post({
      account: 'bus',
      kind: 'cleared',
      subject: 's',
      text: 'two',
      reply: first.uri,
    });
    const reply = [...restarted.client.posts.values()][0];
    expect(reply.value.reply.root.uri).toBe(first.uri);
  });
});
