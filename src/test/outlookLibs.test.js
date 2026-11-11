import { describe, expect, it } from 'vitest';
import { elevatorReliability, formatUptime, reliabilitySummary } from '../lib/accessibility.js';
import { activeNavKey } from '../lib/nav.js';
import {
  comingWeekend,
  filterPlanned,
  layoutPlanned,
  plannedItems,
  windowText,
} from '../lib/plannedWork.js';
import {
  changeSummary,
  dayChange,
  daysBetween,
  effectiveLabel,
  percentChange,
  phillyDateKey,
  routesFor,
  secClock,
  specialDayText,
  upcomingSpecialDays,
} from '../lib/scheduleChanges.js';
import {
  chronicTrains,
  dayStatus,
  findTrains,
  measureCell,
  measureKeys,
  minutesLabel,
  mostCancelledTrains,
  routeIdentity,
  routeScore,
  scoreRows,
  sortRows,
  trainRoute,
  weekLabel,
  weightsText,
} from '../lib/scorecards.js';
import { slowZoneBands, slowZoneLines, slowZoneRows, wantsSlowZones } from '../lib/slowZones.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// Wednesday, Nov 11, 2026, noon in Philadelphia (EST).
const NOW = Date.UTC(2026, 10, 11, 17);
const eastern = (y, m, d, h = 0, min = 0) => Date.UTC(y, m - 1, d, h + 5, min);

describe('scorecards', () => {
  const entry = (route, rank, score, measures = {}, counts = {}) => ({
    route,
    rank,
    score,
    measures: { onTime: 80, cancelled: 1.2, speed: 9.5, bunching: 0.4, gaps: 0.1, ...measures },
    counts: { cancelled: 3, bunching: 7, gaps: 2, ...counts },
  });
  const FILE = {
    schema_version: 1,
    weights: {
      bus: { onTime: 30, cancelled: 20, speed: 20, bunching: 15, gaps: 15 },
      rail: { onTime: 35, cancelled: 25, delay: 20, speed: 20 },
    },
    modes: {
      bus: {
        weeks: [
          { from: '2026-11-01', to: '2026-11-07', ranked: 3 },
          { from: '2026-10-25', to: '2026-10-31', ranked: 3 },
        ],
        latest: {
          from: '2026-11-01',
          to: '2026-11-07',
          ranked: 3,
          entries: [
            entry('17', 1, 81.4, { speed: 8 }, { bunching: 12 }),
            entry('2', 2, 60, { onTime: 91.2, speed: 11 }, { bunching: 1 }),
            entry('K', 3, 22.5, { onTime: null, speed: 14 }, { bunching: 30 }),
          ],
        },
        history: { 17: [81.4, 70], 2: [60, 64.2], K: [22.5, null] },
      },
    },
  };

  it('lists the measures a mode is scored on, and what the score weighs', () => {
    expect(measureKeys(FILE, 'bus')).toEqual(['onTime', 'cancelled', 'speed', 'bunching', 'gaps']);
    expect(measureKeys(FILE, 'rail')).toEqual(['onTime', 'cancelled', 'delay', 'speed']);
    expect(weightsText(FILE, 'rail')).toBe('on time 35%, cancellations 25%, delays 20%, speed 20%');
    expect(measureKeys(null, 'bus')).toEqual([]);
  });

  it('gives each row its score the week before and its trend, oldest first', () => {
    const rows = scoreRows(FILE, 'bus');
    expect(rows.map((r) => [r.route, r.previous, r.trend])).toEqual([
      ['17', 70, [70, 81.4]],
      ['2', 64.2, [64.2, 60]],
      ['K', null, [null, 22.5]],
    ]);
    expect(scoreRows(FILE, 'metro')).toEqual([]);
  });

  it('shows counts as counted and rates as percentages', () => {
    const [first, , last] = scoreRows(FILE, 'bus');
    expect(measureCell(first, 'onTime', 'bus')).toBe('80%');
    expect(measureCell(first, 'cancelled', 'bus')).toBe('3');
    expect(measureCell(first, 'cancelled', 'rail')).toBe('1.2%');
    expect(measureCell(first, 'speed', 'bus')).toBe('8.0');
    expect(measureCell(last, 'onTime', 'bus')).toBe('–');
  });

  it('sorts by a measure, best first, with routes that lack it last', () => {
    const rows = scoreRows(FILE, 'bus');
    const order = (key) => sortRows(rows, key, 'bus').map((r) => r.route);
    expect(order('rank')).toEqual(['17', '2', 'K']);
    expect(order('speed')).toEqual(['K', '2', '17']);
    expect(order('bunching')).toEqual(['2', '17', 'K']);
    expect(order('onTime')).toEqual(['2', '17', 'K']);
    expect(order('route')).toEqual(['2', '17', 'K']);
  });

  it("finds a route's score for its own page", () => {
    expect(routeScore(FILE, 'bus', '2')).toMatchObject({ rank: 2, ranked: 3, to: '2026-11-07' });
    expect(routeScore(FILE, 'bus', '99')).toBeNull();
    expect(routeScore(null, 'bus', '2')).toBeNull();
  });

  it('names routes and weeks', () => {
    expect(routeIdentity('bus', '17')).toMatchObject({ label: 'Route 17', href: '/route/17' });
    expect(routeIdentity('metro', 'l1')).toMatchObject({ label: 'L1', href: '/line/l1' });
    expect(routeIdentity('rail', 'pao')).toMatchObject({
      label: 'Paoli/Thorndale',
      href: '/rail/line/pao',
    });
    expect(weekLabel('2026-11-01', '2026-11-07')).toBe('Nov 1 – 7');
    expect(weekLabel('2026-10-25', '2026-11-07')).toBe('Oct 25 – Nov 7');
  });

  const train = (no, over = {}) => ({
    no,
    line: 'pao',
    origin: 'Thorndale',
    dest: 'Temple U',
    seen: 20,
    ran: 20,
    late: 2,
    cancelled: 0,
    avg_late: 3,
    ...over,
  });
  const TRAINS = [
    train('418', { late: 15, avg_late: 9 }),
    train('9531', { late: 15, avg_late: 12 }),
    train('3819', { late: 9 }),
    train('700', { ran: 4, late: 4, seen: 4 }),
    train('95', { cancelled: 5, ran: 15 }),
    train('96', { cancelled: 2, ran: 18 }),
  ];

  it('picks the trains late most often, and cancelled most often', () => {
    expect(chronicTrains(TRAINS).map((t) => t.no)).toEqual(['9531', '418']);
    expect(mostCancelledTrains(TRAINS).map((t) => t.no)).toEqual(['95', '96']);
  });

  it('finds trains by the start of their number', () => {
    expect(findTrains(TRAINS, '95').map((t) => t.no)).toEqual(['9531', '95']);
    expect(findTrains(TRAINS, '#9531').map((t) => t.no)).toEqual(['9531']);
    expect(findTrains(TRAINS, '')).toEqual([]);
  });

  it('reads a train and its days', () => {
    expect(trainRoute(TRAINS[0])).toBe('Thorndale → Temple U');
    expect(trainRoute({ line: 'pao', origin: null, dest: null })).toBe('Paoli/Thorndale');
    expect([null, -1, 0, 5, 6].map((v) => dayStatus(v, 5))).toEqual([
      'none',
      'cancelled',
      'on-time',
      'on-time',
      'late',
    ]);
    expect(minutesLabel(17 * 60 + 8)).toBe('5:10 PM');
  });
});

describe('planned work', () => {
  const planned = ({
    id,
    alertId = id,
    mode = 'metro',
    routes = ['l1'],
    start,
    end,
    firstSeen,
  }) => ({
    id,
    mode,
    routes,
    lifecycle: { first_seen_ts: firstSeen ?? NOW - 3 * DAY, active: true },
    official_alert: {
      id: alertId,
      headline: `Work ${id}`,
      description: null,
      septa: { type: 'ADVISORY' },
      agency_event_window: {
        start_ts: start,
        end_ts: end,
        start_is_date_only: false,
        end_is_date_only: true,
      },
    },
    detections: [],
  });
  const saturday = eastern(2026, 11, 14);
  const INCIDENTS = [
    planned({ id: 'weekend', start: saturday + 5 * HOUR, end: saturday + 2 * DAY - 60_000 }),
    planned({ id: 'now', start: NOW - 2 * DAY, end: NOW + DAY }),
    planned({ id: 'old', start: NOW - 30 * DAY, end: NOW + 30 * DAY, firstSeen: NOW - 31 * DAY }),
    planned({ id: 'later', start: NOW + 20 * DAY, end: NOW + 22 * DAY }),
    planned({
      id: 'friday',
      mode: 'bus',
      routes: ['17'],
      start: eastern(2026, 11, 13, 9),
      end: eastern(2026, 11, 13, 15),
    }),
    // One alert on two networks is one item.
    planned({ id: 'both', alertId: 'x', start: NOW + DAY, end: NOW + 2 * DAY }),
    planned({
      id: 'both-bus',
      alertId: 'x',
      mode: 'bus',
      routes: ['L1-OWL'],
      start: NOW + DAY,
      end: NOW + 2 * DAY,
    }),
    // Over already, resolved, and not planned at all.
    planned({ id: 'past', start: NOW - 5 * DAY, end: NOW - DAY }),
    {
      ...planned({ id: 'gone', start: NOW, end: NOW + DAY }),
      lifecycle: { first_seen_ts: NOW, active: false },
    },
    {
      id: 'live',
      mode: 'metro',
      routes: ['b1'],
      lifecycle: { first_seen_ts: NOW - HOUR, active: true },
      official_alert: { id: 'live', headline: 'Trains are delayed', septa: { type: 'ALERT' } },
      detections: [],
    },
  ];

  it('lists each planned alert once, soonest first', () => {
    const items = plannedItems(INCIDENTS, NOW);
    expect(items.map((i) => i.id)).toEqual(['old', 'now', 'both', 'friday', 'weekend', 'later']);
    const both = items.find((i) => i.id === 'both');
    expect(both.kinds).toEqual(['metro', 'bus']);
    expect(both.parts).toHaveLength(2);
    expect(filterPlanned(items, 'bus').map((i) => i.id)).toEqual(['both', 'friday']);
  });

  it('lays them out by the weekend, the days ahead, now, later and long-running', () => {
    const layout = layoutPlanned(plannedItems(INCIDENTS, NOW), NOW);
    expect(layout.weekend.items.map((i) => [i.id, i.startsThen])).toEqual([['weekend', true]]);
    expect(layout.weekend.longRunning).toBe(1);
    expect(layout.days.map((d) => d.items.map((i) => i.id))).toEqual([
      ['both'],
      ['friday'],
      ['weekend'],
    ]);
    expect(layout.now.map((i) => i.id)).toEqual(['now']);
    expect(layout.ongoing.map((i) => i.id)).toEqual(['old']);
    expect(layout.later.map((i) => i.id)).toEqual(['later']);
  });

  it('knows the weekend coming, and the one under way', () => {
    const day = (ts) => new Date(ts).toISOString().slice(0, 10);
    expect(day(comingWeekend(NOW).saturday)).toBe('2026-11-14');
    expect(day(comingWeekend(eastern(2026, 11, 15, 10)).saturday)).toBe('2026-11-14');
    expect(day(comingWeekend(eastern(2026, 11, 16, 10)).saturday)).toBe('2026-11-21');
  });

  it("puts an item's dates in words", () => {
    const items = Object.fromEntries(plannedItems(INCIDENTS, NOW).map((i) => [i.id, i]));
    expect(windowText(items.weekend, NOW)).toBe('Sat, Nov 14, 5:00 AM – Sun, Nov 15');
    expect(windowText(items.now, NOW)).toBe('Through Thu, Nov 12');
    // An end at midnight is the whole of the day before; an end at a time is that time.
    expect(
      windowText({ ...items.now, endTs: eastern(2026, 11, 16), endDateOnly: false }, NOW),
    ).toBe('Through Sun, Nov 15');
    expect(
      windowText({ ...items.now, endTs: eastern(2026, 11, 11, 16), endDateOnly: false }, NOW),
    ).toBe('Until Wed, Nov 11, 4:00 PM');
    expect(windowText({ ...items.now, endTs: Date.UTC(2027, 7, 25, 3, 59) }, NOW)).toBe(
      'Through Tue, Aug 24, 2027',
    );
    expect(windowText({ ...items.friday, endDateOnly: false }, NOW)).toBe(
      'Fri, Nov 13, 9:00 AM – 3:00 PM',
    );
    expect(windowText({ ...items.old, endTs: null }, NOW)).toBe(
      'Since Mon, Oct 12 · no end date posted',
    );
    expect(windowText({ ...items.later, endTs: null }, NOW)).toMatch(/^From Tue, Dec 1/);
  });
});

describe('schedule changes', () => {
  it('writes clock times and day changes', () => {
    expect(secClock(18000)).toBe('5:00 AM');
    expect(secClock(93960)).toBe('2:06 AM');
    expect(dayChange({ trips: [183, 153], first: [100, 100], last: [200, 200] })).toEqual({
      trips: '183 → 153 (−30)',
      times: [],
    });
    expect(dayChange({ trips: [2, 0], first: [1, null], last: [2, null] }).trips).toBe(
      'no service (was 2)',
    );
    expect(dayChange({ trips: [0, 40], first: [null, 1], last: [null, 2] }).trips).toBe('new: 40');
    expect(dayChange({ trips: [90, 90], first: [18000, 19800], last: [86400, 82800] })).toEqual({
      trips: null,
      times: ['first trip 5:00 AM → 5:30 AM', 'last trip 12:00 AM → 11:00 PM'],
    });
  });

  it('summarises a change set', () => {
    const set = {
      routes: [
        { route: '26', mode: 'bus', kind: 'changed', delta: -150 },
        { route: 'b2', mode: 'metro', kind: 'changed', delta: -2 },
        { route: '31', mode: 'bus', kind: 'new', delta: 200 },
        { route: 'M1-Bus', mode: 'bus', kind: 'ended', delta: -818 },
      ],
    };
    expect(changeSummary(set)).toEqual({ routes: 4, added: 1, ended: 1, fewer: 3, more: 1 });
    expect(routesFor(set, 'metro').map((r) => r.route)).toEqual(['b2']);
    expect(routesFor(set).length).toBe(4);
    expect(percentChange([14904, 14778])).toBe('−0.8%');
    expect(percentChange([100, 100])).toBeNull();
  });

  it('says when a change takes effect', () => {
    expect(effectiveLabel('2026-12-20', '2026-12-11')).toBe('in 9 days');
    expect(effectiveLabel('2026-12-20', '2026-12-19')).toBe('tomorrow');
    expect(effectiveLabel('2026-12-20', '2026-12-20')).toBe('today');
    expect(effectiveLabel('2026-12-20', '2026-12-25')).toBe('in effect');
    expect(daysBetween('2026-11-11', '2026-11-26')).toBe(15);
    expect(phillyDateKey(eastern(2026, 11, 11, 23, 30))).toBe('2026-11-11');
  });

  it('describes special days', () => {
    const thanksgiving = {
      date: '2026-11-26',
      trips: 8437,
      typical: 14904,
      like: 'sunday',
      kind: 'reduced',
      routes_off: ['1', '8'],
    };
    const schools = {
      date: '2026-11-27',
      trips: 14568,
      typical: 14904,
      like: null,
      kind: 'routes-off',
      routes_off: ['409', '411'],
    };
    expect(specialDayText(thanksgiving)).toBe(
      'Buses and Metro run a Sunday timetable: 8,437 trips, 57% of a usual Thursday.',
    );
    expect(specialDayText(schools)).toBe(
      "The 2 school routes (400s) don't run. Everything else runs a usual Friday.",
    );
    expect(specialDayText({ ...schools, routes_off: ['17'] })).toBe(
      "1 route that usually runs on a Friday doesn't.",
    );
    const file = { special_days: [thanksgiving, schools] };
    expect(upcomingSpecialDays(file, '2026-11-27').map((d) => d.date)).toEqual(['2026-11-27']);
    expect(upcomingSpecialDays(null, '2026-11-27')).toEqual([]);
  });
});

describe('slow zones', () => {
  const zone = (over) => ({
    mode: 'bus',
    route: '21',
    dir: '0',
    direction: 'Eastbound',
    mph: 3.9,
    name: 'Chestnut St, 17th St to 12th St',
    points: [
      [39.95, -75.17],
      [39.95, -75.16],
    ],
    ...over,
  });
  const FILE = {
    schema_version: 1,
    generated_at: NOW - HOUR,
    zones: [
      zone({ route: '47', mph: 6.2 }),
      zone({}),
      zone({ mode: 'metro', route: 't2', mph: 12 }),
    ],
  };

  it('reads the layer from the URL', () => {
    expect(wantsSlowZones('?layer=slow')).toBe(true);
    expect(wantsSlowZones('?modes=bus')).toBe(false);
  });

  it('lists the zones of the modes on show, slowest first, each in its speed band', () => {
    const rows = slowZoneRows(FILE, ['bus', 'metro', 'rail'], NOW);
    expect(rows.map((z) => [z.label, z.href, z.band.label])).toEqual([
      ['Route 21', '/route/21', 'under 5 mph'],
      ['Route 47', '/route/47', '5–10'],
      ['T2', '/line/t2', '10–15'],
    ]);
    expect(slowZoneRows(FILE, ['rail'], NOW)).toEqual([]);
    expect(slowZoneBands(rows).map((b) => b.label)).toEqual(['under 5 mph', '5–10', '10–15']);
  });

  it('draws them slowest on top, each saying what it is', () => {
    const lines = slowZoneLines(slowZoneRows(FILE, ['bus'], NOW));
    expect(lines.map((l) => l.id)).toEqual(['slow:bus:47:0', 'slow:bus:21:0']);
    expect(lines[1]).toMatchObject({
      color: '#ff2a2a',
      tip: 'Route 21 · 3.9 mph · Chestnut St, 17th St to 12th St',
    });
  });

  it('leaves out a file from a bot server gone quiet', () => {
    expect(slowZoneRows(FILE, ['bus'], NOW + 4 * DAY)).toEqual([]);
    expect(slowZoneRows(null, ['bus'], NOW)).toEqual([]);
  });
});

describe('elevator reliability', () => {
  const outage = (unit, start, end, over = {}) => ({
    id: `${unit}-${start}`,
    unit_key: `elevator:8th-market:${unit}`,
    mode: 'metro',
    station: { slug: '8th-market', name: '8th-Market', lines: ['l1'] },
    unit_label: unit,
    lifecycle: { first_seen_ts: start, restored_ts: end, active: end == null },
    ...over,
  });
  const OUTAGES = [
    outage('eastbound', NOW - 20 * DAY, NOW - 19 * DAY),
    outage('eastbound', NOW - 10 * DAY, NOW - 10 * DAY + 6 * HOUR),
    outage('eastbound', NOW - 2 * DAY, null),
    outage('westbound', NOW - 5 * DAY, NOW - 5 * DAY + 2 * HOUR),
    outage('north', NOW - 3 * DAY, NOW - 3 * DAY + 4 * HOUR, {
      unit_key: 'elevator:suburban-station:north',
      mode: 'regional_rail',
      station: { slug: 'suburban-station', name: 'Suburban Station', lines: ['pao'] },
    }),
    // Before the window.
    outage('westbound', NOW - 200 * DAY, NOW - 199 * DAY),
  ];
  const opts = { now: NOW, windowDays: 90, dataStartTs: NOW - 40 * DAY };

  it('gives each elevator its outages, uptime over what the archive covers, and repair time', () => {
    const rows = elevatorReliability(OUTAGES, opts);
    expect(rows.map((r) => [r.name, r.unit, r.outageCount])).toEqual([
      ['8th-Market', 'eastbound', 3],
      ['Suburban Station', 'north', 1],
      ['8th-Market', 'westbound', 1],
    ]);
    const [east] = rows;
    // Down 1 day + 6 hours + 2 days of the 40 the archive covers.
    expect(east.uptime).toBeCloseTo(1 - 3.25 / 40, 5);
    expect(east.currentlyOut).toBe(true);
    expect(east.longestMs).toBe(2 * DAY);
    // The median of the two finished outages: 1 day and 6 hours.
    expect(east.typicalRepairMs).toBe((DAY + 6 * HOUR) / 2);
    expect(elevatorReliability(OUTAGES, { ...opts, kind: 'rail' })).toHaveLength(1);
    expect(elevatorReliability(OUTAGES, { ...opts, line: 'b1' })).toEqual([]);
  });

  it('sums it up', () => {
    expect(reliabilitySummary(OUTAGES, opts)).toMatchObject({
      elevators: 3,
      repeat: 1,
      outages: 5,
      typicalRepairMs: 5 * HOUR,
      longestRepairMs: DAY,
      coveredDays: 40,
    });
    expect(reliabilitySummary([], opts)).toMatchObject({ elevators: 0, typicalRepairMs: null });
  });

  it('writes an uptime share', () => {
    expect(formatUptime(0.91875)).toBe('91.9%');
    expect(formatUptime(0.99999)).toBe('99.9%+');
  });
});

describe('navigation', () => {
  it('puts the new pages under their tabs', () => {
    expect(activeNavKey('/scorecards')).toBe('history');
    expect(activeNavKey('/planned')).toBe('now');
    expect(activeNavKey('/schedule-changes/')).toBe('now');
  });
});
