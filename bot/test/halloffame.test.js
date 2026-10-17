import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  cancelledTrips,
  composeList,
  FAME,
  pickEnds,
  postHallOfFame,
  railStandings,
  rollupRouteDays,
  scoreEntries,
  speedStandings,
  standout,
  transitStandings,
  WEIGHTS,
  weightsText,
} from '../features/halloffame.js';
import { recordTrains } from '../features/rail.js';
import { MPH_PER_MPS } from '../features/speedmaps.js';
import { keyStart } from '../lib/clock.js';
import { getMeta } from '../lib/db.js';
import { graphemeLength } from '../lib/text.js';
import { testPoster } from './helpers.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
// Sunday, Oct 11, 2026, 12:05 PM in Philadelphia: the week is Oct 4–10.
const SUNDAY = Date.UTC(2026, 9, 11, 16, 5);
const WEEK = Array.from({ length: 7 }, (_, i) => `2026-10-${String(4 + i).padStart(2, '0')}`);
const WINDOW = { fromKey: '2026-10-04', toKey: '2026-10-10' };
const LABEL = 'Oct 4 – Oct 10';

/** A day's tally for a route moving at `mph`, over `readings` one-minute readings. */
function tally(db, { day, mode = 'bus', route, mph, readings = 100, dir = '0', bin = 0 }) {
  const dt = readings * MIN;
  db.prepare(
    'INSERT INTO speed_bins (day, mode, route, dir, bin, dist, dt, n) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(day, mode, route, dir, bin, (mph / MPH_PER_MPS) * (dt / 1000), dt, readings);
}

/** Every day of the week for each route, from the slowest at 5 mph up in 1 mph steps. */
function seedSpeeds(db, routes, { mode = 'bus', days = WEEK } = {}) {
  routes.forEach((route, i) => {
    for (const day of days) tally(db, { day, mode, route, mph: 5 + i });
  });
}

/** A route's on-time tally for each day of the week: `pct` of 100 timed reports. */
function seedOnTime(db, route, pct, { mode = 'bus', days = WEEK } = {}) {
  for (const day of days) {
    db.prepare(
      'INSERT INTO route_days (day, mode, route, timed, on_time) VALUES (?, ?, ?, 100, ?)',
    ).run(day, mode, route, pct);
  }
}

let seq = 0;
/** `n` detections of a kind on a route, on a day of the week. */
function detect(db, { source, route, n, mode = 'bus', day = WEEK[2] }) {
  for (let i = 0; i < n; i++) {
    db.prepare(
      'INSERT INTO detection_events (subject, source, mode, route, ts) VALUES (?, ?, ?, ?, ?)',
    ).run(`${source}-${++seq}`, source, mode, route, keyStart(day) + 9 * HOUR + i * MIN);
  }
}

/** A trip-cancellation incident in the collector's shape. */
const cancellation = (route, day, cancelled, mode = 'bus') => [
  `trip-cancellations-${day}-${route}`,
  {
    id: `trip-cancellations-${day}-${route}`,
    mode,
    routes: [route],
    detections: [{ evidence: { details: { service_date: day, cancelled, scheduled: 200 } } }],
  },
];

const BUS_ROUTES = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];

/**
 * The bus week the thread tests use: route n runs at 4 + n mph and is on time
 * 50 + 4n% of the time, so the higher the number the better, except Route 12,
 * the fastest and most on time, which bunched, gapped and lost trips all week.
 */
function seedBusWeek(db) {
  seedSpeeds(db, BUS_ROUTES);
  BUS_ROUTES.forEach((route, i) => {
    seedOnTime(db, route, 50 + 4 * (i + 1));
  });
  detect(db, { source: 'bunching', route: '12', n: 20 });
  detect(db, { source: 'gap', route: '12', n: 10 });
  return new Map([cancellation('12', WEEK[3], 30)]);
}

const entry = (route, value) => ({ route, value });

describe('the daily on-time tally', () => {
  const obs = (db, ts, { mode = 'bus', route = '23', late = 0, vehicle = 'v1' } = {}) =>
    db
      .prepare(
        'INSERT INTO observations (ts, mode, route, vehicle_id, lat, lon, late_min) VALUES (?, ?, ?, ?, 39.95, -75.16, ?)',
      )
      .run(ts, mode, route, vehicle, late);
  const day = (key) => keyStart(key);

  it('tallies each finished day once, and skips one the observations only partly cover', () => {
    const { db } = testPoster();
    // Oct 5 from noon only: the bot started then (or the morning's been pruned).
    obs(db, day('2026-10-05') + 12 * HOUR);
    // Oct 6: Route 23 on time at 0, 5, and 1 early; late at 6; early at 2; once without
    // SEPTA's lateness. One T1 report, 3 late. A train, which isn't tallied here.
    [0, 5, 6, -1, -2, null].forEach((late, i) => {
      obs(db, day('2026-10-06') + (1 + 4 * i) * HOUR, { late });
    });
    obs(db, day('2026-10-06') + 8 * HOUR, { mode: 'metro', route: 't1', late: 3 });
    obs(db, day('2026-10-06') + 8 * HOUR, { mode: 'regional_rail', route: 'tre', late: 1 });
    // Oct 7, still under way.
    obs(db, day('2026-10-07') + HOUR, { late: 30 });
    const rows = () => db.prepare('SELECT * FROM route_days ORDER BY day, mode, route').all();

    expect(rollupRouteDays(db, day('2026-10-07') + 2 * HOUR)).toEqual({ days: 1 });
    expect(rows()).toEqual([
      { day: '2026-10-06', mode: 'bus', route: '23', timed: 5, on_time: 3 },
      { day: '2026-10-06', mode: 'metro', route: 't1', timed: 1, on_time: 1 },
    ]);
    expect(getMeta(db, 'route_days_through')).toBe('2026-10-06');
    // Run again within the day: nothing new.
    expect(rollupRouteDays(db, day('2026-10-07') + 3 * HOUR)).toEqual({ days: 0 });
    // Once Oct 7 is over, it's tallied too.
    expect(rollupRouteDays(db, day('2026-10-08') + HOUR)).toEqual({ days: 1 });
    expect(rows().at(-1)).toEqual({
      day: '2026-10-07',
      mode: 'bus',
      route: '23',
      timed: 1,
      on_time: 0,
    });
  });

  it('does nothing before there are observations', () => {
    const { db } = testPoster();
    expect(rollupRouteDays(db, SUNDAY)).toEqual({ days: 0 });
  });
});

describe('scoring', () => {
  const weights = { onTime: 30, cancelled: 20, speed: 20, bunching: 15, gaps: 15 };
  const route = (r, measures) => ({ route: r, measures });

  it('ranks each measure from 0 to 1 and weighs the ranks into a score out of 100', () => {
    const scored = scoreEntries(
      [
        route('a', { onTime: 90, cancelled: 0, speed: 8, bunching: 0, gaps: 0 }),
        route('b', { onTime: 80, cancelled: 1, speed: 12, bunching: 2, gaps: 1 }),
        route('c', { onTime: 70, cancelled: 2, speed: 10, bunching: 1, gaps: 2 }),
      ],
      weights,
    );
    expect(scored.map((e) => e.parts)).toEqual([
      { onTime: 1, cancelled: 1, speed: 0, bunching: 1, gaps: 1 },
      { onTime: 0.5, cancelled: 0.5, speed: 1, bunching: 0, gaps: 0.5 },
      { onTime: 0, cancelled: 0, speed: 0.5, bunching: 0.5, gaps: 0 },
    ]);
    expect(scored.map((e) => e.value)).toEqual([80, 52.5, 17.5]);
  });

  it('shares a rank between ties: routes that never bunched are all middling on bunching', () => {
    const scored = scoreEntries(
      [
        route('a', { bunching: 0 }),
        route('b', { bunching: 0 }),
        route('c', { bunching: 0 }),
        route('d', { bunching: 3 }),
      ],
      { bunching: 1 },
    );
    expect(scored.map((e) => e.parts.bunching)).toEqual([2 / 3, 2 / 3, 2 / 3, 0]);
  });

  it('scores a route missing a measure on the rest, if they carry enough of the weight', () => {
    const scored = scoreEntries(
      [
        route('a', { onTime: null, cancelled: 0, speed: 10, bunching: 0, gaps: 0 }),
        route('b', { onTime: 50, cancelled: 1, speed: 5, bunching: 1, gaps: 1 }),
        // Speed alone is 20% of the weight: not enough to rank on.
        route('c', { onTime: null, cancelled: null, speed: 7, bunching: null, gaps: null }),
      ],
      weights,
    );
    expect(scored.map((e) => e.route)).toEqual(['a', 'b']);
    // Ahead on everything it has: 100, whatever its on-time running.
    expect(scored[0].value).toBe(100);
    expect(scored[0].parts.onTime).toBeUndefined();
    // Alone with an on-time share, b ranks in the middle on it.
    expect(scored[1].parts.onTime).toBe(0.5);
    expect(FAME.minWeight).toBeGreaterThan(0.2);
  });

  it('names the measure a route stood out on, only from the right half', () => {
    const e = { parts: { onTime: 0.9, cancelled: 0.9, speed: 0.1, bunching: 0.5, gaps: 0.3 } };
    // A tie goes to the weightier measure.
    expect(standout(e, weights, 'fame')).toBe('onTime');
    expect(standout(e, weights, 'shame')).toBe('speed');
    // Middling at worst: nothing to shame it for.
    expect(standout({ parts: { onTime: 0.5, speed: 0.8 } }, weights, 'shame')).toBe(null);
  });

  it('describes its weights, which add up to the whole score', () => {
    expect(weightsText('bus')).toBe(
      'on time 30%, cancellations 20%, speed 20%, bunching 15%, gaps 15%',
    );
    expect(weightsText('rail')).toBe('on time 35%, cancellations 25%, delays 20%, speed 20%');
    for (const w of Object.values(WEIGHTS)) {
      expect(Object.values(w).reduce((a, b) => a + b, 0)).toBe(100);
    }
  });
});

describe('pickEnds', () => {
  it('takes the best and worst five, each in rank order, when there are ten or more', () => {
    const entries = Array.from({ length: 13 }, (_, i) => entry(`r${i}`, i * 2));
    const { best, worst } = pickEnds(entries);
    expect(best.map((e) => e.route)).toEqual(['r12', 'r11', 'r10', 'r9', 'r8']);
    expect(worst.map((e) => e.route)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4']);
  });

  it('splits fewer evenly so no route is in both lists', () => {
    const nine = pickEnds(Array.from({ length: 9 }, (_, i) => entry(`r${i}`, i)));
    expect(nine.best.map((e) => e.route)).toEqual(['r8', 'r7', 'r6', 'r5']);
    expect(nine.worst.map((e) => e.route)).toEqual(['r0', 'r1', 'r2', 'r3']);
    const six = pickEnds(Array.from({ length: 6 }, (_, i) => entry(`r${i}`, i)));
    expect(six.best).toHaveLength(3);
    expect(six.worst).toHaveLength(3);
    expect(new Set([...six.best, ...six.worst]).size).toBe(6);
  });

  it('breaks ties by route name, so a rerun lists the same routes', () => {
    const { best } = pickEnds([entry('b', 10), entry('c', 10), entry('a', 10), entry('d', 1)]);
    expect(best.map((e) => e.route)).toEqual(['a', 'b']);
  });
});

describe('speed standings', () => {
  it('averages a route’s distance over its time across the week’s directions and days', () => {
    const { db } = testPoster();
    // Equal time in each tally, so the route's speed is the mean of 10, 20, 30, and 10 mph.
    tally(db, { day: WEEK[0], route: '23', mph: 10, readings: 100, dir: '0' });
    tally(db, { day: WEEK[1], route: '23', mph: 20, readings: 100, dir: '1' });
    tally(db, { day: WEEK[2], route: '23', mph: 30, readings: 100, dir: '1', bin: 3 });
    tally(db, { day: WEEK[3], route: '23', mph: 10, readings: 100, dir: '0', bin: 3 });
    const { entries, days } = speedStandings(db, { mode: 'bus', ...WINDOW });
    expect(days).toBe(4);
    expect(entries).toHaveLength(1);
    expect(entries[0].route).toBe('23');
    expect(entries[0].value).toBeCloseTo(17.5, 5);
    expect(entries[0].readings).toBe(400);
  });

  it('counts only the week asked for, and only the mode asked for', () => {
    const { db } = testPoster();
    seedSpeeds(db, ['23']);
    // Fast days either side of the week, and a Metro line with the same id.
    tally(db, { day: '2026-10-03', route: '23', mph: 60 });
    tally(db, { day: '2026-10-11', route: '23', mph: 60 });
    tally(db, { day: WEEK[0], mode: 'metro', route: 't1', mph: 40 });
    const bus = speedStandings(db, { mode: 'bus', ...WINDOW });
    expect(bus.entries.map((e) => [e.route, Math.round(e.value)])).toEqual([['23', 5]]);
    expect(bus.days).toBe(7);
  });

  it('leaves out routes with too few readings or days, and unknown Metro lines', () => {
    const { db } = testPoster();
    seedSpeeds(db, ['1']);
    // Plenty of days, too few readings.
    for (const day of WEEK) tally(db, { day, route: 'thin', mph: 9, readings: 10 });
    // Plenty of readings, too few days.
    for (const day of WEEK.slice(0, FAME.minRouteDays - 1))
      tally(db, { day, route: 'brief', mph: 9, readings: 1000 });
    for (const day of WEEK) tally(db, { day, mode: 'metro', route: 'zz', mph: 9 });
    expect(speedStandings(db, { mode: 'bus', ...WINDOW }).entries.map((e) => e.route)).toEqual([
      '1',
    ]);
    expect(speedStandings(db, { mode: 'metro', ...WINDOW }).entries).toEqual([]);
  });
});

describe('bus and Metro standings', () => {
  it('gathers the week’s on-time share, cancellations, bunching and gaps for each route', () => {
    const { db } = testPoster();
    // Route 23 has twice Route 9's readings (1,000 a day to 500), so twice the chances.
    for (const day of WEEK) {
      tally(db, { day, route: '23', mph: 8, readings: 1000 });
      tally(db, { day, route: '9', mph: 11, readings: 500 });
    }
    seedOnTime(db, '23', 70);
    // A day outside the week doesn't count.
    seedOnTime(db, '23', 0, { days: ['2026-10-11'] });
    detect(db, { source: 'bunching', route: '23', n: 14 });
    detect(db, { source: 'bunching', route: '9', n: 7 });
    detect(db, { source: 'gap', route: '9', n: 2 });
    detect(db, { source: 'gap', route: '9', n: 5, day: '2026-10-11' });
    detect(db, { source: 'bunching', route: '23', n: 3, mode: 'metro' });
    const incidents = new Map([
      cancellation('23', WEEK[0], 4),
      cancellation('23', WEEK[6], 3),
      cancellation('23', '2026-10-03', 50),
      cancellation('t1', WEEK[0], 9, 'metro'),
    ]);
    const { days, entries } = transitStandings(db, incidents, { mode: 'bus', ...WINDOW });
    expect(days).toBe(7);
    const r23 = entries.find((e) => e.route === '23');
    const r9 = entries.find((e) => e.route === '9');
    // Rates per 1,000 readings.
    expect(r23.counts).toEqual({ cancelled: 7, bunching: 14, gaps: 0 });
    expect(r23.measures).toMatchObject({ onTime: 70, cancelled: 1, bunching: 2, gaps: 0 });
    expect(r23.measures.speed).toBeCloseTo(8, 5);
    // Half the bunches on half the service: the same rate.
    expect(r9.counts).toEqual({ cancelled: 0, bunching: 7, gaps: 2 });
    expect(r9.measures.bunching).toBeCloseTo(r23.measures.bunching, 9);
    // No on-time tally: no on-time share.
    expect(r9.measures.onTime).toBe(null);
  });

  it('needs enough timed reports for an on-time share', () => {
    const { db } = testPoster();
    seedSpeeds(db, ['23']);
    db.prepare(
      "INSERT INTO route_days (day, mode, route, timed, on_time) VALUES (?, 'bus', '23', ?, ?)",
    ).run(WEEK[0], FAME.minTimed - 1, 10);
    const [r] = transitStandings(db, new Map(), { mode: 'bus', ...WINDOW }).entries;
    expect(r.measures.onTime).toBe(null);
  });

  it('counts cancelled trips by service day, mode and route', () => {
    const incidents = new Map([
      cancellation('23', WEEK[0], 4),
      cancellation('23', WEEK[1], 2),
      cancellation('9', WEEK[6], 1),
      cancellation('9', '2026-10-11', 8),
      cancellation('g1', WEEK[2], 5, 'metro'),
      ['alert-1', { id: 'alert-1', mode: 'bus', routes: ['23'], detections: [] }],
    ]);
    expect(cancelledTrips(incidents, { mode: 'bus', ...WINDOW })).toEqual(
      new Map([
        ['23', 6],
        ['9', 1],
      ]),
    );
  });
});

describe('Regional Rail standings', () => {
  it('takes on time and delays from the trains that ran, and cancellations from all of them', () => {
    const { db } = testPoster();
    // 40 Trenton trains: 30 on time (2 or 5 min late), 6 late (6 or 20 min), 4 cancelled.
    const trains = Array.from({ length: 40 }, (_, k) => ({
      trainno: String(k),
      line: 'Trenton',
      late: k < 25 ? 2 : k < 30 ? 5 : k < 33 ? 6 : k < 36 ? 20 : 999,
    }));
    recordTrains(db, Date.UTC(2026, 9, 6, 16), trains);
    // Too few trains on a line to rank it.
    recordTrains(db, Date.UTC(2026, 9, 6, 16), [{ trainno: '900', line: 'Cynwyd', late: 0 }]);
    for (const day of WEEK.slice(0, 3))
      tally(db, { day, mode: 'regional_rail', route: 'tre', mph: 31, readings: 400 });
    const { trains: total, entries } = railStandings(db, WINDOW);
    expect(total).toBe(41);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      route: 'tre',
      counts: { cancelled: 4, trains: 40 },
      measures: {
        onTime: (100 * 30) / 36,
        cancelled: 10,
        delay: (25 * 2 + 5 * 5 + 3 * 6 + 3 * 20) / 36,
      },
    });
    expect(entries[0].measures.speed).toBeCloseTo(31, 5);
  });
});

describe('composing the lists', () => {
  const scored = (route, value, measures, parts, counts = {}) => ({
    route,
    value,
    measures,
    parts,
    counts: { cancelled: 0, bunching: 0, gaps: 0, ...counts },
  });
  const best = [
    scored(
      '14',
      91.2,
      { onTime: 93.6, cancelled: 0, speed: 13.21, bunching: 0, gaps: 0.4 },
      { onTime: 1, cancelled: 0.7, speed: 0.9, bunching: 0.7, gaps: 0.6 },
      { gaps: 1 },
    ),
    scored(
      'L1-OWL',
      84.6,
      { onTime: 80, cancelled: 0, speed: 17.4, bunching: 0, gaps: 0 },
      { onTime: 0.7, cancelled: 0.7, speed: 1, bunching: 0.7, gaps: 0.7 },
    ),
    scored(
      'K',
      80.4,
      { onTime: 85, cancelled: 0, speed: 9, bunching: 0, gaps: 0 },
      { onTime: 0.6, cancelled: 0.7, speed: 0.4, bunching: 0.9, gaps: 0.7 },
    ),
  ];
  const worst = [
    scored(
      '23',
      12.4,
      { onTime: 51.2, cancelled: 3.1, speed: 7.9, bunching: 4.2, gaps: 1.1 },
      { onTime: 0.2, cancelled: 0.1, speed: 0.3, bunching: 0, gaps: 0.2 },
      { cancelled: 18, bunching: 31, gaps: 8 },
    ),
    scored(
      '108',
      20.6,
      { onTime: null, cancelled: 6, speed: 11, bunching: 0, gaps: 0 },
      { cancelled: 0, speed: 0.6, bunching: 0.7, gaps: 0.7 },
      { cancelled: 22 },
    ),
  ];

  it('lists the best routes with their scores and what they did best', () => {
    const fame = composeList('bus', 'fame', best, { label: LABEL, ranked: 84 });
    expect(fame.text.split('\n\n')).toEqual([
      '🏆 Bus Hall of Fame · Oct 4 – Oct 10',
      [
        'Best of 84 routes, scored out of 100:',
        '1. Route 14 — 91 · 94% on time',
        '2. Route L1 OWL — 85 · 17.4 mph',
        '3. Route K — 80 · no bunching seen',
      ].join('\n'),
      'Scores weigh on-time running, cancellations, speed, bunching and gaps.',
    ]);
  });

  it('lists the worst with what they did worst', () => {
    const shame = composeList('bus', 'shame', worst, { label: LABEL, ranked: 84 });
    expect(shame.text.split('\n\n')).toEqual([
      '🐌 Bus Wall of Shame · Oct 4 – Oct 10',
      [
        'Worst of 84 routes, scored out of 100:',
        '1. Route 23 — 12 · bunched 31 times',
        '2. Route 108 — 21 · 22 trips cancelled',
      ].join('\n'),
      'Scores weigh on-time running, cancellations, speed, bunching and gaps.',
    ]);
  });

  it('shows every measure on a scorecard, the standout in bold', () => {
    const shame = composeList('bus', 'shame', worst, { label: LABEL, ranked: 84 });
    expect(shame.chart).toMatchObject({
      title: 'Worst bus routes · Oct 4 – Oct 10',
      subtitle:
        'Score out of 100: on time 30%, cancellations 20%, speed 20%, bunching 15%, gaps 15%',
      columns: ['On time', 'Cancelled', 'Mph', 'Bunches', 'Long gaps'],
    });
    expect(shame.chart.rows[0]).toEqual({
      label: 'Route 23',
      score: 12.4,
      display: '12',
      cells: [
        { text: '51%', strong: false },
        { text: '18', strong: false },
        { text: '7.9', strong: false },
        { text: '31', strong: true },
        { text: '8', strong: false },
      ],
    });
    // A measure it has no figure for.
    expect(shame.chart.rows[1].cells[0]).toEqual({ text: '–', strong: false });
    expect(shame.alt).toBe(
      'Scorecard of the 2 worst-scoring bus routes, Oct 4 – Oct 10, out of 100, weighing on time 30%, cancellations 20%, speed 20%, bunching 15%, gaps 15%: ' +
        'Route 23 12 (51% on time, 18 trips cancelled, 7.9 mph, bunched 31 times, 8 long gaps); ' +
        'Route 108 21 (22 trips cancelled, 11.0 mph, no bunching seen, no long gaps seen).',
    );
  });

  it('scores Regional Rail lines on their own measures', () => {
    const line = {
      route: 'pao',
      rail: true,
      value: 22.2,
      measures: { onTime: 71.4, cancelled: 4.2, delay: 9.36, speed: 28.1 },
      parts: { onTime: 0.1, cancelled: 0.2, delay: 0, speed: 0.6 },
      counts: { cancelled: 12, trains: 286 },
    };
    const shame = composeList('rail', 'shame', [line], { label: LABEL, ranked: 13 });
    expect(shame.text).toMatch(
      /^🐌 Regional Rail Wall of Shame · Oct 4 – Oct 10\n\nWorst of 13 lines, scored out of 100:\n1\. Paoli\/Thorndale — 22 · avg 9\.4 min late/,
    );
    expect(shame.chart.columns).toEqual(['On time', 'Cancelled', 'Avg late', 'Mph']);
    expect(shame.chart.rows[0].cells.map((c) => c.text)).toEqual([
      '71%',
      '4.2%',
      '9.4 min',
      '28.1',
    ]);
    expect(shame.chart.note).toContain('on time: up to 5 min late');
  });

  it('always fits in a post, dropping the footer and intro before it drops a route', () => {
    const lines = ['lan', 'nor', 'chw', 'che', 'wil'].map((route) => ({
      route,
      rail: true,
      value: 55.5,
      measures: { onTime: 88.8, cancelled: 1.1, delay: 10.25, speed: 30.1 },
      parts: { onTime: 0.1, cancelled: 0.9, delay: 0.1, speed: 0.9 },
      counts: { cancelled: 288, trains: 300 },
    }));
    for (const kind of ['fame', 'shame']) {
      const { text } = composeList('rail', kind, lines, { label: 'September 2026', ranked: 13 });
      expect(graphemeLength(text)).toBeLessThanOrEqual(300);
      expect(text.match(/^\d\. /gm)).toHaveLength(5);
    }
    const buses = ['L1-OWL', 'LUCY', 'C', 'XH', 'G'].map((r) => ({
      ...best[0],
      route: r,
      counts: { cancelled: 188, bunching: 188, gaps: 188 },
    }));
    for (const kind of ['fame', 'shame']) {
      const { text } = composeList('bus', kind, buses, { label: LABEL, ranked: 120 });
      expect(graphemeLength(text)).toBeLessThanOrEqual(300);
      expect(text.match(/^\d\. /gm)).toHaveLength(5);
    }
  });
});

describe('Hall of Fame and Wall of Shame threads', () => {
  it('ranks bus routes on the whole week, not speed alone, and posts the best then the worst', async () => {
    const t = testPoster();
    const incidents = seedBusWeek(t.db);
    // Fastest of all, but only outside the week.
    for (const day of ['2026-10-02', '2026-10-12']) tally(t.db, { day, route: '99', mph: 50 });
    const args = { db: t.db, poster: t.poster, account: 'bus', incidents, now: SUNDAY };
    const res = await postHallOfFame(args);
    expect(res).toMatchObject({ posted: 'week', ranked: 12, listed: 5 });
    const [fame, shame] = t.client.posts;
    expect(fame.account).toBe('bus');
    expect(fame.opts.reply).toBeUndefined();
    // Route 12 was the fastest and most on time, but bunched, gapped and lost trips all week.
    expect(fame.opts.text.split('\n\n')[1]).toBe(
      [
        'Best of 12 routes, scored out of 100:',
        '1. Route 11 — 73 · 94% on time',
        '2. Route 10 — 68 · 90% on time',
        '3. Route 9 — 64 · 86% on time',
        '4. Route 8 — 59 · 82% on time',
        '5. Route 7 — 55 · 78% on time',
      ].join('\n'),
    );
    expect(fame.opts.text).not.toContain('Route 12 ');
    expect(fame.opts.text).not.toContain('Route 99');
    expect(shame.opts.text).toContain('🐌 Bus Wall of Shame · Oct 4 – Oct 10');
    expect(shame.opts.text).toContain(
      [
        '1. Route 1 — 27 · 54% on time',
        '2. Route 2 — 32 · 58% on time',
        '3. Route 3 — 36 · 62% on time',
        '4. Route 4 — 41 · 66% on time',
        '5. Route 5 — 45 · 70% on time',
      ].join('\n'),
    );
    expect(shame.opts.reply.parent.uri).toBe(fame.uri);
    expect(shame.opts.reply.root.uri).toBe(fame.uri);
    for (const post of [fame, shame]) {
      expect(await sharp(post.opts.image.data).metadata()).toMatchObject({
        format: 'jpeg',
        width: 1200,
      });
      expect(post.opts.image.alt).toMatch(/^Scorecard of the 5 (best|worst)-scoring bus routes/);
      expect(graphemeLength(post.opts.text)).toBeLessThanOrEqual(300);
    }
    expect(res.url).toBe(t.poster.find('halloffame:bus:2026-10-10', 'shame').url);
    expect(await postHallOfFame(args)).toEqual({ skipped: 'posted' });
    expect(t.client.posts).toHaveLength(2);
    // The next Sunday is a new thread.
    seedSpeeds(t.db, BUS_ROUTES, {
      days: ['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15'],
    });
    expect(await postHallOfFame({ ...args, now: SUNDAY + 7 * 24 * HOUR })).toMatchObject({
      posted: 'week',
    });
    expect(t.client.posts).toHaveLength(4);
  });

  it('splits Metro’s handful of lines evenly, and ranks them before there’s an on-time tally', async () => {
    const t = testPoster();
    seedSpeeds(t.db, ['m1', 't1', 't2', 't3', 't4', 't5', 'g1', 'd1', 'd2'], { mode: 'metro' });
    expect(
      await postHallOfFame({ db: t.db, poster: t.poster, account: 'metro', now: SUNDAY }),
    ).toMatchObject({ ranked: 9, listed: 4 });
    const [fame, shame] = t.client.posts;
    expect(fame.opts.text).toContain('🏆 SEPTA Metro Hall of Fame');
    expect(fame.opts.text.match(/^\d\. /gm)).toHaveLength(4);
    // All else equal, speed decides.
    expect(fame.opts.text).toContain('1. D2 — 64 · 13.0 mph');
    expect(shame.opts.text.match(/^\d\. /gm)).toHaveLength(4);
    expect(shame.opts.text).toContain('1. M1 — 36 · 5.0 mph');
    expect(shame.opts.text).not.toContain('D2');
  });

  it('ranks Regional Rail lines on on-time running, cancellations, delays and speed', async () => {
    const t = testPoster();
    // Six trains a line a day; the lower down the list, the more of them late.
    const lines = [
      'Airport',
      'Chestnut Hill East',
      'Chestnut Hill West',
      'Cynwyd',
      'Fox Chase',
      'Lansdale/Doylestown',
      'Media/Wawa',
      'Manayunk/Norristown',
      'Paoli/Thorndale',
      'Trenton',
      'Warminster',
      'Wilmington/Newark',
      'West Trenton',
    ];
    for (let d = 0; d < WEEK.length; d++) {
      const trains = lines.flatMap((line, i) =>
        Array.from({ length: 6 }, (_, k) => ({
          trainno: String(100 * i + k),
          line,
          SOURCE: line,
          late: d * 6 + k < 3 * i ? 20 : 2,
        })),
      );
      recordTrains(t.db, Date.UTC(2026, 9, 4 + d, 16), trains);
    }
    expect(railStandings(t.db, WINDOW)).toMatchObject({ trains: 546 });
    expect(
      await postHallOfFame({ db: t.db, poster: t.poster, account: 'rail', now: SUNDAY }),
    ).toMatchObject({ posted: 'week', ranked: 13, listed: 5 });
    const [fame, shame] = t.client.posts;
    expect(fame.opts.text.split('\n\n')[0]).toBe('🏆 Regional Rail Hall of Fame · Oct 4 – Oct 10');
    expect(fame.opts.text).toContain('1. Airport — 84 · 100% on time');
    expect(fame.opts.text).toContain('2. Chestnut Hill East — 79 · 93% on time');
    expect(shame.opts.text).toContain('1. West Trenton — 16 · 14% on time');
    expect(shame.opts.text).toContain('2. Wilmington/Newark — 21 · 21% on time');
    expect(shame.opts.reply.parent.uri).toBe(fame.uri);
    expect(fame.opts.image.alt).toContain('Airport 84 (100% on time, no trains cancelled');
  });

  it('picks up with the reply when the thread failed after its first post', async () => {
    const t = testPoster();
    const incidents = seedBusWeek(t.db);
    const args = { db: t.db, poster: t.poster, account: 'bus', incidents, now: SUNDAY };
    const post = t.client.post;
    let calls = 0;
    t.client.post = (...a) => {
      if (++calls === 2) throw new Error('bluesky is down');
      return post(...a);
    };
    await expect(postHallOfFame(args)).rejects.toThrow('bluesky is down');
    expect(t.client.posts).toHaveLength(1);
    expect(await postHallOfFame(args)).toMatchObject({ posted: 'week' });
    expect(t.client.posts).toHaveLength(2);
    expect(t.client.posts[1].opts.reply.parent.uri).toBe(t.client.posts[0].uri);
    expect(await postHallOfFame(args)).toEqual({ skipped: 'posted' });
  });

  it('posts nothing for a week the bot hardly saw, or with too few routes to rank', async () => {
    const logs = [];
    const log = (m) => logs.push(m);
    const t = testPoster();
    const args = { db: t.db, poster: t.poster, now: SUNDAY, log };
    // Speeds on only a few days of the week.
    seedSpeeds(t.db, BUS_ROUTES, { days: WEEK.slice(0, FAME.minWindowDays - 1) });
    expect(await postHallOfFame({ ...args, account: 'bus' })).toEqual({
      skipped: 'too-little-data',
      days: FAME.minWindowDays - 1,
    });
    // A full week, but only five lines reporting.
    seedSpeeds(t.db, ['m1', 't1', 't2', 't3', 't4'], { mode: 'metro' });
    expect(await postHallOfFame({ ...args, account: 'metro' })).toEqual({
      skipped: 'too-few-routes',
      ranked: 5,
    });
    // A handful of trains on TrainView.
    recordTrains(t.db, Date.UTC(2026, 9, 6, 16), [{ trainno: '1', line: 'Trenton', late: 0 }]);
    expect(await postHallOfFame({ ...args, account: 'rail' })).toEqual({
      skipped: 'too-little-data',
      trains: 1,
    });
    expect(t.client.posts).toHaveLength(0);
    expect(logs).toHaveLength(3);
  });

  it('does nothing for an account that isn’t set up, or isn’t a mode account', async () => {
    const t = testPoster();
    seedSpeeds(t.db, BUS_ROUTES);
    expect(
      await postHallOfFame({ db: t.db, poster: t.poster, account: 'alerts', now: SUNDAY }),
    ).toBe(null);
    t.client.hasAccount = (name) => name !== 'bus';
    expect(await postHallOfFame({ db: t.db, poster: t.poster, account: 'bus', now: SUNDAY })).toBe(
      null,
    );
    expect(t.client.posts).toHaveLength(0);
  });
});
