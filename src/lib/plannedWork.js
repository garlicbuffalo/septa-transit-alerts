// Planned work ahead: SEPTA's advisories and short detours that are scheduled
// rather than unfolding (see isPlannedIncident), read from the same archive as
// everything else and laid out by date instead of by "active now".
import { phillyDayUTC } from './format.js';
import {
  incidentLifecycle,
  isPlannedIncident,
  isPlannedWork,
  legacyKind,
  officialAlert,
} from './incidents.js';

const DAY_MS = 24 * 60 * 60 * 1000;
// Work that began longer ago than this is long-running: still listed, apart.
export const LONG_RUNNING_DAYS = 14;
export const AHEAD_DAYS = 7;

/**
 * The planned work in the archive that hasn't ended: one item per SEPTA alert
 * (an alert spanning Metro and bus is two incidents, one item), with its
 * stated window and the lines it names.
 * @param {object[]} incidents the published incidents (wire shape)
 * @returns {Array<{ id: string, headline: string, description: string | null,
 *   startTs: number, endTs: number | null, startDateOnly: boolean, endDateOnly: boolean,
 *   postedTs: number, parts: Array<{ kind: string, routes: string[] }>, kinds: string[] }>}
 */
export function plannedItems(incidents = [], now = Date.now()) {
  const byAlert = new Map();
  for (const inc of incidents) {
    const alert = officialAlert(inc);
    const life = incidentLifecycle(inc);
    if (!alert || !life.active) continue;
    if (!isPlannedIncident(inc, now) && !isPlannedWork(inc)) continue;
    const w = alert.agency_event_window ?? {};
    if (w.end_ts != null && w.end_ts < now) continue;
    const kind = legacyKind(inc);
    const key = alert.id ?? inc.id;
    if (!byAlert.has(key)) {
      byAlert.set(key, {
        id: inc.id,
        headline: alert.headline ?? 'Planned service change',
        description: alert.description ?? null,
        startTs: w.start_ts ?? life.first_seen_ts ?? now,
        endTs: w.end_ts ?? null,
        startDateOnly: w.start_is_date_only === true,
        endDateOnly: w.end_is_date_only === true,
        postedTs: life.first_seen_ts ?? now,
        parts: [],
      });
    }
    byAlert.get(key).parts.push({ kind, routes: inc.routes ?? [] });
  }
  return [...byAlert.values()]
    .map((item) => ({ ...item, kinds: [...new Set(item.parts.map((p) => p.kind))] }))
    .sort((a, b) => a.startTs - b.startTs || a.id.localeCompare(b.id));
}

/** Items touching a kind ('metro' | 'bus' | 'rail'), or all of them for null. */
export function filterPlanned(items, kind = null) {
  return kind ? items.filter((i) => i.kinds.includes(kind)) : items;
}

/** The Philadelphia Saturday and Sunday coming (or under way), as phillyDayUTC values. */
export function comingWeekend(now = Date.now()) {
  const today = phillyDayUTC(now);
  const wd = new Date(today).getUTCDay();
  const saturday = wd === 0 ? today - DAY_MS : today + (6 - wd) * DAY_MS;
  return { saturday, sunday: saturday + DAY_MS };
}

// Whether an item's window covers any part of the Philadelphia days [fromDay, toDay].
function coversDays(item, fromDay, toDay) {
  const start = phillyDayUTC(item.startTs);
  // An end at midnight is the end of the day before, not a minute of the next.
  const end = item.endTs == null ? Number.POSITIVE_INFINITY : phillyDayUTC(item.endTs - 60_000);
  return start <= toDay && end >= fromDay;
}

/**
 * The items laid out for the page:
 *   weekend   what covers the coming weekend, the work that starts with it
 *             first (`startsThen`); long-running work is only counted
 *   days      the next AHEAD_DAYS days, each with the items that start that day
 *   now       in effect now and not long-running
 *   ongoing   in effect now, begun over LONG_RUNNING_DAYS ago
 *   later     starting after the days ahead
 */
export function layoutPlanned(items, now = Date.now()) {
  const today = phillyDayUTC(now);
  const { saturday, sunday } = comingWeekend(now);
  const longRunning = (i) => now - i.startTs > LONG_RUNNING_DAYS * DAY_MS;
  const started = (i) => i.startTs <= now;

  // Long-running work covers every weekend: it's counted here and listed in its own section.
  const covering = items.filter((i) => coversDays(i, saturday, sunday));
  const weekend = covering
    .filter((i) => !(started(i) && longRunning(i)))
    .map((i) => ({ ...i, startsThen: phillyDayUTC(i.startTs) >= saturday - DAY_MS && !started(i) }))
    .sort((a, b) => Number(b.startsThen) - Number(a.startsThen) || a.startTs - b.startTs);

  const days = [];
  for (let n = 0; n < AHEAD_DAYS; n++) {
    const day = today + n * DAY_MS;
    const starting = items.filter((i) => !started(i) && phillyDayUTC(i.startTs) === day);
    if (starting.length) days.push({ day, items: starting });
  }
  const horizon = today + (AHEAD_DAYS - 1) * DAY_MS;
  return {
    weekend: {
      saturday,
      sunday,
      items: weekend,
      longRunning: covering.length - weekend.length,
    },
    days,
    now: items.filter((i) => started(i) && !longRunning(i)),
    ongoing: items.filter((i) => started(i) && longRunning(i)),
    later: items.filter((i) => !started(i) && phillyDayUTC(i.startTs) > horizon),
  };
}

const dateFmt = (ts, opts) =>
  new Date(ts).toLocaleDateString('en-US', { timeZone: 'America/New_York', ...opts });
const timeFmt = (ts) =>
  new Date(ts).toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
  });

const yearOf = (ts) => dateFmt(ts, { year: 'numeric' });

/** "Sat, Nov 14" for an instant, in Philadelphia; with the year when it isn't this one. */
export const dayText = (ts, now = Date.now()) =>
  dateFmt(ts, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(yearOf(ts) !== yearOf(now) && { year: 'numeric' }),
  });

const isMidnight = (ts) => timeFmt(ts) === '12:00 AM';

// A moment a window starts: the date, and the time unless SEPTA gave only a date.
const startText = (item, now) =>
  item.startDateOnly
    ? dayText(item.startTs, now)
    : `${dayText(item.startTs, now)}, ${timeFmt(item.startTs)}`;

// The moment a window ends. SEPTA writes "through Sunday" as 11:59 PM Sunday or as midnight
// Monday: both are the whole of Sunday.
const endsWholeDay = (item) => item.endDateOnly || isMidnight(item.endTs);
const endText = (item, now) =>
  endsWholeDay(item)
    ? dayText(isMidnight(item.endTs) ? item.endTs - 60_000 : item.endTs, now)
    : `${dayText(item.endTs, now)}, ${timeFmt(item.endTs)}`;

/**
 * An item's dates in words: "Sat, Nov 14, 5:00 AM – Sun, Nov 15", "Through Sat,
 * Dec 19", "Until Wed, Nov 11, 4:00 PM", "Since Oct 30 · no end date posted".
 */
export function windowText(item, now = Date.now()) {
  if (item.startTs > now) {
    const start = startText(item, now);
    if (item.endTs == null) return `From ${start}`;
    const lastDay = isMidnight(item.endTs) ? item.endTs - 60_000 : item.endTs;
    // One day's work reads as that day, or a time range within it.
    if (phillyDayUTC(item.startTs) === phillyDayUTC(lastDay)) {
      return item.startDateOnly || endsWholeDay(item) ? start : `${start} – ${timeFmt(item.endTs)}`;
    }
    return `${start} – ${endText(item, now)}`;
  }
  if (item.endTs == null) return `Since ${dayText(item.startTs, now)} · no end date posted`;
  return `${endsWholeDay(item) ? 'Through' : 'Until'} ${endText(item, now)}`;
}
