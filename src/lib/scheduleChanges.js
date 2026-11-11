// Reading schedule-changes.json (collector/lib/scheduleChanges.js): the changes
// SEPTA's published bus and Metro timetable holds, route by route, and the days
// ahead whose service isn't the usual for their weekday.
import { formatBusRoute } from './busRoutes.js';
import { METRO_LINES } from './metroLines.js';

export const DAY_TYPES = ['weekday', 'saturday', 'sunday'];
export const DAY_TYPE_LABELS = { weekday: 'Weekday', saturday: 'Saturday', sunday: 'Sunday' };

const utc = (key) => new Date(`${key}T12:00:00Z`);
const fmt = (key, opts) => utc(key).toLocaleDateString('en-US', { timeZone: 'UTC', ...opts });

/** "Sun, Dec 20" for a date key. */
export const shortDate = (key) => fmt(key, { weekday: 'short', month: 'short', day: 'numeric' });
/** "Sunday, December 20, 2026" for a date key. */
export const longDate = (key) =>
  fmt(key, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
/** "Thursday" for a date key. */
export const weekdayName = (key) => fmt(key, { weekday: 'long' });

/** The Philadelphia calendar date of an instant, as a date key. */
export function phillyDateKey(ts) {
  return new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/** Whole days from one date key to another (negative when `to` is earlier). */
export function daysBetween(from, to) {
  return Math.round((utc(to) - utc(from)) / (24 * 60 * 60 * 1000));
}

/** "5:10 AM" for seconds past a service day's midnight (25:10:00 is 1:10 AM). */
export function secClock(sec) {
  if (sec == null) return null;
  const m = Math.round(sec / 60) % 1440;
  const h = Math.floor(m / 60);
  return `${h % 12 || 12}:${String(m % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** A route's label and page from its key and mode ('bus' | 'metro'). */
export function changeRoute(r) {
  if (r.mode === 'metro') {
    return { kind: 'metro', label: METRO_LINES[r.route]?.label ?? r.route.toUpperCase() };
  }
  return { kind: 'bus', label: formatBusRoute(r.route) };
}

/** When a change set takes effect, against today: "in 9 days", "tomorrow", "in effect since". */
export function effectiveLabel(effective, todayKey) {
  const days = daysBetween(todayKey, effective);
  if (days > 1) return `in ${days} days`;
  if (days === 1) return 'tomorrow';
  if (days === 0) return 'today';
  return 'in effect';
}

/**
 * One kind of day's change for a route, as text: "183 → 153 trips (−30)",
 * "no service (was 2 trips)", "new: 40 trips", and a first or last trip that moved.
 * @returns {{ trips: string | null, times: string[] }}
 */
export function dayChange(d) {
  const [before, after] = d.trips;
  let trips = null;
  if (before !== after) {
    const delta = after - before;
    if (!after) trips = `no service (was ${before})`;
    else if (!before) trips = `new: ${after}`;
    else trips = `${before} → ${after} (${delta > 0 ? '+' : '−'}${Math.abs(delta)})`;
  }
  const times = [];
  if (before && after) {
    if (d.first[0] != null && d.first[1] != null && d.first[0] !== d.first[1]) {
      times.push(`first trip ${secClock(d.first[0])} → ${secClock(d.first[1])}`);
    }
    if (d.last[0] != null && d.last[1] != null && d.last[0] !== d.last[1]) {
      times.push(`last trip ${secClock(d.last[0])} → ${secClock(d.last[1])}`);
    }
  }
  return { trips, times };
}

/** A change set's routes for one mode filter ('all' | 'bus' | 'metro'). */
export function routesFor(set, mode = 'all') {
  return (set?.routes ?? []).filter((r) => mode === 'all' || r.mode === mode);
}

/** Counts for a change set's summary line. */
export function changeSummary(set) {
  const routes = set?.routes ?? [];
  let fewer = 0;
  let more = 0;
  for (const r of routes) {
    if (r.delta < 0) fewer++;
    else if (r.delta > 0) more++;
  }
  return {
    routes: routes.length,
    added: routes.filter((r) => r.kind === 'new').length,
    ended: routes.filter((r) => r.kind === 'ended').length,
    fewer,
    more,
  };
}

/** The percent change of a [before, after] pair, as "−0.8%" (null when unchanged or no base). */
export function percentChange([before, after]) {
  if (!before || before === after) return null;
  const p = ((after - before) / before) * 100;
  return `${p > 0 ? '+' : '−'}${Math.abs(p).toFixed(1)}%`;
}

/** What a special day's service is, in a phrase. */
export function specialDayText(day) {
  const share = `${Math.round((100 * day.trips) / day.typical)}%`;
  if (day.kind === 'routes-off') {
    const n = day.routes_off.length;
    return day.routes_off.every((r) => /^4\d\d$/.test(r))
      ? `The ${n} school routes (400s) don't run. Everything else runs a usual ${weekdayName(day.date)}.`
      : `${n} route${n === 1 ? '' : 's'} that usually run${n === 1 ? 's' : ''} on a ${weekdayName(day.date)} ${n === 1 ? "doesn't" : "don't"}.`;
  }
  if (day.like) {
    return `Buses and Metro run a ${day.like === 'sunday' ? 'Sunday' : 'Saturday'} timetable: ${day.trips.toLocaleString('en-US')} trips, ${share} of a usual ${weekdayName(day.date)}.`;
  }
  return day.kind === 'extra'
    ? `Buses and Metro run extra service: ${day.trips.toLocaleString('en-US')} trips, ${share} of a usual ${weekdayName(day.date)}.`
    : `Buses and Metro run a reduced timetable: ${day.trips.toLocaleString('en-US')} trips, ${share} of a usual ${weekdayName(day.date)}.`;
}

/** The special days from today on, soonest first. */
export function upcomingSpecialDays(file, todayKey) {
  return (file?.special_days ?? []).filter((d) => d.date >= todayKey);
}
