// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeVehiclePositions, encodeVehiclePositions } from '../lib/gtfsRealtime.js';
import { buildScheduleIndex, Schedule } from '../lib/schedule.js';
import {
  assignTrips,
  SUBWAY_CONFIG,
  SubwayLine,
  scheduledPlaceAt,
  scheduledTimeAt,
  subwayLine,
  trackSubway,
} from '../lib/subwayTrains.js';
import { easternToEpoch } from '../lib/time.js';
import { applyVehicleConditions, findConditions } from '../lib/vehicleDetectors.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const MIN = 60 * 1000;

// An hour of the MFL's cars on SEPTA's vehicle feed (Saturday 2026-10-10, 11:42–12:25), with that
// hour's L1 trips and the L1's line.
const RECORDED = JSON.parse(readFileSync(join(FIXTURES, 'mfl-2026-10-10.json'), 'utf8'));
const recordedSchedule = Schedule.from(RECORDED.schedule);
const recordedLine = new SubwayLine(RECORDED.line);
const recordedFeeds = RECORDED.polls.map(([ts, cars]) => ({
  timestamp: ts * 1000,
  vehicles: cars.map(([id, lat, lon, bearing, speed, report]) => ({
    vehicleId: id,
    label: id,
    tripId: null,
    routeId: null,
    directionId: null,
    lat,
    lon,
    bearing,
    speed,
    reportTs: report * 1000,
  })),
}));
const at = (h, m, s = 0) => easternToEpoch(2026, 10, 10, h, m) + s * 1000;

/** Run the tracker over the recorded polls; `onTick(result, feed, stateBefore)` sees each one. */
function replay(onTick = () => {}, { every = 1, cfg = SUBWAY_CONFIG } = {}) {
  let state = {};
  recordedFeeds.forEach((feed, i) => {
    if (i % every) return;
    const before = state;
    const result = trackSubway(feed, {
      schedule: recordedSchedule,
      line: recordedLine,
      state,
      now: feed.timestamp,
      cfg,
    });
    state = result.state;
    onTick(result, feed, before);
  });
  return state;
}

const trainWith = (trains, car) => trains.find((t) => t.cars.includes(car));

describe('GTFS-realtime vehicle positions', () => {
  it('round-trips vehicles, with and without a trip', () => {
    const vehicles = [
      {
        vehicleId: '1011',
        lat: 39.95304,
        lon: -75.14141,
        bearing: 174.25,
        speed: 8.96,
        reportTs: 1791647086000,
      },
      {
        vehicleId: '3632',
        tripId: '841544',
        routeId: '133',
        directionId: 1,
        lat: 40.0844,
        lon: -74.9355,
        reportTs: 1791647447000,
      },
    ];
    const feed = decodeVehiclePositions(
      encodeVehiclePositions({ timestamp: 1791647449000, vehicles }),
    );
    expect(feed.timestamp).toBe(1791647449000);
    expect(feed.vehicles).toHaveLength(2);
    const [car, bus] = feed.vehicles;
    expect(car).toMatchObject({ vehicleId: '1011', label: '1011', tripId: null, routeId: null });
    expect(car.lat).toBeCloseTo(39.95304, 4);
    expect(car.bearing).toBeCloseTo(174.25, 2);
    expect(car.speed).toBeCloseTo(8.96, 2);
    expect(car.reportTs).toBe(1791647086000);
    expect(bus).toMatchObject({ tripId: '841544', routeId: '133', directionId: 1, bearing: null });
  });

  it('leaves out a vehicle without a position', () => {
    const feed = decodeVehiclePositions(
      encodeVehiclePositions({ vehicles: [{ vehicleId: '1', lat: 0, lon: 0 }] }),
    );
    expect(feed.vehicles).toEqual([]);
  });
});

describe('schedule index stop times', () => {
  const files = {
    'trips.txt':
      'route_id,service_id,trip_id,trip_headsign,direction_id\nL1,sat,m1,69th St,1\nL1,sat,m2,69th St,1\n17,sat,b1,20th-Johnston,0\n',
    'stop_times.txt':
      'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nm1,11:00:00,11:00:00,f,1\nm1,11:10:00,11:10:00,c,2\nm1,11:30:00,11:30:00,s,3\nm2,11:10:00,11:10:00,f,1\nm2,11:20:00,11:20:00,c,2\nm2,11:40:00,11:40:00,s,3\nb1,10:00:00,10:00:00,c,1\nb1,10:30:00,10:30:00,s,2\n',
    'stops.txt':
      'stop_id,stop_name,stop_lat,stop_lon\nf,Frankford Transit Center,40.02306,-75.07804\nc,15th St/City Hall,39.95239,-75.16465\ns,69th St Transit Center,39.96234,-75.25855\n',
    'calendar.txt':
      'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nsat,0,0,0,0,0,1,0,20260901,20261231\n',
  };
  const zip = { read: (name) => Buffer.from(files[name] ?? '') };

  it("keeps every stop's time for the L1's trips, and only theirs", () => {
    const s = Schedule.from(buildScheduleIndex(zip, at(9, 0)));
    expect(Object.keys(s.index.timed)).toEqual(['l1']);
    expect(s.index.timed.l1.patterns).toHaveLength(1); // both trips run the same stops
    const st = s.stopTimes('m2');
    expect(st.stops.map((x) => [x.name, x.seq])).toEqual([
      ['Frankford Transit Center', 1],
      ['15th St/City Hall', 2],
      ['69th St Transit Center', 3],
    ]);
    expect(st.stops[1]).toMatchObject({ lat: 39.95239, lon: -75.16465 });
    expect(st.secs).toEqual([11 * 3600 + 600, 11 * 3600 + 1200, 11 * 3600 + 2400]);
    expect(s.stopTimes('b1')).toBeNull();
    expect(s.timedStops('l1').map((x) => x.name)).toHaveLength(3);
  });

  it('lists the trips running at any point of a window', () => {
    const s = Schedule.from(buildScheduleIndex(zip, at(9, 0)));
    const ids = (from, to) => s.tripsBetween('l1', 1, from, to).map((t) => t.tripId);
    expect(ids(at(11, 35), at(11, 35))).toEqual(['m2']);
    expect(ids(at(11, 25), at(11, 35))).toEqual(['m1', 'm2']);
    expect(ids(at(10, 0), at(10, 30))).toEqual([]);
    const [m1] = s.tripsBetween('l1', 1, at(11, 0), at(11, 0));
    expect(m1).toMatchObject({ startTs: at(11, 0), endTs: at(11, 30), midnight: at(0, 0) });
  });
});

describe('the L1 line', () => {
  it('runs from the Frankford end, whichever way its shape is drawn', () => {
    const bundled = subwayLine(null); // the site's own copy, drawn from 69th St
    const start = bundled.pointAt(0);
    expect(start.lat).toBeCloseTo(40.023, 2); // Frankford Transit Center
    const reversed = new SubwayLine([...RECORDED.line].reverse());
    const oriented = subwayLine({ shape: () => reversed.points });
    expect(oriented.pointAt(0).lat).toBeCloseTo(start.lat, 2);
  });

  it('measures positions along it', () => {
    const p = recordedLine.project(39.96746, -75.13673); // a car on Front St at Girard
    expect(p.off).toBeLessThan(15);
    expect(p.m / 1000).toBeCloseTo(8.34, 1);
    const back = recordedLine.pointAt(p.m);
    expect(back.lat).toBeCloseTo(39.96746, 3);
  });
});

describe('tracking the MFL from the recorded feed', () => {
  it('places trains through the tunnel within ~150 m of where they come out', () => {
    // When a car that went into the tunnel next reports, where the schedule, stretched as the
    // tracker had it, put it at that moment.
    const exits = [];
    replay((result, _feed, before) => {
      for (const [car, was] of Object.entries(before.cars ?? {})) {
        const now = result.state.cars[car];
        if (!was.dark || now?.dark || !(now?.reportTs > was.dark.t0)) continue;
        const [tripId, startTs] = was.dark.tripKey.split('|');
        const trip = recordedSchedule.trip(tripId);
        const midnight = Number(startTs) - trip.startSec * 1000;
        const st = recordedSchedule.stopTimes(tripId);
        const profile = {
          ms: st.stops.map((s) => recordedLine.project(s.lat, s.lon).m),
          ts: st.secs.map((sec) => midnight + sec * 1000),
        };
        const stretch = before.stretch?.[was.dark.dir] ?? SUBWAY_CONFIG.stretch;
        const t0 = scheduledTimeAt(profile, was.dark.m0);
        const placed = scheduledPlaceAt(profile, t0 + (now.reportTs - was.dark.t0) / stretch);
        const unstretched = scheduledPlaceAt(profile, t0 + (now.reportTs - was.dark.t0));
        exits.push({ car, err: placed - now.m, unstretched: unstretched - now.m });
      }
    });
    // Four trains (six cars) through the tunnel: 1200, 1011+1133, 1031+1032, 1020+1046 — 1133
    // only reported again at 69th St, after its partner was out.
    expect(exits.map((e) => e.car).sort()).toEqual([
      '1011',
      '1020',
      '1031',
      '1032',
      '1046',
      '1200',
    ]);
    for (const e of exits) {
      expect(Math.abs(e.err)).toBeLessThan(150);
      // The schedule alone is a station or so out.
      expect(Math.abs(e.unstretched)).toBeGreaterThan(500);
    }
  });

  it('learns how much longer than scheduled trains take through the tunnel', () => {
    const state = replay();
    expect(state.stretch[0]).toBeGreaterThan(1.08);
    expect(state.stretch[0]).toBeLessThan(1.18);
    expect(state.stretch[1]).toBeGreaterThan(1.08);
    expect(state.stretch[1]).toBeLessThan(1.18);
  });

  it('keeps placing a train after SEPTA drops its cars from the feed', () => {
    // 1011 and 1133 went in at Front St at 11:44:46; the feed stops listing them ten minutes on.
    const seen = [];
    replay((result, feed) => {
      if (feed.timestamp < at(11, 55) || feed.timestamp > at(11, 57)) return;
      const inFeed = feed.vehicles.some((v) => v.vehicleId === '1011');
      seen.push({ inFeed, train: trainWith(result.trains, '1011') });
    });
    const away = seen.filter((s) => !s.inFeed);
    expect(away.length).toBeGreaterThan(0);
    for (const { train } of away) {
      expect(train).toMatchObject({ estimated: true, directionName: 'Westbound', label: '1011' });
      const m = recordedLine.project(train.lat, train.lon).m;
      expect(m).toBeGreaterThan(14_000); // past 30th St…
      expect(m).toBeLessThan(16_300); // …and not out yet
    }
  });

  it("makes one train of a train's cars, and keeps trains laying over at 69th St apart", () => {
    const at1150 = [];
    const at1220 = [];
    replay((result, feed) => {
      if (Math.abs(feed.timestamp - at(11, 50, 29)) < 15_000) at1150.push(result.trains);
      if (Math.abs(feed.timestamp - at(12, 20, 30)) < 15_000) at1220.push(result.trains);
    });
    const [early] = at1150;
    expect(trainWith(early, '1020').cars).toEqual(['1020', '1046']);
    expect(trainWith(early, '1031').cars).toEqual(['1031', '1032']);
    const [late] = at1220;
    for (const train of late) expect(train.cars.length).toBeLessThanOrEqual(2);
    expect(trainWith(late, '1011')).not.toBe(trainWith(late, '1200'));
    expect(trainWith(late, '1011')).not.toBe(trainWith(late, '1020'));
  });

  it('matches trains to trips in the order they run', () => {
    // At 11:52:51 three westbound trains: 1016 nearly at 69th St, 1200 just out of the tunnel,
    // 1011 in it. 1016 is on the 11:11 from Frankford and 1200 on the 11:21, so 1011, though
    // nearest the 11:21's schedule, can't be on it: it would be 5½ minutes early on the 11:31,
    // further than a train is let run early, so it has no trip.
    let trains = null;
    replay((result, feed) => {
      if (Math.abs(feed.timestamp - at(11, 52, 51)) < 5000) trains = result.trains;
    });
    expect(trainWith(trains, '1016')).toMatchObject({ tripId: '980966', estimated: false });
    expect(trainWith(trains, '1200')).toMatchObject({ tripId: '980967', estimated: false });
    expect(trainWith(trains, '1011')).toMatchObject({ tripId: null, estimated: true });
    const t1200 = trainWith(trains, '1200');
    expect(Math.abs(t1200.lateMin)).toBeLessThan(1);
    expect(t1200).toMatchObject({
      mode: 'metro',
      route: 'l1',
      id: 'L1-1200',
      destination: '69th St Transit Center',
      nextStopName: '52nd St',
    });
  });

  it('works from polls ten minutes apart, as on the GitHub Actions collector', () => {
    // A car underground still shows its last fix, stamped when it was taken: no earlier poll is
    // needed to know when it went in.
    let estimated = 0;
    replay(
      (result) => {
        estimated += result.trains.filter((t) => t.estimated).length;
      },
      { every: 25 },
    );
    expect(estimated).toBeGreaterThan(0);
  });
});

describe('tracking the MFL, made-up cases', () => {
  // A day of westbound trips every 10 minutes, Frankford to 69th St in 40 minutes, along the
  // recorded line: what the recorded hour's schedule has, extended.
  const t0 = at(11, 0);
  const car = (id, m, reportTs, extra = {}) => {
    const p = recordedLine.pointAt(m);
    return {
      vehicleId: id,
      label: id,
      tripId: null,
      routeId: null,
      directionId: null,
      lat: p.lat,
      lon: p.lon,
      bearing: p.bearing,
      speed: 12,
      reportTs,
      ...extra,
    };
  };
  const east = recordedLine.project(
    SUBWAY_CONFIG.portals.east.lat,
    SUBWAY_CONFIG.portals.east.lon,
  ).m;
  const west = recordedLine.project(
    SUBWAY_CONFIG.portals.west.lat,
    SUBWAY_CONFIG.portals.west.lon,
  ).m;
  const track = (vehicles, now, state = {}) =>
    trackSubway(
      { timestamp: now, vehicles },
      { schedule: recordedSchedule, line: recordedLine, state, now },
    );

  it('leaves out cars in a yard and cars that are not M-4s', () => {
    const yard = { ...car('1063', 300, t0), lat: 40.02567, lon: -75.07738 };
    const bus = car('3632', 9000, t0);
    const { trains, stats } = track([yard, bus, car('1101', 9000, t0)], t0);
    expect(trains.map((t) => t.cars)).toEqual([['1101']]);
    expect(stats).toMatchObject({ cars: 2, offLine: 1, gps: 1 });
  });

  it('holds a train overdue out of the tunnel at the far portal, and gives up on it later', () => {
    const went = at(11, 44);
    // Heading west (up the line) and last seen just short of the Front St portal.
    const fix = car('1101', east - 100, went);
    let r = track([fix], went + 10_000);
    r = track([fix], went + 30 * 1000, r.state);
    // The scheduled run to 45th St is about 11 minutes; at 20 it's overdue.
    r = track([fix], went + 20 * MIN, r.state);
    const [train] = r.trains;
    expect(train).toMatchObject({ estimated: true, frozen: true });
    expect(recordedLine.project(train.lat, train.lon).m).toBeCloseTo(west, -1);
    // Lost at 1.6 times the stretched run.
    r = track([fix], went + 25 * MIN, r.state);
    expect(r.trains).toEqual([]);
    expect(r.stats.lost).toBe(1);
  });

  it('drops a car still dark once its partner has come out of the tunnel', () => {
    const went = at(11, 44);
    const pair = (m, ts) => [car('1101', m, ts), car('1102', m - 60, ts)];
    let r = track(pair(east - 900, went - 30_000), went - 30_000);
    r = track(pair(east - 100, went), went + 5_000, r.state);
    expect(r.state.mates['1101'].mate).toBe('1102');
    r = track(pair(east - 100, went), went + 5 * MIN, r.state);
    expect(r.trains).toHaveLength(1);
    expect(r.trains[0]).toMatchObject({ estimated: true, cars: ['1101', '1102'] });
    // 1101 reports from 46th St; 1102's fix is still the one from Front St.
    const out = went + 13 * MIN;
    r = track([car('1101', west + 300, out), car('1102', east - 160, went)], out + 5000, r.state);
    expect(r.trains).toHaveLength(1);
    expect(r.trains[0]).toMatchObject({ estimated: false, cars: ['1101'] });
  });

  it('assigns trips in order, preferring late to early', () => {
    // Trips every 10 minutes, all at the same speed along a straight 10 km.
    const trips = [0, 1, 2, 3].map((i) => ({
      key: `t${i}`,
      ms: [0, 10_000],
      ts: [t0 + i * 10 * MIN, t0 + i * 10 * MIN + 20 * MIN],
    }));
    const now = t0 + 25 * MIN;
    const where = (i, lateMin) => scheduledPlaceAt(trips[i], now - lateMin * MIN);
    // Leading train on t1 three minutes late, the next on t2 on time.
    let out = assignTrips(
      [
        { m: where(1, 3), t: now },
        { m: where(2, 0), t: now },
      ],
      trips,
    );
    expect(out.map((o) => o.trip.key)).toEqual(['t1', 't2']);
    expect(out[0].lateMs / MIN).toBeCloseTo(3, 5);
    // Two trains running together where t2 should be: the leader is t1, a headway late (how a
    // bunch forms), not t3 ten minutes early.
    out = assignTrips(
      [
        { m: where(2, 0), t: now },
        { m: where(2, 0) - 100, t: now },
      ],
      trips,
    );
    expect(out.map((o) => o.trip.key)).toEqual(['t1', 't2']);
    expect(out[0].lateMs / MIN).toBeCloseTo(10, 0);
    // With t1's train seen ahead, the second of the pair would be t3 running ten minutes early:
    // further than a train is let run early, so it has no trip.
    out = assignTrips(
      [
        { m: where(1, 0), t: now },
        { m: where(2, 0), t: now },
        { m: where(2, 0) - 100, t: now },
      ],
      trips,
    );
    expect(out.map((o) => o?.trip.key ?? null)).toEqual(['t1', 't2', null]);
    // A train halfway between two trips' schedules is the earlier one, late.
    out = assignTrips([{ m: where(2, 5), t: now }], trips);
    expect(out[0].trip.key).toBe('t2');
  });
});

describe('L1 trains in the vehicle detectors', () => {
  // Westbound L1 trips every 10 minutes from 9:00, 40 minutes end to end, 27 stops.
  const NOW = at(10, 30);
  const sec = (h, m) => h * 3600 + m * 60;
  const index = {
    version: 2,
    built_at: NOW,
    feed_version: 'test',
    services: { all: { days: '1111111', start: '20260101', end: '20271231', add: [], remove: [] } },
    stops: ['Frankford Transit Center', '69th St Transit Center'],
    trips: Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [
        `w${i}`,
        ['l1', 1, 'all', sec(9, 0) + i * 600, sec(9, 40) + i * 600, 0, 1, 27],
      ]),
    ),
  };
  const sched = Schedule.from(index);
  // w6 (10:00) … w9 (10:30) are under way.
  const train = (i, over = {}) => ({
    id: `L1-${1100 + i}`,
    label: String(1100 + i),
    mode: 'metro',
    route: 'l1',
    tripId: `w${i}`,
    directionName: 'Westbound',
    destination: '69th St Transit Center',
    lat: 39.9525,
    lon: -75.15 - (9 - i) * 0.02,
    heading: 270,
    lateMin: 0,
    nextStopSequence: 14,
    nextStopName: '13th St',
    reportTs: NOW,
    estimated: false,
    cars: [String(1100 + i)],
    ...over,
  });
  const find = (vehicles, state = {}, now = NOW) =>
    findConditions({ vehicles, schedule: sched, cancelledTripIds: new Set(), state, now });

  it('finds trains scheduled apart running together', () => {
    const vehicles = [
      train(6),
      train(7, { lat: 39.9525, lon: -75.2, lateMin: 9 }),
      train(8, { lat: 39.9526, lon: -75.2 }),
    ];
    const bunch = find(vehicles).conditions.get('bunching|metro|l1|1');
    expect(bunch.details).toMatchObject({ vehicle_count: 2, vehicles: ['1107', '1108'] });
    expect(bunch.description).toMatch(
      /^2 L1 trains toward 69th St Transit Center running together/,
    );
  });

  it('finds a gap between tracked trains, from their lateness', () => {
    const vehicles = [train(6), train(7, { lateMin: 18 })];
    const gap = find(vehicles).conditions.get('gap|metro|l1|1');
    expect(gap.details).toMatchObject({ gap_min: 28, headway_min: 10 });
  });

  it('never finds a train placed by the schedule held in place', () => {
    const held = (estimated) => {
      const state = {};
      const still = (ts) => [
        train(7, { reportTs: ts, estimated, lat: 39.9525, lon: -75.16 }),
        train(8, { reportTs: ts, estimated, lat: 39.9526, lon: -75.161 }),
      ];
      find(still(NOW - 12 * MIN), state, NOW - 12 * MIN);
      return find(still(NOW), state, NOW).conditions.has('pulse-held|metro|l1');
    };
    expect(held(false)).toBe(true);
    expect(held(true)).toBe(false);
  });

  it("leaves the L1 out of the missing-vehicle checks: most of its trains aren't tracked", () => {
    const state = {};
    find([], state);
    expect(state.routeCoverage?.l1).toBeUndefined();
  });

  it("holds the L1's detections as they are when its feed fails", () => {
    const state = {};
    const incidents = new Map();
    const vehicles = [train(6), train(7, { lateMin: 18 })];
    let t = NOW;
    for (let i = 0; i < 3; i++, t += 5 * MIN) {
      applyVehicleConditions(incidents, find(vehicles, state, t).conditions, state, t);
    }
    expect(Object.keys(state.active)).toEqual(['gap|metro|l1|1']);
    for (let i = 0; i < 3; i++, t += 5 * MIN) {
      applyVehicleConditions(incidents, new Map(), state, t, { hold: (r) => r === 'l1' });
    }
    expect(Object.keys(state.active)).toEqual(['gap|metro|l1|1']);
    for (let i = 0; i < 3; i++, t += 5 * MIN)
      applyVehicleConditions(incidents, new Map(), state, t);
    expect(Object.keys(state.active)).toEqual([]);
  });
});
