// Reading scorecards.json and rail-trains.json for the scorecards page and the
// strip on each route's page. The scores come from the bot server, which works
// them out for its weekly Hall of Fame posts (bot/features/halloffame.js): each
// measure is ranked among the week's routes and the score is the weighted
// average of those ranks, out of 100.
import { busRouteName, formatBusRoute } from './busRoutes.js';
import { METRO_LINES, metroLineFullName } from './metroLines.js';
import { RAIL_LINES, railLineFullName } from './railLines.js';

export const SCORE_MODES = [
  { key: 'bus', label: 'Buses', noun: 'routes' },
  { key: 'metro', label: 'SEPTA Metro', noun: 'lines' },
  { key: 'rail', label: 'Regional Rail', noun: 'lines' },
];

const pct = (v) => (v > 0 && v < 9.95 ? `${v.toFixed(1)}%` : `${Math.round(v)}%`);

// Each measure behind a score: its column heading, which way is better, and how
// a cell reads. `counts` holds bunching, gaps and (bus and Metro) cancelled
// trips as counted; `measures` holds what was ranked (rates, for those).
export const MEASURES = {
  onTime: { heading: 'On time', better: 'high', cell: (e) => pct(e.measures.onTime) },
  cancelled: {
    heading: 'Cancelled',
    better: 'low',
    cell: (e, mode) =>
      mode === 'rail' ? pct(e.measures.cancelled) : String(e.counts?.cancelled ?? 0),
  },
  speed: { heading: 'Mph', better: 'high', cell: (e) => e.measures.speed.toFixed(1) },
  bunching: { heading: 'Bunches', better: 'low', cell: (e) => String(e.counts?.bunching ?? 0) },
  gaps: { heading: 'Long gaps', better: 'low', cell: (e) => String(e.counts?.gaps ?? 0) },
  delay: { heading: 'Avg late', better: 'low', cell: (e) => `${e.measures.delay.toFixed(1)} min` },
};

/** The measures a mode is scored on, in the order its weights list them. */
export function measureKeys(file, mode) {
  return Object.keys(file?.weights?.[mode] ?? {}).filter((k) => MEASURES[k]);
}

/** A cell's text: "–" when the route had no figure for that measure. */
export function measureCell(entry, key, mode) {
  return entry.measures?.[key] == null ? '–' : MEASURES[key].cell(entry, mode);
}

/** "on time 30%, cancellations 20%, …" for a mode. */
export function weightsText(file, mode) {
  const names = {
    onTime: 'on time',
    cancelled: 'cancellations',
    speed: 'speed',
    bunching: 'bunching',
    gaps: 'gaps',
    delay: 'delays',
  };
  return Object.entries(file?.weights?.[mode] ?? {})
    .map(([key, w]) => `${names[key] ?? key} ${w}%`)
    .join(', ');
}

/** What a route is called in the table: its label, full name, and page. */
export function routeIdentity(mode, route) {
  if (mode === 'metro') {
    const info = METRO_LINES[route];
    return {
      label: info?.label ?? String(route).toUpperCase(),
      name: info ? metroLineFullName(route) : String(route).toUpperCase(),
      href: `/line/${route}`,
    };
  }
  if (mode === 'rail') {
    return {
      label: RAIL_LINES[route]?.label ?? route,
      name: railLineFullName(route) ?? route,
      href: `/rail/line/${route}`,
    };
  }
  return {
    label: formatBusRoute(route),
    name: busRouteName(route) ?? '',
    href: `/route/${encodeURIComponent(route)}`,
  };
}

/**
 * A mode's rows for the table: the latest week's entries, each with its score
 * the week before (`previous`, null when it wasn't ranked) and its scores by
 * week, oldest first, for a trend line.
 */
export function scoreRows(file, mode) {
  const m = file?.modes?.[mode];
  if (!m?.latest) return [];
  return m.latest.entries.map((e) => {
    const history = m.history?.[e.route] ?? [e.score];
    return {
      ...e,
      previous: history[1] ?? null,
      trend: [...history].reverse(),
    };
  });
}

/**
 * Rows sorted by a column: 'rank' (the default order), 'route', or a measure,
 * best first unless `descending` is false. Rows without a figure go last.
 */
export function sortRows(rows, key, mode) {
  if (key === 'rank') return [...rows].sort((a, b) => a.rank - b.rank);
  if (key === 'route') {
    return [...rows].sort((a, b) =>
      routeIdentity(mode, a.route).label.localeCompare(routeIdentity(mode, b.route).label, 'en', {
        numeric: true,
      }),
    );
  }
  const better = MEASURES[key]?.better ?? 'high';
  // Counts are what the table shows for bunching, gaps and cancelled trips.
  const value = (e) =>
    e.counts?.[key] != null && !(mode === 'rail' && key === 'cancelled')
      ? e.counts[key]
      : e.measures?.[key];
  return [...rows].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    if (x == null || y == null) return (x == null) - (y == null) || a.rank - b.rank;
    return (better === 'high' ? y - x : x - y) || a.rank - b.rank;
  });
}

/** A route's entry in the latest week, with how many were ranked; null when it wasn't. */
export function routeScore(file, mode, route) {
  const m = file?.modes?.[mode];
  const entry = m?.latest?.entries.find((e) => e.route === route);
  if (!entry) return null;
  return { ...entry, ranked: m.latest.ranked, from: m.latest.from, to: m.latest.to };
}

/** "Nov 1 – 7" or "Oct 25 – Nov 7" for two date keys. */
export function weekLabel(from, to) {
  const fmt = (key, opts) =>
    new Date(`${key}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', ...opts });
  const a = fmt(from, { month: 'short', day: 'numeric' });
  const b =
    from.slice(0, 7) === to.slice(0, 7)
      ? fmt(to, { day: 'numeric' })
      : fmt(to, { month: 'short', day: 'numeric' });
  return `${a} – ${b}`;
}

// ── Regional Rail trains ────────────────────────────────────────────────────

// As the bot's weekly post picks them (bot/features/latetrains.js).
export const CHRONIC = { minRuns: 8, minLateShare: 0.5 };

/** "5:10 PM" for minutes past midnight, to the nearest five. */
export function minutesLabel(min) {
  if (min == null) return null;
  const m = (Math.round(min / 5) * 5) % 1440;
  const h = Math.floor(m / 60);
  return `${h % 12 || 12}:${String(m % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** The share of the days a train ran that it was late, 0–1 (null when it never ran). */
export const lateShare = (t) => (t.ran ? t.late / t.ran : null);

/** The trains late most often, worst first. */
export function chronicTrains(trains = [], cfg = CHRONIC) {
  return trains
    .filter((t) => t.ran >= cfg.minRuns && t.late / t.ran >= cfg.minLateShare)
    .sort(
      (a, b) =>
        lateShare(b) - lateShare(a) || (b.avg_late ?? 0) - (a.avg_late ?? 0) || b.ran - a.ran,
    );
}

/** The trains cancelled most often (at least twice), most first. */
export function mostCancelledTrains(trains = [], limit = 10) {
  return trains
    .filter((t) => t.cancelled >= 2)
    .sort((a, b) => b.cancelled - a.cancelled || b.seen - a.seen)
    .slice(0, limit);
}

/** Trains whose number starts with what was typed, in number order. */
export function findTrains(trains = [], query, limit = 12) {
  const q = String(query ?? '')
    .replace(/[^0-9a-z]/gi, '')
    .toLowerCase();
  if (!q) return [];
  return trains.filter((t) => String(t.no).toLowerCase().startsWith(q)).slice(0, limit);
}

/** "Thorndale → Temple U", "to Temple U", or the line's name. */
export function trainRoute(t) {
  if (t.origin && t.dest && t.origin !== t.dest) return `${t.origin} → ${t.dest}`;
  if (t.dest) return `to ${t.dest}`;
  return RAIL_LINES[t.line]?.label ?? t.line;
}

/**
 * How one day went for a train, from its `daily` value: 'cancelled' (-1),
 * 'late' (over the on-time limit), 'on-time', or 'none' (not seen).
 */
export function dayStatus(value, onTimeMax = 5) {
  if (value == null) return 'none';
  if (value < 0) return 'cancelled';
  return value > onTimeMax ? 'late' : 'on-time';
}
