import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { easternToEpoch } from '../../collector/lib/time.js';
import {
  chronicLateTrains,
  composeLateTrains,
  lateTrainsWindow,
  minutesLabel,
  postLateTrains,
} from '../features/latetrains.js';
import {
  buildScorecards,
  ensureScorecardWeeks,
  maybePublishScorecards,
  RAIL_TRAINS_FILE,
  railTrainStats,
  SCORECARDS_FILE,
  trainWindow,
  weekScores,
} from '../features/scorecards.js';
import { MPH_PER_MPS } from '../features/speedmaps.js';
import { addDays } from '../lib/clock.js';
import { setMeta } from '../lib/db.js';
import { graphemeLength } from '../lib/text.js';
import { testPoster } from './helpers.js';

const MIN = 60_000;
// Sunday, Oct 11, 2026, 4:30 AM in Philadelphia (the service day turns over at 3): the week
// just ended is Oct 4–10.
const SUNDAY = easternToEpoch(2026, 10, 11, 4, 30);
const WEEK = Array.from({ length: 7 }, (_, i) => `2026-10-${String(4 + i).padStart(2, '0')}`);
const WINDOW = { fromKey: '2026-10-04', toKey: '2026-10-10' };
const ROUTES = ['1', '2', '3', '4', '5', '6'];

/** A week of speeds and on-time tallies: route n runs at 4 + n mph, 50 + 5n% on time. */
function seedBusWeek(db, days = WEEK) {
  ROUTES.forEach((route, i) => {
    for (const day of days) {
      const dt = 100 * MIN;
      db.prepare(
        "INSERT INTO speed_bins (day, mode, route, dir, bin, dist, dt, n) VALUES (?, 'bus', ?, '0', 0, ?, ?, 100)",
      ).run(day, route, ((5 + i) / MPH_PER_MPS) * (dt / 1000), dt);
      db.prepare(
        "INSERT INTO route_days (day, mode, route, timed, on_time) VALUES (?, 'bus', ?, 100, ?)",
      ).run(day, route, 55 + 5 * i);
    }
  });
}

/** One train on one service day in rail_trains. */
function train(
  db,
  { day, no, line = 'pao', late = 0, ran = 1, cancelled = 0, hour = 17, minute = 10 },
) {
  const [y, m, d] = day.split('-').map(Number);
  const seen = easternToEpoch(y, m, d, hour, minute);
  db.prepare(
    `INSERT INTO rail_trains (service_date, train_no, line, origin, dest, max_late, ran, cancelled, first_seen, last_seen)
     VALUES (?, ?, ?, 'Thorndale', 'Temple U', ?, ?, ?, ?, ?)`,
  ).run(day, no, line, ran ? late : null, ran, cancelled, seen, seen + 60 * MIN);
}

describe('a week of scores', () => {
  it('ranks every route with its measures, best first', () => {
    const { db } = testPoster();
    seedBusWeek(db);
    const scores = weekScores(db, new Map(), 'bus', WINDOW);
    expect(scores).toMatchObject({ from: '2026-10-04', to: '2026-10-10', ranked: 6 });
    expect(scores.entries.map((e) => e.route)).toEqual(['6', '5', '4', '3', '2', '1']);
    expect(scores.entries[0]).toMatchObject({
      rank: 1,
      measures: { onTime: 80, speed: 10, cancelled: 0, bunching: 0, gaps: 0 },
      counts: { cancelled: 0, bunching: 0, gaps: 0 },
    });
    expect(scores.entries[0].score).toBeGreaterThan(scores.entries[5].score);
  });

  it('is null when the bot saw too little of the week', () => {
    const { db } = testPoster();
    seedBusWeek(db, WEEK.slice(0, 3));
    expect(weekScores(db, new Map(), 'bus', WINDOW)).toBeNull();
    expect(weekScores(db, new Map(), 'rail', WINDOW)).toBeNull();
  });
});

describe('scoring the week just ended', () => {
  it("waits for the last day's on-time tally, then scores the week once", () => {
    const { db } = testPoster();
    seedBusWeek(db);
    setMeta(db, 'route_days_through', '2026-10-09');
    expect(ensureScorecardWeeks(db, new Map(), SUNDAY).stored).toEqual([]);
    setMeta(db, 'route_days_through', '2026-10-10');
    expect(ensureScorecardWeeks(db, new Map(), SUNDAY).stored).toEqual(['bus']);
    // Not again, even when the tallies behind it have gone.
    db.prepare('DELETE FROM speed_bins').run();
    expect(ensureScorecardWeeks(db, new Map(), SUNDAY + 60 * MIN).stored).toEqual([]);
    expect(db.prepare('SELECT week_to, account FROM scorecard_weeks').all()).toEqual([
      { week_to: '2026-10-10', account: 'bus' },
    ]);
  });

  it("keeps each route's score week by week, newest first", () => {
    const { db } = testPoster();
    const put = (weekTo, entries) =>
      db
        .prepare('INSERT INTO scorecard_weeks (week_to, account, data, ts) VALUES (?, ?, ?, 0)')
        .run(
          weekTo,
          'bus',
          JSON.stringify({
            from: addDays(weekTo, -6),
            to: weekTo,
            ranked: entries.length,
            entries,
          }),
        );
    put('2026-10-03', [
      { route: '1', rank: 1, score: 70 },
      { route: '2', rank: 2, score: 40 },
    ]);
    put('2026-10-10', [
      { route: '2', rank: 1, score: 66 },
      { route: '3', rank: 2, score: 20 },
    ]);
    const file = buildScorecards(db, SUNDAY);
    expect(file.schema_version).toBe(1);
    expect(file.weights.bus.onTime).toBe(30);
    expect(Object.keys(file.modes)).toEqual(['bus']);
    expect(file.modes.bus.weeks.map((w) => w.to)).toEqual(['2026-10-10', '2026-10-03']);
    expect(file.modes.bus.latest.entries.map((e) => e.route)).toEqual(['2', '3']);
    expect(file.modes.bus.history).toEqual({ 1: [null, 70], 2: [66, 40], 3: [20, null] });
  });
});

describe("each train's record", () => {
  it('counts the days it ran late, on time, and cancelled', () => {
    const { db } = testPoster();
    train(db, { day: '2026-10-05', no: '9531', late: 12 });
    train(db, { day: '2026-10-06', no: '9531', late: 3 });
    train(db, { day: '2026-10-07', no: '9531', ran: 0, cancelled: 1 });
    train(db, { day: '2026-10-08', no: '9531', late: 6, hour: 17, minute: 14 });
    train(db, { day: '2026-10-05', no: '418', line: 'nope', late: 0 });
    const stats = railTrainStats(db, WINDOW);
    expect(stats.days).toEqual(WEEK);
    expect(stats.trains).toEqual([
      {
        no: '9531',
        line: 'pao',
        origin: 'Thorndale',
        dest: 'Temple U',
        first_seen_min: 17 * 60 + 10,
        seen: 4,
        ran: 3,
        on_time: 1,
        late: 2,
        cancelled: 1,
        avg_late: 7,
        worst: 12,
        daily: [null, 12, 3, -1, 6, null, null],
      },
    ]);
  });

  it('covers the four weeks of service days before today', () => {
    expect(trainWindow(easternToEpoch(2026, 10, 30, 9))).toEqual({
      fromKey: '2026-10-02',
      toKey: '2026-10-29',
    });
  });
});

describe('publishing the scorecards', () => {
  it('writes both files, at most hourly', async () => {
    const { db } = testPoster();
    const dataDir = await mkdtemp(join(tmpdir(), 'septa-cards-'));
    seedBusWeek(db);
    setMeta(db, 'route_days_through', '2026-10-10');
    train(db, { day: '2026-10-08', no: '9531', late: 9 });
    const first = await maybePublishScorecards(db, { dataDir, incidents: new Map(), now: SUNDAY });
    expect(first).toEqual({ stored: ['bus'], files: 2 });
    const cards = JSON.parse(await readFile(join(dataDir, SCORECARDS_FILE), 'utf8'));
    expect(cards.modes.bus.latest.ranked).toBe(6);
    const trains = JSON.parse(await readFile(join(dataDir, RAIL_TRAINS_FILE), 'utf8'));
    expect(trains.trains.map((t) => t.no)).toEqual(['9531']);
    expect(trains.on_time_max).toBe(5);
    expect(
      await maybePublishScorecards(db, { dataDir, incidents: new Map(), now: SUNDAY + 10 * MIN }),
    ).toEqual({ skipped: 'recent' });
  });

  it('writes nothing while there is nothing to say', async () => {
    const { db } = testPoster();
    const dataDir = await mkdtemp(join(tmpdir(), 'septa-cards-'));
    expect(await maybePublishScorecards(db, { dataDir, incidents: null, now: SUNDAY })).toEqual({
      stored: [],
      files: 0,
    });
  });
});

describe('the most-often-late trains', () => {
  // Sunday, Nov 8, 2026, 11:20 AM: the four weeks are Oct 11 – Nov 7.
  const POST_TIME = easternToEpoch(2026, 11, 8, 11, 20);
  const weekdays = [];
  for (let k = '2026-10-12'; k <= '2026-11-06'; k = addDays(k, 1)) {
    if (![0, 6].includes(new Date(`${k}T12:00:00Z`).getUTCDay())) weekdays.push(k);
  }
  /** A train late on `late` of the window's 20 weekdays, by `min` minutes. */
  function seedTrain(db, no, late, min, line = 'pao') {
    weekdays.forEach((day, i) => {
      train(db, { day, no, line, late: i < late ? min : 1 });
    });
  }

  it('covers the four full weeks before this one', () => {
    expect(lateTrainsWindow(POST_TIME)).toEqual({
      fromKey: '2026-10-11',
      toKey: '2026-11-07',
      label: 'Oct 11 – Nov 7',
    });
  });

  it('ranks by the share of days late, then how late', () => {
    const { db } = testPoster();
    seedTrain(db, '9531', 16, 12);
    seedTrain(db, '418', 16, 20);
    seedTrain(db, '3819', 12, 30, 'wtr');
    seedTrain(db, '700', 4, 40);
    // Late every day, but it only ran twice.
    train(db, { day: weekdays[0], no: '9999', late: 50 });
    train(db, { day: weekdays[1], no: '9999', late: 50 });
    const trains = chronicLateTrains(railTrainStats(db, lateTrainsWindow(POST_TIME)).trains);
    expect(trains.map((t) => [t.no, t.late, t.ran])).toEqual([
      ['418', 16, 20],
      ['9531', 16, 20],
      ['3819', 12, 20],
    ]);
  });

  it('says how often and how late, within a post', () => {
    const { db } = testPoster();
    for (const [no, late] of [
      ['9531', 16],
      ['418', 15],
      ['3819', 14],
      ['4321', 13],
      ['5555', 12],
      ['6001', 11],
    ]) {
      seedTrain(db, no, late, 12);
    }
    const win = lateTrainsWindow(POST_TIME);
    const trains = chronicLateTrains(railTrainStats(db, win).trains);
    const { text, facets, chart, alt } = composeLateTrains(trains, win);
    expect(graphemeLength(text)).toBeLessThanOrEqual(300);
    expect(text).toContain("🐌 Regional Rail's most-often-late trains · Oct 11 – Nov 7");
    expect(text).toContain('1. #9531 Thorndale → Temple U');
    expect(text).toContain('late 16 of 20 days');
    expect(facets[0].features[0].uri).toMatch(/\/scorecards\?mode=rail$/);
    expect(chart.rows).toHaveLength(6);
    expect(chart.rows[0]).toEqual({
      label: '#9531 · Paoli/Thorndale',
      value: 80,
      display: '16 of 20',
    });
    expect(alt).toContain('#9531 · Paoli/Thorndale 16 of 20 days');
  });

  it('posts once per window, with the chart', async () => {
    const { db, poster, client } = testPoster();
    seedTrain(db, '9531', 16, 12);
    seedTrain(db, '418', 15, 9);
    seedTrain(db, '3819', 12, 30, 'wtr');
    const res = await postLateTrains({ db, poster, now: POST_TIME });
    expect(res.posted).toBe(3);
    expect(client.posts).toHaveLength(1);
    expect(client.posts[0].account).toBe('rail');
    const meta = await sharp(client.posts[0].opts.image.data).metadata();
    expect(meta.format).toBe('jpeg');
    expect(await postLateTrains({ db, poster, now: POST_TIME + MIN })).toEqual({
      skipped: 'posted',
    });
  });

  it('stays quiet when few trains are late that often', async () => {
    const { db, poster, client } = testPoster();
    seedTrain(db, '9531', 16, 12);
    seedTrain(db, '700', 2, 40);
    expect(await postLateTrains({ db, poster, now: POST_TIME })).toEqual({
      skipped: 'too-few-trains',
      trains: 1,
    });
    expect(client.posts).toHaveLength(0);
  });

  it('labels a time to the nearest five minutes', () => {
    expect(minutesLabel(17 * 60 + 8)).toBe('5:10 PM');
    expect(minutesLabel(7)).toBe('12:05 AM');
    expect(minutesLabel(12 * 60)).toBe('12:00 PM');
    expect(minutesLabel(null)).toBeNull();
  });
});
