import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { easternToEpoch } from '../../collector/lib/time.js';
import {
  briefingStats,
  changeLine,
  composeBriefing,
  composeHeadsUp,
  composeScheduleChange,
  composeWeekend,
  dueChangeSet,
  headsUpFor,
  maybePostOutlook,
  postScheduleChange,
  secClock,
  specialDayPhrase,
  weekendOf,
  weekendWork,
} from '../features/outlook.js';
import { graphemeLength } from '../lib/text.js';
import { officialIncident, testPoster } from './helpers.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const at = (y, m, d, h = 0, min = 0) => easternToEpoch(y, m, d, h, min);
// Wednesday, Nov 11, 2026, 6:31 AM in Philadelphia.
const MORNING = at(2026, 11, 11, 6, 31);
const asMap = (list) => new Map(list.map((i) => [i.id, i]));

/** A planned advisory with a stated window. */
function planned({ id, routes = ['l1'], mode = 'metro', headline, start, end, firstSeen }) {
  const inc = officialIncident({
    id,
    mode,
    routes,
    headline,
    type: 'ADVISORY',
    effect: 'MODIFIED_SERVICE',
    firstSeen: firstSeen ?? start - 3 * DAY,
  });
  inc.official_alert.agency_event_window = {
    start_ts: start,
    end_ts: end,
    start_is_date_only: false,
    end_is_date_only: true,
  };
  return inc;
}

function cancelledTrips(date, route, cancelled) {
  return {
    id: `trip-cancellations-${date}-${route}`,
    mode: 'bus',
    routes: [route],
    lifecycle: { first_seen_ts: MORNING - HOUR, active: true },
    official_alert: null,
    detections: [
      { source: 'trip-cancellations', evidence: { details: { service_date: date, cancelled } } },
    ],
    status: null,
  };
}

function railCancellation(no, departure) {
  return {
    id: `cancel-2026-11-11-${no}`,
    mode: 'regional_rail',
    routes: ['pao'],
    lifecycle: { first_seen_ts: MORNING - HOUR, active: true },
    official_alert: null,
    detections: [{ source: 'cancellation' }],
    status: { type: 'cancellation', state: 'upcoming', scheduled_departure_ts: departure },
  };
}

const THANKSGIVING = {
  date: '2026-11-26',
  day_type: 'weekday',
  holiday: 'Thanksgiving',
  trips: 8437,
  typical: 14904,
  like: 'sunday',
  kind: 'reduced',
  routes_off: [
    '1',
    '8',
    '19',
    '90',
    '92',
    '95',
    '103',
    '106',
    '120',
    '123',
    '124',
    '125',
    '150',
    '201',
  ],
};
const SCHOOLS_OFF = {
  date: '2026-11-27',
  day_type: 'weekday',
  holiday: 'the day after Thanksgiving',
  trips: 14568,
  typical: 14904,
  like: null,
  kind: 'routes-off',
  routes_off: ['409', '411', '415', '426', '428', '433'],
};

describe('the morning briefing', () => {
  const incidents = () =>
    asMap([
      officialIncident({ id: 'alert-1', routes: ['l1'], firstSeen: MORNING - 20 * MIN }),
      officialIncident({
        id: 'alert-2',
        mode: 'bus',
        routes: ['23', '47'],
        headline: 'Routes 23 and 47 are detoured: police activity',
        firstSeen: MORNING - 40 * MIN,
      }),
      // One alert on two networks counts once.
      officialIncident({ id: 'alert-2-metro', alertId: '2', mode: 'metro', routes: ['t1'] }),
      // Cleared overnight.
      officialIncident({
        id: 'alert-3',
        firstSeen: MORNING - 8 * HOUR,
        resolvedTs: MORNING - 5 * HOUR,
      }),
      // A platform notice isn't worth a line.
      officialIncident({
        id: 'alert-4',
        type: 'ADVISORY',
        headline: 'Platform boarding change at 30th St',
      }),
      planned({
        id: 'alert-5',
        routes: ['b1'],
        headline: 'Shuttle buses replace trains between Olney and Fern Rock',
        start: MORNING - 2 * DAY,
        end: MORNING + 4 * DAY,
      }),
      // Starts next week: not today's.
      planned({
        id: 'alert-6',
        routes: ['m1'],
        headline: 'No service between Norristown and Bridgeport',
        start: MORNING + 6 * DAY,
        end: MORNING + 8 * DAY,
      }),
      cancelledTrips('2026-11-11', '16', 14),
      cancelledTrips('2026-11-11', '52', 9),
      cancelledTrips('2026-11-11', '3', 2),
      cancelledTrips('2026-11-10', '16', 30),
      railCancellation('3556', at(2026, 11, 11, 8, 5)),
      railCancellation('3558', at(2026, 11, 12, 8, 5)),
    ]);
  const outages = new Map([
    ['e1', { id: 'e1', lifecycle: { active: true } }],
    ['e2', { id: 'e2', lifecycle: { active: false } }],
  ]);

  it('counts what is in effect now and today', () => {
    const stats = briefingStats({ incidents: incidents(), outages, now: MORNING });
    expect(stats.unplanned.map((g) => g.map((i) => i.id))).toEqual([
      ['alert-1'],
      ['alert-2', 'alert-2-metro'],
    ]);
    expect(stats.planned.map((g) => g[0].id)).toEqual(['alert-5']);
    expect(stats.cancelledTrips).toBe(25);
    expect(stats.cancelledRoutes[0]).toEqual({ mode: 'bus', route: '16', n: 14 });
    expect(stats.railCancelled).toBe(1);
    expect(stats.elevators).toBe(1);
    expect(stats.special).toBeNull();
  });

  it('says it in a post', () => {
    const { text, facets } = composeBriefing(
      briefingStats({ incidents: incidents(), outages, now: MORNING }),
    );
    expect(text.split('\n')).toEqual([
      '☀️ SEPTA this morning · Wednesday, Nov 11',
      '',
      '⚠️ 2 unplanned alerts in effect: L1, Route 23, Route 47, T1',
      '🚧 1 planned change today: B1',
      '🚫 25 bus and Metro trips cancelled so far (Route 16 14, Route 52 9)',
      '🚆 1 Regional Rail train cancelled',
      '♿ 1 elevator out',
      '',
      expect.stringMatching(/^🔗 /),
    ]);
    expect(graphemeLength(text)).toBeLessThanOrEqual(300);
    expect(facets).toHaveLength(1);
  });

  it('says so on a clear morning, and leads with a holiday timetable', () => {
    const calm = asMap([cancelledTrips('2026-11-10', '16', 30)]);
    expect(composeBriefing(briefingStats({ incidents: calm, now: MORNING })).text).toContain(
      '✅ No unplanned SEPTA alerts in effect',
    );
    const holiday = at(2026, 11, 26, 8, 1);
    const { text } = composeBriefing(
      briefingStats({
        incidents: calm,
        scheduleChanges: { special_days: [THANKSGIVING, SCHOOLS_OFF] },
        now: holiday,
      }),
    );
    expect(text).toContain('🗓️ Thanksgiving: buses and Metro run a Sunday timetable');
  });

  it('stays within a post however much is going on', () => {
    const many = asMap(
      Array.from({ length: 30 }, (_, i) =>
        officialIncident({ id: `alert-${i + 10}`, mode: 'bus', routes: [String(i + 100)] }),
      ),
    );
    const { text } = composeBriefing(briefingStats({ incidents: many, now: MORNING }));
    expect(graphemeLength(text)).toBeLessThanOrEqual(300);
    expect(text).toContain(
      '⚠️ 30 unplanned alerts in effect: Route 100, Route 101, Route 102, Route 103 +26',
    );
  });
});

describe('the weekend preview', () => {
  // Friday, Nov 13, 2026, 3:31 PM.
  const FRIDAY = at(2026, 11, 13, 15, 31);
  const saturday = at(2026, 11, 14);

  it('knows the weekend coming, and the one under way', () => {
    expect(weekendOf(FRIDAY)).toEqual({ saturday: '2026-11-14', sunday: '2026-11-15' });
    expect(weekendOf(at(2026, 11, 15, 9))).toEqual({
      saturday: '2026-11-14',
      sunday: '2026-11-15',
    });
    expect(weekendOf(at(2026, 11, 16, 9))).toEqual({
      saturday: '2026-11-21',
      sunday: '2026-11-22',
    });
  });

  const incidents = () =>
    asMap([
      planned({
        id: 'alert-1',
        routes: ['l1'],
        headline: 'Shuttle buses replace trains between 15th St and 69th St',
        start: saturday + 5 * HOUR,
        end: saturday + 2 * DAY - MIN,
      }),
      planned({
        id: 'alert-2',
        mode: 'regional_rail',
        routes: ['pao'],
        headline: 'Paoli/Thorndale Line: buses replace trains between Malvern and Thorndale',
        start: saturday,
        end: saturday + 2 * DAY - MIN,
      }),
      // Long-running: began three weeks ago.
      planned({
        id: 'alert-3',
        routes: ['t5'],
        headline: 'T5 is suspended between 49th St and Darby',
        start: saturday - 21 * DAY,
        end: saturday + 30 * DAY,
      }),
      // Over before the weekend.
      planned({
        id: 'alert-4',
        routes: ['b1'],
        headline: 'No service at Tasker-Morris',
        start: saturday - 3 * DAY,
        end: saturday - 6 * HOUR,
      }),
      // A stop notice isn't something to plan a weekend around.
      planned({
        id: 'alert-5',
        mode: 'bus',
        routes: ['17'],
        headline: 'Bus stop changes on Market St',
        start: saturday,
        end: saturday + DAY,
      }),
      officialIncident({ id: 'alert-6', routes: ['m1'] }),
    ]);

  it('finds the planned work covering the weekend, new work first', () => {
    const work = weekendWork({ incidents: incidents(), now: FRIDAY });
    expect(work.fresh.map((g) => g[0].id)).toEqual(['alert-2', 'alert-1']);
    expect(work.continuing.map((g) => g[0].id)).toEqual(['alert-3']);
  });

  it('lists it in a post', () => {
    const { text, facets } = composeWeekend(weekendWork({ incidents: incidents(), now: FRIDAY }));
    expect(text.split('\n')).toEqual([
      '🗓️ This weekend on SEPTA · Nov 14–15',
      '',
      '· Paoli/Thorndale Line: buses replace trains between Malvern and Thorndale',
      '· L1: Shuttle buses replace trains between 15th St and 69th St',
      '',
      'Plus 1 longer-running change still in effect.',
      expect.stringMatching(/^Dates and details: .*\/planned$/),
    ]);
    expect(graphemeLength(text)).toBeLessThanOrEqual(300);
    expect(facets[0].features[0].uri).toMatch(/\/planned$/);
  });

  it('writes the dates across the end of a month', () => {
    const work = weekendWork({ incidents: incidents(), now: at(2026, 10, 30, 15, 31) });
    expect(composeWeekend({ ...work, continuing: [[incidents().get('alert-3')]] }).text).toContain(
      '· Oct 31 – Nov 1',
    );
  });

  it('has nothing to say about a weekend with nothing planned', () => {
    expect(composeWeekend(weekendWork({ incidents: new Map(), now: FRIDAY }))).toBeNull();
  });
});

describe('the holiday heads-up', () => {
  const file = { special_days: [THANKSGIVING, SCHOOLS_OFF] };

  it('is for tomorrow, when tomorrow is special', () => {
    expect(headsUpFor(file, at(2026, 11, 25, 16, 1))).toBe(THANKSGIVING);
    expect(headsUpFor(file, at(2026, 11, 24, 16, 1))).toBeNull();
    expect(headsUpFor(null, at(2026, 11, 25, 16, 1))).toBeNull();
  });

  it('announces a run of days with routes off once, at its start', () => {
    // The day after Thanksgiving follows a special day: already said.
    expect(headsUpFor(file, at(2026, 11, 26, 16, 1))).toBeNull();
    const breakDays = ['2026-12-23', '2026-12-24', '2026-12-25', '2026-12-28'].map((date) => ({
      ...SCHOOLS_OFF,
      date,
      holiday: null,
    }));
    expect(headsUpFor({ special_days: breakDays }, at(2026, 12, 22, 16, 1))?.date).toBe(
      '2026-12-23',
    );
    expect(headsUpFor({ special_days: breakDays }, at(2026, 12, 23, 16, 1))).toBeNull();
    // Monday's follows Friday's across the weekend.
    expect(headsUpFor({ special_days: breakDays }, at(2026, 12, 27, 16, 1))).toBeNull();
  });

  it('says which timetable runs and which routes do not', () => {
    const { text, facets } = composeHeadsUp(THANKSGIVING);
    expect(text).toContain('🗓️ Heads-up: tomorrow is Thanksgiving (Thu, Nov 26)');
    expect(text).toContain(
      'SEPTA buses and Metro run a Sunday timetable: 8,437 trips, 57% of a usual Thursday.',
    );
    expect(text).toContain("14 routes that usually run on a Thursday don't.");
    // Without a Sunday or Saturday timetable to say it all, some are named.
    expect(composeHeadsUp({ ...THANKSGIVING, like: null }).text).toContain(
      "14 routes that usually run on a Thursday don't: 1, 8, 19, 90, 92",
    );
    expect(text).toMatch(/Regional Rail isn't covered/);
    expect(graphemeLength(text)).toBeLessThanOrEqual(300);
    expect(facets.map((f) => f.features[0].uri)).toEqual(
      expect.arrayContaining([expect.stringMatching(/\/schedule-changes$/)]),
    );
  });

  it('knows the school routes', () => {
    expect(composeHeadsUp(SCHOOLS_OFF).text).toContain(
      '🗓️ Heads-up for tomorrow, Fri, Nov 27 (the day after Thanksgiving)',
    );
    const { text } = composeHeadsUp({ ...SCHOOLS_OFF, holiday: null });
    expect(text.split('\n')[0]).toBe('🗓️ Heads-up for tomorrow, Fri, Nov 27');
    expect(text).toContain("The 6 school routes (400s) don't run.");
    expect(text).not.toContain('timetable:');
    expect(specialDayPhrase(SCHOOLS_OFF)).toBe("the 6 school routes (400s) don't run");
    expect(specialDayPhrase(THANKSGIVING)).toBe('buses and Metro run a Sunday timetable');
    expect(specialDayPhrase({ ...THANKSGIVING, like: null })).toBe(
      'buses and Metro run a reduced timetable (57% of usual)',
    );
  });
});

describe('schedule changes', () => {
  const route = (r, kind, days, mode = 'bus') => ({ route: r, mode, kind, days, delta: 0 });
  const SET = {
    id: '2026-12-20',
    effective: '2026-12-20',
    feed_version: 'v2',
    totals: { weekday: [14904, 14778], saturday: [10205, 10097], sunday: [8369, 8287] },
    routes: [
      route('M1-Bus', 'ended', {
        weekday: { trips: [126, 0], first: [16080, null], last: [93960, null] },
      }),
      route('26', 'changed', {
        weekday: { trips: [183, 153], first: [19260, 19260], last: [93840, 93840] },
      }),
      route(
        'b2',
        'changed',
        { sunday: { trips: [2, 0], first: [66000, null], last: [66600, null] } },
        'metro',
      ),
      route('31', 'new', {
        weekday: { trips: [0, 40], first: [null, 18000], last: [null, 80000] },
      }),
      route('9', 'changed', {
        weekday: { trips: [90, 90], first: [18000, 19800], last: [86400, 86400] },
      }),
      route('12', 'changed', {
        saturday: { trips: [60, 60], first: [18000, 18000], last: [90000, 86400] },
      }),
    ],
  };

  it("puts a route's change in a line", () => {
    expect(SET.routes.map(changeLine)).toEqual([
      'Route M1 Bus: no longer scheduled (was 126 weekday trips)',
      'Route 26: 183 → 153 weekday trips',
      'B2: no Sunday service (was 2 trips)',
      'Route 31: new, 40 weekday trips',
      'Route 9: first weekday trip 5:00 AM → 5:30 AM',
      'Route 12: last Saturday trip 1:00 AM → 12:00 AM',
    ]);
    expect(secClock(93960)).toBe('2:06 AM');
    expect(secClock(null)).toBeNull();
  });

  it('is due from ten days before it starts until two days after', () => {
    const file = { changes: [SET] };
    expect(dueChangeSet(file, at(2026, 12, 9, 10))).toBeNull();
    expect(dueChangeSet(file, at(2026, 12, 10, 10))).toBe(SET);
    expect(dueChangeSet(file, at(2026, 12, 22, 10))).toBe(SET);
    expect(dueChangeSet(file, at(2026, 12, 23, 10))).toBeNull();
    expect(dueChangeSet({ changes: [{ ...SET, routes: [] }] }, at(2026, 12, 15, 10))).toBeNull();
  });

  it('says when, how much, and what', () => {
    const { text, facets } = composeScheduleChange(SET, at(2026, 12, 12, 10));
    expect(text).toContain('🗓️ New SEPTA schedules start Sun, Dec 20');
    expect(text).toContain('Buses and Metro: 6 routes change.');
    expect(text).toContain('· Route 26: 183 → 153 weekday trips');
    expect(text).toContain('· B2: no Sunday service (was 2 trips)');
    expect(text).toMatch(/…and \d more/);
    expect(graphemeLength(text)).toBeLessThanOrEqual(300);
    expect(facets[0].features[0].uri).toMatch(/\/schedule-changes$/);
    expect(composeScheduleChange(SET, at(2026, 12, 21, 10)).text).toContain(
      'New SEPTA schedules started Sun, Dec 20',
    );
  });

  it('posts a change set once', async () => {
    const { poster, client } = testPoster();
    const opts = { scheduleChanges: { changes: [SET] }, poster, now: at(2026, 12, 12, 10) };
    expect(await postScheduleChange(opts)).toMatchObject({ posted: '2026-12-20', routes: 6 });
    expect(await postScheduleChange(opts)).toEqual({ skipped: 'posted' });
    expect(client.posts).toHaveLength(1);
    expect(client.posts[0].account).toBe('alerts');
  });
});

describe('each tick', () => {
  async function dataDirWith(file) {
    const dir = await mkdtemp(join(tmpdir(), 'septa-outlook-'));
    if (file) await writeFile(join(dir, 'schedule-changes.json'), JSON.stringify(file));
    return dir;
  }
  const incidents = () => asMap([officialIncident({ id: 'alert-1', firstSeen: MORNING - HOUR })]);

  it('posts the briefing once, after its slot and before noon', async () => {
    const { db, poster, client } = testPoster();
    const dataDir = await dataDirWith(null);
    const tick = (now) => maybePostOutlook({ incidents: incidents(), dataDir, db, poster, now });
    expect(await tick(at(2026, 11, 11, 6, 29))).toBeNull();
    expect((await tick(MORNING)).briefing).toMatchObject({ posted: '2026-11-11' });
    expect(await tick(MORNING + 2 * MIN)).toBeNull();
    expect(client.posts).toHaveLength(1);
    // The next day the bot comes up in the afternoon: too late for a morning briefing.
    expect((await tick(at(2026, 11, 12, 13, 0)))?.briefing).toBeUndefined();
    // Saturday's is at 8.
    expect(await tick(at(2026, 11, 14, 7, 0))).toBeNull();
    expect((await tick(at(2026, 11, 14, 8, 1))).briefing).toMatchObject({ posted: '2026-11-14' });
  });

  it("posts Friday's weekend preview, the heads-up, and a schedule change when due", async () => {
    const { db, poster, client } = testPoster();
    const saturday = at(2026, 11, 28);
    const work = asMap([
      planned({
        id: 'alert-1',
        headline: 'Shuttle buses replace trains between 15th St and 69th St',
        start: saturday,
        end: saturday + 2 * DAY - MIN,
      }),
    ]);
    const dataDir = await dataDirWith({
      special_days: [THANKSGIVING, SCHOOLS_OFF],
      changes: [
        {
          id: '2026-12-06',
          effective: '2026-12-06',
          totals: { weekday: [100, 90] },
          routes: [
            {
              route: '26',
              mode: 'bus',
              kind: 'changed',
              days: { weekday: { trips: [100, 90], first: [1, 1], last: [2, 2] } },
            },
          ],
        },
      ],
    });
    const tick = (now) => maybePostOutlook({ incidents: work, dataDir, db, poster, now });
    // Wednesday afternoon before Thanksgiving: the heads-up.
    const wednesday = await tick(at(2026, 11, 25, 16, 2));
    expect(wednesday.headsUp).toMatchObject({ posted: '2026-11-26' });
    expect(wednesday.weekend).toBeUndefined();
    // Friday afternoon: the weekend preview, and the schedule change ten days out.
    const friday = await tick(at(2026, 11, 27, 15, 31));
    expect(friday.weekend).toMatchObject({ posted: 1 });
    expect(friday.scheduleChange).toMatchObject({ posted: '2026-12-06' });
    expect(friday.headsUp).toBeUndefined();
    expect(client.posts.map((p) => p.opts.text.split('\n')[0])).toEqual([
      '🗓️ Heads-up: tomorrow is Thanksgiving (Thu, Nov 26)',
      '🗓️ This weekend on SEPTA · Nov 28–29',
      '🗓️ New SEPTA schedules start Sun, Dec 6',
    ]);
  });
});
