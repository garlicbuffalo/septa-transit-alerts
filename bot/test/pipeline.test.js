import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDryRunClient } from '../lib/bluesky.js';
import { loadConfig } from '../lib/config.js';
import { getMeta, openDb, setMeta } from '../lib/db.js';
import { createPipeline } from '../lib/pipeline.js';
import { createPoster } from '../lib/poster.js';
import { createPublisher, SERVER_MARK } from '../lib/publish.js';
import { createBasemap } from '../map/basemap.js';
import { fakeLiveClient } from './helpers.js';

const FIXTURES = resolve(import.meta.dirname, '../../collector/test/fixtures');
const FIXTURE_NOW = 1791244200000;

const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

function bareRemote() {
  const dir = mkdtempSync(join(tmpdir(), 'remote-'));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'data', dir]);
  return dir;
}

function fakeGitHub({ busy = false } = {}) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body ?? null });
    if (String(url).includes('/runs')) {
      return new Response(
        JSON.stringify({ workflow_runs: busy ? [{ status: 'in_progress' }] : [] }),
        { status: 200 },
      );
    }
    return new Response(null, { status: 204 });
  };
  return { calls, fetchFn };
}

describe('publisher', () => {
  it('pushes one parentless server snapshot and triggers a deploy', async () => {
    const remote = bareRemote();
    const dataDir = mkdtempSync(join(tmpdir(), 'data-'));
    const db = openDb(':memory:');
    const gh = fakeGitHub();
    let t = FIXTURE_NOW;
    const publisher = createPublisher({
      dataDir,
      github: {
        repo: 'o/r',
        token: 't',
        dataBranch: 'data',
        deployWorkflow: 'deploy.yml',
        deployRef: 'main',
      },
      db,
      enabled: true,
      deployMinGapMs: 10 * 60_000,
      fetchFn: gh.fetchFn,
      now: () => t,
      remoteUrl: remote,
    });
    await publisher.prepare();
    cpSync(join(FIXTURES, 'alerts.json'), join(dataDir, 'alerts.json'));
    const first = await publisher.publish({ changed: 2 });
    expect(first).toMatchObject({ pushed: true, deployed: true });
    expect(git(remote, 'log', '-1', '--format=%s', 'data')).toMatch(new RegExp(`${SERVER_MARK}$`));
    expect(git(remote, 'rev-list', '--count', 'data')).toBe('1');
    expect(gh.calls.find((c) => c.method === 'POST').url).toMatch(/deploy\.yml\/dispatches$/);

    // Nothing new: no push, no deploy.
    t += 60_000;
    expect(await publisher.publish({ changed: 0 })).toMatchObject({
      pushed: false,
      deployed: false,
    });

    // A rider-visible change inside the deploy gap: push now, deploy later.
    t += 60_000;
    cpSync(join(FIXTURES, 'elevators.json'), join(dataDir, 'elevators.json'));
    expect(await publisher.publish({ changed: 1 })).toMatchObject({
      pushed: true,
      deployed: false,
    });
    expect(getMeta(db, 'deploy_pending')).toBe('1');
    expect(git(remote, 'rev-list', '--count', 'data')).toBe('1');
    t += 10 * 60_000;
    expect(await publisher.publish({ changed: 0 })).toMatchObject({ deployed: true });
  });

  it('never pushes before it has read the published branch', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'data-'));
    const db = openDb(':memory:');
    const gh = fakeGitHub();
    const publisher = createPublisher({
      dataDir,
      github: {
        repo: 'o/r',
        token: 't',
        dataBranch: 'data',
        deployWorkflow: 'deploy.yml',
        deployRef: 'main',
      },
      db,
      enabled: true,
      deployMinGapMs: 0,
      fetchFn: gh.fetchFn,
      remoteUrl: join(tmpdir(), 'no-such-remote'),
    });
    expect((await publisher.prepare()).error).toBeTruthy();
    cpSync(join(FIXTURES, 'alerts.json'), join(dataDir, 'alerts.json'));
    expect(await publisher.publish({ changed: 5 })).toMatchObject({
      pushed: false,
      reason: 'unsynced',
    });
    expect(gh.calls).toHaveLength(0);
  });

  it('waits while a deploy is already running', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'data-'));
    const db = openDb(':memory:');
    setMeta(db, 'deploy_pending', '1');
    const gh = fakeGitHub({ busy: true });
    const publisher = createPublisher({
      dataDir,
      github: {
        repo: 'o/r',
        token: 't',
        dataBranch: 'data',
        deployWorkflow: 'deploy.yml',
        deployRef: 'main',
      },
      db,
      enabled: true,
      deployMinGapMs: 0,
      fetchFn: gh.fetchFn,
      remoteUrl: bareRemote(),
    });
    await publisher.prepare();
    await publisher.publish({ changed: 0 });
    expect(gh.calls.some((c) => c.method === 'POST')).toBe(false);
  });
});

describe('pipeline', () => {
  function setup(client, fixtures = FIXTURES) {
    const stateDir = mkdtempSync(join(tmpdir(), 'bot-'));
    const config = loadConfig({ STATE_DIR: stateDir, FIXTURES_DIR: fixtures });
    const db = openDb(config.dbPath);
    // Posting since well before the fixtures' alerts began (0 would read as unset).
    setMeta(db, client.dryRun ? 'dry_run_since' : 'live_since', 1);
    const poster = createPoster({ db, client, now: () => FIXTURE_NOW });
    // An empty local remote: the real published branch would make the test
    // depend on the network and on whatever the live detectors remember.
    const publisher = createPublisher({
      dataDir: config.dataDir,
      github: config.github,
      db,
      enabled: false,
      deployMinGapMs: 0,
      remoteUrl: bareRemote(),
    });
    const logs = [];
    const pipeline = createPipeline({
      config: { ...config, postMaxAgeMs: Number.POSITIVE_INFINITY },
      db,
      poster,
      basemap: createBasemap(),
      publisher,
      log: (m) => logs.push(m),
      now: () => FIXTURE_NOW,
    });
    return { config, db, pipeline, publisher, logs };
  }

  it('observes, collects, posts alerts, and links them into the published data', async () => {
    const client = fakeLiveClient();
    const { config, db, pipeline, publisher, logs } = setup(client);
    await publisher.prepare();
    const seen = await pipeline.observe();
    expect(seen.vehicles).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM observations').get().n).toBe(seen.rows);

    const { ok, summary } = await pipeline.collectTick();
    expect(ok).toBe(true);
    expect(summary.hook.alerts.posted).toBeGreaterThan(0);
    expect(client.posts.filter((p) => p.account === 'alerts')).toHaveLength(
      summary.hook.alerts.posted,
    );
    // The fixtures' trip feed cancels bus trips and it's past 2:45 PM: one
    // cancelled-trip roundup; nothing else on the other accounts yet.
    expect(summary.hook.cancellations).toMatchObject({ posts: 1 });
    expect(client.posts.filter((p) => p.account !== 'alerts')).toHaveLength(1);
    const recent = JSON.parse(readFileSync(join(config.dataDir, 'alerts-recent.json'), 'utf8'));
    const linked = recent.incidents.filter((i) => i.official_alert?.post_url);
    const roundup = recent.incidents.filter((i) => i.detections?.some((d) => d.post_url));
    expect(roundup.length).toBeGreaterThan(0);
    expect(linked.length + roundup.length).toBe(summary.hook.linked);
    expect(linked[0].official_alert.post_url).toMatch(
      /^https:\/\/bsky\.app\/profile\/did:plc:alerts\/post\//,
    );
    expect(logs.at(-1)).toMatch(/^collect: \d+ active/);

    // The next tick posts nothing new.
    const again = await pipeline.collectTick();
    expect(again.summary.hook.alerts.posted).toBe(0);
  });

  it('keeps positions that cannot be right out of the observations and the maps', async () => {
    // Route 17's trips run a straight north–south shape; bus 7413 reports from 5 km west of it.
    const fixtures = mkdtempSync(join(tmpdir(), 'fixtures-'));
    cpSync(FIXTURES, fixtures, { recursive: true });
    writeFileSync(
      join(fixtures, 'route-shapes.json'),
      JSON.stringify({
        version: 1,
        built_at: FIXTURE_NOW,
        routes: {},
        patterns: [
          [
            [39.9, -75.17],
            [40.0, -75.17],
          ],
        ],
        tripPatterns: Object.fromEntries([12, 13, 14, 15, 16, 17].map((n) => [`17-${n}`, 0])),
      }),
    );
    const feed = JSON.parse(readFileSync(join(fixtures, 'transitview.json'), 'utf8'));
    feed.routes[0]['17'].find((v) => v.VehicleID === '7413').lng = '-75.23';
    writeFileSync(join(fixtures, 'transitview.json'), JSON.stringify(feed));

    const { db, pipeline, publisher } = setup(fakeLiveClient(), fixtures);
    await publisher.prepare();
    await pipeline.loadShapes();
    await pipeline.observe();
    const observed = db
      .prepare("SELECT vehicle_id FROM observations WHERE route = '17' ORDER BY vehicle_id")
      .all()
      .map((r) => r.vehicle_id);
    expect(observed).toContain('7412');
    expect(observed).not.toContain('7413');
    // The detectors' tick drops it too, and says so.
    const { summary } = await pipeline.collectTick();
    expect(summary.sources.transitView.dropped).toEqual({ offRoute: 1, jump: 0 });
  });

  it('stops recording a trolley whose position has repeated for three minutes', async () => {
    // The fixtures' T1 car #9101 reports the same position every poll, as a car in the tunnel does.
    let t = FIXTURE_NOW;
    const client = fakeLiveClient();
    const stateDir = mkdtempSync(join(tmpdir(), 'bot-'));
    const config = loadConfig({ STATE_DIR: stateDir, FIXTURES_DIR: FIXTURES });
    const db = openDb(config.dbPath);
    const pipeline = createPipeline({
      config,
      db,
      poster: createPoster({ db, client, now: () => t }),
      basemap: createBasemap(),
      publisher: null,
      log: () => {},
      now: () => t,
    });
    const rows = () =>
      db.prepare("SELECT COUNT(*) AS n FROM observations WHERE vehicle_id = '9101'").get().n;
    const counts = [];
    // (The fixtures' reports are 30 seconds old at minute 0, and go stale after minute 4.)
    for (let minute = 0; minute <= 4; minute++) {
      t = FIXTURE_NOW + minute * 60_000;
      await pipeline.observe();
      counts.push(rows());
    }
    // Recorded at minutes 0–2, while it might just be stopped; frozen from minute 3.
    expect(counts).toEqual([1, 2, 3, 3, 3]);
    // A bus in the same feed keeps being recorded.
    const bus = db
      .prepare("SELECT COUNT(*) AS n FROM observations WHERE vehicle_id = '7412'")
      .get();
    expect(bus.n).toBe(5);
  });

  it('reads the route shapes again once the collector has rebuilt them', async () => {
    // No fixtures: the shapes come from the cache file the collector writes.
    const stateDir = mkdtempSync(join(tmpdir(), 'bot-'));
    const config = loadConfig({ STATE_DIR: stateDir });
    const file = join(config.cacheDir, 'route-shapes.json');
    const cache = (extra = {}) =>
      JSON.stringify({
        version: 1,
        built_at: 1,
        routes: {
          17: {
            0: [
              [39.9, -75.17],
              [40, -75.17],
            ],
          },
        },
        ...extra,
      });
    mkdirSync(config.cacheDir, { recursive: true });
    // A cache from before trips' own shapes were kept.
    writeFileSync(file, cache());
    const pipeline = createPipeline({
      config,
      db: openDb(':memory:'),
      poster: null,
      basemap: createBasemap(),
      publisher: null,
      log: () => {},
      now: () => FIXTURE_NOW,
    });
    const before = await pipeline.loadShapes();
    expect(before.tripShape('17-12')).toBeNull();
    // Nothing has changed: the same shapes.
    expect(await pipeline.refreshShapes()).toBe(before);
    // The collector rebuilds the cache with every trip's shape.
    writeFileSync(
      file,
      cache({
        patterns: [
          [
            [39.9, -75.2],
            [40, -75.2],
          ],
        ],
        tripPatterns: { '17-12': 0 },
      }),
    );
    const later = new Date(Date.now() + 60_000);
    utimesSync(file, later, later);
    const after = await pipeline.refreshShapes();
    expect(after).not.toBe(before);
    expect(after.tripShape('17-12')).toEqual([
      [39.9, -75.2],
      [40, -75.2],
    ]);
    expect(await pipeline.refreshShapes()).toBe(after);
  });

  it('keeps dry-run posts out of the published data', async () => {
    const client = createDryRunClient({ assetsDir: mkdtempSync(join(tmpdir(), 'assets-')) });
    const { config, pipeline, publisher } = setup(client);
    await publisher.prepare();
    await pipeline.observe();
    const { summary } = await pipeline.collectTick();
    expect(summary.hook.alerts.posted).toBeGreaterThan(0);
    const recent = JSON.parse(readFileSync(join(config.dataDir, 'alerts-recent.json'), 'utf8'));
    expect(recent.incidents.some((i) => i.official_alert?.post_url)).toBe(false);
  });
});
