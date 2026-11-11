// @vitest-environment node
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { collect } from '../collect.js';
import { Schedule } from '../lib/schedule.js';
import {
  buildScheduleChanges,
  dayTypeOf,
  diffProfiles,
  findChanges,
  holidayName,
  periodProfile,
  SCHEDULE_CHANGES_FILE,
  schedulePeriods,
  scheduleProfile,
  specialDay,
  tripsOn,
} from '../lib/scheduleChanges.js';
import { easternToEpoch } from '../lib/time.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
// Wednesday, Nov 11, 2026, 9 AM in Philadelphia.
const NOW = easternToEpoch(2026, 11, 11, 9);

const service = (days, start, end, { add = [], remove = [] } = {}) => ({
  days,
  start,
  end,
  add,
  remove,
});

/**
 * A schedule index from `{ service: { route: [start seconds, …] } }`. Each trip runs for half
 * an hour in direction 0.
 */
function index(services, trips, feedVersion = 'v1') {
  const out = {};
  let n = 0;
  for (const [svc, routes] of Object.entries(trips)) {
    for (const [route, starts] of Object.entries(routes)) {
      for (const start of starts) out[`t${++n}`] = [route, 0, svc, start, start + 1800, 0, 0, 10];
    }
  }
  return {
    version: 3,
    built_at: NOW,
    feed_version: feedVersion,
    services,
    stops: ['A'],
    trips: out,
  };
}

const hourly = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => (from + i) * 3600);

// A feed like SEPTA's: weekday, Saturday and Sunday services through February, a route (9)
// whose services stop on Dec 19, a school route (401) added date by date, and a Sunday
// timetable on Thanksgiving (the weekday services removed, the Sunday ones added).
const SCHOOL_DAYS = [];
for (let d = 2; d <= 30; d++) {
  const key = `2026-11-${String(d).padStart(2, '0')}`;
  if (dayTypeOf(key) === 'weekday' && d !== 26 && d !== 27)
    SCHOOL_DAYS.push(key.replaceAll('-', ''));
}
const FEED = index(
  {
    wk: service('1111100', '20261101', '20270220', { remove: ['20261126'] }),
    sa: service('0000010', '20261101', '20270220'),
    su: service('0000001', '20261101', '20270220', { add: ['20261126'] }),
    wk9: service('1111100', '20261101', '20261219', { remove: ['20261126'] }),
    school: service('0000000', '20261101', '20270220', { add: SCHOOL_DAYS }),
  },
  {
    wk: { 17: hourly(5, 23), 23: hourly(6, 22) },
    sa: { 17: hourly(6, 22) },
    su: { 17: hourly(7, 20) },
    wk9: { 9: hourly(6, 9) },
    school: { 401: [7 * 3600, 15 * 3600] },
  },
);

describe('the trips on a date', () => {
  const schedule = Schedule.from(FEED);

  it('counts each route, with its first and last start', () => {
    const day = tripsOn(schedule, '2026-11-10');
    expect(day.get('17')).toEqual([19, 5 * 3600, 23 * 3600]);
    expect(day.get('401')).toEqual([2, 7 * 3600, 15 * 3600]);
    expect(tripsOn(schedule, '2026-11-14').get('17')).toEqual([17, 6 * 3600, 22 * 3600]);
    expect(tripsOn(schedule, '2026-11-14').has('23')).toBe(false);
  });

  it('follows the calendar exceptions', () => {
    const thanksgiving = tripsOn(schedule, '2026-11-26');
    expect(thanksgiving.get('17')).toEqual([14, 7 * 3600, 20 * 3600]);
    expect(thanksgiving.has('23')).toBe(false);
    expect(thanksgiving.has('401')).toBe(false);
  });
});

describe('the periods of a feed', () => {
  it('cuts where a weekly service starts or stops', () => {
    expect(schedulePeriods(FEED)).toEqual([
      { start: '2026-11-01', end: '2026-12-19' },
      { start: '2026-12-20', end: '2027-02-20' },
    ]);
  });

  it('folds a period of a few days into the one before', () => {
    const feed = index(
      {
        a: service('1111111', '20261101', '20261130'),
        b: service('1111111', '20261101', '20261202'),
      },
      { a: { 1: [3600] }, b: { 2: [3600] } },
    );
    expect(schedulePeriods(feed)).toEqual([{ start: '2026-11-01', end: '2026-12-02' }]);
  });

  it('is one period for a feed that lists every date', () => {
    const feed = index(
      { x: service('0000000', null, null, { add: ['20261103', '20261110'] }) },
      { x: { 1: [3600] } },
    );
    expect(schedulePeriods(feed)).toEqual([{ start: '2026-11-03', end: '2026-11-10' }]);
  });

  it('is empty for a feed with no dates', () => {
    expect(schedulePeriods(index({}, {}))).toEqual([]);
  });
});

describe('a period profile', () => {
  const schedule = Schedule.from(FEED);
  const profile = periodProfile(schedule, { start: '2026-11-01', end: '2026-12-19' });

  it('is the typical day of each kind, whatever a holiday in it does', () => {
    expect(profile.routes['17']).toEqual({
      weekday: [19, 5 * 3600, 23 * 3600],
      saturday: [17, 6 * 3600, 22 * 3600],
      sunday: [14, 7 * 3600, 20 * 3600],
    });
    expect(profile.routes['23'].saturday).toBeNull();
  });

  it('counts trips added date by date, like the school routes', () => {
    expect(profile.routes['401'].weekday).toEqual([2, 7 * 3600, 15 * 3600]);
    expect(profile.totals).toEqual({ weekday: 19 + 17 + 4 + 2, saturday: 17, sunday: 14 });
  });
});

describe('what changes between two periods', () => {
  const schedule = Schedule.from(FEED);
  const profile = scheduleProfile(schedule, { fromKey: '2026-11-11' });

  it('finds the route that stops, effective the day the later period starts', () => {
    const [set, ...rest] = findChanges(null, profile, { now: NOW });
    expect(rest).toEqual([]);
    expect(set.id).toBe('2026-12-20');
    expect(set.effective).toBe('2026-12-20');
    // The school route isn't added on any date after November: it stops too.
    expect(set.routes.map((r) => [r.route, r.kind])).toEqual([
      ['9', 'ended'],
      ['401', 'ended'],
    ]);
    expect(set.routes[0].days.weekday.trips).toEqual([4, 0]);
    expect(set.totals.weekday).toEqual([42, 36]);
  });

  it('compares a new feed with the timetable it replaces', () => {
    const next = index(
      {
        wk: service('1111100', '20270221', '20270620'),
        sa: service('0000010', '20270221', '20270620'),
        su: service('0000001', '20270221', '20270620'),
      },
      {
        // The 17 loses two weekday trips and starts an hour later; the 23 is unchanged; the 31
        // is new; Saturday and Sunday are as they were.
        wk: { 17: hourly(6, 22), 23: hourly(6, 22), 31: hourly(7, 9) },
        sa: { 17: hourly(6, 22) },
        su: { 17: hourly(7, 20) },
      },
      'v2',
    );
    const after = scheduleProfile(Schedule.from(next), { fromKey: '2027-02-12' });
    const sets = findChanges(profile, after, { now: NOW });
    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({
      effective: '2027-02-21',
      feed_version: 'v2',
      from_feed_version: 'v1',
    });
    const byRoute = Object.fromEntries(sets[0].routes.map((r) => [r.route, r]));
    expect(Object.keys(byRoute).sort()).toEqual(['17', '31']);
    expect(byRoute['17']).toMatchObject({ kind: 'changed', mode: 'bus', delta: -10 });
    expect(byRoute['17'].days).toEqual({
      weekday: { trips: [19, 17], first: [5 * 3600, 6 * 3600], last: [23 * 3600, 22 * 3600] },
    });
    expect(byRoute['31'].kind).toBe('new');
  });

  it('counts a first or last trip that moves, and not one that barely does', () => {
    const before = { routes: { 5: { weekday: [10, 18000, 80000], saturday: null, sunday: null } } };
    const moved = { routes: { 5: { weekday: [10, 18000, 82400], saturday: null, sunday: null } } };
    const nudged = { routes: { 5: { weekday: [10, 18300, 80000], saturday: null, sunday: null } } };
    expect(diffProfiles(before, moved)[0].days.weekday.last).toEqual([80000, 82400]);
    expect(diffProfiles(before, nudged)).toEqual([]);
  });

  it('says nothing when the feed is the same', () => {
    const again = scheduleProfile(schedule, { fromKey: '2026-11-12' });
    expect(findChanges(profile, again, { now: NOW }).map((s) => s.id)).toEqual(['2026-12-20']);
    const flat = scheduleProfile(
      Schedule.from(index({ a: service('1111111', '20261101', '20270220') }, { a: { 1: [3600] } })),
      { fromKey: '2026-11-11' },
    );
    expect(findChanges(flat, flat, { now: NOW })).toEqual([]);
  });
});

describe('special days', () => {
  const schedule = Schedule.from(FEED);
  const profile = scheduleProfile(schedule, { fromKey: '2026-11-11' });

  it('finds a holiday running the Sunday timetable', () => {
    expect(specialDay(schedule, profile, '2026-11-26')).toEqual({
      date: '2026-11-26',
      day_type: 'weekday',
      holiday: 'Thanksgiving',
      trips: 14,
      typical: 42,
      like: 'sunday',
      kind: 'reduced',
      routes_off: ['9', '23', '401'],
    });
  });

  it('leaves an ordinary day alone', () => {
    expect(specialDay(schedule, profile, '2026-11-18')).toBeNull();
    expect(specialDay(schedule, profile, '2026-11-21')).toBeNull();
  });

  it('finds a day when a set of routes is off, though most trips run', () => {
    const cfg = { likeShare: 0.05, bigShare: 0.1, minRoutesOff: 1 };
    // The day after Thanksgiving: only the school route is off (2 of 42 trips).
    expect(specialDay(schedule, profile, '2026-11-27', cfg)).toMatchObject({
      kind: 'routes-off',
      like: null,
      routes_off: ['401'],
      holiday: 'the day after Thanksgiving',
    });
    expect(specialDay(schedule, profile, '2026-11-27')).toBeNull();
  });

  it('names the holidays SEPTA runs a holiday timetable on', () => {
    expect(holidayName('2026-11-26')).toBe('Thanksgiving');
    expect(holidayName('2026-12-25')).toBe('Christmas Day');
    expect(holidayName('2027-01-01')).toBe("New Year's Day");
    expect(holidayName('2027-01-18')).toBe('Martin Luther King Jr. Day');
    expect(holidayName('2027-05-31')).toBe('Memorial Day');
    expect(holidayName('2027-09-06')).toBe('Labor Day');
    expect(holidayName('2026-11-19')).toBeNull();
  });
});

describe('the schedule-changes file', () => {
  const schedule = Schedule.from(FEED);

  it('lists the periods, the changes, and the special days ahead', () => {
    const { profile, file } = buildScheduleChanges({ schedule, now: NOW });
    expect(profile.periods).toHaveLength(2);
    expect(file).toMatchObject({
      schema_version: 1,
      covers: ['bus', 'metro'],
      feed_version: 'v1',
      feed_start: '2026-11-01',
      feed_end: '2027-02-20',
    });
    expect(file.periods[0]).toEqual({
      start: '2026-11-01',
      end: '2026-12-19',
      totals: { weekday: 42, saturday: 17, sunday: 14 },
    });
    expect(file.changes.map((c) => c.id)).toEqual(['2026-12-20']);
    expect(file.special_days.map((d) => d.date)).toEqual(['2026-11-26']);
  });

  it('keeps a change set found on an earlier day, and when it was found', () => {
    const first = buildScheduleChanges({ schedule, now: NOW });
    const kept = {
      ...first.file,
      changes: [
        ...first.file.changes,
        { id: '2026-11-01', effective: '2026-11-01', detected_ts: 1, totals: {}, routes: [{}] },
        { id: '2026-01-04', effective: '2026-01-04', detected_ts: 1, totals: {}, routes: [{}] },
      ],
    };
    const later = buildScheduleChanges({
      schedule,
      prevProfile: first.profile,
      prevFile: kept,
      now: NOW + 24 * 3600 * 1000,
    });
    // Newest first; the one from January is past keeping.
    expect(later.file.changes.map((c) => c.id)).toEqual(['2026-12-20', '2026-11-01']);
    expect(later.file.changes[0].detected_ts).toBe(NOW);
  });
});

describe('the collector', () => {
  it('writes the file with its tick, and keeps the profile in its state', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'septa-sched-'));
    const now = 1_791_244_200_000;
    const { ok } = await collect({
      dataDir,
      fixturesDir: FIXTURES,
      now,
      log: () => {},
      warn: () => {},
    });
    expect(ok).toBe(true);
    const file = JSON.parse(await readFile(join(dataDir, SCHEDULE_CHANGES_FILE), 'utf8'));
    expect(file.schema_version).toBe(1);
    expect(file.periods.length).toBeGreaterThan(0);
    expect(Array.isArray(file.changes)).toBe(true);
    const state = JSON.parse(await readFile(join(dataDir, '_collector-state.json'), 'utf8'));
    expect(state.scheduleProfile.periods.length).toBe(file.periods.length);
    // Left alone on the next tick: the schedule hasn't been rebuilt.
    await collect({
      dataDir,
      fixturesDir: FIXTURES,
      now: now + 120_000,
      log: () => {},
      warn: () => {},
    });
    const again = JSON.parse(await readFile(join(dataDir, SCHEDULE_CHANGES_FILE), 'utf8'));
    expect(again.generated_at).toBe(file.generated_at);
  });
});
