// What SEPTA's published timetable says is coming, for buses and SEPTA Metro (the schedule
// index covers those; Regional Rail's timetable is a separate GTFS feed the collector doesn't
// read):
//
// - Schedule changes. A timetable is regular between the dates its services start and end
//   (calendar.txt), so those dates cut the feed into periods. Each period gets a profile: per
//   route, the trips on a typical weekday, Saturday and Sunday, and the first and last one.
//   Two periods that follow each other (in one feed, or the last of the outgoing feed and the
//   first of a new one) are compared route by route: that is a change set, effective the day
//   the later period starts.
// - Special days. SEPTA's calendar_dates.txt has exceptions on nearly every date (its school
//   trips are added day by day), so "a date with an exception" says nothing. A date is special
//   when its trips differ from the period's typical day of the same kind: a holiday running a
//   Sunday or Saturday timetable, or a day a set of routes doesn't run at all (the 400-series
//   school routes, on a day schools are closed).
//
// "Typical" is the median over the period's dates of that kind, so a holiday in the period
// doesn't pull it, and trips SEPTA adds date by date still count.
import { join } from 'node:path';
import { writeFileAtomic } from './files.js';
import { classifyRoute } from './network.js';
import { easternDateKey } from './time.js';

export const SCHEDULE_CHANGES_FILE = 'schedule-changes.json';
export const SCHEDULE_CHANGES_VERSION = 1;
export const DAY_TYPES = ['weekday', 'saturday', 'sunday'];

export const CHANGES_CONFIG = {
  // Dates of each kind a period's typical day is the median of.
  sampleDates: 11,
  // …taken from across the period, as far as this many days into it.
  maxPeriodDays: 200,
  // A period shorter than this is folded into the one before it.
  minPeriodDays: 5,
  // A first or last trip must move this far (seconds) to count as a change.
  minShiftSec: 10 * 60,
  // How far ahead special days are listed.
  horizonDays: 28,
  // A day's trips this far from typical (as a share) make it a reduced or extra day…
  bigShare: 0.1,
  // …and within this share of a typical Sunday or Saturday, it runs that timetable.
  likeShare: 0.05,
  // Otherwise it's special when this many routes that usually run don't.
  minRoutesOff: 5,
  // Change sets are kept this long after they took effect.
  keepDays: 180,
};

const DAY_MS = 24 * 60 * 60 * 1000;
const keyOf = (ymd) => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
const utc = (key) => new Date(`${key}T12:00:00Z`);
const partsOf = (key) => {
  const [year, month, day] = key.split('-').map(Number);
  return { year, month, day };
};

/** A YYYY-MM-DD key moved by whole days. */
export function shiftKey(key, days) {
  return new Date(utc(key).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

/** 'weekday', 'saturday' or 'sunday' for a date key. */
export function dayTypeOf(key) {
  const wd = utc(key).getUTCDay();
  return wd === 0 ? 'sunday' : wd === 6 ? 'saturday' : 'weekday';
}

// US holidays SEPTA runs a holiday timetable on, by rule; null for any other date. Only names
// the day: whether its service differs comes from the timetable itself.
const nth = (key, weekday, n) => {
  const d = utc(key);
  return d.getUTCDay() === weekday && Math.ceil(d.getUTCDate() / 7) === n;
};
const last = (key, weekday) => {
  const d = utc(key);
  return d.getUTCDay() === weekday && utc(shiftKey(key, 7)).getUTCMonth() !== d.getUTCMonth();
};
/** "Thanksgiving", "Christmas Day", … for a date key, or null. */
export function holidayName(key) {
  const md = key.slice(5);
  const month = Number(md.slice(0, 2));
  if (md === '01-01') return "New Year's Day";
  if (md === '06-19') return 'Juneteenth';
  if (md === '07-04') return 'Independence Day';
  if (md === '12-24') return 'Christmas Eve';
  if (md === '12-25') return 'Christmas Day';
  if (md === '12-31') return "New Year's Eve";
  if (md === '11-11') return 'Veterans Day';
  if (month === 1 && nth(key, 1, 3)) return 'Martin Luther King Jr. Day';
  if (month === 2 && nth(key, 1, 3)) return "Presidents' Day";
  if (month === 5 && last(key, 1)) return 'Memorial Day';
  if (month === 9 && nth(key, 1, 1)) return 'Labor Day';
  if (month === 10 && nth(key, 1, 2)) return 'Indigenous Peoples’ Day';
  if (month === 11 && nth(key, 4, 4)) return 'Thanksgiving';
  if (month === 11 && nth(shiftKey(key, -1), 4, 4)) return 'the day after Thanksgiving';
  return null;
}

// Each service's trips by route: service → Map(route → [trips, first start, last start]),
// built once per schedule.
const tallies = new WeakMap();
function serviceTallies(schedule) {
  if (tallies.has(schedule)) return tallies.get(schedule);
  const out = new Map();
  for (const t of Object.values(schedule.index.trips)) {
    const [route, , service, start] = t;
    if (!out.has(service)) out.set(service, new Map());
    const byRoute = out.get(service);
    const r = byRoute.get(route);
    if (!r) byRoute.set(route, [1, start, start]);
    else {
      r[0]++;
      if (start < r[1]) r[1] = start;
      if (start > r[2]) r[2] = start;
    }
  }
  tallies.set(schedule, out);
  return out;
}

/**
 * The trips scheduled on a date, by route: route → [trips, first start, last start] (seconds
 * past the service date's midnight).
 * @param {import('./schedule.js').Schedule} schedule
 * @param {string} key YYYY-MM-DD
 * @returns {Map<string, number[]>}
 */
export function tripsOn(schedule, key) {
  const date = partsOf(key);
  const out = new Map();
  for (const [service, byRoute] of serviceTallies(schedule)) {
    if (!schedule.serviceRuns(service, date)) continue;
    for (const [route, [n, first, lastStart]] of byRoute) {
      const r = out.get(route);
      if (!r) out.set(route, [n, first, lastStart]);
      else {
        r[0] += n;
        if (first < r[1]) r[1] = first;
        if (lastStart > r[2]) r[2] = lastStart;
      }
    }
  }
  return out;
}

/**
 * The periods a feed's regular timetable is cut into, as inclusive date keys: one between each
 * pair of dates a weekly service starts or stops.
 * @returns {Array<{ start: string, end: string }>} in date order; empty for a feed with no dates
 */
export function schedulePeriods(index, cfg = CHANGES_CONFIG) {
  const regular = Object.values(index.services ?? {}).filter(
    (s) => s.start && s.end && s.days?.includes('1'),
  );
  let first = null;
  let end = null;
  const cuts = new Set();
  if (regular.length) {
    for (const s of regular) {
      cuts.add(keyOf(s.start));
      cuts.add(shiftKey(keyOf(s.end), 1));
    }
    const sorted = [...cuts].sort();
    first = sorted[0];
    end = shiftKey(sorted.at(-1), -1);
  } else {
    // A feed that lists every date: one period over all of them.
    const dates = Object.values(index.services ?? {})
      .flatMap((s) => s.add ?? [])
      .sort();
    if (!dates.length) return [];
    first = keyOf(dates[0]);
    end = keyOf(dates.at(-1));
    cuts.add(first);
  }
  const starts = [...cuts].filter((k) => k >= first && k <= end).sort();
  const periods = [];
  for (let i = 0; i < starts.length; i++) {
    const stop = i + 1 < starts.length ? shiftKey(starts[i + 1], -1) : end;
    const days = Math.round((utc(stop) - utc(starts[i])) / DAY_MS) + 1;
    if (periods.length && days < cfg.minPeriodDays) periods.at(-1).end = stop;
    else periods.push({ start: starts[i], end: stop });
  }
  return periods;
}

/**
 * A period's typical days: per route, [trips, first start, last start] on a typical weekday,
 * Saturday and Sunday (null when it doesn't run then), and the total trips of each.
 */
export function periodProfile(schedule, period, cfg = CHANGES_CONFIG) {
  // Dates spread over the whole period, so a run of unusual days at one end of it (the school
  // break at Christmas) is a few of them, not most.
  const all = { weekday: [], saturday: [], sunday: [] };
  for (
    let k = period.start, i = 0;
    k <= period.end && i < cfg.maxPeriodDays;
    k = shiftKey(k, 1), i++
  ) {
    all[dayTypeOf(k)].push(k);
  }
  const dates = {};
  for (const type of DAY_TYPES) {
    const list = all[type];
    const n = Math.min(cfg.sampleDates, list.length);
    dates[type] = Array.from({ length: n }, (_, i) => list[Math.floor((i * list.length) / n)]);
  }
  const routes = {};
  const totals = {};
  for (const type of DAY_TYPES) {
    const days = dates[type].map((k) => tripsOn(schedule, k));
    const seen = new Set(days.flatMap((d) => [...d.keys()]));
    let total = 0;
    for (const route of seen) {
      // The median day for this route; a route that runs on under half the dates doesn't
      // usually run.
      const sorted = days.map((d) => d.get(route) ?? [0, null, null]).sort((a, b) => a[0] - b[0]);
      const typical = sorted[Math.floor(sorted.length / 2)];
      if (!typical[0]) continue;
      routes[route] ??= { weekday: null, saturday: null, sunday: null };
      routes[route][type] = typical;
      total += typical[0];
    }
    totals[type] = total;
  }
  return { start: period.start, end: period.end, totals, routes };
}

/**
 * Every period of a schedule from `fromKey` on, with its profile (the period under way
 * included, profiled from its own start).
 */
export function scheduleProfile(schedule, { fromKey, cfg = CHANGES_CONFIG }) {
  const periods = schedulePeriods(schedule.index, cfg)
    .filter((p) => p.end >= fromKey)
    .map((p) => periodProfile(schedule, p, cfg));
  return {
    feed_version: schedule.index.feed_version ?? null,
    built_at: schedule.index.built_at ?? null,
    periods,
  };
}

/**
 * What changes between two periods' profiles, route by route.
 * @returns {Array<{ route: string, mode: string, kind: 'new' | 'ended' | 'changed',
 *   days: Record<string, { trips: [number, number], first: [number|null, number|null],
 *   last: [number|null, number|null] }>, delta: number }>} biggest change in trips first
 */
export function diffProfiles(before, after, cfg = CHANGES_CONFIG) {
  const out = [];
  const routes = new Set([...Object.keys(before.routes), ...Object.keys(after.routes)]);
  for (const route of routes) {
    const a = before.routes[route];
    const b = after.routes[route];
    const days = {};
    let delta = 0;
    for (const type of DAY_TYPES) {
      const x = a?.[type] ?? null;
      const y = b?.[type] ?? null;
      if (!x && !y) continue;
      const moved = (i) =>
        x && y && x[i] != null && y[i] != null && Math.abs(x[i] - y[i]) >= cfg.minShiftSec;
      if ((x?.[0] ?? 0) === (y?.[0] ?? 0) && !moved(1) && !moved(2)) continue;
      days[type] = {
        trips: [x?.[0] ?? 0, y?.[0] ?? 0],
        first: [x?.[1] ?? null, y?.[1] ?? null],
        last: [x?.[2] ?? null, y?.[2] ?? null],
      };
      // A weekday counts five times toward a week's trips.
      delta += ((y?.[0] ?? 0) - (x?.[0] ?? 0)) * (type === 'weekday' ? 5 : 1);
    }
    if (!Object.keys(days).length) continue;
    out.push({
      route,
      mode: classifyRoute(route)?.mode ?? 'bus',
      kind: !a ? 'new' : !b ? 'ended' : 'changed',
      days,
      delta,
    });
  }
  return out.sort(
    (x, y) =>
      Math.abs(y.delta) - Math.abs(x.delta) ||
      x.route.localeCompare(y.route, 'en', { numeric: true }),
  );
}

function changeSet(before, after, { effective, feedVersion, fromFeedVersion = null, now, cfg }) {
  const routes = diffProfiles(before, after, cfg);
  return {
    id: effective,
    effective,
    feed_version: feedVersion,
    from_feed_version: fromFeedVersion,
    detected_ts: now,
    totals: Object.fromEntries(
      DAY_TYPES.map((t) => [t, [before.totals[t] ?? 0, after.totals[t] ?? 0]]),
    ),
    routes,
  };
}

/**
 * The change sets a new profile shows: one between each pair of its periods that follow each
 * other, and, when the feed itself is new, one from the outgoing feed's timetable to its first
 * period. Sets with nothing changed are left out.
 * @param {object | null} prev the profile kept from the last build (state)
 * @param {object} next the profile just built
 */
export function findChanges(prev, next, { now, cfg = CHANGES_CONFIG }) {
  const sets = [];
  const [first] = next.periods;
  if (prev?.periods?.length && first && prev.feed_version !== next.feed_version) {
    // The outgoing timetable as it was just before the new one starts.
    const dayBefore = shiftKey(first.start, -1);
    const outgoing =
      prev.periods.find((p) => p.start <= dayBefore && p.end >= dayBefore) ?? prev.periods.at(-1);
    sets.push(
      changeSet(outgoing, first, {
        effective: first.start,
        feedVersion: next.feed_version,
        fromFeedVersion: prev.feed_version,
        now,
        cfg,
      }),
    );
  }
  for (let i = 1; i < next.periods.length; i++) {
    sets.push(
      changeSet(next.periods[i - 1], next.periods[i], {
        effective: next.periods[i].start,
        feedVersion: next.feed_version,
        now,
        cfg,
      }),
    );
  }
  return sets.filter((s) => s.routes.length);
}

/**
 * How a date's service compares with its period's typical day of the same kind, or null when
 * it's an ordinary day (or the profile has no period for it).
 * @returns {{ date: string, day_type: string, holiday: string | null, trips: number,
 *   typical: number, like: 'sunday' | 'saturday' | null,
 *   kind: 'reduced' | 'extra' | 'routes-off', routes_off: string[] } | null}
 */
export function specialDay(schedule, profile, key, cfg = CHANGES_CONFIG) {
  const period = profile.periods.find((p) => p.start <= key && p.end >= key);
  if (!period) return null;
  const type = dayTypeOf(key);
  const typical = period.totals[type] ?? 0;
  if (!typical) return null;
  const actual = tripsOn(schedule, key);
  let trips = 0;
  for (const [n] of actual.values()) trips += n;
  const routesOff = Object.entries(period.routes)
    .filter(([route, r]) => r[type] && !actual.has(route))
    .map(([route]) => route)
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const share = (trips - typical) / typical;
  const near = (other) => {
    const t = period.totals[other] ?? 0;
    return other !== type && t > 0 && Math.abs(trips - t) / t <= cfg.likeShare;
  };
  const big = Math.abs(share) >= cfg.bigShare;
  if (!big && routesOff.length < cfg.minRoutesOff) return null;
  return {
    date: key,
    day_type: type,
    holiday: holidayName(key),
    trips,
    typical,
    like: big ? (near('sunday') ? 'sunday' : near('saturday') ? 'saturday' : null) : null,
    kind: big ? (share < 0 ? 'reduced' : 'extra') : 'routes-off',
    routes_off: routesOff,
  };
}

/** The special days from `fromKey` for `days` days, in date order. */
export function specialDays(schedule, profile, { fromKey, days, cfg = CHANGES_CONFIG }) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const day = specialDay(schedule, profile, shiftKey(fromKey, i), cfg);
    if (day) out.push(day);
  }
  return out;
}

/**
 * Bring the schedule-changes file up to date with a schedule: profile it, find what changes,
 * keep the change sets found on earlier days (one between two feeds can only be worked out the
 * day the new feed arrives), and list the special days ahead.
 * @param {object} opts
 * @param {import('./schedule.js').Schedule} opts.schedule
 * @param {object | null} opts.prevProfile the profile kept in the collector's state
 * @param {object | null} opts.prevFile the file as last published
 * @param {number} opts.now
 * @returns {{ profile: object, file: object }} the profile to keep, and the file to publish
 */
export function buildScheduleChanges({
  schedule,
  prevProfile = null,
  prevFile = null,
  now,
  cfg = CHANGES_CONFIG,
}) {
  const today = easternDateKey(now);
  const profile = scheduleProfile(schedule, { fromKey: today, cfg });
  const found = findChanges(prevProfile, profile, { now, cfg });
  const byId = new Map((prevFile?.changes ?? []).map((c) => [c.id, c]));
  for (const set of found) {
    // First seen when it was first found, whatever day it's found again.
    byId.set(set.id, { ...set, detected_ts: byId.get(set.id)?.detected_ts ?? set.detected_ts });
  }
  const oldest = shiftKey(today, -cfg.keepDays);
  const changes = [...byId.values()]
    .filter((c) => c.effective >= oldest)
    .sort((a, b) => b.effective.localeCompare(a.effective));
  const dates = Object.values(schedule.index.services ?? {})
    .flatMap((s) => [s.start, s.end, ...(s.add ?? [])])
    .filter(Boolean)
    .sort();
  return {
    profile,
    file: {
      schema_version: SCHEDULE_CHANGES_VERSION,
      generated_at: now,
      covers: ['bus', 'metro'],
      feed_version: profile.feed_version,
      feed_start: dates.length ? keyOf(dates[0]) : null,
      feed_end: dates.length ? keyOf(dates.at(-1)) : null,
      periods: profile.periods.map(({ start, end, totals }) => ({ start, end, totals })),
      changes,
      special_days: specialDays(schedule, profile, { fromKey: today, days: cfg.horizonDays, cfg }),
    },
  };
}

/** Write the file into the data directory; left alone when only its timestamp would change. */
export async function publishScheduleChanges(dir, file, prevFile = null) {
  const same = (f) => JSON.stringify({ ...f, generated_at: 0 });
  if (prevFile && same(prevFile) === same(file)) return false;
  await writeFileAtomic(join(dir, SCHEDULE_CHANGES_FILE), `${JSON.stringify(file)}\n`);
  return true;
}
