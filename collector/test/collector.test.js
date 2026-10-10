// @vitest-environment node
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collect } from '../collect.js';
import { buildDailyCounts, loadArchive, publishArchive } from '../lib/archive.js';
import { applyElevators } from '../lib/elevators.js';
import { alertParts, applyOfficialAlerts, classifyAlert } from '../lib/officialAlerts.js';
import { advanceCancellations, applyTrainView } from '../lib/railTrains.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = async (name) => JSON.parse(await readFile(join(FIXTURES, name), 'utf8'));
// 7:50 PM Eastern on Monday 2026-10-05 — when the fixtures were captured.
const NOW = Date.UTC(2026, 9, 5, 23, 50);
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

const alert = (over = {}) => ({
  alert_id: '500',
  routes: ['B1'],
  type: 'ADVISORY',
  subject: 'Shuttle Busing Between Olney and Fern Rock Transit Center',
  message: '<p>Bus service replaces trains.</p>',
  status: 'NORMAL',
  cause: 'MAINTENANCE',
  effect: 'MODIFIED_SERVICE',
  severity: 'SEVERE',
  start: '2026-10-10 00:45:00.000',
  end: '2026-10-12 04:00:00.000',
  created_at: '2026-10-01 12:00:00',
  updated_at: '2026-10-01 12:00:00',
  ...over,
});

describe('classifyAlert', () => {
  it('keeps short detours and drops long-running ones', () => {
    const short = {
      alert_id: 'D1',
      routes: ['4'],
      type: 'DETOUR',
      start: '2026-10-05 14:40:00',
      end: '2026-10-05 20:00:00',
    };
    const long = { ...short, end: '2026-12-31 23:00:00' };
    expect(classifyAlert(short)).toEqual({ include: true, reason: 'short-detour' });
    expect(classifyAlert(long).reason).toBe('long-term-detour');
    expect(classifyAlert({ ...short, end: null }).reason).toBe('open-ended-detour');
  });

  it('drops amenity, accessibility, and no-effect advisories', () => {
    expect(classifyAlert(alert({ subject: 'No Parking in North Lot' })).reason).toBe(
      'station-amenity',
    );
    expect(classifyAlert(alert({ subject: '8th-Market Elevator Out of Service' })).reason).toBe(
      'accessibility',
    );
    expect(classifyAlert(alert({ effect: 'NO_EFFECT' })).reason).toBe('no-service-effect');
    expect(classifyAlert(alert({ routes: [] })).reason).toBe('no-routes');
    expect(classifyAlert(alert()).include).toBe(true);
  });
});

describe('alertParts', () => {
  it('splits an alert spanning Metro and bus into one incident per network', () => {
    const parts = alertParts(alert({ alert_id: '77', routes: ['L1', 'L1 OWL'] }));
    expect(parts.map((p) => [p.id, p.mode, p.routes])).toEqual([
      ['alert-77', 'metro', ['l1']],
      ['alert-77-bus', 'bus', ['L1-OWL']],
    ]);
  });

  it('carries the agency window, station scope, and plain-text body', () => {
    const [p] = alertParts(alert());
    expect(p.window.start_ts).toBe(Date.UTC(2026, 9, 10, 4, 45));
    expect(p.window.end_is_date_only).toBe(false);
    expect(p.scope.from_station).toBe('Olney Transit Center');
    expect(p.description).toBe('Bus service replaces trains.');
    expect(p.createdTs).toBe(Date.UTC(2026, 9, 1, 16, 0));
  });
});

describe('applyOfficialAlerts', () => {
  it('opens, revises, and resolves an incident over successive polls', () => {
    const incidents = new Map();
    applyOfficialAlerts(incidents, [alert()], NOW);
    const opened = incidents.get('alert-500');
    expect(opened.lifecycle).toEqual({
      first_seen_ts: Date.UTC(2026, 9, 1, 16, 0),
      resolved_ts: null,
      active: true,
      duration_ms: null,
    });
    expect(opened.sources).toEqual(['septa']);
    expect(opened.official_alert.versions).toBeUndefined();

    const { changed: quiet } = applyOfficialAlerts(incidents, [alert()], NOW + 10 * MIN);
    expect(quiet.size).toBe(0);

    applyOfficialAlerts(
      incidents,
      [alert({ message: '<p>Shuttles every 10 minutes.</p>' })],
      NOW + 20 * MIN,
    );
    const revised = incidents.get('alert-500').official_alert;
    expect(revised.description).toBe('Shuttles every 10 minutes.');
    expect(revised.versions.map((v) => v.short_description)).toEqual([
      'Bus service replaces trains.',
      'Shuttles every 10 minutes.',
    ]);

    applyOfficialAlerts(incidents, [], NOW + 30 * MIN);
    const resolved = incidents.get('alert-500');
    expect(resolved.lifecycle.active).toBe(false);
    expect(resolved.lifecycle.resolved_ts).toBe(NOW + 30 * MIN);
    expect(resolved.official_alert.lifecycle.active).toBe(false);
  });

  it('reopens an alert that comes back', () => {
    const incidents = new Map();
    applyOfficialAlerts(incidents, [alert()], NOW);
    applyOfficialAlerts(incidents, [], NOW + 10 * MIN);
    applyOfficialAlerts(incidents, [alert()], NOW + 20 * MIN);
    expect(incidents.get('alert-500').lifecycle.active).toBe(true);
  });

  it('does not mass-resolve when the feed comes back truncated', () => {
    const incidents = new Map();
    const many = Array.from({ length: 12 }, (_, i) => alert({ alert_id: String(600 + i) }));
    applyOfficialAlerts(incidents, many, NOW);
    const { stats } = applyOfficialAlerts(incidents, many.slice(0, 2), NOW + 10 * MIN);
    expect(stats.truncated).toBe(true);
    expect([...incidents.values()].every((i) => i.lifecycle.active)).toBe(true);
  });

  it('with miss tracking, resolves only after two misses spanning a few minutes', () => {
    const incidents = new Map();
    const misses = {};
    applyOfficialAlerts(incidents, [alert()], NOW, { misses });
    // One miss: pending, still active.
    let { stats } = applyOfficialAlerts(incidents, [], NOW + 2 * MIN, { misses });
    expect(stats.pending).toBe(1);
    expect(incidents.get('alert-500').lifecycle.active).toBe(true);
    // Back in the feed: the miss is forgotten.
    applyOfficialAlerts(incidents, [alert()], NOW + 4 * MIN, { misses });
    expect(misses).toEqual({});
    // Two misses, but only 2 minutes apart: still pending.
    applyOfficialAlerts(incidents, [], NOW + 6 * MIN, { misses });
    ({ stats } = applyOfficialAlerts(incidents, [], NOW + 8 * MIN, { misses }));
    expect(stats.pending).toBe(1);
    // A third, 4+ minutes after the first: resolved, backdated to the first miss.
    ({ stats } = applyOfficialAlerts(incidents, [], NOW + 10 * MIN, { misses }));
    expect(stats.resolved).toBe(1);
    expect(incidents.get('alert-500').lifecycle.resolved_ts).toBe(NOW + 6 * MIN);
    expect(misses).toEqual({});
  });

  it('keeps the Bluesky links the bot service wrote', () => {
    const incidents = new Map();
    applyOfficialAlerts(incidents, [alert()], NOW);
    const inc = incidents.get('alert-500');
    incidents.set('alert-500', {
      ...inc,
      official_alert: {
        ...inc.official_alert,
        post_url: 'https://bsky.app/profile/did:plc:x/post/1',
        resolved_reply_url: null,
      },
    });
    applyOfficialAlerts(incidents, [alert({ message: '<p>Edited.</p>' })], NOW + 10 * MIN);
    expect(incidents.get('alert-500').official_alert.post_url).toBe(
      'https://bsky.app/profile/did:plc:x/post/1',
    );
  });

  it('closes an alert still listed well past its stated end', () => {
    const incidents = new Map();
    const stale = alert({ start: '2026-10-01 09:30:00.000', end: '2026-10-02 14:00:00.000' });
    applyOfficialAlerts(incidents, [stale], NOW);
    const inc = incidents.get('alert-500');
    expect(inc.lifecycle.active).toBe(false);
    expect(inc.lifecycle.resolved_ts).toBe(Date.UTC(2026, 9, 2, 18, 0));
  });
});

const train = (over = {}) => ({
  trainno: '3556',
  line: 'Lansdale/Doylestown',
  late: 22,
  SOURCE: 'Wawa',
  dest: 'Doylestown',
  currentstop: 'Fern Rock T C',
  nextstop: 'Jenkintown Wyncote',
  service: 'LOCAL',
  ...over,
});

const schedules = async () => fixture('rr-schedules.json');

describe('applyTrainView', () => {
  it('opens a delay anchored to the scheduled departure, then resolves it on recovery', async () => {
    const all = await schedules();
    const lookupSchedule = async (n) => all[n] ?? [];
    const incidents = new Map();
    await applyTrainView(incidents, [train()], NOW, { lookupSchedule });
    const inc = incidents.get('delay-2026-10-05-3556');
    expect(inc.mode).toBe('regional_rail');
    expect(inc.routes).toEqual(['lan']);
    expect(inc.sources).toEqual(['bot']);
    expect(inc.status).toMatchObject({ type: 'delay', train_number: '3556', delay_min: 22 });
    expect(inc.status.scheduled_departure_ts).toBe(Date.UTC(2026, 9, 5, 22, 31));
    expect(inc.detections[0].description).toBe(
      '~22 min late — the 6:31 PM Wawa to Doylestown train (#3556)',
    );
    expect(inc.detections[0].scope.direction_label).toBe('toward Doylestown');

    await applyTrainView(incidents, [train({ late: 35, line: 'Media/Wawa' })], NOW + 10 * MIN, {
      lookupSchedule,
    });
    const worse = incidents.get('delay-2026-10-05-3556');
    expect(worse.status.delay_min).toBe(35);
    expect(worse.routes).toEqual(['lan', 'med']);
    expect(worse.detections[0].evidence.updates).toHaveLength(2);

    await applyTrainView(incidents, [train({ late: 4 })], NOW + 20 * MIN, { lookupSchedule });
    const cleared = incidents.get('delay-2026-10-05-3556');
    expect(cleared.lifecycle.active).toBe(false);
    expect(cleared.lifecycle.duration_ms).toBe(20 * MIN);
  });

  it('resolves a delay once its train leaves the feed', async () => {
    const incidents = new Map();
    await applyTrainView(incidents, [train(), train({ trainno: '9', late: 0 })], NOW);
    await applyTrainView(incidents, [train({ trainno: '9', late: 0 })], NOW + 10 * MIN);
    expect(incidents.get('delay-2026-10-05-3556').lifecycle.active).toBe(false);
  });

  it('keeps a delay open through a briefly empty feed', async () => {
    const incidents = new Map();
    await applyTrainView(incidents, [train()], NOW);
    await applyTrainView(incidents, [], NOW + 10 * MIN);
    expect(incidents.get('delay-2026-10-05-3556').lifecycle.active).toBe(true);
    await applyTrainView(incidents, [], NOW + 120 * MIN);
    const inc = incidents.get('delay-2026-10-05-3556');
    expect(inc.lifecycle.active).toBe(false);
    expect(inc.lifecycle.resolved_ts).toBe(NOW);
  });

  it('records cancellations as upcoming until the scheduled departure passes', async () => {
    const lookupSchedule = async () => [
      { station: 'Warminster', sched_tm: '8:30 pm' },
      { station: 'Suburban Station', sched_tm: '9:25 pm' },
    ];
    const incidents = new Map();
    await applyTrainView(
      incidents,
      [
        train({
          trainno: '445',
          line: 'Warminster',
          late: 999,
          SOURCE: 'Warminster',
          dest: 'Suburban Station',
        }),
      ],
      NOW,
      { lookupSchedule },
    );
    const inc = incidents.get('cancel-2026-10-05-445');
    expect(inc.status).toMatchObject({
      type: 'cancellation',
      state: 'upcoming',
      train_number: '445',
    });
    expect(inc.lifecycle.active).toBe(true);
    expect(inc.detections[0].description).toBe(
      'Canceled — the 8:30 PM Warminster to Suburban Station train (#445)',
    );

    advanceCancellations(incidents, Date.UTC(2026, 9, 6, 0, 31));
    const done = incidents.get('cancel-2026-10-05-445');
    expect(done.status.state).toBe('cancelled');
    expect(done.lifecycle.active).toBe(false);
    expect(done.lifecycle.resolved_ts).toBe(Date.UTC(2026, 9, 6, 0, 30));
  });

  it('records an already-departed cancellation as a closed point event', async () => {
    const all = await schedules();
    const incidents = new Map();
    await applyTrainView(
      incidents,
      [
        train({
          trainno: '6311',
          line: 'West Trenton',
          late: 999,
          SOURCE: 'West Trenton',
          dest: '30th Street Station',
        }),
      ],
      NOW,
      { lookupSchedule: async (n) => all[n] },
    );
    const inc = incidents.get('cancel-2026-10-05-6311');
    expect(inc.lifecycle).toEqual({
      first_seen_ts: NOW,
      resolved_ts: NOW,
      active: false,
      duration_ms: 0,
    });
    expect(inc.detections[0].lifecycle.onset_ts).toBe(Date.UTC(2026, 9, 5, 12, 6));
    expect(inc.status.state).toBe('cancelled');
  });
});

describe('applyElevators', () => {
  it('opens outages, restores them, and starts a new episode on re-failure', async () => {
    const payload = await fixture('elevators.json');
    const outages = new Map();
    applyElevators(outages, payload, NOW);
    expect(outages.size).toBe(6);
    const eighth = [...outages.values()].find((o) => o.station.slug === '8th-market');
    expect(eighth).toMatchObject({
      mode: 'metro',
      station: { name: '8th-Market', lines: ['l1', 'b3'] },
      unit_type: 'elevator',
      description: 'No access to/from station',
    });

    const without = {
      ...payload,
      results: payload.results.filter((r) => r.station !== '8th-Market'),
    };
    const { stats } = applyElevators(outages, without, NOW + DAY);
    expect(stats.restored).toBe(1);
    expect(outages.get(eighth.id).lifecycle).toMatchObject({
      active: false,
      restored_ts: NOW + DAY,
    });

    applyElevators(outages, payload, NOW + 3 * DAY);
    const episodes = [...outages.values()].filter((o) => o.station.slug === '8th-market');
    expect(episodes).toHaveLength(2);
    expect(episodes.filter((o) => o.lifecycle.active)).toHaveLength(1);
  });

  it('rejects a payload without results', () => {
    expect(() => applyElevators(new Map(), { meta: {} }, NOW)).toThrow(/results/);
  });
});

describe('archive', () => {
  let dir;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'septa-archive-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips incidents through shards and derives every published file', async () => {
    const incidents = new Map();
    applyOfficialAlerts(
      incidents,
      [alert(), alert({ alert_id: '501', routes: ['17'], created_at: '2026-06-02 08:00:00' })],
      NOW,
    );
    applyOfficialAlerts(incidents, [alert()], NOW + MIN); // 501 resolves
    const outages = new Map();
    await publishArchive(dir, { incidents, outages, dataStartTs: NOW - 200 * DAY, now: NOW + MIN });

    const read = async (f) => JSON.parse(await readFile(join(dir, f), 'utf8'));
    const index = await read('alerts-index.json');
    expect(index.months.map((m) => m.key)).toEqual(['2026-10', '2026-06']);
    expect(index.id_month).toEqual({ 'alert-500': '2026-10', 'alert-501': '2026-06' });
    expect(index.lines.map((l) => [l.key, l.mode])).toEqual([
      ['17', 'bus'],
      ['b1', 'metro'],
    ]);
    // 501 is resolved and older than the 93-day window → archive only.
    const recent = await read('alerts-recent.json');
    expect(recent.incidents.map((i) => i.id)).toEqual(['alert-500']);
    expect((await read('incidents/by-line/17.json')).incidents.map((i) => i.id)).toEqual([
      'alert-501',
    ]);
    expect((await read('aggregates.json')).yoy.by_mode.metro.currentCount).toBe(1);

    const loaded = await loadArchive(dir);
    expect([...loaded.incidents.keys()].sort()).toEqual(['alert-500', 'alert-501']);
    expect(loaded.dataStartTs).toBe(NOW - 200 * DAY);

    // Re-publishing unchanged incidents rewrites only the timestamped files.
    const written = await publishArchive(dir, {
      incidents: loaded.incidents,
      outages: loaded.outages,
      dataStartTs: loaded.dataStartTs,
      now: NOW + 2 * MIN,
      previousShardKeys: loaded.shardKeys,
    });
    expect(written.sort()).toEqual([
      'accessibility.json',
      'aggregates.json',
      'alerts-index.json',
      'alerts-recent.json',
      'daily-counts.json',
    ]);
  });

  it('counts incidents per Philadelphia day by network', () => {
    const inc = (id, mode, routes, ts) => ({ id, mode, routes, lifecycle: { first_seen_ts: ts } });
    const counts = buildDailyCounts(
      [
        inc('a', 'metro', ['l1'], Date.UTC(2026, 9, 5, 14)),
        inc('b', 'regional_rail', ['pao', 'cyn'], Date.UTC(2026, 9, 5, 15)),
        inc('c', 'bus', ['17'], Date.UTC(2026, 9, 6, 2)), // 10 PM on the 5th in Philly
      ],
      NOW + DAY,
      null,
    );
    expect(counts.days).toEqual([
      {
        date: '2026-10-05',
        metro_count: 1,
        bus_count: 1,
        rail_count: 1,
        by_line: { l1: 1 },
        by_route: { 17: 1 },
        by_rail_line: { pao: 1, cyn: 1 },
      },
    ]);
  });
});

describe('collect (fixtures end to end)', () => {
  let dir;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'septa-collect-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('runs the beforePublish hook and takes source overrides', async () => {
    const seen = {};
    const { summary } = await collect({
      dataDir: dir,
      fixturesDir: FIXTURES,
      now: NOW,
      log: () => {},
      sources: { elevators: async () => [] },
      beforePublish: async ({ incidents, now }) => {
        seen.count = incidents.size;
        seen.now = now;
        const first = [...incidents.values()].find((i) => i.official_alert);
        first.official_alert.post_url = 'https://bsky.app/profile/did:plc:x/post/hook';
        return { touched: first.id };
      },
    });
    expect(seen.count).toBeGreaterThan(0);
    expect(seen.now).toBe(NOW);
    expect(summary.sources.elevators.active ?? 0).toBe(0);
    const recent = JSON.parse(await readFile(join(dir, 'alerts-recent.json'), 'utf8'));
    expect(
      recent.incidents.find((i) => i.id === summary.hook.touched).official_alert.post_url,
    ).toBe('https://bsky.app/profile/did:plc:x/post/hook');
  });

  it('leaves a position that cannot be right out of the detectors and the hook', async () => {
    // Route 17's trips run a straight north–south shape; bus 7413 reports from 5 km west of it.
    const fixtures = await mkdtemp(join(tmpdir(), 'collect-fixtures-'));
    try {
      await cp(FIXTURES, fixtures, { recursive: true });
      const tripPatterns = Object.fromEntries([12, 13, 14, 15, 16, 17].map((n) => [`17-${n}`, 0]));
      await writeFile(
        join(fixtures, 'route-shapes.json'),
        JSON.stringify({
          version: 1,
          built_at: NOW,
          routes: {},
          patterns: [
            [
              [39.9, -75.17],
              [40.0, -75.17],
            ],
          ],
          tripPatterns,
        }),
      );
      const payload = await fixture('transitview.json');
      const stray = payload.routes[0]['17'].find((v) => v.VehicleID === '7413');
      stray.lng = '-75.23';
      let seen = null;
      const { summary } = await collect({
        dataDir: dir,
        fixturesDir: fixtures,
        now: NOW,
        log: () => {},
        sources: { transitView: async () => payload },
        beforePublish: async ({ vehicles }) => {
          seen = vehicles.map((v) => v.id);
          return {};
        },
      });
      expect(summary.sources.transitView).toMatchObject({
        vehicles: 9, // TransitView's 7 that passed, and the vehicle feed's two L1 trains
        dropped: { offRoute: 1, jump: 0 },
      });
      expect(seen).toContain('7412');
      expect(seen).not.toContain('7413');
      const state = JSON.parse(await readFile(join(dir, '_collector-state.json'), 'utf8'));
      expect(state.screen['7412']).toMatchObject({ lat: 39.96 });
      expect(state.screen).not.toHaveProperty('7413');
    } finally {
      await rm(fixtures, { recursive: true, force: true });
    }
  });

  it('builds a complete data directory from captured SEPTA responses', async () => {
    const { ok, summary } = await collect({
      dataDir: dir,
      fixturesDir: FIXTURES,
      now: NOW,
      log: () => {},
    });
    expect(ok).toBe(true);
    expect(summary.sources.alerts.skipped).toMatchObject({ 'long-term-detour': 3 });
    const recent = JSON.parse(await readFile(join(dir, 'alerts-recent.json'), 'utf8'));
    const ids = recent.incidents.map((i) => i.id);
    expect(ids).toEqual(
      expect.arrayContaining(['alert-190001', 'alert-190001-bus', 'detour-d90001']),
    );
    expect(ids).toContain('delay-2026-10-05-9233');
    expect(ids).toContain('cancel-2026-10-05-3285');
    expect(ids).not.toContain('alert-25981'); // waiting room — amenity notice
    const live = recent.incidents.find((i) => i.id === 'alert-190001');
    expect(live.official_alert.scope).toMatchObject({
      from_station: 'Drexel Station at 30th St',
      to_station: '15th St/City Hall',
    });
    const detour = recent.incidents.filter((i) => i.id.startsWith('detour-d90001'));
    expect(detour.map((i) => i.mode).sort()).toEqual(['bus', 'metro']);
    const access = JSON.parse(await readFile(join(dir, 'accessibility.json'), 'utf8'));
    expect(access.outages.filter((o) => o.lifecycle.active)).toHaveLength(6);
    // Bus and Metro trip cancellations, placed with the fixture schedule.
    const cancels = recent.incidents.find((i) => i.id === 'trip-cancellations-2026-10-05-17');
    expect(cancels.detections[0].description).toBe(
      '3 Route 17 trips cancelled — 6:40 PM, 8:20 PM, 9:10 PM (3 of 30 scheduled)',
    );
    expect(ids).toContain('trip-cancellations-2026-10-05-t1');
    // The MFL's cars on the vehicle feed: two trains of two cars, and one in the yard. The
    // fixture schedule has no L1 trips, so neither is on one.
    expect(summary.sources.vehiclePositions).toMatchObject({
      cars: 5,
      offLine: 1,
      trains: 2,
      matched: 0,
    });
    // A late Route 17 bus opens a gap candidate (confirmed on the next tick).
    expect(summary.sources.transitView).toMatchObject({
      vehicles: 10, // TransitView's 8, and the two L1 trains
      dropped: { offRoute: 0, jump: 0 },
      conditions: 1,
    });
    const state = JSON.parse(await readFile(join(dir, '_collector-state.json'), 'utf8'));
    expect(Object.keys(state.candidates)).toEqual(['gap|bus|17|0']);
    // Everything is new on the first run.
    expect(summary.changed).toBe(summary.incidents + access.outages.length);
  });

  it('reports no rider-visible changes when the feeds are unchanged', async () => {
    const opts = { dataDir: dir, fixturesDir: FIXTURES, log: () => {} };
    await collect({ ...opts, now: NOW });
    const { summary } = await collect({ ...opts, now: NOW + 10 * 60_000 });
    expect(summary.changed).toBe(0);
  });
});
