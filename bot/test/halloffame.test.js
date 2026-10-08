import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  composeList,
  FAME,
  onTimeStandings,
  pickEnds,
  postHallOfFame,
  speedStandings,
} from '../features/halloffame.js';
import { recordTrains } from '../features/rail.js';
import { MPH_PER_MPS } from '../features/speedmaps.js';
import { graphemeLength } from '../lib/text.js';
import { testPoster } from './helpers.js';

const MIN = 60_000;
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

const BUS_ROUTES = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];
const entry = (route, value) => ({ route, value });

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

describe('composing the lists', () => {
  const fastest = [
    entry('14', 17.34),
    entry('L1-OWL', 15.06),
    entry('K', 14.99),
    entry('9', 14.9),
    entry('88', 14.5),
  ];

  it('lists the fastest routes with their speeds, then the slowest', () => {
    const fame = composeList('bus', 'fame', fastest, { label: LABEL });
    expect(fame.text.split('\n\n')).toEqual([
      '🏆 Bus Hall of Fame · Oct 4 – Oct 10',
      [
        'Fastest routes by average speed:',
        '1. Route 14 — 17.3 mph',
        '2. Route L1 OWL — 15.1 mph',
        '3. Route K — 15.0 mph',
        '4. Route 9 — 14.9 mph',
        '5. Route 88 — 14.5 mph',
      ].join('\n'),
      'Average speed includes time at stops. Per SEPTA TransitView.',
    ]);
    const shame = composeList('metro', 'shame', [entry('t1', 4.2), entry('g1', 4.9)], {
      label: LABEL,
    });
    expect(shame.text.split('\n\n')).toEqual([
      '🐌 SEPTA Metro Wall of Shame · Oct 4 – Oct 10',
      'Slowest lines by average speed:\n1. T1 — 4.2 mph\n2. G1 — 4.9 mph',
      'Average speed includes time at stops. Per SEPTA TransitView.',
    ]);
  });

  it('charts the speeds from zero on a scale the whole thread can share', () => {
    const fame = composeList('bus', 'fame', fastest, { label: LABEL });
    expect(fame.chart).toMatchObject({
      title: 'Fastest bus routes · Oct 4 – Oct 10',
      max: 20,
      ticks: [0, 5, 10, 15, 20],
    });
    expect(fame.chart.rows[0]).toEqual({ label: 'Route 14', value: 17.34, display: '17.3 mph' });
    const shame = composeList('bus', 'shame', [entry('3', 4.1), entry('2', 4.4)], {
      label: LABEL,
      max: 17.34,
    });
    expect(shame.chart).toMatchObject({ max: 20, ticks: [0, 5, 10, 15, 20] });
    expect(shame.alt).toBe(
      'Bar chart of the 2 slowest bus routes, Oct 4 – Oct 10: Route 3 4.1 mph, Route 2 4.4 mph.',
    );
    // Faster ground needs a wider scale.
    const fast = composeList('metro', 'fame', [entry('m1', 31.2)], { label: LABEL });
    expect(fast.chart).toMatchObject({ max: 40, ticks: [0, 10, 20, 30, 40] });
  });

  it('ranks Regional Rail lines by on-time share, on a 0–100% chart', () => {
    const fame = composeList(
      'rail',
      'fame',
      [entry('tre', 97.32), entry('wil', 95), entry('air', 90.04)],
      { label: LABEL },
    );
    expect(fame.text.split('\n\n')).toEqual([
      '🏆 Regional Rail Hall of Fame · Oct 4 – Oct 10',
      [
        'Most on-time lines (under 15 min late, not cancelled):',
        '1. Trenton — 97.3%',
        '2. Wilmington/Newark — 95.0%',
        '3. Airport — 90.0%',
      ].join('\n'),
      "Counts every train on SEPTA's TrainView.",
    ]);
    expect(fame.chart).toMatchObject({ max: 100, ticks: [0, 25, 50, 75, 100] });
    expect(fame.chart.tickFormat(50)).toBe('50%');
    const shame = composeList('rail', 'shame', [entry('pao', 71.4)], { label: LABEL });
    expect(shame.text).toMatch(
      /^🐌 Regional Rail Wall of Shame · Oct 4 – Oct 10\n\nLeast on-time lines \(15\+ min late or cancelled\):\n1\. Paoli\/Thorndale — 71\.4%/,
    );
  });

  it('always fits in a post, dropping the footer before it drops a route', () => {
    const longest = ['lan', 'nor', 'chw', 'che', 'wil'].map((r) => entry(r, 100));
    for (const kind of ['fame', 'shame']) {
      const { text } = composeList('rail', kind, longest, { label: 'September 2026' });
      expect(graphemeLength(text)).toBeLessThanOrEqual(300);
      expect(text.match(/^\d\. /gm)).toHaveLength(5);
    }
    const buses = ['L1-OWL', 'LUCY', 'C', 'XH', 'G'].map((r) => entry(r, 12.34));
    expect(
      graphemeLength(composeList('bus', 'fame', buses, { label: LABEL }).text),
    ).toBeLessThanOrEqual(300);
  });
});

describe('Hall of Fame and Wall of Shame threads', () => {
  it('posts the five fastest bus routes, then the five slowest as a reply, once', async () => {
    const t = testPoster();
    seedSpeeds(t.db, BUS_ROUTES);
    // Fastest of all, but only outside the week.
    for (const day of ['2026-10-02', '2026-10-12']) tally(t.db, { day, route: '99', mph: 50 });
    const args = { db: t.db, poster: t.poster, account: 'bus', now: SUNDAY };
    const res = await postHallOfFame(args);
    expect(res).toMatchObject({ posted: 'week', ranked: 12, listed: 5 });
    const [fame, shame] = t.client.posts;
    expect(fame.account).toBe('bus');
    expect(fame.opts.reply).toBeUndefined();
    expect(fame.opts.text).toContain('🏆 Bus Hall of Fame · Oct 4 – Oct 10');
    expect(fame.opts.text).toContain(
      ['1. Route 12 — 16.0 mph', '2. Route 11 — 15.0 mph', '3. Route 10 — 14.0 mph'].join('\n'),
    );
    expect(fame.opts.text).toContain('5. Route 8 — 12.0 mph');
    expect(fame.opts.text).not.toContain('Route 99');
    expect(shame.opts.text).toContain('🐌 Bus Wall of Shame · Oct 4 – Oct 10');
    expect(shame.opts.text).toContain(
      [
        '1. Route 1 — 5.0 mph',
        '2. Route 2 — 6.0 mph',
        '3. Route 3 — 7.0 mph',
        '4. Route 4 — 8.0 mph',
        '5. Route 5 — 9.0 mph',
      ].join('\n'),
    );
    expect(shame.opts.reply.parent.uri).toBe(fame.uri);
    expect(shame.opts.reply.root.uri).toBe(fame.uri);
    for (const post of [fame, shame]) {
      expect(await sharp(post.opts.image.data).metadata()).toMatchObject({
        format: 'jpeg',
        width: 1200,
      });
      expect(post.opts.image.alt).toMatch(/^Bar chart of the 5 (fastest|slowest) bus routes/);
      expect(graphemeLength(post.opts.text)).toBeLessThanOrEqual(300);
    }
    expect(res.url).toBe(t.poster.find('halloffame:bus:2026-10-10', 'shame').url);
    expect(await postHallOfFame(args)).toEqual({ skipped: 'posted' });
    expect(t.client.posts).toHaveLength(2);
    // The next Sunday is a new thread.
    seedSpeeds(t.db, BUS_ROUTES, {
      days: ['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15'],
    });
    expect(await postHallOfFame({ ...args, now: SUNDAY + 7 * 24 * 60 * MIN })).toMatchObject({
      posted: 'week',
    });
    expect(t.client.posts).toHaveLength(4);
  });

  it('splits Metro’s handful of lines evenly rather than listing one twice', async () => {
    const t = testPoster();
    seedSpeeds(t.db, ['m1', 't1', 't2', 't3', 't4', 't5', 'g1', 'd1', 'd2'], { mode: 'metro' });
    expect(
      await postHallOfFame({ db: t.db, poster: t.poster, account: 'metro', now: SUNDAY }),
    ).toMatchObject({ ranked: 9, listed: 4 });
    const [fame, shame] = t.client.posts;
    expect(fame.opts.text).toContain('🏆 SEPTA Metro Hall of Fame');
    expect(fame.opts.text.match(/^\d\. /gm)).toHaveLength(4);
    expect(fame.opts.text).toContain('1. D2 — 13.0 mph');
    expect(shame.opts.text.match(/^\d\. /gm)).toHaveLength(4);
    expect(shame.opts.text).toContain('1. M1 — 5.0 mph');
    expect(shame.opts.text).not.toContain('D2');
  });

  it('ranks Regional Rail lines by the share of trains on time', async () => {
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
    expect(onTimeStandings(t.db, WINDOW)).toMatchObject({ trains: 546 });
    expect(
      await postHallOfFame({ db: t.db, poster: t.poster, account: 'rail', now: SUNDAY }),
    ).toMatchObject({ posted: 'week', ranked: 13, listed: 5 });
    const [fame, shame] = t.client.posts;
    expect(fame.opts.text.split('\n\n')).toEqual([
      '🏆 Regional Rail Hall of Fame · Oct 4 – Oct 10',
      [
        'Most on-time lines (under 15 min late, not cancelled):',
        '1. Airport — 100.0%',
        '2. Chestnut Hill East — 92.9%',
        '3. Chestnut Hill West — 85.7%',
        '4. Cynwyd — 78.6%',
        '5. Fox Chase — 71.4%',
      ].join('\n'),
      "Counts every train on SEPTA's TrainView.",
    ]);
    expect(shame.opts.text.split('\n\n')).toEqual([
      '🐌 Regional Rail Wall of Shame · Oct 4 – Oct 10',
      [
        'Least on-time lines (15+ min late or cancelled):',
        '1. West Trenton — 14.3%',
        '2. Wilmington/Newark — 21.4%',
        '3. Warminster — 28.6%',
        '4. Trenton — 35.7%',
        '5. Paoli/Thorndale — 42.9%',
      ].join('\n'),
      "Counts every train on SEPTA's TrainView.",
    ]);
    expect(shame.opts.reply.parent.uri).toBe(fame.uri);
    expect(fame.opts.image.alt).toContain('Airport 100.0%');
  });

  it('picks up with the reply when the thread failed after its first post', async () => {
    const t = testPoster();
    seedSpeeds(t.db, BUS_ROUTES);
    const args = { db: t.db, poster: t.poster, account: 'bus', now: SUNDAY };
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
