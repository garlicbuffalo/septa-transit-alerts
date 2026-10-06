// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { decodeTripUpdates, encodeTripUpdates } from '../lib/gtfsRealtime.js';
import { applyOfficialAlerts } from '../lib/officialAlerts.js';
import { buildScheduleIndex, gtfsSeconds, Schedule } from '../lib/schedule.js';
import { easternToEpoch } from '../lib/time.js';
import { advanceTripCancellations, applyTripCancellations } from '../lib/tripCancellations.js';
import {
  applyVehicleConditions,
  DETECTOR_CONFIG,
  findConditions,
  nearestStation,
} from '../lib/vehicleDetectors.js';
import { normalizeTransitView } from '../lib/vehicles.js';

const MIN = 60 * 1000;
const TICK = 10 * MIN;
// Tuesday, October 6, 2026, 10:30 AM in Philadelphia.
const NOW = easternToEpoch(2026, 10, 6, 10, 30);
const at = (h, m) => h * 3600 + m * 60;

// A schedule index built directly (the shape buildScheduleIndex produces).
// `trips` entries: [tripId, route, dir, startSec, endSec, origin?, dest?, lastSeq?]
function schedule(
  trips,
  { service = { days: '1111111', start: '20260101', end: '20271231' } } = {},
) {
  const stops = ['Origin A', 'Terminal B', 'Origin C'];
  const index = {
    version: 1,
    built_at: NOW,
    feed_version: 'test',
    services: { all: { add: [], remove: [], ...service } },
    stops,
    trips: Object.fromEntries(
      trips.map(([id, route, dir, start, end, origin = 0, dest = 1, last = 40]) => [
        id,
        [route, dir, 'all', start, end, origin, dest, last],
      ]),
    ),
  };
  return Schedule.from(index);
}

// A TransitViewAll payload from a list of vehicles.
function transitView(vehicles) {
  const routes = {};
  for (const v of vehicles) {
    if (!routes[v.route]) routes[v.route] = [];
    routes[v.route].push({
      lat: String(v.lat),
      lng: String(v.lon),
      label: v.id,
      VehicleID: v.id,
      route_id: v.route,
      trip: v.trip,
      Direction: v.direction ?? 'Southbound',
      destination: v.destination ?? 'Terminal B',
      late: v.late ?? 0,
      next_stop_sequence: v.seq ?? 20,
      next_stop_name: v.stopName ?? null,
      timestamp: Math.floor((v.ts ?? NOW) / 1000),
    });
  }
  return { routes: [routes] };
}

function tick({ vehicles, sched, cancelled = new Set(), state, incidents, now }) {
  const { vehicles: list } = normalizeTransitView(transitView(vehicles), now);
  const { conditions } = findConditions({
    vehicles: list,
    schedule: sched,
    cancelledTripIds: cancelled,
    state,
    now,
  });
  return { conditions, ...applyVehicleConditions(incidents, conditions, state, now) };
}

describe('schedule index', () => {
  const files = {
    'trips.txt':
      'route_id,service_id,trip_id,trip_headsign,direction_id\n17,wk,t1,20th-Johnston,1\n17,wk,t2,20th-Johnston,1\nL1 OWL,sat,t3,69th St,0\nPAO,wk,t4,Paoli,0\n',
    'stop_times.txt':
      'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nt1,10:00:00,10:00:00,a,1\nt1,10:20:00,10:20:00,m,2\nt1,10:45:00,10:45:00,b,3\nt2,25:10:00,25:10:00,a,1\nt2,25:50:00,25:50:00,b,2\nt3,23:30:00,23:30:00,a,1\nt3,24:15:00,24:15:00,b,2\n',
    'stops.txt': 'stop_id,stop_name\na,Front-Market\nm,Midway\nb,20th-Johnston\n',
    'calendar.txt':
      'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nwk,1,1,1,1,1,0,0,20260901,20261231\nsat,0,0,0,0,0,1,0,20260901,20261231\n',
    'calendar_dates.txt': 'service_id,date,exception_type\nwk,20261126,2\nsat,20261126,1\n',
  };
  const zip = { read: (name) => Buffer.from(files[name] ?? '') };

  it('parses GTFS clock times past midnight', () => {
    expect(gtfsSeconds('25:10:00')).toBe(25 * 3600 + 600);
    expect(gtfsSeconds('bogus')).toBeNull();
  });

  it('keeps each trip’s first and last stop, keyed by published route', () => {
    const index = buildScheduleIndex(zip, NOW);
    expect(Object.keys(index.trips).sort()).toEqual(['t1', 't2', 't3']); // no Regional Rail
    const s = Schedule.from(index);
    expect(s.trip('t1')).toMatchObject({
      route: '17',
      direction: 1,
      startSec: at(10, 0),
      endSec: at(10, 45),
      origin: 'Front-Market',
      destination: '20th-Johnston',
      lastSequence: 3,
    });
    expect(s.trip('t3').route).toBe('L1-OWL');
  });

  it('applies weekdays and calendar exceptions', () => {
    const s = Schedule.from(buildScheduleIndex(zip, NOW));
    expect(s.serviceRuns('wk', { year: 2026, month: 10, day: 6 })).toBe(true); // Tuesday
    expect(s.serviceRuns('wk', { year: 2026, month: 10, day: 10 })).toBe(false); // Saturday
    expect(s.serviceRuns('wk', { year: 2026, month: 11, day: 26 })).toBe(false); // removed
    expect(s.serviceRuns('sat', { year: 2026, month: 11, day: 26 })).toBe(true); // added
  });

  it("places after-midnight trips on the previous day's service", () => {
    const s = Schedule.from(buildScheduleIndex(zip, NOW));
    // t2 runs 1:10–1:50 AM Wednesday on Tuesday's service.
    const ts = easternToEpoch(2026, 10, 7, 1, 30);
    expect(s.activeTrips('17', 1, ts).map((t) => t.tripId)).toEqual(['t2']);
    const times = s.tripTimes('t2', ts);
    expect(times.date).toEqual({ year: 2026, month: 10, day: 6 });
    expect(times.startTs).toBe(easternToEpoch(2026, 10, 7, 1, 10));
  });

  it("places a trip listed the night before on tomorrow's service", () => {
    const s = Schedule.from(buildScheduleIndex(zip, NOW));
    // t1 runs at 10 AM; at 11 PM it's nearer tomorrow's run than today's.
    const late = easternToEpoch(2026, 10, 6, 23, 0);
    expect(s.tripTimes('t1', late).date).toEqual({ year: 2026, month: 10, day: 7 });
    expect(s.tripTimes('t1', NOW).date).toEqual({ year: 2026, month: 10, day: 6 });
  });

  it('measures scheduled spacing around a moment', () => {
    const trips = [0, 10, 20, 30, 40].map((m, i) => [`x${i}`, '17', 0, at(10, m), at(11, m)]);
    expect(schedule(trips).headwayMin('17', 0, NOW)).toBe(10);
    expect(schedule(trips.slice(0, 2)).headwayMin('17', 0, NOW)).toBeNull();
  });
});

describe('GTFS-realtime trip updates', () => {
  it('round-trips trips and their schedule relationship', () => {
    const buf = encodeTripUpdates({
      timestamp: NOW,
      trips: [
        { tripId: '869298', routeId: '16', directionId: 0, relationship: 'CANCELED' },
        { tripId: '993345', routeId: '17', directionId: 1 },
      ],
    });
    const feed = decodeTripUpdates(buf);
    expect(feed.timestamp).toBe(Math.floor(NOW / 1000) * 1000);
    expect(feed.trips).toEqual([
      {
        tripId: '869298',
        routeId: '16',
        directionId: 0,
        startDate: null,
        relationship: 'CANCELED',
      },
      {
        tripId: '993345',
        routeId: '17',
        directionId: 1,
        startDate: null,
        relationship: 'SCHEDULED',
      },
    ]);
  });

  it('rejects a truncated message', () => {
    const buf = encodeTripUpdates({ trips: [{ tripId: '1', relationship: 'CANCELED' }] });
    expect(() => decodeTripUpdates(buf.subarray(0, buf.length - 3))).toThrow();
  });
});

describe('normalizeTransitView', () => {
  it('keeps fresh GPS reports and drops placeholders, stale reports, and sentinels', () => {
    const payload = {
      routes: [
        {
          17: [
            {
              VehicleID: '7480',
              lat: '39.91',
              lng: '-75.17',
              trip: '1',
              late: 3,
              timestamp: NOW / 1000,
            },
            {
              VehicleID: '7481',
              lat: '39.92',
              lng: '-75.17',
              trip: '2',
              late: 999,
              timestamp: NOW / 1000,
            },
            {
              VehicleID: '7482',
              lat: '39.93',
              lng: '-75.17',
              trip: '3',
              late: 0,
              timestamp: (NOW - 20 * MIN) / 1000,
            },
          ],
          L1: [
            {
              VehicleID: 'block_70001_schedBasedVehicle',
              lat: '39.952187',
              lng: '-75.15995',
              trip: '4',
              timestamp: NOW / 1000,
            },
            { VehicleID: 'None', lat: '39.95', lng: '-75.15', trip: '5', timestamp: 63240 },
          ],
          L1_OWL: [
            {
              VehicleID: '3001',
              lat: '39.96',
              lng: '-75.2',
              trip: '6',
              late: 1,
              timestamp: NOW / 1000,
            },
          ],
          T1: [
            { VehicleID: '9001', lat: '39.95', lng: '-75.19', trip: '7', timestamp: NOW / 1000 },
          ],
        },
      ],
    };
    const { vehicles, placeholders, stale } = normalizeTransitView(payload, NOW);
    expect(placeholders).toBe(2);
    expect(stale).toBe(1);
    expect(vehicles.map((v) => [v.id, v.mode, v.route, v.lateMin])).toEqual([
      ['7480', 'bus', '17', 3],
      ['7481', 'bus', '17', null],
      ['3001', 'bus', 'L1-OWL', 1],
      ['9001', 'metro', 't1', null],
    ]);
  });

  it('rejects a payload without routes', () => {
    expect(() => normalizeTransitView({}, NOW)).toThrow();
  });
});

describe('applyTripCancellations', () => {
  const sched = schedule([
    ['c1', '16', 0, at(6, 0), at(6, 50)],
    ['c2', '16', 1, at(12, 0), at(12, 50)],
    ['c3', '16', 0, at(18, 0), at(18, 50)],
    ['ok', '16', 0, at(7, 0), at(7, 50)],
    ['t9', 't1', 0, at(11, 0), at(11, 40)],
  ]);
  const feed = (ids) => ({ trips: ids.map((tripId) => ({ tripId, relationship: 'CANCELED' })) });

  it("groups a day's cancelled trips into one incident per route", () => {
    const incidents = new Map();
    const { stats } = applyTripCancellations(
      incidents,
      feed(['c1', 'c2', 'c3', 't9', 'gone']),
      sched,
      NOW,
    );
    expect(stats).toMatchObject({ cancelled: 4, unmatched: 1, routes: 2 });
    const bus = incidents.get('trip-cancellations-2026-10-06-16');
    expect(bus).toMatchObject({ mode: 'bus', routes: ['16'], sources: ['bot'] });
    expect(bus.lifecycle.active).toBe(true);
    const det = bus.detections[0];
    expect(det.source).toBe('trip-cancellations');
    expect(det.description).toBe(
      '3 Route 16 trips cancelled — 6:00 AM, 12:00 PM, 6:00 PM (3 of 4 scheduled)',
    );
    expect(det.evidence.details).toMatchObject({ cancelled: 3, scheduled: 4 });
    expect(det.evidence.bullets).toEqual(['3 of 4 scheduled trips cancelled']);
    const metro = incidents.get('trip-cancellations-2026-10-06-t1');
    expect(metro.mode).toBe('metro');
    expect(metro.detections[0].description).toMatch(/^1 T1 trolley trip cancelled/);
  });

  it('drops reinstated trips but keeps ones that already passed', () => {
    const incidents = new Map();
    applyTripCancellations(incidents, feed(['c1', 'c2', 'c3']), sched, NOW);
    // c1 (6 AM, past) and c3 (6 PM, future) leave the feed.
    applyTripCancellations(incidents, feed(['c2', 'ok']), sched, NOW + TICK);
    const det = incidents.get('trip-cancellations-2026-10-06-16').detections[0];
    expect(det.evidence.details.trips.map((t) => t.trip_id)).toEqual(['c1', 'ok', 'c2']);
    expect(det.evidence.updates.at(-1).description).toBe(
      '1 more cancelled, 1 reinstated (3 total)',
    );
  });

  it('resolves once the last cancelled trip has run its course', () => {
    const incidents = new Map();
    applyTripCancellations(incidents, feed(['c2']), sched, NOW);
    expect(advanceTripCancellations(incidents, NOW + MIN).size).toBe(0);
    const later = easternToEpoch(2026, 10, 6, 13, 0);
    expect(advanceTripCancellations(incidents, later).size).toBe(1);
    const inc = incidents.get('trip-cancellations-2026-10-06-16');
    expect(inc.lifecycle).toMatchObject({
      active: false,
      resolved_ts: easternToEpoch(2026, 10, 6, 12, 50),
    });
  });
});

describe('vehicle detectors', () => {
  // Route 17 southbound every 10 minutes all morning.
  const busTrips = Array.from({ length: 24 }, (_, i) => [
    `b${i}`,
    '17',
    0,
    at(8, 0) + i * 600,
    at(8, 0) + i * 600 + 3600,
  ]);
  const sched = schedule(busTrips);
  // The trips in progress at 10:30: b9 (9:30) … b15 (10:30).
  const running = (overrides = {}) =>
    [9, 10, 11, 12, 13, 14, 15].map((i) => ({
      id: `v${i}`,
      route: '17',
      trip: `b${i}`,
      lat: 39.9 + (15 - i) * 0.01,
      lon: -75.17,
      ...overrides[i],
    }));

  it('opens a gap after two ticks and resolves it after two clear ones', () => {
    const state = {};
    const incidents = new Map();
    // b13 is running 25 minutes late: ~35 minutes behind b12.
    const gappy = (ts) =>
      running({
        13: { late: 25, ts },
        9: { ts },
        10: { ts },
        11: { ts },
        12: { ts },
        14: { ts },
        15: { ts },
      });
    let r = tick({ vehicles: gappy(NOW), sched, state, incidents, now: NOW });
    expect([...r.conditions.keys()]).toEqual(['gap|bus|17|0']);
    expect(incidents.size).toBe(0); // first sighting is only a candidate

    r = tick({ vehicles: gappy(NOW + TICK), sched, state, incidents, now: NOW + TICK });
    expect(r.stats.opened).toBe(1);
    const [inc] = incidents.values();
    expect(inc.id).toBe('gap-2026-10-06-17-0-1040');
    expect(inc).toMatchObject({
      mode: 'bus',
      routes: ['17'],
      sources: ['bot'],
      official_alert: null,
    });
    const det = inc.detections[0];
    expect(det.source).toBe('gap');
    expect(det.lifecycle).toMatchObject({ onset_ts: NOW, first_seen_ts: NOW + TICK, active: true });
    expect(det.evidence.details).toMatchObject({ kind: 'gap', gap_min: 35, headway_min: 10 });
    expect(det.description).toBe(
      '~35 min between Route 17 buses toward Terminal B — scheduled every ~10 min',
    );
    expect(det.scope).toMatchObject({ direction: 'south', direction_label: 'toward Terminal B' });

    const calm = (ts) =>
      running(Object.fromEntries([9, 10, 11, 12, 13, 14, 15].map((i) => [i, { ts }])));
    r = tick({ vehicles: calm(NOW + 2 * TICK), sched, state, incidents, now: NOW + 2 * TICK });
    expect(incidents.get(inc.id).lifecycle.active).toBe(true); // one clear tick isn't enough
    r = tick({ vehicles: calm(NOW + 3 * TICK), sched, state, incidents, now: NOW + 3 * TICK });
    expect(r.stats.resolved).toBe(1);
    const done = incidents.get(inc.id);
    expect(done.lifecycle).toMatchObject({ active: false, resolved_ts: NOW + 2 * TICK });
    expect(done.detections[0].evidence.resolved_description).toBe(
      'Route 17 buses back to normal spacing.',
    );
  });

  it('counts cancelled trips toward a gap and skips spacing it cannot see', () => {
    const state = {};
    const vehicles = running().filter((v) => v.trip !== 'b12' && v.trip !== 'b13');
    // b12 and b13 untracked: unknown spacing, no gap.
    let r = tick({ vehicles, sched, state, incidents: new Map(), now: NOW });
    expect(r.conditions.size).toBe(0);
    // Cancelled instead: 30 minutes between b11 and b14.
    r = tick({
      vehicles,
      sched,
      cancelled: new Set(['b12', 'b13']),
      state,
      incidents: new Map(),
      now: NOW,
    });
    const gap = r.conditions.get('gap|bus|17|0');
    expect(gap.details).toMatchObject({ gap_min: 30, cancelled_between: 2 });
    expect(gap.description).toMatch(/; 2 trips in between were cancelled$/);
  });

  it('flags vehicles scheduled apart that are running together', () => {
    const vehicles = running({ 12: { lat: 39.93, late: 12 }, 13: { lat: 39.9301 } });
    const { conditions } = tick({ vehicles, sched, state: {}, incidents: new Map(), now: NOW });
    const bunch = conditions.get('bunching|bus|17|0');
    expect(bunch.details).toMatchObject({
      kind: 'bunching',
      vehicle_count: 2,
      scheduled_spacing_min: 10,
    });
    expect(bunch.description).toMatch(
      /^2 Route 17 buses toward Terminal B running together — ~11 m apart/,
    );
  });

  it('only compares bunching within a route pattern', () => {
    // b13 starts from a different stop (a short-turn), so its schedule says
    // nothing about where it should be relative to b12.
    const s = schedule(busTrips.map((t) => (t[0] === 'b13' ? [...t, 2] : t)));
    const vehicles = running({ 12: { lat: 39.93, late: 12 }, 13: { lat: 39.9301 } });
    const { conditions } = tick({ vehicles, sched: s, state: {}, incidents: new Map(), now: NOW });
    expect(conditions.has('bunching|bus|17|0')).toBe(false);
  });

  it('ignores vehicles at the ends of their trips when looking for bunching', () => {
    const vehicles = running({ 12: { lat: 39.93, seq: 2 }, 13: { lat: 39.9301, seq: 2 } });
    const { conditions } = tick({ vehicles, sched, state: {}, incidents: new Map(), now: NOW });
    expect(conditions.has('bunching|bus|17|0')).toBe(false);
  });

  it('detects vehicles held in place across ticks', () => {
    const state = {};
    const stopped = (ts) =>
      running({
        9: { ts },
        10: { ts },
        11: { ts, lat: 39.95, lon: -75.16 },
        12: { ts, lat: 39.951, lon: -75.16 },
        13: { ts },
        14: { ts },
        15: { ts },
      }).map((v) => (v.trip === 'b11' || v.trip === 'b12' ? v : { ...v, lat: v.lat + ts / 1e13 }));
    tick({ vehicles: stopped(NOW), sched, state, incidents: new Map(), now: NOW });
    const { conditions } = tick({
      vehicles: stopped(NOW + TICK),
      sched,
      state,
      incidents: new Map(),
      now: NOW + TICK,
    });
    const held = conditions.get('pulse-held|bus|17');
    expect(held.details).toMatchObject({
      kind: 'held',
      vehicle_count: 2,
      busCount: 2,
      stationaryMs: TICK,
    });
    expect(held.description).toBe('2 Route 17 buses stopped for 10+ min');
  });

  it('flags a route with far fewer vehicles on the tracker than usual', () => {
    // Twenty other trips in progress, all tracked, so the system feed is healthy.
    const others = Array.from({ length: 20 }, (_, i) => [`o${i}`, '23', 1, at(10, 0), at(11, 0)]);
    const s = schedule([...busTrips, ...others]);
    const otherVehicles = others.map(([trip], i) => ({
      id: `w${i}`,
      route: '23',
      trip,
      lat: 40 + i * 0.01,
      lon: -75.1,
      direction: 'Northbound',
    }));
    const state = { routeCoverage: { 17: 0.95, 23: 0.95 } };
    const vehicles = [...otherVehicles, ...running().filter((v) => ['b9', 'b10'].includes(v.trip))];
    const { conditions } = tick({ vehicles, sched: s, state, incidents: new Map(), now: NOW });
    const ghost = conditions.get('ghost|bus|17');
    expect(ghost.details).toMatchObject({ kind: 'ghost', scheduled: 7, tracked: 2, missing: 5 });
    expect(ghost.description).toBe(
      "Only 2 of 7 scheduled Route 17 buses showing on SEPTA's tracker",
    );
    // A route that's usually poorly tracked stays quiet.
    const quiet = { routeCoverage: { 17: 0.4, 23: 0.95 } };
    expect(
      tick({ vehicles, sched: s, state: quiet, incidents: new Map(), now: NOW }).conditions.has(
        'ghost|bus|17',
      ),
    ).toBe(false);
  });

  it('attaches to an active SEPTA alert on the route, and keeps it when the alert refreshes', () => {
    const raw = {
      alert_id: '77',
      routes: ['17'],
      type: 'ALERT',
      subject: 'Route 17 delays',
      message: '<p>Buses are delayed due to a disabled vehicle.</p>',
      status: 'NORMAL',
      cause: 'TECHNICAL_PROBLEM',
      effect: 'SIGNIFICANT_DELAYS',
      severity: 'SEVERE',
      start: null,
      end: null,
      created_at: null,
      updated_at: null,
    };
    const incidents = new Map();
    applyOfficialAlerts(incidents, [raw], NOW - TICK);
    const alertId = [...incidents.keys()][0];
    const state = {};
    const gappy = (ts) =>
      running({
        13: { late: 25, ts },
        ...Object.fromEntries([9, 10, 11, 12, 14, 15].map((i) => [i, { ts }])),
      });
    tick({ vehicles: gappy(NOW), sched, state, incidents, now: NOW });
    tick({ vehicles: gappy(NOW + TICK), sched, state, incidents, now: NOW + TICK });
    let inc = incidents.get(alertId);
    expect(incidents.size).toBe(1);
    expect(inc.sources).toEqual(['septa', 'bot']);
    expect(inc.detections.map((d) => d.source)).toEqual(['gap']);
    // The next alerts poll rebuilds the incident; the detection survives.
    applyOfficialAlerts(incidents, [raw], NOW + TICK + MIN);
    inc = incidents.get(alertId);
    expect(inc.detections).toHaveLength(1);
    expect(inc.sources).toEqual(['septa', 'bot']);
  });

  it('reports an unhealthy feed when the tracker covers under half of a busy system', () => {
    const others = Array.from({ length: 20 }, (_, i) => [`o${i}`, '23', 1, at(10, 0), at(11, 0)]);
    const s = schedule([...busTrips, ...others]);
    const { vehicles } = normalizeTransitView(transitView(running().slice(0, 3)), NOW);
    const found = findConditions({
      vehicles,
      schedule: s,
      cancelledTripIds: new Set(),
      state: {},
      now: NOW,
    });
    expect(found.stats).toMatchObject({ scheduled: 27, tracked: 3, feedHealthy: false });
  });

  it('exposes the thresholds it runs with', () => {
    expect(DETECTOR_CONFIG.confirmTicks).toBe(2);
    expect(DETECTOR_CONFIG.gap).toEqual({ minMin: 20, factor: 2 });
  });

  it('names the nearest Metro station within reach', () => {
    expect(nearestStation('t1', { lat: 39.95478, lon: -75.18952 })?.name).toBe('33rd St');
    expect(nearestStation('t1', { lat: 40.2, lon: -75.5 })).toBeNull();
  });
});
