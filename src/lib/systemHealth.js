// Live system-health figures for the homepage dashboard: per-mode status,
// per-line status, and the small breakdowns its charts draw. Everything here
// is a pure function of the incident list and `now`, so the dashboard
// re-derives on every poll and the numbers always agree with the alert lists
// beneath it (both read the same `incidentCategory` buckets).

import { BUS_ROUTE_ORDER, formatBusRoute } from './busRoutes.js';
import {
  incidentCategory,
  incidentDetections,
  incidentLifecycle,
  isPlannedWork,
  legacyKind,
  officialAlert,
  SIGNAL_LABELS,
} from './incidents.js';
import { METRO_LINE_ORDER, METRO_LINES, normalizeMetroLine } from './metroLines.js';
import { normalizeRailLine, RAIL_LINE_ORDER, RAIL_LINES } from './railLines.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Display order of the three modes, and how each is named on its tile.
export const MODES = ['metro', 'bus', 'rail'];
export const MODE_LABELS = { metro: 'SEPTA Metro', bus: 'Bus', rail: 'Regional Rail' };
// What one entry in a mode's roster is called ("4 of 13 lines affected").
export const MODE_UNITS = {
  metro: ['line', 'lines'],
  bus: ['route', 'routes'],
  rail: ['line', 'lines'],
};

// The incident buckets the homepage lists already use, worst first. A line's
// status is the worst bucket among its active incidents; 'ok' means none.
export const CATEGORIES = ['disruption', 'delay', 'planned'];
export const CATEGORY_LABELS = {
  disruption: 'Disruptions',
  delay: 'Delays & cancellations',
  planned: 'Planned work',
};
const SEVERITY = { ok: 0, planned: 1, delay: 2, disruption: 3 };

// Overall mode status, mapped onto the four status steps (good → critical).
export const STATUS_LABELS = {
  good: 'Good service',
  warning: 'Minor delays',
  serious: 'Disruptions',
  critical: 'Major disruptions',
};

/** The fixed roster of lines/routes a mode runs, in display order. */
export function modeRoster(mode) {
  if (mode === 'metro') return METRO_LINE_ORDER;
  if (mode === 'rail') return RAIL_LINE_ORDER;
  return BUS_ROUTE_ORDER;
}

function normalizeRoute(mode, route) {
  if (route == null) return null;
  if (mode === 'metro') return normalizeMetroLine(route);
  if (mode === 'rail') return normalizeRailLine(route);
  return String(route);
}

/** Short label for a line/route in charts ("L1", "Paoli/Thorndale", "Route 21"). */
export function routeLabel(mode, route) {
  if (mode === 'metro') return METRO_LINES[route]?.label ?? String(route).toUpperCase();
  if (mode === 'rail') return RAIL_LINES[route]?.label ?? String(route).toUpperCase();
  return formatBusRoute(route);
}

/** Link target for a line/route's own page. */
export function routeHref(mode, route) {
  if (mode === 'metro') return `/line/${route}`;
  if (mode === 'rail') return `/rail/line/${route}`;
  return `/route/${route}`;
}

// Mode status from the active incident mix. Planned work never degrades a
// mode on its own — it's published service, and a weeks-long station closure
// would otherwise pin a mode at "disrupted" for a month. A mode is "major"
// once unplanned disruptions are widespread: three or more of them (scaled up
// for the bus network, which runs ~150 routes and is rarely free of one), or
// a quarter of its roster disrupted. Delays alone stop at "disruptions" even
// when they're spread across a quarter of the roster.
function modeStatus({ disruption, delay }, lineCounts, rosterSize) {
  const majorCount = Math.max(3, Math.ceil(rosterSize * 0.05));
  const share = (n) => (rosterSize > 0 ? n / rosterSize : 0);
  if (disruption >= majorCount || share(lineCounts.disruption) >= 0.25) return 'critical';
  if (disruption > 0 || share(lineCounts.disruption + lineCounts.delay) >= 0.25) return 'serious';
  if (delay > 0) return 'warning';
  return 'good';
}

// Whether an incident was open at any point in the window [from, to].
function overlapsWindow(incident, from, to) {
  const { first_seen_ts: start, resolved_ts: end, active } = incidentLifecycle(incident);
  if (start == null || start > to) return false;
  if (active || end == null) return true;
  return end >= from;
}

/**
 * Hourly counts of unplanned incidents that started in the last 24 hours,
 * oldest first, aligned to clock hours (the last bucket is the current, partial
 * hour). Buckets that end before `dataStartTs` carry `noData` so the chart can
 * tell "quiet" from "not yet collecting".
 */
export function hourlyUnplannedStarts(incidents, { now, dataStartTs = null, hours = 24 }) {
  const currentHourStart = Math.floor(now / HOUR_MS) * HOUR_MS;
  const firstStart = currentHourStart - (hours - 1) * HOUR_MS;
  const bins = Array.from({ length: hours }, (_, i) => {
    const start = firstStart + i * HOUR_MS;
    return {
      start,
      end: start + HOUR_MS,
      count: 0,
      noData: dataStartTs != null && start + HOUR_MS <= dataStartTs,
    };
  });
  for (const inc of incidents) {
    const ts = incidentLifecycle(inc).first_seen_ts;
    if (ts == null || ts < firstStart || ts > now) continue;
    if (isPlannedWork(inc)) continue;
    const idx = Math.floor((ts - firstStart) / HOUR_MS);
    if (bins[idx]) bins[idx].count += 1;
  }
  return bins;
}

function countUnplannedStarted(incidents, from, to) {
  let n = 0;
  for (const inc of incidents) {
    const ts = incidentLifecycle(inc).first_seen_ts;
    if (ts == null || ts < from || ts >= to) continue;
    if (!isPlannedWork(inc)) n += 1;
  }
  return n;
}

/**
 * Health summary for one mode.
 * @param {object[]} incidents  every incident in scope (active and resolved)
 * @param {'metro'|'bus'|'rail'} mode
 * @param {{ now: number, dataStartTs?: number|null }} opts
 */
export function computeModeHealth(incidents, mode, { now, dataStartTs = null }) {
  const modeIncidents = incidents.filter((inc) => legacyKind(inc) === mode);
  const roster = modeRoster(mode);
  const rosterSet = new Set(roster);
  const counts = { disruption: 0, delay: 0, planned: 0 };
  // route -> { status, counts: {disruption, delay, planned} }
  const lineStatus = new Map();
  let systemWide = 0;

  for (const inc of modeIncidents) {
    if (!incidentLifecycle(inc).active) continue;
    const cat = incidentCategory(inc, now);
    counts[cat] += 1;
    const routes = [
      ...new Set((inc.routes || []).map((r) => normalizeRoute(mode, r)).filter(Boolean)),
    ];
    if (routes.length === 0) systemWide += 1;
    for (const r of routes) {
      let entry = lineStatus.get(r);
      if (!entry) {
        entry = { status: 'ok', counts: { disruption: 0, delay: 0, planned: 0 } };
        lineStatus.set(r, entry);
      }
      entry.counts[cat] += 1;
      if (SEVERITY[cat] > SEVERITY[entry.status]) entry.status = cat;
    }
  }

  // Lines in each worst-status bucket. Routes outside the roster (a retired bus
  // route still in an old alert) count toward the buckets but can't push the
  // affected total past the roster size.
  const lineCounts = { disruption: 0, delay: 0, planned: 0 };
  for (const [route, { status }] of lineStatus) {
    if (mode !== 'bus' || rosterSet.has(route)) lineCounts[status] += 1;
  }
  const rosterSize = roster.length;
  const affected = Math.min(
    rosterSize,
    lineCounts.disruption + lineCounts.delay + lineCounts.planned,
  );
  const unplannedLines = lineCounts.disruption + lineCounts.delay;

  const hourly = hourlyUnplannedStarts(modeIncidents, { now, dataStartTs });
  const last24 = countUnplannedStarted(modeIncidents, now - DAY_MS, now + 1);
  // Only compare with the prior 24h when the data actually covers it —
  // otherwise a site that started collecting yesterday reads as "∞% busier".
  const hasPrior = dataStartTs == null || dataStartTs <= now - 2 * DAY_MS;
  const prior24 = hasPrior
    ? countUnplannedStarted(modeIncidents, now - 2 * DAY_MS, now - DAY_MS)
    : null;

  return {
    mode,
    counts,
    activeTotal: counts.disruption + counts.delay + counts.planned,
    systemWide,
    lineStatus,
    lineCounts,
    rosterSize,
    affected,
    unplannedLines,
    status: modeStatus(counts, lineCounts, rosterSize),
    hourly,
    last24,
    prior24,
  };
}

// Elapsed-time buckets for the "how long have active alerts been open" chart.
export const AGE_BUCKETS = [
  { key: 'lt1h', label: '<1h', tip: 'Under 1 hour', maxMs: HOUR_MS },
  { key: '1-3h', label: '1–3h', tip: '1–3 hours', maxMs: 3 * HOUR_MS },
  { key: '3-12h', label: '3–12h', tip: '3–12 hours', maxMs: 12 * HOUR_MS },
  { key: '12-24h', label: '12–24h', tip: '12–24 hours', maxMs: DAY_MS },
  { key: '1-7d', label: '1–7d', tip: '1–7 days', maxMs: 7 * DAY_MS },
  { key: '7d+', label: '7d+', tip: 'Over a week', maxMs: Number.POSITIVE_INFINITY },
];

/** Active incidents bucketed by how long they've been open, split by category. */
export function activeAgeBreakdown(incidents, { now }) {
  const bins = AGE_BUCKETS.map((b) => ({ ...b, disruption: 0, delay: 0, planned: 0, total: 0 }));
  for (const inc of incidents) {
    const { active, first_seen_ts: start } = incidentLifecycle(inc);
    if (!active || start == null) continue;
    const age = Math.max(0, now - start);
    const bin = bins.find((b) => age < b.maxMs) ?? bins[bins.length - 1];
    bin[incidentCategory(inc, now)] += 1;
    bin.total += 1;
  }
  return bins;
}

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// The rider-facing kinds of trouble one incident represents. Bot detections
// contribute their signal kinds (gaps, bunching, late trains, …); an official
// SEPTA alert contributes planned work, a detour, or a general service alert.
function incidentIssueTypes(inc) {
  const types = new Set();
  for (const d of incidentDetections(inc)) {
    const source = d.source ?? d.detection_source;
    const signals = source === 'roundup' ? (d.evidence?.signals ?? d.signals ?? []) : [source];
    for (const s of signals) if (s) types.add(s);
  }
  const alert = officialAlert(inc);
  if (alert) {
    if (isPlannedWork(inc)) types.add('planned');
    else if (alert.septa?.effect === 'DETOUR') types.add('detour');
    else types.add('alert');
  }
  return types;
}

const ISSUE_LABELS = {
  ...Object.fromEntries(Object.entries(SIGNAL_LABELS).map(([k, v]) => [k, capitalize(v)])),
  planned: 'Planned work',
  detour: 'Detours',
  alert: 'SEPTA service alerts',
};

/** Human label for an issue-type key from {@link issueTypeBreakdown}. */
export function issueTypeLabel(key) {
  return ISSUE_LABELS[key] ?? capitalize(String(key));
}

/**
 * Incidents open at any point in the last `windowMs`, counted by the kind of
 * trouble they describe, most common first. An incident carrying two signals
 * counts toward both. Past `limit` kinds the tail folds into one "Other" row.
 */
export function issueTypeBreakdown(incidents, { now, windowMs = DAY_MS, limit = 7 }) {
  const counts = new Map();
  for (const inc of incidents) {
    if (!overlapsWindow(inc, now - windowMs, now)) continue;
    for (const t of incidentIssueTypes(inc)) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const rows = [...counts]
    .map(([key, count]) => ({ key, label: issueTypeLabel(key), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  if (rows.length <= limit) return rows;
  const head = rows.slice(0, limit - 1);
  const other = rows.slice(limit - 1).reduce((sum, r) => sum + r.count, 0);
  return [...head, { key: 'other', label: 'Other', count: other }];
}

/**
 * Lines and routes with the most incidents open at any point in the last
 * `windowMs`, split by category, most first. Ties go to the more severe mix.
 */
export function mostAffectedRoutes(incidents, { now, windowMs = DAY_MS, limit = 8 }) {
  const rows = new Map();
  for (const inc of incidents) {
    if (!overlapsWindow(inc, now - windowMs, now)) continue;
    const mode = legacyKind(inc);
    if (!MODES.includes(mode)) continue;
    const cat = incidentCategory(inc, now);
    const routes = new Set((inc.routes || []).map((r) => normalizeRoute(mode, r)).filter(Boolean));
    for (const route of routes) {
      const key = `${mode}:${route}`;
      let row = rows.get(key);
      if (!row) {
        row = { key, mode, route, disruption: 0, delay: 0, planned: 0, total: 0 };
        rows.set(key, row);
      }
      row[cat] += 1;
      row.total += 1;
    }
  }
  return [...rows.values()]
    .sort(
      (a, b) =>
        b.total - a.total ||
        b.disruption - a.disruption ||
        b.delay - a.delay ||
        a.key.localeCompare(b.key),
    )
    .slice(0, limit);
}
