import { describe, expect, it } from 'vitest';
import { postCrossBunching } from '../features/crossBunching.js';
import { postDetections } from '../features/detections.js';
import {
  bunchingOutcome,
  captureBlocked,
  clusterOutcome,
  gapOutcome,
  rawRouteId,
  renderDueCapture,
  routeLayers,
  sampleCaptures,
  snapshotText,
  startCapture,
  startDetectionCapture,
  startSnapshots,
  VIDEO_LIMITS,
} from '../features/timelapse.js';
import { pruneDb } from '../lib/db.js';
import { recordObservations } from '../lib/observations.js';
import { createBasemap } from '../map/basemap.js';
import { encodeMp4, ffmpegAvailable } from '../video/encode.js';
import { nearestShape } from '../video/scenes.js';
import { clockRange, elapsedLabel, frameTimes, renderTimelapse } from '../video/timelapse.js';
import { buildTracks, positionAt, trailAt } from '../video/tracks.js';
import { byLabel, detectionIncident, fakeShapes, NOW, testPoster, vehicle } from './helpers.js';

const MIN = 60_000;
const HAS_FFMPEG = await ffmpegAvailable();

/** A TransitView vehicle as SEPTA serves it. */
function rawVehicle(id, lat, lon, ts, over = {}) {
  return {
    lat: String(lat),
    lng: String(lon),
    label: id,
    VehicleID: id,
    trip: `trip-${id}`,
    Direction: 'Southbound',
    destination: '11th-Market',
    heading: 180,
    late: 0,
    next_stop_sequence: 10,
    next_stop_name: 'Broad & Walnut',
    timestamp: Math.floor(ts / 1000),
    ...over,
  };
}

/** Sources stand-in: positions per route as a function of time. */
function fakeSources(byRoute, at) {
  const calls = [];
  return {
    calls,
    async transitViewRoute(route) {
      calls.push(route);
      return { bus: (byRoute[route] ?? (() => []))(at()) };
    },
    async transitView() {
      calls.push('*');
      return {
        routes: [Object.fromEntries(Object.entries(byRoute).map(([r, fn]) => [r, fn(at())]))],
      };
    },
  };
}

// Counts frames instead of running ffmpeg.
async function fakeEncode(frames) {
  let n = 0;
  for await (const _ of frames) n++;
  return Buffer.from(`fake-mp4:${n}`);
}

describe('vehicle tracks', () => {
  const samples = [
    { vehicle_id: 'a', route: '23', t: NOW, lat: 40.0, lon: -75.17 },
    { vehicle_id: 'a', route: '23', t: NOW, lat: 40.0, lon: -75.17 },
    { vehicle_id: 'a', route: '23', t: NOW + 30_000, lat: 40.01, lon: -75.17, late_min: 4 },
    { vehicle_id: 'b', route: '23', t: NOW, lat: 39.99, lon: -75.17 },
    { vehicle_id: 'b', route: '23', t: NOW + 10 * MIN, lat: 39.9, lon: -75.17 },
  ];

  it('groups reports by vehicle, one per report time, oldest first', () => {
    const tracks = buildTracks([...samples].reverse());
    expect(tracks.get('a').points.map((p) => p.t)).toEqual([NOW, NOW + 30_000]);
    expect(tracks.get('a').points[1].late).toBe(4);
  });

  it('interpolates between reports and fades a vehicle out after its last one', () => {
    const a = buildTracks(samples).get('a');
    const mid = positionAt(a, NOW + 15_000);
    expect(mid.lat).toBeCloseTo(40.005, 6);
    expect(mid.opacity).toBe(1);
    expect(positionAt(a, NOW - 60_000)).toMatchObject({ lat: 40.0 });
    expect(positionAt(a, NOW - 5 * MIN)).toBeNull();
    expect(positionAt(a, NOW + 30_000 + MIN).opacity).toBe(1);
    expect(positionAt(a, NOW + 30_000 + 2.5 * MIN).opacity).toBeLessThan(1);
    expect(positionAt(a, NOW + 30_000 + 4 * MIN)).toBeNull();
    expect(trailAt(a, NOW + 30_000).length).toBeGreaterThan(5);
  });

  it("doesn't draw a vehicle across a long dropout", () => {
    const b = buildTracks(samples).get('b');
    expect(positionAt(b, NOW + MIN)).toMatchObject({ lat: 39.99 });
    expect(positionAt(b, NOW + 5 * MIN)).toBeNull();
    expect(positionAt(b, NOW + 10 * MIN)).toMatchObject({ lat: 39.9 });
  });
});

describe('timelapse text', () => {
  const track = (id, points) => ({
    id,
    label: id,
    track: buildTracks(
      points.map(([t, lat]) => ({ vehicle_id: id, route: '23', t, lat, lon: -75.17 })),
    ).get(id),
  });
  const ctx = { start: NOW, end: NOW + 10 * MIN, noun: 'buses' };

  it('says whether a bunch spread out', () => {
    const still = [
      track('1', [
        [NOW, 40.0],
        [NOW + 10 * MIN, 39.98],
      ]),
      track('2', [
        [NOW, 40.0005],
        [NOW + 10 * MIN, 39.9806],
      ]),
    ];
    expect(bunchingOutcome(still, ctx)).toBe('Still bunched: 2 buses within 220 ft (was 180 ft).');
    const spread = [
      track('1', [
        [NOW, 40.0],
        [NOW + 10 * MIN, 39.97],
      ]),
      track('2', [
        [NOW, 40.0005],
        [NOW + 10 * MIN, 39.99],
      ]),
    ];
    expect(bunchingOutcome(spread, ctx)).toBe(
      'The buses spread out: 180 ft → 1.38 mi from first to last.',
    );
    const gone = [track('1', [[NOW, 40.0]]), track('2', [[NOW, 40.0005]])];
    expect(bunchingOutcome(gone, ctx)).toBe("2 of the 2 buses dropped off SEPTA's tracker.");
  });

  it('measures a gap along the route', () => {
    const l = track('3787', [
      [NOW, 39.98],
      [NOW + 10 * MIN, 39.96],
    ]);
    const n = track('3314', [
      [NOW, 40.02],
      [NOW + 10 * MIN, 39.99],
    ]);
    expect(gapOutcome([l, n], { ...ctx, shape: fakeShapes().shape('23') })).toBe(
      'The gap between #3787 (L) and #3314 (N) went from 2.77 mi to 2.08 mi.',
    );
  });

  it('counts cluster vehicles that moved on', () => {
    const vs = [
      track('1', [
        [NOW, 40.0],
        [NOW + 10 * MIN, 40.0],
      ]),
      track('2', [
        [NOW, 40.0],
        [NOW + 10 * MIN, 39.98],
      ]),
      track('3', [
        [NOW, 40.0],
        [NOW + 10 * MIN, 39.97],
      ]),
    ];
    expect(clusterOutcome(vs, ctx)).toBe('2 of the 3 buses had moved on; 1 still there.');
    expect(clusterOutcome(vs.slice(0, 1), ctx)).toBe('All 1 buses were still there.');
  });

  it('summarizes a snapshot: window, counts, lateness or lines', () => {
    const samples = [];
    for (let i = 0; i < 20; i++) {
      const late = i < 14 ? 2 : i < 18 ? 7 : 12;
      samples.push({
        vehicle_id: `b${i}`,
        route: '23',
        t: NOW,
        lat: 40,
        lon: -75.1,
        late_min: late,
      });
      samples.push({
        vehicle_id: `b${i}`,
        route: '23',
        t: NOW + 15 * MIN,
        lat: 40,
        lon: -75.1,
        late_min: late,
      });
    }
    const { text, alt } = snapshotText({
      mode: 'bus',
      tracks: buildTracks(samples),
      start: NOW,
      end: NOW + 15 * MIN,
    });
    expect(text.split('\n\n')).toEqual([
      '🚌 SEPTA buses · 15-minute timelapse',
      `${clockRange(NOW, NOW + 15 * MIN)} · 20 → 20 buses on the tracker`,
      'On time or up to 5 min late: 70% · 10+ min late: 10%',
    ]);
    expect(alt).toMatch(/^Timelapse map of every bus/);
    const metro = snapshotText({
      mode: 'metro',
      tracks: buildTracks([
        { vehicle_id: 'x', route: 't1', t: NOW, lat: 39.95, lon: -75.2 },
        { vehicle_id: 'y', route: 'g1', t: NOW + 15 * MIN, lat: 39.97, lon: -75.15 },
      ]),
      start: NOW,
      end: NOW + 15 * MIN,
    });
    expect(metro.text).toContain('1 → 1 vehicles on the tracker');
    expect(metro.text.split('\n\n')[2]).toBe('G1 1');
  });

  it('formats clock ranges and elapsed time', () => {
    expect(clockRange(Date.UTC(2026, 9, 6, 20, 0), Date.UTC(2026, 9, 6, 20, 15))).toBe(
      '4:00–4:15 PM',
    );
    expect(clockRange(Date.UTC(2026, 9, 6, 15, 50), Date.UTC(2026, 9, 6, 16, 5))).toBe(
      '11:50 AM–12:05 PM',
    );
    expect(elapsedLabel(225_000)).toBe('+3:45');
    expect(frameTimes(0, 100, 3)).toEqual([0, 50, 100]);
  });
});

describe('captures', () => {
  const detection = (over = {}) => ({
    kind: 'bunching',
    subject: 'det:b1',
    account: 'bus',
    mode: 'bus',
    routes: ['23'],
    directionId: 0,
    title: 'Route 23 · 2 buses bunched',
    header: '🎬 Route 23 · the next 10 minutes',
    noun: 'buses',
    vehicles: [
      { id: 'a', label: 'a', tag: '1', route: '23' },
      { id: 'b', label: 'b', tag: '2', route: '23' },
    ],
    post: { uri: 'at://did:plc:bus/app.bsky.feed.post/p1' },
    now: NOW,
    ...over,
  });

  it('starts one detection timelapse per account and kind an hour, within the daily budget', () => {
    const { db } = testPoster();
    expect(startDetectionCapture(db, detection())).toBe(1);
    expect(captureBlocked(db, { account: 'bus', kind: 'bunching', now: NOW + MIN })).toBe('hourly');
    expect(startDetectionCapture(db, detection({ subject: 'det:b2', now: NOW + MIN }))).toBeNull();
    expect(startDetectionCapture(db, detection({ kind: 'gap', subject: 'det:g1' }))).toBe(2);
    expect(
      startDetectionCapture(db, detection({ subject: 'det:m1', account: 'metro', mode: 'metro' })),
    ).toBe(3);
    // Fewer than two vehicles: nothing to follow.
    expect(
      startDetectionCapture(
        db,
        detection({ subject: 'det:x', account: 'metro', kind: 'gap', vehicles: [] }),
      ),
    ).toBeNull();
    // Room for 3 detection timelapses a day (8 videos, 5 kept for snapshots);
    // the bus account has used 2.
    const tight = { ...VIDEO_LIMITS, dailyPerAccount: 8, snapshotsPerDay: 5 };
    expect(
      captureBlocked(db, { account: 'bus', kind: 'cluster', now: NOW, limits: tight }),
    ).toBeNull();
    startCapture(db, {
      kind: 'cluster',
      subject: 'x',
      account: 'bus',
      mode: 'bus',
      routes: ['1'],
      start: NOW,
      durationMs: 1,
    });
    expect(
      captureBlocked(db, {
        account: 'bus',
        kind: 'cluster',
        now: NOW + 2 * 3_600_000,
        limits: tight,
      }),
    ).toBe('daily');
  });

  it('polls only the routes being recorded, every report once', async () => {
    const { db } = testPoster();
    startDetectionCapture(db, detection());
    let t = NOW;
    const sources = fakeSources(
      {
        23: (now) => [
          rawVehicle('a', 40.0 - (now - NOW) / 6e7, -75.17, now - 5000),
          rawVehicle('b', 40.001 - (now - NOW) / 6e7, -75.17, now - 5000),
          rawVehicle('None', 39.95, -75.16, now),
        ],
        47: () => [rawVehicle('z', 39.95, -75.15, NOW)],
      },
      () => t,
    );
    expect(await sampleCaptures({ db, sources, now: t })).toEqual({ captures: 1, samples: 2 });
    expect(sources.calls).toEqual(['23']);
    // The same reports again add nothing.
    expect((await sampleCaptures({ db, sources, now: t })).samples).toBe(0);
    t = NOW + 30_000;
    expect((await sampleCaptures({ db, sources, now: t })).samples).toBe(2);
    // After the window, nothing is polled.
    t = NOW + 11 * 60_000;
    expect(await sampleCaptures({ db, sources, now: t })).toEqual({ captures: 0, samples: 0 });
    expect(sources.calls).toEqual(['23', '23', '23']);
    expect(rawRouteId('metro', 't1')).toBe('T1');
  });

  it('leaves out a position nowhere near its trip’s shape', async () => {
    const { db } = testPoster();
    startDetectionCapture(db, detection());
    const line = [
      [40.05, -75.17],
      [39.95, -75.17],
    ];
    const shapes = fakeShapes(undefined, { 'trip-a': line, 'trip-b': line });
    const sources = fakeSources(
      {
        // b reports from 5 km west of the line its trip runs.
        23: (now) => [
          rawVehicle('a', 40.0, -75.17, now - 5000),
          rawVehicle('b', 40.001, -75.23, now - 5000),
        ],
      },
      () => NOW,
    );
    expect(await sampleCaptures({ db, sources, shapes, now: NOW })).toEqual({
      captures: 1,
      samples: 1,
    });
    expect(db.prepare('SELECT vehicle_id FROM capture_samples').all()).toEqual([
      { vehicle_id: 'a' },
    ]);
  });

  it('records the whole feed for a snapshot, per mode', async () => {
    const { db } = testPoster();
    expect(startSnapshots(db, { now: NOW })).toEqual(['bus', 'metro']);
    expect(startSnapshots(db, { now: NOW + MIN })).toEqual([]);
    const sources = fakeSources(
      {
        23: () => [rawVehicle('a', 40.0, -75.17, NOW)],
        T1: () => [rawVehicle('9028', 39.955, -75.19, NOW)],
      },
      () => NOW,
    );
    await sampleCaptures({ db, sources, now: NOW + 1000 });
    expect(sources.calls).toEqual(['*']);
    const rows = db
      .prepare(
        'SELECT c.mode, s.route FROM capture_samples s JOIN captures c ON c.id = s.capture_id ORDER BY c.mode',
      )
      .all();
    expect(rows).toEqual([
      { mode: 'bus', route: '23' },
      { mode: 'metro', route: 't1' },
    ]);
  });

  it('renders a finished capture and replies under the detection post', async () => {
    const t = testPoster();
    const parent = await t.poster.post({
      account: 'bus',
      kind: 'detection',
      subject: 'det:b1',
      text: 'bunch',
    });
    startDetectionCapture(t.db, detection({ post: parent }));
    for (let m = 0; m <= 10; m++) {
      recordObservations(t.db, NOW + m * MIN, {
        vehicles: [
          vehicle({ label: 'a', id: 'a', lat: 40.0 - m * 0.002, reportTs: NOW + m * MIN }),
          vehicle({ label: 'b', id: 'b', lat: 40.0005 - m * 0.0015, reportTs: NOW + m * MIN }),
          vehicle({ label: 'c', id: 'c', lat: 39.96, reportTs: NOW + m * MIN }),
        ],
      });
    }
    const args = {
      db: t.db,
      poster: t.poster,
      shapes: fakeShapes(),
      basemap: createBasemap(),
      encode: fakeEncode,
      frames: 4,
    };
    expect(await renderDueCapture({ ...args, now: NOW + 10 * MIN })).toBeNull();
    const r = await renderDueCapture({ ...args, now: NOW + 11 * MIN });
    expect(r.posted).toBe('bunching');
    const reply = t.client.posts.at(-1);
    expect(reply.opts.reply.parent.uri).toBe(parent.uri);
    expect(reply.opts.text).toBe(
      '🎬 Route 23 · the next 10 minutes\n\nThe buses spread out: 180 ft → 0.38 mi from first to last.',
    );
    // 4 frames plus a second held at the end.
    expect(reply.opts.video.data.toString()).toBe('fake-mp4:20');
    expect(reply.opts.video).toMatchObject({ width: 1080, height: 1080 });
    expect(reply.opts.video.alt).toMatch(/^Timelapse map of the 10 minutes after the post/);
    expect(t.db.prepare('SELECT status FROM captures').get().status).toBe('done');
    expect(await renderDueCapture({ ...args, now: NOW + 12 * MIN })).toBeNull();
  });

  it('skips a capture whose post is gone, and retries a failed render once', async () => {
    const t = testPoster();
    startDetectionCapture(
      t.db,
      detection({ post: { uri: 'at://did:plc:bus/app.bsky.feed.post/gone' } }),
    );
    recordObservations(t.db, NOW, {
      vehicles: [vehicle({ label: 'a', id: 'a' }), vehicle({ label: 'b', id: 'b', lat: 40.001 })],
    });
    const args = {
      db: t.db,
      poster: t.poster,
      shapes: fakeShapes(),
      basemap: createBasemap(),
      frames: 2,
      now: NOW + 11 * MIN,
    };
    expect(await renderDueCapture({ ...args, encode: fakeEncode })).toEqual({
      skipped: 'parent-gone',
    });
    expect(t.client.posts).toHaveLength(0);

    startDetectionCapture(t.db, detection({ subject: 'det:b9', kind: 'gap', post: { uri: 'x' } }));
    const broken = async () => {
      throw new Error('encoder broke');
    };
    expect(await renderDueCapture({ ...args, encode: broken })).toEqual({ error: 'encoder broke' });
    expect(t.db.prepare("SELECT status FROM captures WHERE subject = 'det:b9'").get().status).toBe(
      'capturing',
    );
    await renderDueCapture({ ...args, encode: broken });
    expect(
      t.db.prepare("SELECT status, note FROM captures WHERE subject = 'det:b9'").get(),
    ).toEqual({
      status: 'failed',
      note: 'encoder broke',
    });
  });

  it('posts snapshots as top-level videos, within the daily video cap', async () => {
    const t = testPoster();
    startSnapshots(t.db, { now: NOW });
    for (let m = 0; m <= 15; m += 5) {
      recordObservations(t.db, NOW + m * MIN, {
        vehicles: [
          vehicle({ label: 'a', id: 'a', lat: 40.0 - m * 0.001, reportTs: NOW + m * MIN }),
          vehicle({
            label: 'k',
            id: 'k',
            mode: 'metro',
            route: 't1',
            lat: 39.955,
            lon: -75.19,
            reportTs: NOW + m * MIN,
          }),
        ],
      });
    }
    const args = {
      db: t.db,
      poster: t.poster,
      shapes: fakeShapes(),
      basemap: createBasemap(),
      encode: fakeEncode,
      frames: 2,
      now: NOW + 16 * MIN,
    };
    expect((await renderDueCapture(args)).posted).toBe('snapshot');
    expect((await renderDueCapture(args)).posted).toBe('snapshot');
    expect(t.client.posts.map((p) => [p.account, p.opts.reply ?? null])).toEqual([
      ['bus', null],
      ['metro', null],
    ]);
    expect(t.client.posts[1].opts.text).toMatch(
      /^🚋 SEPTA Metro trolleys, M1 and L1 · 15-minute timelapse/,
    );

    startSnapshots(t.db, { now: NOW + 3 * 3_600_000 });
    const capped = {
      ...args,
      limits: { ...VIDEO_LIMITS, dailyPerAccount: 1 },
      now: NOW + 3 * 3_600_000 + 16 * MIN,
    };
    expect(await renderDueCapture(capped)).toEqual({ skipped: 'daily-cap' });
  });

  it('starts a gap timelapse from the detection post, following L and N', async () => {
    const t = testPoster();
    const inc = detectionIncident({
      details: { gap_min: 25, headway_min: 10, vehicles: ['3787', '3314'], direction_id: 0 },
    });
    const vehicles = byLabel([
      vehicle({ label: '3787', id: '3787', lat: 39.97 }),
      vehicle({ label: '3314', id: '3314', lat: 40.03 }),
    ]);
    await postDetections({
      incidents: new Map([[inc.id, inc]]),
      poster: t.poster,
      db: t.db,
      vehicles,
      shapes: fakeShapes(),
      basemap: createBasemap(),
      timelapse: (opts) => startDetectionCapture(t.db, opts),
      now: NOW,
      maxAgeMs: 30 * MIN,
    });
    const c = t.db.prepare('SELECT * FROM captures').get();
    expect(c).toMatchObject({
      kind: 'gap',
      account: 'bus',
      mode: 'bus',
      reply_uri: t.client.posts[0].uri,
    });
    expect(JSON.parse(c.routes)).toEqual(['23']);
    const focus = JSON.parse(c.focus);
    expect(focus.vehicles.map((v) => `${v.tag}:${v.id}`)).toEqual(['L:3787', 'N:3314']);
    // Each vehicle's trip, so the video draws the shape it runs.
    expect(focus.vehicles.map((v) => v.tripId)).toEqual(['t1', 't1']);
    expect(focus.header).toBe('🎬 Route 23 — toward 11th-Market · the next 10 minutes');
    expect(focus.title).toBe('Route 23 · ~25 min gap');
  });

  it('starts a cluster timelapse with each route in its map color', async () => {
    const t = testPoster();
    const at = (i, route) =>
      vehicle({
        label: `v${i}`,
        id: `v${i}`,
        route,
        lat: 39.9526 + i * 0.0002,
        lon: -75.1652,
        nextStopSequence: 15,
      });
    const vs = [at(0, '17'), at(1, '17'), at(2, '33'), at(3, '48')];
    for (let m = -10; m <= 6; m++) recordObservations(t.db, NOW - m * MIN, { vehicles: vs });
    await postCrossBunching({
      vehicles: vs,
      schedule: null,
      db: t.db,
      poster: t.poster,
      shapes: fakeShapes(),
      basemap: createBasemap(),
      timelapse: (opts) => startDetectionCapture(t.db, opts),
      now: NOW,
    });
    const c = t.db.prepare('SELECT * FROM captures').get();
    expect(c).toMatchObject({ kind: 'cluster', account: 'bus' });
    expect(JSON.parse(c.routes).sort()).toEqual(['17', '33', '48']);
    const focus = JSON.parse(c.focus);
    expect(focus.vehicles.map((v) => v.tag)).toEqual(['1', '2', '3', '4']);
    const colors = new Map(focus.vehicles.map((v) => [v.route, v.color]));
    expect(new Set(colors.values()).size).toBe(3);
    for (const v of focus.vehicles) expect(v.color).toBe(colors.get(v.route));
  });

  it('prunes finished captures’ samples', async () => {
    const { db } = testPoster();
    const id = startCapture(db, {
      kind: 'snapshot',
      subject: 's',
      account: 'bus',
      mode: 'bus',
      start: NOW,
      durationMs: MIN,
    });
    db.prepare(
      "INSERT INTO capture_samples (capture_id, vehicle_id, label, route, t, lat, lon, late_min) VALUES (?, 'a', 'a', '23', ?, 40, -75, 0)",
    ).run(id, NOW);
    db.prepare("UPDATE captures SET status = 'done'").run();
    expect(pruneDb(db, NOW + 2 * MIN, { observationRetentionDays: 3 }).samples).toBe(1);
  });
});

describe('video encoding', () => {
  it('renders frames over the basemap and holds the last one', async () => {
    const frames = [];
    const out = await renderTimelapse({
      view: { lat: 40, lon: -75.17, zoom: 13, width: 320, height: 320 },
      staticSvg: '<rect x="0" y="0" width="10" height="10" fill="#fff"/>',
      drawFrame: (_t, progress) =>
        `<circle cx="${100 + progress * 100}" cy="160" r="10" fill="#f00"/>`,
      start: NOW,
      end: NOW + MIN,
      basemap: createBasemap(),
      frames: 3,
      fps: 4,
      encode: async (gen) => {
        for await (const f of gen) frames.push(f);
        return Buffer.from('x');
      },
    });
    expect(out.frames).toBe(3);
    expect(frames).toHaveLength(3 + 4);
    expect(frames[0].subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(frames.at(-1)).toBe(frames[2]);
  });

  // CI installs ffmpeg for this (and must run it); the server's setup script
  // installs it too. Local runs without ffmpeg skip it.
  it.runIf(HAS_FFMPEG || process.env.CI)('encodes an H.264 MP4 with ffmpeg', async () => {
    const out = await renderTimelapse({
      view: { lat: 40, lon: -75.17, zoom: 13, width: 160, height: 160 },
      staticSvg: '',
      drawFrame: (_t, p) => `<circle cx="${20 + p * 120}" cy="80" r="10" fill="#f00"/>`,
      start: NOW,
      end: NOW + MIN,
      basemap: createBasemap(),
      frames: 8,
      encode: encodeMp4,
    });
    expect(out.data.subarray(4, 8).toString()).toBe('ftyp');
    expect(out.data.length).toBeGreaterThan(1000);
  });
});

describe('the route lines under a timelapse', () => {
  const trunk = [
    [40.05, -75.17],
    [39.95, -75.17],
  ];
  const extension = [
    [40.05, -75.2],
    [39.95, -75.2],
  ];
  const shapes = fakeShapes({ 23: trunk }, { ext: extension, main: trunk });
  const follow = (route, tripId, over = {}) => ({ id: tripId, route, tripId, ...over });
  const layers = (kind, vehicles, over = {}) =>
    routeLayers(
      { kind, mode: 'bus', routes: JSON.stringify(['23']) },
      { direction_id: 0, vehicles, ...over },
      shapes,
    );

  it('are the shapes the followed vehicles’ own trips run, each once', () => {
    expect(layers('gap', [follow('23', 'ext'), follow('23', 'ext')])[0].shapes).toEqual([
      extension,
    ]);
    expect(layers('bunching', [follow('23', 'ext'), follow('23', 'main')])[0].shapes).toEqual([
      extension,
      trunk,
    ]);
  });

  it('are the route’s own shape for a vehicle whose trip has none', () => {
    expect(layers('gap', [follow('23', 'nope'), follow('23', 'nope')])[0].shapes).toEqual([trunk]);
    expect(layers('gap', [{ id: 'a', route: '23' }])[0].shapes).toEqual([trunk]);
  });

  it('leave a cross-route cluster to the routes’ shapes', () => {
    expect(layers('cluster', [follow('23', 'ext')], { direction_id: null })[0].shapes).toEqual([
      trunk,
    ]);
  });
});

describe('route shapes for gaps', () => {
  it('follows the direction the vehicles are on', () => {
    const north = [
      [39.95, -75.15],
      [40.05, -75.15],
    ];
    const south = [
      [40.05, -75.152],
      [39.95, -75.152],
    ];
    const on = [
      { lat: 39.98, lon: -75.15 },
      { lat: 40.01, lon: -75.1501 },
    ];
    expect(nearestShape([south, north], on)).toBe(north);
    expect(nearestShape([], on)).toBeNull();
  });
});
