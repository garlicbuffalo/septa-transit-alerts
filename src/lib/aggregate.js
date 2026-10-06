// Aggregation helpers — turn the raw alerts/observations feed into the shapes
// the timeline grid and the at-a-glance summary line need.

import { formatBusRoute } from './busRoutes.js';
import { phillyDayUTC } from './format.js';
import {
  groupIncidentRecords,
  incidentDetections,
  incidentLifecycle,
  legacyKind,
  observationSignals,
  officialAlert,
  postUrlRkey,
  railIncidentStatus,
  SIGNAL_TYPES,
} from './incidents.js';
import { METRO_LINE_ORDER, METRO_LINES } from './metroLines.js';
import { RAIL_LINE_ORDER, RAIL_LINES } from './railLines.js';
import { buildStationIndex } from './stations.js';

// Identity-based cache so the eight aggregators downstream of a single
// `data` poll don't re-run the O(alerts × observations) merge in lockstep.
// incidentRecords returns fresh array references on every fetch, so the
// cache hits on the same poll cycle's references and misses cleanly the
// next time the JSON updates. WeakMap so old payloads are GC'd.
const _mergeCache = new WeakMap();
function getMerge(alerts, observations) {
  if (!alerts || !observations) return groupIncidentRecords(alerts, observations);
  const entry = _mergeCache.get(alerts);
  if (entry && entry.observations === observations) return entry.result;
  const result = groupIncidentRecords(alerts, observations);
  _mergeCache.set(alerts, { observations, result });
  return result;
}

const PHILLY_TZ = 'America/New_York';
const phillyHourFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: PHILLY_TZ,
  weekday: 'short',
  hour: 'numeric',
  hour12: false,
});

// 'Sun' (system locale) → 0 ... 'Sat' → 6, matching JS Date conventions so
// callers can index with the same model they already use elsewhere.
const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function phillyWeekdayHour(ts) {
  let weekday = null;
  let hour = null;
  for (const p of phillyHourFmt.formatToParts(new Date(ts))) {
    if (p.type === 'weekday') weekday = WEEKDAY_INDEX[p.value];
    else if (p.type === 'hour') hour = Number(p.value);
  }
  // Intl renders midnight as '24' under hour12:false in some Node/ICU builds.
  if (hour === 24) hour = 0;
  return { weekday, hour };
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Build a map of lineId -> { dayIdx: incidentCount } for the timeline grid.
// dayIdx 0 = today, 1 = yesterday, ..., numDays-1 = oldest day shown.
// Only includes train lines (bus incidents appear in the list but not the grid).
/**
 * @param {import('./incidents.js').Alert[]} alerts
 * @param {import('./incidents.js').Observation[]} observations
 * @param {number} [numDays]
 * @param {number} [now]
 * @returns {Object<string, Object<number, number>>} lineId -> dayIdx -> count
 */
export function buildIncidentsByDay(alerts, observations, numDays = 90, now = Date.now()) {
  const result = {};
  const todayUTC = phillyDayUTC(now);

  function addSpan(lineId, startTs, endTs) {
    if (!METRO_LINE_ORDER.includes(lineId)) return;
    if (!result[lineId]) result[lineId] = {};

    const end = endTs || now;
    const startDayIdx = Math.round((todayUTC - phillyDayUTC(startTs)) / DAY_MS);
    const endDayIdx = Math.round((todayUTC - phillyDayUTC(end)) / DAY_MS);

    const lo = Math.max(0, endDayIdx);
    const hi = Math.min(numDays - 1, startDayIdx);
    for (let d = lo; d <= hi; d++) {
      result[lineId][d] = (result[lineId][d] || 0) + 1;
    }
  }

  // Use merge logic to avoid double-counting incidents that have both an alert
  // and a matching observation (e.g. a combined Green line incident).
  const { merged, standaloneAlerts, standaloneObs } = groupIncidentRecords(
    alerts.filter((a) => a.kind === 'metro'),
    observations.filter((o) => o.kind === 'metro'),
  );

  for (const m of merged) {
    for (const route of m.routes) {
      addSpan(route, m.first_seen_ts, m.resolved_ts);
    }
  }

  for (const a of standaloneAlerts) {
    for (const route of a.routes) {
      addSpan(route, a.first_seen_ts, a.resolved_ts);
    }
  }

  for (const o of standaloneObs) {
    addSpan(o.line, o.ts, o.resolved_ts);
  }

  return result;
}

// Regional Rail analog of buildIncidentsByDay: per-line incident counts keyed
// by day index for the timeline grid. Returns { lineKey: { dayIdx: count } }
// for the 13 Regional Rail lines (keys absent until a line has activity). Same
// merge + span-bucketing model as the Metro version.
export function buildRailIncidentsByDay(alerts, observations, numDays = 90, now = Date.now()) {
  const result = {};
  const todayUTC = phillyDayUTC(now);

  function addSpan(lineId, startTs, endTs) {
    if (!RAIL_LINE_ORDER.includes(lineId)) return;
    if (!result[lineId]) result[lineId] = {};
    const end = endTs || now;
    const startDayIdx = Math.round((todayUTC - phillyDayUTC(startTs)) / DAY_MS);
    const endDayIdx = Math.round((todayUTC - phillyDayUTC(end)) / DAY_MS);
    const lo = Math.max(0, endDayIdx);
    const hi = Math.min(numDays - 1, startDayIdx);
    for (let d = lo; d <= hi; d++) {
      result[lineId][d] = (result[lineId][d] || 0) + 1;
    }
  }

  const { merged, standaloneAlerts, standaloneObs } = groupIncidentRecords(
    alerts.filter((a) => a.kind === 'rail'),
    observations.filter((o) => o.kind === 'rail'),
  );
  for (const m of merged) {
    for (const route of m.routes) addSpan(route, m.first_seen_ts, m.resolved_ts);
  }
  for (const a of standaloneAlerts) {
    for (const route of a.routes) addSpan(route, a.first_seen_ts, a.resolved_ts);
  }
  for (const o of standaloneObs) {
    addSpan(o.line, o.ts, o.resolved_ts);
  }
  return result;
}

// Build bus incident counts for the timeline grid.
// Returns { aggregate, byRoute, topRoutes, otherAggregate }
//   - aggregate: { dayIdx: distinctRouteCount } across all routes
//   - byRoute:   { routeId: { dayIdx: count } }
//   - topRoutes: routeIds sorted by total incidents desc, capped at topN
//   - otherAggregate: { dayIdx: distinctRouteCount } excluding topRoutes
// Distinct-route counts are used (not raw event counts) so the color reflects
// breadth of impact across the system.
/**
 * @param {import('./incidents.js').Alert[]} alerts
 * @param {import('./incidents.js').Observation[]} observations
 * @param {number} [numDays]
 * @param {number} [now]
 * @param {number} [topN]
 * @returns {{
 *   aggregate: Object<number, number>,
 *   byRoute: Object<string, Object<number, number>>,
 *   topRoutes: string[],
 *   otherAggregate: Object<number, number>,
 * }}
 */
export function buildBusIncidentsByDay(
  alerts,
  observations,
  numDays = 90,
  now = Date.now(),
  topN = 5,
) {
  const byRoute = {};
  const routesPerDay = {}; // { dayIdx: Set<routeId> } — for dedup in aggregate
  const todayUTC = phillyDayUTC(now);

  function addSpan(routeId, startTs, endTs) {
    const key = String(routeId);
    if (!byRoute[key]) byRoute[key] = {};
    const end = endTs || now;
    const startDayIdx = Math.round((todayUTC - phillyDayUTC(startTs)) / DAY_MS);
    const endDayIdx = Math.round((todayUTC - phillyDayUTC(end)) / DAY_MS);
    const lo = Math.max(0, endDayIdx);
    const hi = Math.min(numDays - 1, startDayIdx);
    for (let d = lo; d <= hi; d++) {
      byRoute[key][d] = (byRoute[key][d] || 0) + 1;
      if (!routesPerDay[d]) routesPerDay[d] = new Set();
      routesPerDay[d].add(key);
    }
  }

  // Merge to avoid double-counting bus incidents that have both a SEPTA alert
  // and a matching bot observation on the same route.
  const { merged, standaloneAlerts, standaloneObs } = groupIncidentRecords(
    alerts.filter((a) => a.kind === 'bus'),
    observations.filter((o) => o.kind === 'bus'),
  );

  for (const m of merged) {
    for (const route of m.routes) addSpan(route, m.first_seen_ts, m.resolved_ts);
  }
  for (const a of standaloneAlerts) {
    for (const route of a.routes) addSpan(route, a.first_seen_ts, a.resolved_ts);
  }
  for (const o of standaloneObs) {
    addSpan(o.line, o.ts, o.resolved_ts);
  }

  const aggregate = {};
  for (const [d, routes] of Object.entries(routesPerDay)) {
    aggregate[Number(d)] = routes.size;
  }

  // Rank routes by total incidents within the visible window, then take topN.
  const totals = Object.entries(byRoute).map(([routeId, days]) => {
    let sum = 0;
    for (const c of Object.values(days)) sum += c;
    return [routeId, sum];
  });
  totals.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const topRoutes = totals.slice(0, topN).map(([id]) => id);
  const topSet = new Set(topRoutes);

  const otherAggregate = {};
  for (const [d, routes] of Object.entries(routesPerDay)) {
    let n = 0;
    for (const r of routes) if (!topSet.has(r)) n++;
    if (n > 0) otherAggregate[Number(d)] = n;
  }

  return { aggregate, byRoute, topRoutes, otherAggregate };
}

// Headline stats for the at-a-glance summary line. Always computed against
// the full dataset (not the filtered view) so the answer to "how's SEPTA
// doing right now" doesn't change based on whatever the user has narrowed to.
// Uses merged incidents so a SEPTA alert and a matching bot observation count
// once, not twice. Most-affected uses a 30-day window for stability — a
// 7-day window flips around too much when one bad day dominates.
/**
 * @param {import('./incidents.js').Alert[]} alerts
 * @param {import('./incidents.js').Observation[]} observations
 * @param {number} [now]
 * @returns {{
 *   activeCount: number,
 *   weeklyCount: number,
 *   mostAffectedKind: 'metro' | 'bus' | null,
 *   mostAffectedId: string | null,
 *   mostAffectedCount: number,
 *   quietestLineId: string | null,
 *   quietestLineDays: number,
 *   railMostAffectedId: string | null,
 *   railMostAffectedCount: number,
 *   railQuietestLineId: string | null,
 *   railQuietestLineDays: number,
 * }}
 */
export function computeSummaryStats(alerts, observations, now = Date.now()) {
  const weekAgo = now - 7 * DAY_MS;
  const monthAgo = now - 30 * DAY_MS;

  const { merged, standaloneAlerts, standaloneObs } = getMerge(alerts, observations);

  const incidents = [
    ...merged.map((m) => ({
      ts: m.first_seen_ts,
      kind: m.kind,
      lines: m.routes,
      active: m.active,
    })),
    ...standaloneAlerts.map((a) => ({
      ts: a.first_seen_ts,
      kind: a.kind,
      lines: a.routes,
      active: a.active,
    })),
    ...standaloneObs.map((o) => ({
      ts: o.first_seen_ts || o.ts,
      kind: o.kind,
      lines: [o.line],
      active: o.active,
    })),
  ];

  const activeCount = incidents.filter((i) => i.active).length;
  const weeklyCount = incidents.filter((i) => i.ts >= weekAgo).length;

  // Count last-30-day incidents per (kind, key) — Metro line key (e.g. "l1"),
  // bus route number ("17"), or Regional Rail line key ("pao"). Bus routes are
  // included so the "most affected" answer reflects reality even when a
  // chronically-troubled bus route outpaces every Metro line. Transit (Metro +
  // bus) and Regional Rail are counted into separate maps so each network
  // surfaces its own leader — the homepage shows both side by side.
  const transitCounts = new Map(); // key: `${kind}:${id}` -> { kind, id, count }
  const railCounts = new Map(); // key: rail line -> { kind:'rail', id, count }
  for (const inc of incidents) {
    if (inc.ts < monthAgo) continue;
    if (inc.kind === 'metro') {
      for (const line of inc.lines || []) {
        if (!METRO_LINE_ORDER.includes(line)) continue;
        const key = `metro:${line}`;
        const cur = transitCounts.get(key) || { kind: 'metro', id: line, count: 0 };
        cur.count++;
        transitCounts.set(key, cur);
      }
    } else if (inc.kind === 'bus') {
      for (const route of inc.lines || []) {
        const id = String(route);
        const key = `bus:${id}`;
        const cur = transitCounts.get(key) || { kind: 'bus', id, count: 0 };
        cur.count++;
        transitCounts.set(key, cur);
      }
    } else if (inc.kind === 'rail') {
      for (const line of inc.lines || []) {
        if (!RAIL_LINE_ORDER.includes(line)) continue;
        const cur = railCounts.get(line) || { kind: 'rail', id: line, count: 0 };
        cur.count++;
        railCounts.set(line, cur);
      }
    }
  }
  const pickMost = (map) => {
    let best = null;
    for (const entry of map.values()) {
      if (!best || entry.count > best.count) best = entry;
    }
    return best;
  };
  const mostAffected = pickMost(transitCounts);
  const railMostAffected = pickMost(railCounts);

  // Quietest line: among a rail agency's lines, find the one whose most recent
  // incident is the oldest (longest streak of clean days). Buses are excluded —
  // there are too many low-traffic routes for "Route 490: 60 days since last
  // incident" to be meaningful, and that's not the kind of brag riders care
  // about anyway. Computed per network so Metro and Regional Rail each get a streak.
  const quietestFor = (kind, lineOrder) => {
    const lastTsByLine = new Map();
    for (const inc of incidents) {
      if (inc.kind !== kind) continue;
      for (const line of inc.lines || []) {
        if (!lineOrder.includes(line)) continue;
        const prev = lastTsByLine.get(line);
        if (prev == null || inc.ts > prev) lastTsByLine.set(line, inc.ts);
      }
    }
    let lineId = null;
    let lineDays = 0;
    for (const line of lineOrder) {
      const ts = lastTsByLine.get(line);
      if (ts == null) continue; // no data for this line — skip rather than guess at the streak
      const days = Math.floor((now - ts) / DAY_MS);
      if (days > lineDays) {
        lineDays = days;
        lineId = line;
      }
    }
    return { lineId, lineDays };
  };
  const metroQuietest = quietestFor('metro', METRO_LINE_ORDER);
  const railQuietest = quietestFor('rail', RAIL_LINE_ORDER);

  return {
    activeCount,
    weeklyCount,
    mostAffectedKind: mostAffected?.kind ?? null,
    mostAffectedId: mostAffected?.id ?? null,
    mostAffectedCount: mostAffected?.count ?? 0,
    quietestLineId: metroQuietest.lineId,
    quietestLineDays: metroQuietest.lineDays,
    railMostAffectedId: railMostAffected?.id ?? null,
    railMostAffectedCount: railMostAffected?.count ?? 0,
    railQuietestLineId: railQuietest.lineId,
    railQuietestLineDays: railQuietest.lineDays,
  };
}

// Build per-day incident counts for the most recent `numDays` Philadelphia calendar
// days, plus a rolling 7-day average and a trend indicator comparing the most
// recent 7 days to the prior 7 days. Used by the homepage trend sparkline.
//
// `counts[i]` and `avg[i]` are indexed with i=0 = oldest day, i=numDays-1 =
// today — the sparkline reads naturally left-to-right as time progresses.
// Trend ratio is `recent7Avg / prior7Avg`; null when the prior window is zero
// (no baseline to compare against).
/**
 * @param {import('./incidents.js').Alert[]} alerts
 * @param {import('./incidents.js').Observation[]} observations
 * @param {number} [numDays]
 * @param {number} [now]
 * @returns {{
 *   counts: number[],
 *   avg: number[],
 *   recent7Avg: number,
 *   prior7Avg: number,
 *   trendRatio: number | null,
 * }}
 */
export function buildDailyTrend(alerts, observations, numDays = 30, now = Date.now()) {
  const todayUTC = phillyDayUTC(now);
  // chronological array: index 0 = oldest, index numDays-1 = today.
  const counts = new Array(numDays).fill(0);

  function bump(ts) {
    if (ts == null) return;
    const dayIdx = numDays - 1 - Math.round((todayUTC - phillyDayUTC(ts)) / DAY_MS);
    if (dayIdx >= 0 && dayIdx < numDays) counts[dayIdx] += 1;
  }

  const { merged, standaloneAlerts, standaloneObs } = getMerge(alerts, observations);
  for (const m of merged) bump(m.first_seen_ts);
  for (const a of standaloneAlerts) bump(a.first_seen_ts);
  for (const o of standaloneObs) bump(o.first_seen_ts ?? o.ts);

  // Trailing 7-day average ending at each day (so avg[i] reflects the week
  // leading up to day i, including i itself). Earlier-than-7-days slots use
  // a shorter window — better than NaN, and lets the sparkline span the full
  // range without a leading dead zone.
  const avg = new Array(numDays).fill(0);
  for (let i = 0; i < numDays; i++) {
    const lo = Math.max(0, i - 6);
    let sum = 0;
    for (let j = lo; j <= i; j++) sum += counts[j];
    avg[i] = sum / (i - lo + 1);
  }

  // Compare the most recent 7 days to the 7 before that. With <14 days of
  // data both windows are partial; trendRatio is still meaningful because
  // both halves shrink symmetrically. With 0 in the prior window we return
  // null so callers can render "no baseline" rather than divide-by-zero.
  const recentLo = Math.max(0, numDays - 7);
  let recentSum = 0;
  for (let i = recentLo; i < numDays; i++) recentSum += counts[i];
  const recent7Avg = recentSum / (numDays - recentLo);
  const priorLo = Math.max(0, numDays - 14);
  const priorHi = Math.max(0, numDays - 7);
  let priorSum = 0;
  for (let i = priorLo; i < priorHi; i++) priorSum += counts[i];
  const priorWindowSize = priorHi - priorLo;
  const prior7Avg = priorWindowSize > 0 ? priorSum / priorWindowSize : 0;
  const trendRatio = prior7Avg > 0 ? recent7Avg / prior7Avg : null;

  return { counts, avg, recent7Avg, prior7Avg, trendRatio };
}

// Build a 7×24 grid of incident counts, indexed [weekday][hour] where weekday
// 0 = Sunday and hour 0 = midnight (Philadelphia local time). Buckets by start
// timestamp — a multi-hour incident counts once at its start, matching how
// the contributions grid handles ongoing spans.
/**
 * @param {import('./incidents.js').Alert[]} alerts
 * @param {import('./incidents.js').Observation[]} observations
 * @returns {{ grid: number[][], maxCount: number, total: number }}
 */
export function buildHourOfWeek(alerts, observations) {
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  let maxCount = 0;
  let total = 0;

  function bump(ts) {
    if (!ts) return;
    const { weekday, hour } = phillyWeekdayHour(ts);
    if (weekday == null || hour == null) return;
    grid[weekday][hour] += 1;
    total += 1;
    if (grid[weekday][hour] > maxCount) maxCount = grid[weekday][hour];
  }

  // Merge to avoid double-counting alert+observation pairs.
  const { merged, standaloneAlerts, standaloneObs } = getMerge(alerts, observations);
  for (const m of merged) bump(m.first_seen_ts);
  for (const a of standaloneAlerts) bump(a.first_seen_ts);
  for (const o of standaloneObs) bump(o.first_seen_ts || o.ts);

  return { grid, maxCount, total };
}

// Day-part buckets for the plain-language heatmap insight. Hour ranges are
// inclusive on both ends (Philadelphia local hours, matching buildHourOfWeek), so
// `hi` is the last hour included and the human range runs to hi+1 o'clock.
// Tuned to transit-meaningful windows rather than even 6-hour blocks.
export const PART_OF_DAY = [
  { key: 'overnight', lo: 0, hi: 4, label: 'overnight', range: '12–5 AM' },
  { key: 'morning', lo: 5, hi: 9, label: 'mornings', range: '5–10 AM' },
  { key: 'midday', lo: 10, hi: 14, label: 'midday', range: '10 AM–3 PM' },
  { key: 'afternoon', lo: 15, hi: 19, label: 'afternoons', range: '3–8 PM' },
  { key: 'night', lo: 20, hi: 23, label: 'evenings', range: '8 PM–12 AM' },
];

// Plain-language description of *when* incidents concentrate, derived from the
// same 7×24 grid the heatmap renders so the sentence and the picture always
// agree. Two-step so adjacent windows don't split a real peak:
//   1. Pick the dominant day-type — weekday (Mon–Fri) vs weekend (Sat/Sun) —
//      by total starts (ties go to weekday).
//   2. Within that day-type, find the busiest part-of-day.
// Only narrates when there's a genuine concentration:
//   - at least `minTotal` starts overall (enough signal to generalize),
//   - the top part holds at least `minShare` of that day-type's starts
//     (5 parts, so uniform ≈ 20% — the default 30% is a clear lead), AND
//   - it leads the runner-up part by at least `leadRatio` (so a three-way
//     tie across weekday daytime, say, isn't spun as a single pattern).
// Returns null otherwise — the caller renders nothing rather than a forced
// "evenly spread" claim. Purely descriptive: it restates the grid, no verdict.
/**
 * @param {number[][]} grid  7×24 [weekday][hour] start counts (see buildHourOfWeek)
 * @param {number} total     total starts in the grid
 * @param {object} [options]
 * @param {number} [options.minTotal]
 * @param {number} [options.minShare]
 * @param {number} [options.leadRatio]
 * @returns {{ dayType: 'weekday'|'weekend', label: string, range: string, count: number, share: number } | null}
 */
export function describePeakWindow(
  grid,
  total,
  { minTotal = 12, minShare = 0.3, leadRatio = 1.25 } = {},
) {
  if (!grid || !total || total < minTotal) return null;

  const sumDays = (days, lo, hi) => {
    let c = 0;
    for (const w of days) {
      for (let h = lo; h <= hi; h++) c += grid[w]?.[h] ?? 0;
    }
    return c;
  };

  const weekdayDays = [1, 2, 3, 4, 5];
  const weekendDays = [0, 6];
  const weekdayTotal = sumDays(weekdayDays, 0, 23);
  const weekendTotal = sumDays(weekendDays, 0, 23);
  const dayType = weekendTotal > weekdayTotal ? 'weekend' : 'weekday';
  const days = dayType === 'weekend' ? weekendDays : weekdayDays;
  const dayTypeTotal = dayType === 'weekend' ? weekendTotal : weekdayTotal;
  if (dayTypeTotal === 0) return null;

  const parts = PART_OF_DAY.map((part) => ({ part, count: sumDays(days, part.lo, part.hi) })).sort(
    (a, b) => b.count - a.count,
  );
  const top = parts[0];
  if (!top || top.count === 0) return null;
  if (top.count / dayTypeTotal < minShare) return null;
  const second = parts[1];
  if (second && top.count < second.count * leadRatio) return null;

  return {
    dayType,
    label: top.part.label,
    range: top.part.range,
    count: top.count,
    share: top.count / total,
  };
}

// Short-window incident burst detection. Counts merged-incident starts in
// the last `windowHours` and the matching baseline rate over `baselineDays`.
// Returns `{ recentCount, baselineCount, ratio }` so callers can decide
// whether to surface a "burst" callout — the ratio is most-recent vs.
// the same window length averaged across the baseline period.
//
// Inputs are expected to be scoped to one line/route by the caller (or the
// whole system). The helper just counts.
/**
 * @param {import('./incidents.js').Alert[]} alerts
 * @param {import('./incidents.js').Observation[]} observations
 * @param {object} [options]
 * @param {number} [options.now]
 * @param {number} [options.windowHours]   How recent the "burst" window is.
 * @param {number} [options.baselineDays]  How far back the baseline cohort runs.
 * @returns {{ recentCount: number, baselineWindowCount: number, ratio: number | null, windowHours: number }}
 */
export function computeRecentBurst(
  alerts,
  observations,
  { now = Date.now(), windowHours = 3, baselineDays = 30 } = {},
) {
  const HOUR_MS = 60 * 60 * 1000;
  const windowMs = windowHours * HOUR_MS;
  const windowStart = now - windowMs;
  const baselineMs = baselineDays * DAY_MS;
  const baselineStart = now - baselineMs;

  const { merged, standaloneAlerts, standaloneObs } = getMerge(alerts, observations);
  let recentCount = 0;
  let baselineTotal = 0;
  function consider(ts) {
    if (ts == null) return;
    if (ts >= baselineStart) baselineTotal += 1;
    if (ts >= windowStart) recentCount += 1;
  }
  for (const m of merged) consider(m.first_seen_ts);
  for (const a of standaloneAlerts) consider(a.first_seen_ts);
  for (const o of standaloneObs) consider(o.first_seen_ts ?? o.ts);

  // Baseline-window average: total over baseline, scaled to one window's
  // length. Subtract the recent window from both numerator and denominator
  // so the burst doesn't anchor its own baseline.
  const baselineNonRecent = baselineTotal - recentCount;
  const baselineWindowSize = baselineMs - windowMs;
  const baselineWindowCount =
    baselineWindowSize > 0 ? (baselineNonRecent * windowMs) / baselineWindowSize : 0;
  const ratio = baselineWindowCount > 0 ? recentCount / baselineWindowCount : null;
  return { recentCount, baselineWindowCount, ratio, windowHours };
}

// Per-weekday incident count over a rolling window. Returns a 7-element
// array indexed Sun..Sat (matching JS Date.getDay conventions). Inputs are
// expected to be scoped to a single line/route (or the whole system) by
// the caller. Counts merged incidents at their start time.
//
// `numWeeks` is exposed so the caller can label the chart with an honest
// denominator ("avg per Monday across N weeks"). Default 13 weeks ≈ 90d.
/**
 * @param {import('./incidents.js').Alert[]} alerts
 * @param {import('./incidents.js').Observation[]} observations
 * @param {object} [options]
 * @param {number} [options.now]
 * @param {number} [options.windowDays]
 * @returns {{ counts: number[], numWeeks: number, total: number, maxCount: number }}
 */
export function computeDayOfWeekCounts(
  alerts,
  observations,
  { now = Date.now(), windowDays = 91 } = {},
) {
  const cutoff = now - windowDays * DAY_MS;
  const counts = new Array(7).fill(0);
  const { merged, standaloneAlerts, standaloneObs } = getMerge(alerts, observations);
  function bump(ts) {
    if (ts == null || ts < cutoff) return;
    const { weekday } = phillyWeekdayHour(ts);
    if (weekday == null) return;
    counts[weekday] += 1;
  }
  for (const m of merged) bump(m.first_seen_ts);
  for (const a of standaloneAlerts) bump(a.first_seen_ts);
  for (const o of standaloneObs) bump(o.first_seen_ts ?? o.ts);

  let total = 0;
  let maxCount = 0;
  for (const c of counts) {
    total += c;
    if (c > maxCount) maxCount = c;
  }
  // numWeeks rounds up so a partial trailing week still feels represented.
  const numWeeks = Math.max(1, Math.ceil(windowDays / 7));
  return { counts, numWeeks, total, maxCount };
}

// Build per-train-line signal-type counts for the breakdown stacked bars.
// Returns { lineId: { gap: n, bunching: n, ... }, totals: { gap: n, ... } }.
// Bus routes are excluded because there are too many to chart usefully — the
// per-line breakdown is most legible for the eight train lines.
/**
 * @param {import('./incidents.js').Observation[]} observations
 * @returns {{ byLine: Object<string, Object<string, number>>, totals: Object<string, number> }}
 */
// Per-line reliability stats over a rolling window: how many of the last N
// Philadelphia days had zero incident activity, and the typical cadence between
// incidents (median gap, start-to-start). Inputs are expected to be already
// filtered to a single line/route — the function does not filter further.
//
// `incidentFreeDays` counts Philadelphia days within [today - windowDays + 1, today]
// that had no overlap with any incident span. An incident spanning multiple
// days subtracts from incident-free days for every day it touched, matching
// the way the timeline grid colors days. `medianGapHours` is null when fewer
// than 2 starts fall inside the window (no gap to take a median over).
/**
 * @param {import('./incidents.js').Alert[]} alerts
 * @param {import('./incidents.js').Observation[]} observations
 * @param {object} [options]
 * @param {number} [options.now]
 * @param {number} [options.windowDays]
 * @returns {{
 *   incidentFreeDays: number,
 *   totalDays: number,
 *   medianGapHours: number | null,
 *   longestStreakDays: number,
 *   currentStreakDays: number,
 * }}
 */
export function computeLineReliability(
  alerts,
  observations,
  { now = Date.now(), windowDays = 90 } = {},
) {
  const todayUTC = phillyDayUTC(now);
  const cutoffDayUTC = todayUTC - (windowDays - 1) * DAY_MS;

  const { merged, standaloneAlerts, standaloneObs } = getMerge(alerts, observations);

  const spans = []; // [startTs, endTs]
  const starts = [];

  function add(startTs, endTs) {
    spans.push([startTs, endTs ?? now]);
    starts.push(startTs);
  }

  for (const m of merged) add(m.first_seen_ts, m.resolved_ts);
  for (const a of standaloneAlerts) add(a.first_seen_ts, a.resolved_ts);
  for (const o of standaloneObs) add(o.ts, o.resolved_ts);

  const daysWithIncident = new Set();
  for (const [start, end] of spans) {
    const startDayIdx = Math.round((todayUTC - phillyDayUTC(start)) / DAY_MS);
    const endDayIdx = Math.round((todayUTC - phillyDayUTC(end)) / DAY_MS);
    const lo = Math.max(0, endDayIdx);
    const hi = Math.min(windowDays - 1, startDayIdx);
    for (let d = lo; d <= hi; d++) daysWithIncident.add(d);
  }

  const incidentFreeDays = windowDays - daysWithIncident.size;

  // Longest run of consecutive Philadelphia days within the window with no
  // incident on this line. Same dayIdx model as the contributions grid:
  // 0 = today, windowDays-1 = oldest day shown.
  let longestStreakDays = 0;
  let currentStreak = 0;
  for (let d = 0; d < windowDays; d++) {
    if (daysWithIncident.has(d)) {
      currentStreak = 0;
    } else {
      currentStreak += 1;
      if (currentStreak > longestStreakDays) longestStreakDays = currentStreak;
    }
  }

  // Current clean streak: consecutive clean days ending at today (dayIdx 0).
  // Iterates from today backward and stops at the first day with an incident.
  // Works for any scope (train line, bus route, system) — unlike the
  // Metro-only quietestLineDays exposed by computeSummaryStats.
  let currentStreakDays = 0;
  for (let d = 0; d < windowDays; d++) {
    if (daysWithIncident.has(d)) break;
    currentStreakDays += 1;
  }

  const startsInWindow = starts.filter((t) => t >= cutoffDayUTC).sort((a, b) => a - b);
  let medianGapHours = null;
  if (startsInWindow.length >= 2) {
    const gaps = [];
    for (let i = 1; i < startsInWindow.length; i++) {
      gaps.push(startsInWindow[i] - startsInWindow[i - 1]);
    }
    gaps.sort((a, b) => a - b);
    const mid = Math.floor(gaps.length / 2);
    const medianMs = gaps.length % 2 === 0 ? (gaps[mid - 1] + gaps[mid]) / 2 : gaps[mid];
    medianGapHours = medianMs / (60 * 60 * 1000);
  }

  return {
    incidentFreeDays,
    totalDays: windowDays,
    medianGapHours,
    longestStreakDays,
    currentStreakDays,
  };
}

// Default SEPTA service window: roughly 5am–1am, ≈ 20 hours per line per day.
// SEPTA Metro runs no 24-hour rail service — overnight, the L1 and B1 are
// replaced by Owl buses (their own routes, L1-OWL and B1-OWL) — so no Metro
// line gets a longer day. A line listed in OWL_SERVICE_LINES would get 24h.
// Bus routes vary too widely to model individually; they fall back to 20.
export const DEFAULT_SERVICE_HOURS_PER_DAY = 20;
const OWL_SERVICE_LINES = new Set();

/**
 * Service hours per day for the denominator in `computeDisruptionMinutes`.
 * @param {'metro'|'bus'} kind
 * @param {string} line
 * @returns {number}
 */
export function serviceHoursForLine(kind, line) {
  if (kind === 'metro' && OWL_SERVICE_LINES.has(line)) return 24;
  return DEFAULT_SERVICE_HOURS_PER_DAY;
}

// Back-compat re-export. The previous single-number constant is still used by
// callers that pass `linesInScope` as a count rather than a list of lines.
export const SERVICE_HOURS_PER_DAY = DEFAULT_SERVICE_HOURS_PER_DAY;

// Disruption-hours: total line-hours of incident coverage over a rolling
// window. Caller hands in a single scope's alerts/observations (one line,
// one route, or the whole system). For a multi-line SEPTA alert (e.g. the
// trolley tunnel shared by T1–T5), each affected line counts separately — a
// 60-min alert on T1+T2 contributes 120 line-minutes, matching the per-day
// timeline cells which also draw on both rows.
//
// Spans are clamped to the window and to `now` (active spans extend to now).
// Overlapping incidents on the same line collapse to the union of their
// intervals so a held cluster + ghost detection don't double-count.
//
// `serviceMinutes` denominator: sum over each line in scope of that line's
// service-hours-per-day × windowDays (see serviceHoursForLine — 20h/day for
// every SEPTA line and route today). The caller specifies scope via one of:
//   - `lines: Array<{kind, line}>` (preferred) — explicit set of scope lines.
//   - `linesInScope: number` (legacy) — bare count, multiplied by the default
//     20h/day. Used when the caller doesn't know the exact line breakdown.
/**
 * @param {import('./incidents.js').Alert[]} alerts
 * @param {import('./incidents.js').Observation[]} observations
 * @param {object} [options]
 * @param {number} [options.now]
 * @param {number} [options.windowDays]
 * @param {Array<{kind: 'metro'|'bus', line: string}> | null} [options.lines]
 * @param {number} [options.linesInScope] Ignored when `lines` is provided.
 * @returns {{
 *   disruptedMinutes: number,
 *   serviceMinutes: number,
 *   ratio: number,
 * }}
 */
export function computeDisruptionMinutes(
  alerts,
  observations,
  { now = Date.now(), windowDays = 30, lines = null, linesInScope = 1 } = {},
) {
  const cutoff = now - windowDays * DAY_MS;

  const { merged, standaloneAlerts, standaloneObs } = getMerge(alerts, observations);

  // When `lines` is provided as scope, only intervals on those routes count
  // toward the numerator. Without this filter, a multi-route reroute alert
  // (a typical SEPTA bus reroute can list 10+ affected routes) would have its
  // full duration added once per route in the alert's `routes` array, even
  // when the caller is asking about a single route — inflating the total
  // disruption time by a factor equal to the alert's route-count.
  const scopeSet =
    Array.isArray(lines) && lines.length > 0
      ? new Set(lines.map(({ kind, line }) => `${kind}:${line}`))
      : null;

  // Per-line interval list. Key: kind + ':' + line. Each entry is a list of
  // [start, end] tuples clamped to the window. We union per-line so two
  // simultaneous detections on L1 don't both add to the total.
  const byLine = new Map();
  function add(lineKey, start, end) {
    if (start == null) return;
    if (scopeSet && !scopeSet.has(lineKey)) return;
    const lo = Math.max(start, cutoff);
    const hi = Math.min(end ?? now, now);
    if (hi <= lo) return;
    if (!byLine.has(lineKey)) byLine.set(lineKey, []);
    byLine.get(lineKey).push([lo, hi]);
  }

  for (const m of merged) {
    for (const route of m.routes || []) {
      add(`${m.kind}:${route}`, m.first_seen_ts, m.resolved_ts);
    }
  }
  for (const a of standaloneAlerts) {
    for (const route of a.routes || []) {
      add(`${a.kind}:${route}`, a.first_seen_ts, a.resolved_ts);
    }
  }
  for (const o of standaloneObs) {
    if (o.line == null) continue;
    add(`${o.kind}:${o.line}`, o.ts, o.resolved_ts);
  }

  let disruptedMs = 0;
  for (const intervals of byLine.values()) {
    intervals.sort((a, b) => a[0] - b[0]);
    // Union overlapping intervals so concurrent detections don't double-count.
    let curStart = null;
    let curEnd = null;
    for (const [s, e] of intervals) {
      if (curStart == null) {
        curStart = s;
        curEnd = e;
        continue;
      }
      if (s <= curEnd) {
        if (e > curEnd) curEnd = e;
      } else {
        disruptedMs += curEnd - curStart;
        curStart = s;
        curEnd = e;
      }
    }
    if (curStart != null) disruptedMs += curEnd - curStart;
  }

  const disruptedMinutes = Math.round(disruptedMs / 60_000);
  let serviceHoursTotal;
  if (Array.isArray(lines) && lines.length > 0) {
    serviceHoursTotal = lines.reduce(
      (acc, { kind, line }) => acc + serviceHoursForLine(kind, line),
      0,
    );
  } else {
    serviceHoursTotal = Math.max(1, linesInScope) * DEFAULT_SERVICE_HOURS_PER_DAY;
  }
  const serviceMinutes = serviceHoursTotal * windowDays * 60;
  // Spans are wall-clock while the denominator counts service hours, so a line
  // disrupted around the clock (a weeks-long station closure) would otherwise
  // read as more than 100% of the time.
  const ratio = serviceMinutes > 0 ? Math.min(1, disruptedMs / (serviceMinutes * 60_000)) : 0;
  return { disruptedMinutes, serviceMinutes, ratio };
}

// Histogram bins for resolution-time distributions on LinePage. Tuned to
// the timescales SEPTA disruptions actually live in: most pulse-detected
// observations clear in well under an hour, while SEPTA alerts can stretch
// to multi-hour reroutes. Six bins keeps the chart compact and the bin
// boundaries memorable.
export const DURATION_BINS = [
  { label: '< 15m', loMs: 0, hiMs: 15 * 60_000 },
  { label: '15–30m', loMs: 15 * 60_000, hiMs: 30 * 60_000 },
  { label: '30m–1h', loMs: 30 * 60_000, hiMs: 60 * 60_000 },
  { label: '1–2h', loMs: 60 * 60_000, hiMs: 2 * 60 * 60_000 },
  { label: '2–4h', loMs: 2 * 60 * 60_000, hiMs: 4 * 60 * 60_000 },
  { label: '4h+', loMs: 4 * 60 * 60_000, hiMs: Number.POSITIVE_INFINITY },
];

// Resolution-time histogram for a (line/route, window) cohort. Inputs are
// expected to already be filtered to the relevant scope — the caller hands
// in alerts/observations for one line and the helper bins their durations.
// Active incidents are excluded (they have no real duration yet); incidents
// that started before the window are excluded too so a stale long disruption
// doesn't dominate the rightmost bin forever.
/**
 * @param {import('./incidents.js').Alert[]} alerts
 * @param {import('./incidents.js').Observation[]} observations
 * @param {object} [options]
 * @param {number} [options.now]
 * @param {number} [options.windowDays]
 * @returns {{ bins: Array<{ label: string, loMs: number, hiMs: number, count: number }>, total: number }}
 */
export function computeDurationHistogram(
  alerts,
  observations,
  { now = Date.now(), windowDays = 90 } = {},
) {
  const cutoff = now - windowDays * DAY_MS;
  const bins = DURATION_BINS.map((b) => ({ ...b, count: 0 }));

  const { merged, standaloneAlerts, standaloneObs } = getMerge(alerts, observations);

  function tally(start, end) {
    if (start == null || end == null) return;
    if (start < cutoff) return;
    const dur = end - start;
    if (dur <= 0) return;
    for (const b of bins) {
      if (dur >= b.loMs && dur < b.hiMs) {
        b.count += 1;
        return;
      }
    }
  }
  for (const m of merged) tally(m.first_seen_ts, m.resolved_ts);
  for (const a of standaloneAlerts) tally(a.first_seen_ts, a.resolved_ts);
  for (const o of standaloneObs) tally(o.ts, o.resolved_ts);

  let total = 0;
  for (const b of bins) total += b.count;
  return { bins, total };
}

// Worst single day within the window for the given scope. Caller hands in
// alerts/observations already filtered to a line, route, station, or the
// whole system; this just counts distinct merged incidents by Philadelphia
// calendar day and picks the busiest. Returns null when there are no
// incidents to rank.
//
// Window is anchored on the most recent `windowDays` calendar days so an
// old "worst day" doesn't get re-crowned indefinitely.
/**
 * @param {import('./incidents.js').Alert[]} alerts
 * @param {import('./incidents.js').Observation[]} observations
 * @param {object} [options]
 * @param {number} [options.now]
 * @param {number} [options.windowDays]
 * @returns {{ dayUtc: number, count: number } | null}
 */
export function computeWorstDay(alerts, observations, { now = Date.now(), windowDays = 90 } = {}) {
  const todayUtc = phillyDayUTC(now);
  const cutoffDayUtc = todayUtc - (windowDays - 1) * DAY_MS;

  const { merged, standaloneAlerts, standaloneObs } = getMerge(alerts, observations);

  const dayCounts = new Map();
  function bump(ts) {
    if (ts == null) return;
    const day = phillyDayUTC(ts);
    if (day < cutoffDayUtc || day > todayUtc) return;
    dayCounts.set(day, (dayCounts.get(day) || 0) + 1);
  }
  for (const m of merged) bump(m.first_seen_ts);
  for (const a of standaloneAlerts) bump(a.first_seen_ts);
  for (const o of standaloneObs) bump(o.first_seen_ts ?? o.ts);

  let worst = null;
  for (const [dayUtc, count] of dayCounts) {
    if (!worst || count > worst.count) worst = { dayUtc, count };
  }
  return worst;
}

// Distribution of resolved-incident durations in the same cohort as
// `incident` (same kind / line / signal). Returns the cohort's median +
// p90 alongside this incident's duration — caller picks how to render the
// comparison ("47m vs 22m median, 2.1× longer than typical"). Returns null
// when there's no usable cohort: the incident has no signal to bucket on,
// or fewer than `minCohort` resolved peers in the window.
//
// Counted peers exclude this incident itself (caller passes its own
// reference so we can match it by post_url and skip).
/**
 * @param {object} incident
 * @param {import('./incidents.js').Alert[]} alerts
 * @param {import('./incidents.js').Observation[]} observations
 * @param {object} [options]
 * @param {number} [options.now]
 * @param {number} [options.windowDays]
 * @param {number} [options.minCohort]   Below this peer count the comparison is too noisy to display.
 * @returns {{ thisMs: number | null, medianMs: number, p90Ms: number, maxMs: number, count: number } | null}
 */
export function computeCohortDurationStats(
  incident,
  alerts,
  observations,
  { now = Date.now(), windowDays = 90, minCohort = 5 } = {},
) {
  if (!incident) return null;
  const targetKey = typicalDurationKey(incident);
  if (!targetKey) return null;
  const cutoff = now - windowDays * DAY_MS;

  const { merged, standaloneObs } = getMerge(alerts, observations);

  const incidentEventId =
    postUrlRkey(incident.post_url) ?? postUrlRkey(incident.obs_post_url) ?? null;
  const isSelf = (other) => {
    const otherId = postUrlRkey(other.post_url) ?? postUrlRkey(other.obs_post_url) ?? null;
    return otherId != null && incidentEventId != null && otherId === incidentEventId;
  };

  const durations = [];
  function offer(peer, startTs, resolvedTs) {
    if (resolvedTs == null || startTs == null) return;
    if (startTs < cutoff) return;
    if (typicalDurationKey(peer) !== targetKey) return;
    if (isSelf(peer)) return;
    const dur = peer.duration_ms ?? resolvedTs - startTs;
    if (dur <= 0) return;
    durations.push(dur);
  }
  for (const m of merged) offer(m, m.first_seen_ts, m.resolved_ts);
  for (const o of standaloneObs) offer(o, o.ts, o.resolved_ts);

  if (durations.length < minCohort) return null;

  durations.sort((a, b) => a - b);
  const pickAt = (p) => {
    const idx = Math.min(durations.length - 1, Math.floor(p * durations.length));
    return durations[idx];
  };
  const medianMs =
    durations.length % 2 === 0
      ? (durations[durations.length / 2 - 1] + durations[durations.length / 2]) / 2
      : durations[(durations.length - 1) / 2];
  const p90Ms = pickAt(0.9);
  const maxMs = durations[durations.length - 1];

  const thisStart = incident.first_seen_ts ?? incident.ts ?? null;
  const thisEnd = incident.resolved_ts ?? null;
  const thisMs =
    thisStart != null && thisEnd != null ? (incident.duration_ms ?? thisEnd - thisStart) : null;

  return { thisMs, medianMs, p90Ms, maxMs, count: durations.length };
}

// Bucket key for typical-duration cohorts: same kind, same line/route, same
// signal "type" (single signal name, or 'roundup' for multi-signal records).
// Returns null when the incident lacks a signal — official-only alerts have no
// type to bucket on, so they get no median hint.
export function typicalDurationKey(incident) {
  if (!incident) return null;
  const kind = incident.kind;
  // Standalone observation has `line`; merged record carries the observation's
  // line as `obs_line` (the alert's `routes` may include multiple lines).
  const lineOrRoute = incident.obs_line ?? incident.line ?? null;
  if (!kind || !lineOrRoute) return null;

  const detection = incident.obs_detection_source ?? incident.detection_source;
  if (!detection) return null;
  const signal = detection === 'roundup' ? 'roundup' : detection;
  return `${kind}::${lineOrRoute}::${signal}`;
}

// Median resolved-incident duration per (kind, line, signal) cohort over a
// rolling window. Powers the "typically clears in ~Xm" hint on active alert
// cards. Only resolved incidents count (active ones have no real duration);
// official-only alerts are excluded (no signal type — see typicalDurationKey).
//
// Returns a Map of bucket-key → { medianMs, count }. Callers gate display on
// count >= some threshold (5 by convention) so a sparse cohort can't show a
// volatile median.
/**
 * @param {import('./incidents.js').Alert[]} alerts
 * @param {import('./incidents.js').Observation[]} observations
 * @param {object} [options]
 * @param {number} [options.now]
 * @param {number} [options.windowDays]
 * @returns {Map<string, { medianMs: number, count: number }>}
 */
export function computeTypicalDurations(
  alerts,
  observations,
  { now = Date.now(), windowDays = 90 } = {},
) {
  const cutoff = now - windowDays * DAY_MS;
  const buckets = new Map();

  function add(incident, startTs, resolvedTs) {
    if (resolvedTs == null) return;
    if (startTs < cutoff) return;
    const duration = resolvedTs - startTs;
    if (duration <= 0) return;
    const key = typicalDurationKey(incident);
    if (!key) return;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(duration);
  }

  const { merged, standaloneObs } = getMerge(alerts, observations);

  for (const m of merged) add(m, m.first_seen_ts, m.resolved_ts);
  for (const o of standaloneObs) add(o, o.ts, o.resolved_ts);

  const out = new Map();
  for (const [key, durations] of buckets) {
    durations.sort((a, b) => a - b);
    const mid = Math.floor(durations.length / 2);
    const medianMs =
      durations.length % 2 === 0 ? (durations[mid - 1] + durations[mid]) / 2 : durations[mid];
    out.set(key, { medianMs, count: durations.length });
  }
  return out;
}

// One-line narrative summary of today's activity for the homepage. Uses
// merged incidents so an alert+observation pair counts once. Returns null
// when there's no data to summarize (e.g. before data_start_ts).
//
// Returns `{ text, lastWeek }` where `text` is the periodless narrative and
// `lastWeek` (or null) carries the same-weekday-last-week comparison so the
// renderer can turn the date into a link to that day's page. The trailing
// period is the renderer's job since the last-week clause comes after it.
//
// `text` takes one of three shapes:
//   - quiet day:   "Quiet today — 0 new incidents so far · 14 hours since the last"
//   - busy day:    "Today: 5 incidents across 3 lines · 1 still ongoing"
//   - simple busy: "Today: 1 incident on the L1"
//
// `lastWeek`, when present: `{ count, label, iso }` — e.g.
//   `{ count: 24, label: 'Saturday, May 23', iso: '2026-05-23' }`. The count
// is incidents that *started* that day (matches today's started-today count
// for a fair weekly comparison); note the day page counts incidents that
// *overlap* the day, so its total can be higher.
/**
 * @param {import('./incidents.js').Alert[]} alerts
 * @param {import('./incidents.js').Observation[]} observations
 * @param {number} [now]
 * @returns {{ text: string, lastWeek: { count: number, label: string, iso: string } | null } | null}
 */
export function buildTodaySummary(alerts, observations, now = Date.now()) {
  const todayUtc = phillyDayUTC(now);
  const lastWeekUtc = todayUtc - 7 * DAY_MS;

  const { merged, standaloneAlerts, standaloneObs } = getMerge(alerts, observations);

  const todays = [];
  let lastWeekSameDayCount = 0;
  const allTs = [];
  function consider(ts, lines, active) {
    if (ts == null) return;
    allTs.push(ts);
    const day = phillyDayUTC(ts);
    if (day === todayUtc) {
      todays.push({ lines: lines || [], active });
    } else if (day === lastWeekUtc) {
      lastWeekSameDayCount += 1;
    }
  }
  for (const m of merged) consider(m.first_seen_ts, m.routes, m.active);
  for (const a of standaloneAlerts) consider(a.first_seen_ts, a.routes, a.active);
  for (const o of standaloneObs) consider(o.ts, [o.line], o.active);

  if (allTs.length === 0) return null;

  if (todays.length === 0) {
    const lastTs = Math.max(...allTs);
    const elapsedMs = now - lastTs;
    if (elapsedMs < 0) return { text: 'Quiet today — 0 new incidents so far', lastWeek: null };
    const hours = Math.floor(elapsedMs / (60 * 60 * 1000));
    if (hours < 24) {
      return {
        text: `Quiet today — 0 new incidents so far · ${hours} hour${hours === 1 ? '' : 's'} since the last`,
        lastWeek: null,
      };
    }
    const days = Math.floor(hours / 24);
    return {
      text: `Quiet today — 0 new incidents so far · ${days} day${days === 1 ? '' : 's'} since the last incident`,
      lastWeek: null,
    };
  }

  const activeCount = todays.filter((i) => i.active).length;
  const lineSet = new Set();
  for (const inc of todays) {
    for (const l of inc.lines) lineSet.add(l);
  }

  const incidentWord = todays.length === 1 ? 'incident' : 'incidents';
  let head = `Today: ${todays.length} ${incidentWord}`;
  if (lineSet.size > 1) {
    head += ` across ${lineSet.size} lines/routes`;
  } else if (lineSet.size === 1) {
    // Line keys are disjoint across networks ('l1' Metro, 'pao' Regional
    // Rail, '17' bus), so the bare key is enough to pick the label.
    const only = [...lineSet][0];
    if (METRO_LINE_ORDER.includes(only)) head += ` on the ${METRO_LINES[only].label}`;
    else if (RAIL_LINE_ORDER.includes(only)) head += ` on the ${RAIL_LINES[only].label} Line`;
    else head += ` on ${formatBusRoute(only)}`;
  }
  if (activeCount > 0) {
    head += ` · ${activeCount} still ongoing`;
  }
  // Same-weekday-last-week context. Skip when the count would be misleading:
  //   - 0/0 looks meaningless ("0 incidents, 0 last X" repeats the obvious)
  //   - early-morning today (lastWeek had a full day to accumulate; today
  //     may have just a couple hours, so the comparison is unfair before
  //     the day really gets going)
  const hoursIntoToday = (now - todayUtc) / (60 * 60 * 1000);
  let lastWeek = null;
  if (lastWeekSameDayCount > 0 && hoursIntoToday >= 6) {
    // Anchor the formatter at noon Philadelphia a week ago so the date components
    // can't be flipped by a UTC-vs-Philadelphia day boundary (lastWeekUtc is the
    // midnight-Philadelphia instant for that day; formatting it directly is safe
    // in any TZ, but noon is unambiguous regardless of DST transitions).
    const weekAgo = new Date(lastWeekUtc + 12 * 60 * 60 * 1000);
    const labeled = new Intl.DateTimeFormat('en-US', {
      timeZone: PHILLY_TZ,
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    }).format(weekAgo);
    // lastWeekUtc is the UTC-midnight instant for that Philadelphia day, so its
    // ISO date slice is the /day/:date path component verbatim.
    const iso = new Date(lastWeekUtc).toISOString().slice(0, 10);
    // Intl returns "Wednesday, May 6" with a comma already.
    lastWeek = { count: lastWeekSameDayCount, label: labeled, iso };
  }
  return { text: head, lastWeek };
}

const WEEK_MS = 7 * DAY_MS;

// Sunday (as a phillyDayUTC value) of the week containing `dayUtc`. Input is
// itself a phillyDayUTC value; since those are UTC-midnight stamps spaced
// exactly a day apart, getUTCDay() reads the Philadelphia weekday and the
// subtraction is DST-safe.
export function weekStartUTC(dayUtc) {
  return dayUtc - new Date(dayUtc).getUTCDay() * DAY_MS;
}

// Sun-start weeks (each the Sunday's phillyDayUTC value) from the week
// containing `dataStartTs` through the week containing `now`, most-recent
// first. Returns [] when dataStartTs is missing. Drives the /week archive
// navigation, prerender list, and sitemap.
export function listWeeks({ dataStartTs, now = Date.now() } = {}) {
  if (dataStartTs == null) return [];
  const first = weekStartUTC(phillyDayUTC(dataStartTs));
  const current = weekStartUTC(phillyDayUTC(now));
  const weeks = [];
  for (let w = current; w >= first; w -= WEEK_MS) weeks.push(w);
  return weeks;
}

// Factual recap of one Sun–Sat week for the /week archive. `weekStartUtc` is
// the Sunday (a phillyDayUTC value). Buckets incidents by their START day —
// all comparisons in phillyDayUTC space, never raw epochs — so the total
// matches the per-day bars and the "started this week" framing. Uses merged
// incidents so an alert + matching observation count once. Purely descriptive:
// counts, busiest day, most-affected lines, the single longest incident, and a
// prior-week total for an unspun week-over-week delta. No scoring.
/**
 * @param {import('./incidents.js').Alert[]} alerts
 * @param {import('./incidents.js').Observation[]} observations
 * @param {number} weekStartUtc  Sunday of the week (a phillyDayUTC value)
 * @param {number} [now]
 */
export function buildWeekSummary(alerts, observations, weekStartUtc, now = Date.now()) {
  const weekEndExclusive = weekStartUtc + WEEK_MS; // next Sunday (day space)
  const priorStart = weekStartUtc - WEEK_MS;
  const { merged, standaloneAlerts, standaloneObs } = getMerge(alerts, observations);

  const incidents = [
    ...merged.map((m) => ({
      ts: m.first_seen_ts,
      kind: m.kind,
      lines: m.routes ?? [],
      active: m.active,
      resolved_ts: m.resolved_ts,
      duration_ms: m.duration_ms,
      headline: m.headline ?? null,
      post_url: m.post_url ?? m.obs_post_url ?? null,
    })),
    ...standaloneAlerts.map((a) => ({
      ts: a.first_seen_ts,
      kind: a.kind,
      lines: a.routes ?? [],
      active: a.active,
      resolved_ts: a.resolved_ts,
      duration_ms: a.duration_ms,
      headline: a.headline ?? null,
      post_url: a.post_url ?? null,
    })),
    ...standaloneObs.map((o) => ({
      ts: o.first_seen_ts ?? o.ts,
      kind: o.kind,
      lines: o.line != null ? [o.line] : [],
      active: o.active,
      resolved_ts: o.resolved_ts,
      duration_ms: o.duration_ms,
      headline: o.headline ?? null,
      post_url: o.post_url ?? null,
    })),
  ];

  const perDay = Array.from({ length: 7 }, (_, i) => ({
    dayUtc: weekStartUtc + i * DAY_MS,
    count: 0,
  }));
  const lineSet = new Set();
  const affected = new Map(); // `${kind}:${id}` -> { kind, id, count }
  let total = 0;
  let activeCount = 0;
  let metroCount = 0;
  let busCount = 0;
  let railCount = 0;
  let priorTotal = 0;
  let longest = null;

  for (const inc of incidents) {
    if (inc.ts == null) continue;
    const incDay = phillyDayUTC(inc.ts);
    if (incDay >= priorStart && incDay < weekStartUtc) {
      priorTotal += 1;
      continue;
    }
    if (incDay < weekStartUtc || incDay >= weekEndExclusive) continue;

    total += 1;
    if (inc.active) activeCount += 1;
    if (inc.kind === 'metro') metroCount += 1;
    else if (inc.kind === 'bus') busCount += 1;
    else if (inc.kind === 'rail') railCount += 1;

    const dayIdx = Math.round((incDay - weekStartUtc) / DAY_MS);
    if (dayIdx >= 0 && dayIdx < 7) perDay[dayIdx].count += 1;

    for (const l of inc.lines) {
      const id = String(l);
      const key = `${inc.kind}:${id}`;
      lineSet.add(key);
      const cur = affected.get(key) || { kind: inc.kind, id, count: 0 };
      cur.count += 1;
      affected.set(key, cur);
    }

    // Longest incident of the week — real durations (resolved span, or
    // elapsed-so-far for one still active). duration_ms is preferred where the
    // exporter provides it (absence-style observations bake in a pre-post tail).
    const end = inc.resolved_ts ?? now;
    const durationMs = inc.duration_ms ?? end - inc.ts;
    if (durationMs > 0 && (!longest || durationMs > longest.durationMs)) {
      longest = {
        kind: inc.kind,
        routes: inc.lines.map(String),
        headline: inc.headline,
        durationMs,
        active: !!inc.active,
        startTs: inc.ts,
        id: postUrlRkey(inc.post_url),
      };
    }
  }

  let busiestDay = null;
  for (const d of perDay) {
    if (d.count > 0 && (!busiestDay || d.count > busiestDay.count)) busiestDay = d;
  }

  const mostAffected = [...affected.values()].sort(
    (a, b) => b.count - a.count || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  return {
    weekStartUtc,
    weekEndUtc: weekStartUtc + 6 * DAY_MS,
    isCurrent: weekStartUtc === weekStartUTC(phillyDayUTC(now)),
    total,
    activeCount,
    metroCount,
    busCount,
    railCount,
    lineCount: lineSet.size,
    perDay,
    busiestDay,
    mostAffected,
    longest,
    priorTotal,
  };
}

// Leaderboard-style stats for the /stats page. Computed against the full
// dataset (no filtering) so each "worst" answer reflects the project's
// recorded history end-to-end. Returns null fields when there's nothing
// in the cohort yet rather than fake-zero rows.
//
//   worstDay        — Philadelphia calendar day with the most distinct incidents.
//   worstHour       — (weekday, hour) cell of the hour-of-week heatmap with
//                     the highest start count.
//   worstStation    — station with the most incident touches in the rolling
//                     window (uses buildStationIndex's own gating).
//   longestIncident — longest resolved incident in ms with its key fields.
/**
 * @param {import('./incidents.js').Alert[]} alerts
 * @param {import('./incidents.js').Observation[]} observations
 * @param {object} [options]
 * @param {number} [options.now]
 * @param {number} [options.windowDays] Used by station + day cohorts.
 * @returns {{
 *   worstDay: { dayUtc: number, count: number } | null,
 *   worstHour: { weekday: number, hour: number, count: number } | null,
 *   worstStation: { slug: string, name: string, count: number, lines: string[] } | null,
 *   longestIncident: {
 *     id: string,
 *     kind: string,
 *     routes: string[],
 *     headline: string | null,
 *     fromStation: string | null,
 *     toStation: string | null,
 *     startTs: number,
 *     endTs: number,
 *     durationMs: number,
 *     postUrl: string | null,
 *   } | null,
 * }}
 */
export function computeStatsLeaderboards(
  alerts,
  observations,
  { now = Date.now(), windowDays = 90 } = {},
) {
  const cutoff = now - windowDays * DAY_MS;

  const { merged, standaloneAlerts, standaloneObs } = getMerge(alerts, observations);

  // worstDay — bucket each incident by its Philadelphia start day.
  const dayCounts = new Map();
  function bumpDay(ts) {
    if (ts == null) return;
    const day = phillyDayUTC(ts);
    dayCounts.set(day, (dayCounts.get(day) || 0) + 1);
  }
  for (const m of merged) bumpDay(m.first_seen_ts);
  for (const a of standaloneAlerts) bumpDay(a.first_seen_ts);
  for (const o of standaloneObs) bumpDay(o.ts);
  let worstDay = null;
  for (const [dayUtc, count] of dayCounts) {
    if (!worstDay || count > worstDay.count) worstDay = { dayUtc, count };
  }

  // worstHour — same dataset reused via buildHourOfWeek so the cell
  // semantics match the homepage heatmap exactly.
  const { grid, maxCount: hourMax, total: hourTotal } = buildHourOfWeek(alerts, observations);
  let worstHour = null;
  if (hourTotal > 0 && hourMax > 0) {
    for (let w = 0; w < 7; w++) {
      for (let h = 0; h < 24; h++) {
        if (grid[w][h] === hourMax) {
          worstHour = { weekday: w, hour: h, count: hourMax };
          break;
        }
      }
      if (worstHour) break;
    }
  }

  // worstStation — reuse buildStationIndex (windowDays-bounded by design).
  const stationIndex = buildStationIndex(alerts, observations, { now, windowDays });
  let worstStation = null;
  for (const rec of stationIndex.values()) {
    if (!worstStation || rec.count > worstStation.count) {
      worstStation = {
        slug: rec.slug,
        name: rec.name,
        count: rec.count,
        lines: rec.lines,
      };
    }
  }

  // longestIncident — only resolved incidents with a positive duration count.
  // Walk merged + standalones the same way the rest of the app does so a
  // merged alert+obs pair contributes once with its alert-side metadata.
  let longestIncident = null;
  function offer(incident, startTs, endTs) {
    if (endTs == null || startTs == null) return;
    // Prefer exported duration_ms — for absence-style observations it includes
    // the pre-post cold period the bot can't see in startTs alone.
    const durationMs = incident.duration_ms ?? endTs - startTs;
    if (durationMs <= 0) return;
    if (longestIncident && durationMs <= longestIncident.durationMs) return;
    const id = postUrlRkey(incident.post_url) ?? postUrlRkey(incident.obs_post_url) ?? null;
    if (!id) return;
    longestIncident = {
      id,
      kind: incident.kind,
      routes: incident.routes ?? (incident.line ? [incident.line] : []),
      headline: incident.headline ?? null,
      fromStation: incident.from_station ?? incident.affected_from_station ?? null,
      toStation: incident.to_station ?? incident.affected_to_station ?? null,
      startTs,
      endTs,
      durationMs,
      postUrl: incident.post_url ?? incident.obs_post_url ?? null,
    };
  }
  for (const m of merged) offer(m, m.first_seen_ts, m.resolved_ts);
  for (const a of standaloneAlerts) offer(a, a.first_seen_ts, a.resolved_ts);
  for (const o of standaloneObs) offer(o, o.ts, o.resolved_ts);

  // Note: `cutoff` isn't applied to worstDay / longestIncident so the page
  // can show a "longest incident on record" rather than artificially clipping.
  // The window only matters for stations and hour-of-week, where the cohort
  // sizes change as data ages out.
  void cutoff;

  return { worstDay, worstHour, worstStation, longestIncident };
}

// Regional Rail leaderboards for /stats. Regional Rail's signature data isn't
// stations or track segments (the Metro leaderboards above) — it's
// cancellations and delays,
// which the timetabled commuter-rail detectors emit as point-event
// observations (detection_source 'cancellation' / 'cancellation-inferred' /
// 'delay'). This rolls them up per line so the page can show which line is
// cancelling or running late most over the window. Official Regional Rail
// alerts (kind='rail' alerts, no detection_source) are counted separately as
// `alertsCount` for context but don't feed the per-line cancel/delay tallies.
/**
 * @param {import('./incidents.js').Alert[]} alerts
 * @param {import('./incidents.js').Observation[]} observations
 * @param {object} [options]
 * @param {number} [options.now]
 * @param {number} [options.windowDays]
 * @returns {{
 *   cancellationTotal: number,
 *   delayTotal: number,
 *   alertsCount: number,
 *   byLine: Array<{ line: string, cancellations: number, delays: number, total: number }>,
 *   topCancelled: { line: string, cancellations: number } | null,
 *   topDelayed: { line: string, delays: number } | null,
 *   hasData: boolean,
 * }}
 */
export function computeRailLeaderboards(
  alerts,
  observations,
  { now = Date.now(), windowDays = 90 } = {},
) {
  const cutoff = now - windowDays * DAY_MS;
  const perLine = new Map(); // line -> { cancellations, delays }
  const bump = (line, field) => {
    if (!line) return;
    const rec = perLine.get(line) ?? { cancellations: 0, delays: 0 };
    rec[field] += 1;
    perLine.set(line, rec);
  };
  let cancellationTotal = 0;
  let delayTotal = 0;
  for (const o of observations) {
    if (o.kind !== 'rail') continue;
    if (o.ts == null || o.ts < cutoff) continue;
    const src = o.detection_source;
    if (src === 'cancellation' || src === 'cancellation-inferred') {
      bump(o.line, 'cancellations');
      cancellationTotal += 1;
    } else if (src === 'delay') {
      bump(o.line, 'delays');
      delayTotal += 1;
    }
  }
  let alertsCount = 0;
  for (const a of alerts) {
    if (a.kind !== 'rail') continue;
    if (a.first_seen_ts == null || a.first_seen_ts < cutoff) continue;
    alertsCount += 1;
  }
  const byLine = [...perLine.entries()]
    .map(([line, c]) => ({ line, ...c, total: c.cancellations + c.delays }))
    .sort((a, b) => b.total - a.total || a.line.localeCompare(b.line));
  const topCancelled =
    byLine
      .filter((r) => r.cancellations > 0)
      .sort((a, b) => b.cancellations - a.cancellations || a.line.localeCompare(b.line))[0] ?? null;
  const topDelayed =
    byLine
      .filter((r) => r.delays > 0)
      .sort((a, b) => b.delays - a.delays || a.line.localeCompare(b.line))[0] ?? null;
  return {
    cancellationTotal,
    delayTotal,
    alertsCount,
    byLine,
    topCancelled,
    topDelayed,
    hasData: byLine.length > 0 || alertsCount > 0,
  };
}

/**
 * Count Regional Rail train-level delay/cancellation status instances from nested
 * incidents. Bot observations count individually; official-only Regional Rail alerts
 * count once through `rail_status` / text fallback.
 *
 * @param {import('./incidents.js').Incident[]} incidents
 * @param {object} [options]
 * @param {number} [options.now]
 * @param {number} [options.windowDays]
 * @param {string | null} [options.lineFilter]
 * @returns {{ cancellations: number, delays: number, total: number }}
 */
export function computeRailStatusCounts(
  incidents,
  { now = Date.now(), windowDays = 90, lineFilter = null } = {},
) {
  const cutoff = now - windowDays * DAY_MS;
  let cancellations = 0;
  let delays = 0;
  const observationInLine = (line, routes = []) =>
    !lineFilter ||
    line === lineFilter ||
    (line == null && Array.isArray(routes) && routes.includes(lineFilter));

  for (const inc of incidents || []) {
    if (legacyKind(inc) !== 'rail') continue;
    const routes = inc.routes || [];
    if (lineFilter && !routes.includes(lineFilter)) continue;

    let countedObservation = false;
    for (const o of incidentDetections(inc)) {
      const lifecycle = o.lifecycle ?? {};
      const scope = o.scope ?? {};
      if (lifecycle.first_seen_ts == null || lifecycle.first_seen_ts < cutoff) continue;
      if (!observationInLine(scope.route, routes)) continue;
      if (o.source === 'delay') {
        delays += 1;
        countedObservation = true;
      } else if (o.source === 'cancellation' || o.source === 'cancellation-inferred') {
        cancellations += 1;
        countedObservation = true;
      }
    }

    if (countedObservation) continue;
    if (!officialAlert(inc)) continue;
    const ts = incidentLifecycle(inc).first_seen_ts;
    if (ts == null || ts < cutoff) continue;
    const source = railIncidentStatus(inc)?.source;
    if (source === 'delay') delays += 1;
    else if (source === 'cancellation' || source === 'cancellation-inferred') cancellations += 1;
  }

  return { cancellations, delays, total: cancellations + delays };
}

// Per-line Regional Rail cancellation + delay analytics for the line page — the richer
// companion to computeRailStatusCounts (which returns only flat counts). It
// reuses the SAME counting model (each train-level detection 'cancellation' /
// 'cancellation-inferred' / 'delay' counts once, with an official-alert
// fallback for incidents that have no detections; planned-delay is excluded) so
// the headline numbers stay consistent with the rest of the site. On top of the
// counts it adds, for cancellations:
//   - byOrigin: the originating terminal (detection scope.from_station, or the
//     incident's cancellation block) so the page can show which terminal sheds
//     the most trains. Inferred cancellations with no named origin still count
//     but drop out of the breakdown.
//   - byPartOfDay: the scheduled departure (detection lifecycle.onset_ts)
//     bucketed into PART_OF_DAY.
//   - hoursSinceLast: recency of the most recent cancelled departure.
// Delays are counted, not measured, here — the magnitude lives on each
// incident (status.delay_min) and on the event page.
/**
 * @param {import('./incidents.js').Incident[]} incidents
 * @param {object} [options]
 * @param {number} [options.now]
 * @param {number} [options.windowDays]
 * @param {string | null} [options.lineFilter]
 * @returns {{windowDays:number,total:number,cancellations:{count:number,perWeek:number,hoursSinceLast:number|null,byOrigin:Array<{origin:string,count:number}>,byPartOfDay:Array<{key:string,label:string,range:string,count:number}>},delays:{count:number,perWeek:number}}}
 */
export function computeRailCancellationDelayStats(
  incidents,
  { now = Date.now(), windowDays = 90, lineFilter = null } = {},
) {
  const cutoff = now - windowDays * DAY_MS;
  const weeks = windowDays / 7;
  const observationInLine = (line, routes = []) =>
    !lineFilter ||
    line === lineFilter ||
    (line == null && Array.isArray(routes) && routes.includes(lineFilter));

  const originCounts = new Map();
  const partCounts = new Map(PART_OF_DAY.map((p) => [p.key, 0]));
  let cancelCount = 0;
  let delayCount = 0;
  let lastCancelTs = null;

  const recordCancellation = (depTs, origin) => {
    cancelCount += 1;
    if (depTs != null) {
      if (lastCancelTs == null || depTs > lastCancelTs) lastCancelTs = depTs;
      const { hour } = phillyWeekdayHour(depTs);
      if (hour != null) {
        const part = PART_OF_DAY.find((p) => hour >= p.lo && hour <= p.hi);
        if (part) partCounts.set(part.key, partCounts.get(part.key) + 1);
      }
    }
    if (origin) originCounts.set(origin, (originCounts.get(origin) || 0) + 1);
  };

  for (const inc of incidents || []) {
    if (legacyKind(inc) !== 'rail') continue;
    const routes = inc.routes || [];
    if (lineFilter && !routes.includes(lineFilter)) continue;

    let countedObservation = false;
    for (const o of incidentDetections(inc)) {
      const lifecycle = o.lifecycle ?? {};
      const scope = o.scope ?? {};
      if (lifecycle.first_seen_ts == null || lifecycle.first_seen_ts < cutoff) continue;
      if (!observationInLine(scope.route, routes)) continue;
      if (o.source === 'delay') {
        delayCount += 1;
        countedObservation = true;
      } else if (o.source === 'cancellation' || o.source === 'cancellation-inferred') {
        recordCancellation(
          lifecycle.onset_ts ?? lifecycle.first_seen_ts,
          scope.from_station || null,
        );
        countedObservation = true;
      }
    }
    if (countedObservation) continue;

    if (!officialAlert(inc)) continue;
    const ts = incidentLifecycle(inc).first_seen_ts;
    if (ts == null || ts < cutoff) continue;
    const source = railIncidentStatus(inc)?.source;
    if (source === 'delay') {
      delayCount += 1;
    } else if (source === 'cancellation' || source === 'cancellation-inferred') {
      const block = inc.status ?? {};
      recordCancellation(block.scheduled_departure_ts ?? ts, block.origin || null);
    }
  }

  const byOrigin = [...originCounts.entries()]
    .map(([origin, count]) => ({ origin, count }))
    .sort((a, b) => b.count - a.count || a.origin.localeCompare(b.origin));
  const byPartOfDay = PART_OF_DAY.map((p) => ({
    key: p.key,
    label: p.label,
    range: p.range,
    count: partCounts.get(p.key) || 0,
  }));

  return {
    windowDays,
    total: cancelCount + delayCount,
    cancellations: {
      count: cancelCount,
      perWeek: cancelCount / weeks,
      hoursSinceLast: lastCancelTs != null ? (now - lastCancelTs) / (60 * 60 * 1000) : null,
      byOrigin,
      byPartOfDay,
    },
    delays: {
      count: delayCount,
      perWeek: delayCount / weeks,
    },
  };
}

// Recurring segments: bucket Metro-only bot observations by (line,
// from_station → to_station) and rank by raw count. The point is to surface
// chokepoints — a stretch of track that disrupts often — which the per-
// station leaderboard (`worstStation`) doesn't capture because every cold
// stretch through 15th St/City Hall also touches 13th St, 8th-Market, etc.
// Counting unique segments instead of stations puts the spotlight on the
// actual recurring infrastructure problem rather than the busiest junction.
//
// Direction matters: the inbound and outbound sides of a segment often
// behave differently (express tracks, peak-hour switching), so (A→B) and
// (B→A) are kept distinct. SEPTA alerts are excluded — their segment endpoints
// describe a planned-reroute scope, not a recurring detection. Roundups
// also excluded (no segment endpoints).
//
// `lineFilter` lets the LinePage version reuse this helper while showing only
// that line's segments. The /stats page passes null for system-wide.
/**
 * @param {import('./incidents.js').Observation[]} observations
 * @param {object} [options]
 * @param {number} [options.now]
 * @param {number} [options.windowDays]
 * @param {string | null} [options.lineFilter]   Restrict to a single train line key.
 * @param {number} [options.limit]               Max rows returned (default 5).
 * @param {number} [options.minCount]            Drop segments below this count (default 2 — singletons aren't "recurring").
 * @returns {Array<{
 *   line: string,
 *   fromStation: string,
 *   toStation: string,
 *   count: number,
 *   lastTs: number,
 * }>}
 */
export function computeSegmentRecurrence(
  observations,
  { now = Date.now(), windowDays = 90, lineFilter = null, limit = 5, minCount = 2 } = {},
) {
  const cutoff = now - windowDays * DAY_MS;
  const buckets = new Map(); // key: `line|from|to` → { count, lastTs }

  for (const o of observations) {
    if (o.kind !== 'metro') continue;
    if (!o.from_station || !o.to_station) continue;
    if (o.detection_source === 'roundup') continue;
    const ts = o.first_seen_ts ?? o.ts;
    if (ts == null || ts < cutoff) continue;
    if (lineFilter != null && o.line !== lineFilter) continue;
    const key = `${o.line}|${o.from_station}|${o.to_station}`;
    const cur = buckets.get(key);
    if (cur) {
      cur.count += 1;
      if (ts > cur.lastTs) cur.lastTs = ts;
    } else {
      buckets.set(key, {
        line: o.line,
        fromStation: o.from_station,
        toStation: o.to_station,
        count: 1,
        lastTs: ts,
      });
    }
  }

  const rows = [...buckets.values()].filter((r) => r.count >= minCount);
  // Sort: most recurrences first; break ties by recency so a recent flare-up
  // outranks a long-ago run with the same count.
  rows.sort((a, b) => b.count - a.count || b.lastTs - a.lastTs);
  return rows.slice(0, limit);
}

export function buildSignalsByLine(observations) {
  const byLine = {};
  const totals = {};
  for (const sig of SIGNAL_TYPES) totals[sig] = 0;
  for (const line of METRO_LINE_ORDER) {
    byLine[line] = {};
    for (const sig of SIGNAL_TYPES) byLine[line][sig] = 0;
  }

  for (const o of observations) {
    if (o.kind !== 'metro') continue;
    if (!METRO_LINE_ORDER.includes(o.line)) continue;
    for (const sig of observationSignals(o)) {
      if (!(sig in totals)) continue;
      byLine[o.line][sig] += 1;
      totals[sig] += 1;
    }
  }

  return { byLine, totals };
}

// Service-restoration delta leaderboard. For every merged incident (SEPTA
// alert + matching bot observation) that has both resolution timestamps,
// compare `alert.resolved_ts` (when SEPTA marked the alert cleared) to
// `obs_resolved_ts` (when the bot saw sustained service recovery). The
// signed delta is `alert.resolved_ts - obs_resolved_ts`:
//
//   - positive → SEPTA cleared AFTER service recovered (slow to mark clear)
//   - negative → SEPTA cleared BEFORE service recovered (alert closed but
//                trains were still stuck — the bot's CLEAR_TICKS_TO_RESET
//                gate requires sustained recovery before firing, so this
//                isn't bot lag)
//
// Returns the top-N each direction. Only deltas above `minDeltaMinutes`
// count — sub-minute clock skew between the two sources isn't accountable.
//
// Pairs are gated on temporal overlap: the bot observation's [ts,
// resolved_ts] span must cover at least `minOverlapRatio` of the alert's
// [first_seen_ts, resolved_ts] span. Without this, a brief bot detection
// that happened to fire during a multi-day planned reroute (construction,
// etc.) gets paired with an alert running orders of magnitude longer than
// the actual disruption the bot saw — and the resulting "delta" compares
// two different things, not an accountability gap. Default 0.5 means the
// obs has to cover at least half the alert's lifespan for the comparison
// to be meaningful.
/**
 * @param {import('./incidents.js').Alert[]} alerts
 * @param {import('./incidents.js').Observation[]} observations
 * @param {object} [options]
 * @param {number} [options.now]
 * @param {number} [options.windowDays]
 * @param {number} [options.limit]            Top-N per direction (default 3).
 * @param {number} [options.minDeltaMinutes]  Drop tiny deltas (default 5).
 * @param {number} [options.minOverlapRatio]  Drop pairs whose obs covers less
 *   than this fraction of the alert's span (default 0.5).
 * @returns {{
 *   agencyClearedEarly: Array<RestorationDeltaRow>,
 *   agencyClearedLate:  Array<RestorationDeltaRow>,
 *   matchedCount: number,
 * }}
 */
export function computeRestorationDeltas(
  alerts,
  observations,
  { now = Date.now(), windowDays = 90, limit = 3, minDeltaMinutes = 5, minOverlapRatio = 0.5 } = {},
) {
  const cutoff = now - windowDays * DAY_MS;
  const minDeltaMs = minDeltaMinutes * 60_000;
  const { merged } = getMerge(alerts, observations);
  const rows = [];
  for (const m of merged) {
    // official-only concept: the gap between SEPTA closing an alert and the bot seeing
    // service recover. Regional Rail has no equivalent "agency cleared the alert" event,
    // so excluding it keeps the "SEPTA cleared early/late" framing accurate.
    if (m.kind === 'rail') continue;
    if (m.resolved_ts == null || m.obs_resolved_ts == null) continue;
    if (m.first_seen_ts < cutoff) continue;
    // Overlap gate: the observation must describe roughly the same span as
    // the alert. obs_ts may be missing on older snapshots — skip rather than
    // assume.
    if (m.obs_ts == null) continue;
    const alertDuration = m.resolved_ts - m.first_seen_ts;
    if (alertDuration <= 0) continue;
    const overlapStart = Math.max(m.first_seen_ts, m.obs_ts);
    const overlapEnd = Math.min(m.resolved_ts, m.obs_resolved_ts);
    const overlapMs = Math.max(0, overlapEnd - overlapStart);
    if (overlapMs / alertDuration < minOverlapRatio) continue;
    const deltaMs = m.resolved_ts - m.obs_resolved_ts;
    if (Math.abs(deltaMs) < minDeltaMs) continue;
    const id = postUrlRkey(m.post_url) ?? postUrlRkey(m.obs_post_url);
    if (!id) continue;
    rows.push({
      id,
      kind: m.kind,
      routes: m.routes ?? [],
      headline: m.headline ?? null,
      alertResolvedTs: m.resolved_ts,
      obsResolvedTs: m.obs_resolved_ts,
      firstSeenTs: m.first_seen_ts,
      deltaMs,
    });
  }
  // SEPTA cleared early: deltaMs < 0 (alert resolved before service recovered).
  // Sort by most negative first.
  const agencyClearedEarly = rows
    .filter((r) => r.deltaMs < 0)
    .sort((a, b) => a.deltaMs - b.deltaMs)
    .slice(0, limit);
  // SEPTA cleared late: deltaMs > 0. Sort by most positive first.
  const agencyClearedLate = rows
    .filter((r) => r.deltaMs > 0)
    .sort((a, b) => b.deltaMs - a.deltaMs)
    .slice(0, limit);
  return { agencyClearedEarly, agencyClearedLate, matchedCount: rows.length };
}

/**
 * @typedef {object} RestorationDeltaRow
 * @property {string} id
 * @property {'metro'|'bus'} kind
 * @property {string[]} routes
 * @property {string|null} headline
 * @property {number} alertResolvedTs
 * @property {number} obsResolvedTs
 * @property {number} firstSeenTs
 * @property {number} deltaMs   Signed: positive = SEPTA cleared late, negative = SEPTA cleared early.
 */

// Year-over-year comparison: count merged incidents in the trailing
// `windowDays` ending now vs the same calendar window one year prior.
// Returns `{ enoughData: false }` when the dataset doesn't reach back far
// enough to cover the prior window — callers gate display on that flag
// rather than rendering misleading "0 vs 5" deltas.
//
// Inputs are expected to already be scoped (full system on /stats; one
// line/route on LinePage); this helper just counts what it's given.
/**
 * @param {import('./incidents.js').Alert[]} alerts
 * @param {import('./incidents.js').Observation[]} observations
 * @param {object} [options]
 * @param {number} [options.now]
 * @param {number} [options.windowDays] Width of each comparison window. Default 30.
 * @param {number | null} [options.dataStartTs] Earliest moment we have
 *   coverage for. When the prior window starts before this, returns
 *   enoughData:false.
 * @returns {{
 *   enoughData: boolean,
 *   currentCount: number,
 *   priorCount: number,
 *   pctChange: number | null,
 *   currentStartTs: number,
 *   currentEndTs: number,
 *   priorStartTs: number,
 *   priorEndTs: number,
 * }}
 */
export function computeYearOverYear(
  alerts,
  observations,
  { now = Date.now(), windowDays = 30, dataStartTs = null } = {},
) {
  const yearMs = 365 * DAY_MS;
  const windowMs = windowDays * DAY_MS;
  const currentEndTs = now;
  const currentStartTs = now - windowMs;
  const priorEndTs = now - yearMs;
  const priorStartTs = priorEndTs - windowMs;

  // `enoughData` gates only the year-over-year comparison (priorCount /
  // pctChange), which needs a full prior window. `currentCount` — the
  // trailing-`windowDays` count — is always well-defined, so we count it
  // regardless and never early-return a hardcoded 0. Callers that show the
  // current count alone (e.g. the compare table's "Last 30 days" row) rely
  // on this; YoY callers still gate on `enoughData`.
  const enoughData = dataStartTs == null || dataStartTs <= priorStartTs;

  const { merged, standaloneAlerts, standaloneObs } = getMerge(alerts, observations);
  let currentCount = 0;
  let priorCount = 0;
  function bump(ts) {
    if (ts == null) return;
    if (ts >= currentStartTs && ts <= currentEndTs) currentCount += 1;
    else if (ts >= priorStartTs && ts <= priorEndTs) priorCount += 1;
  }
  for (const m of merged) bump(m.first_seen_ts);
  for (const a of standaloneAlerts) bump(a.first_seen_ts);
  for (const o of standaloneObs) bump(o.first_seen_ts ?? o.ts);

  const pctChange = enoughData && priorCount > 0 ? (currentCount - priorCount) / priorCount : null;
  return {
    enoughData,
    currentCount,
    priorCount,
    pctChange,
    currentStartTs,
    currentEndTs,
    priorStartTs,
    priorEndTs,
  };
}

// ── Event-page insight helpers ────────────────────────────────────────────
// These read the nested `incidents[]` payload directly (one object per
// real-world disruption) rather than the flat alert/observation arrays the
// aggregators above were written against. They power the per-event callouts:
// "is this a chronic trouble spot?", "was this a bad one?", "is this a busy
// hour for the line?". All are pure and windowed off `now`.

// Span of a single nested incident in ms: resolved_ts - first_seen_ts. Null
// for still-active incidents (no honest endpoint) — severity framing is
// retrospective, so an open incident gets no rank.
function incidentSpanMs(inc) {
  const lifecycle = incidentLifecycle(inc);
  if (lifecycle.resolved_ts == null || lifecycle.first_seen_ts == null) return null;
  const d = lifecycle.resolved_ts - lifecycle.first_seen_ts;
  return d > 0 ? d : null;
}

// True when a nested incident touches any of `routeSet` and matches `kind`.
function incidentTouchesRoutes(inc, kind, routeSet) {
  if (legacyKind(inc) !== kind) return false;
  return (inc.routes || []).some((r) => routeSet.has(r));
}

// Place-scoped recurrence: how many incidents in the window hit the exact same
// line stretch (from→to) as this one. Counts whole incidents (not raw
// observations) so a merged record with two pulse-cold obs on the stretch
// still counts once. Metro-only and stretch-only — the caller passes the
// subject's line/from/to (from its primary bot observation); official-only and bus
// incidents have no comparable stretch and yield null upstream.
//
// Returns null unless the stretch recurred at least once *besides* this
// incident (priorCount >= 1) — a one-off isn't a "trouble spot".
export function computeStretchRecurrence(
  incidents,
  { line, fromStation, toStation, selfId = null, now = Date.now(), windowDays = 90 } = {},
) {
  if (!line || !fromStation || !toStation) return null;
  const cutoff = now - windowDays * DAY_MS;
  let count = 0;
  let priorCount = 0;
  let lastOtherTs = null;
  const days = new Set();
  for (const inc of incidents || []) {
    if (legacyKind(inc) !== 'metro') continue;
    const ts = incidentLifecycle(inc).first_seen_ts;
    if (ts == null || ts < cutoff) continue;
    const matches = incidentDetections(inc).some(
      (o) =>
        o.source !== 'roundup' &&
        o.scope?.route === line &&
        o.scope?.from_station === fromStation &&
        o.scope?.to_station === toStation,
    );
    if (!matches) continue;
    count += 1;
    days.add(phillyDayUTC(ts));
    if (inc.id !== selfId) {
      priorCount += 1;
      if (lastOtherTs == null || ts > lastOtherTs) lastOtherTs = ts;
    }
  }
  if (priorCount < 1) return null;
  return {
    count,
    priorCount,
    distinctDays: days.size,
    lastOtherTs,
    line,
    fromStation,
    toStation,
    windowDays,
  };
}

// Line-wide severity rank: where this incident's duration sits among all
// resolved incidents touching the same line/route in the window, regardless
// of signal type (so an official-only alert still ranks). Returns a tier only when
// notable — the longest, or within the top decile — and only with a cohort
// big enough (`minCohort`) that "longest of 3" can't masquerade as severe.
export function computeLineDurationRank(
  incident,
  incidents,
  { now = Date.now(), windowDays = 30, minCohort = 8 } = {},
) {
  const routes = incident?.routes || [];
  if (routes.length === 0) return null;
  const thisMs = incidentSpanMs(incident);
  if (thisMs == null) return null; // active or unbounded — no retrospective rank
  const routeSet = new Set(routes);
  const cutoff = now - windowDays * DAY_MS;

  const spans = [];
  for (const inc of incidents || []) {
    if (!incidentTouchesRoutes(inc, legacyKind(incident), routeSet)) continue;
    const firstSeen = incidentLifecycle(inc).first_seen_ts;
    if (firstSeen == null || firstSeen < cutoff) continue;
    const d = incidentSpanMs(inc);
    if (d == null) continue;
    spans.push({ id: inc.id, d });
  }
  if (spans.length < minCohort) return null;

  spans.sort((a, b) => b.d - a.d); // longest first
  const rankIdx = spans.findIndex((x) => x.id === incident.id);
  if (rankIdx < 0) return null;
  const count = spans.length;
  let tier = null;
  if (rankIdx === 0) tier = 'longest';
  else if (rankIdx / count <= 0.1) tier = 'top10';
  else return null;
  return { tier, rank: rankIdx + 1, count, windowDays, thisMs };
}

// Hour-of-day context: is the clock-hour this incident started in a
// relatively busy (or unusually quiet) one for disruptions on its line?
// Builds a 24-bucket Philadelphia-local hour histogram from the line's incidents
// in the window and compares this incident's bucket to the flat mean. Coarse
// on purpose — a full 7×24 hour-of-week grid is too sparse per line to read a
// single cell off. Conservative thresholds + a min sample keep it from
// narrating noise. Returns null when not notable or under-sampled.
export function computeHourOfDayContext(
  incident,
  incidents,
  { now = Date.now(), windowDays = 90, minTotal = 24 } = {},
) {
  const routes = incident?.routes || [];
  const incidentStart = incidentLifecycle(incident).first_seen_ts;
  if (routes.length === 0 || incidentStart == null) return null;
  const routeSet = new Set(routes);
  const cutoff = now - windowDays * DAY_MS;

  const hours = new Array(24).fill(0);
  let total = 0;
  for (const inc of incidents || []) {
    if (!incidentTouchesRoutes(inc, legacyKind(incident), routeSet)) continue;
    const ts = incidentLifecycle(inc).first_seen_ts;
    if (ts == null || ts < cutoff) continue;
    const { hour } = phillyWeekdayHour(ts);
    if (hour == null) continue;
    hours[hour] += 1;
    total += 1;
  }
  if (total < minTotal) return null;

  const { hour: thisHour } = phillyWeekdayHour(incidentStart);
  if (thisHour == null) return null;
  const inThisHour = hours[thisHour];
  const mean = total / 24;
  if (mean <= 0) return null;
  const ratio = inThisHour / mean;

  // A ratio gate alone isn't enough: the flat 24-hour mean is dragged down by
  // dead overnight hours, so an ordinary daytime hour clears 1.75× on a thin
  // cohort (e.g. 4 of 54 ≈ 1.78× but only ~1.2σ above expectation — noise). So
  // also require the bucket to be a statistically meaningful excess/deficit:
  // ≥2σ under a Poisson(mean) model, where σ = √mean. This self-scales — a
  // small mean demands a proportionally larger count before it reads "busy."
  const sd = Math.sqrt(mean);
  const sigma = 2;

  if (ratio >= 1.75 && inThisHour - mean >= sigma * sd)
    return { tier: 'busy', hour: thisHour, count: inThisHour, total, ratio };
  // Quiet keeps its denser-sample floor (a 0-count hour on a thin cohort is
  // just sampling, not a real lull) plus the same significance bar.
  if (ratio <= 0.4 && total >= 40 && mean - inThisHour >= sigma * sd)
    return { tier: 'quiet', hour: thisHour, count: inThisHour, total, ratio };
  return null;
}
