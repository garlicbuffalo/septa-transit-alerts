import { useEffect, useMemo, useState } from 'react';
import { useDarkMode } from '../hooks/useDarkMode.js';
import { useNow } from '../hooks/useNow.js';
import {
  buildDailyTrend,
  computeDisruptionMinutes,
  computeSummaryStats,
  computeWorstDay,
} from '../lib/aggregate.js';
import { topLevelTrail } from '../lib/breadcrumbs.js';
import { BUS_ROUTE_NAMES, compareBusRoutes, formatBusRoute } from '../lib/busRoutes.js';
import { cancellationInfo } from '../lib/cancellation.js';
import { formatMinutesAsHours, formatPhillyDay, phillyDayUTC } from '../lib/format.js';
import { loadAggregates, loadRecent } from '../lib/incidentStore.js';
import {
  filterIncidents,
  groupIncidentRecords,
  incidentLifecycle,
  incidentRecords,
  legacyKind,
} from '../lib/incidents.js';
import { METRO_LINE_ORDER, METRO_LINES } from '../lib/metroLines.js';
import { RAIL_LINE_ORDER, RAIL_LINES } from '../lib/railLines.js';
import { SITE_NAME } from '../lib/site.js';
import { buildStationIndex } from '../lib/stations.js';
import ActiveAlerts from './ActiveAlerts.jsx';
import Breadcrumb from './Breadcrumb.jsx';
import CollapsibleSection from './CollapsibleSection.jsx';
import Footer from './Footer.jsx';
import Header from './Header.jsx';
import HourOfWeekHeatmap from './HourOfWeekHeatmap.jsx';
import IncidentList from './IncidentList.jsx';
import { LONG_RUNNING_THRESHOLD_MS } from './LongRunningBanner.jsx';
import RailUpcomingCancellations from './RailUpcomingCancellations.jsx';
import TrendSparkline from './TrendSparkline.jsx';

const DAY_MS = 24 * 60 * 60 * 1000;
// Per-mode pages can show every route, but the leaderboards/grid quickly get
// noisy on the bus side (100+ routes, many with a single 90d incident). Cap
// the grid to routes with material activity; trains are a stable set of 8 so
// the cap is irrelevant there.
const BUS_GRID_MIN_INCIDENTS_90D = 1;
const LEADERBOARD_LIMIT = 5;

// Metro and Regional Rail are "line-like": a fixed roster shown in canonical order and
// labeled by line. Buses are an open route set filtered to recent activity.
const isLineLike = (kind) => kind === 'metro' || kind === 'rail';

// Dedicated page for a route in this mode.
function routeHref(kind, route) {
  if (kind === 'bus') return `/route/${route}`;
  if (kind === 'rail') return `/rail/line/${route}`;
  return `/line/${route}`;
}

// Build the list of routes to render in the per-route grid, plus per-route
// stats. For trains, always render all 8 lines in their canonical order so
// the page reads like a system status board even when most lines are quiet.
// For buses, only routes that appear in the data — there's no fixed set —
// filtered to those with ≥1 incident in the 90d window.
function buildRouteStats({ kind, alerts, observations, now }) {
  const lineLike = isLineLike(kind);
  const weekAgo = now - 7 * DAY_MS;
  const monthAgo = now - 30 * DAY_MS;
  const ninetyAgo = now - 90 * DAY_MS;

  // Pre-bucket alerts/observations by route so we can do per-route work in
  // one pass over the data rather than re-scanning the full list per row.
  const buckets = new Map(); // route -> { alerts: [], observations: [] }
  function bucket(route) {
    const key = String(route);
    let b = buckets.get(key);
    if (!b) {
      b = { alerts: [], observations: [] };
      buckets.set(key, b);
    }
    return b;
  }
  for (const a of alerts) {
    if (a.kind !== kind) continue;
    for (const r of a.routes || []) bucket(r).alerts.push(a);
  }
  for (const o of observations) {
    if (o.kind !== kind || o.line == null) continue;
    bucket(o.line).observations.push(o);
  }

  let routes;
  if (kind === 'metro') {
    routes = [...METRO_LINE_ORDER];
  } else if (kind === 'rail') {
    routes = [...RAIL_LINE_ORDER];
  } else {
    routes = [...buckets.keys()].sort(compareBusRoutes);
  }

  const rows = routes.map((route) => {
    const b = buckets.get(route) || { alerts: [], observations: [] };
    // Merge so an alert + corroborating bot observation count as one
    // incident across all per-row stats, matching LinePage's numbers.
    const { merged, standaloneAlerts, standaloneObs } = groupIncidentRecords(
      b.alerts,
      b.observations,
    );
    const incidents = [
      ...merged.map((m) => ({
        ts: m.first_seen_ts,
        active: m.active,
      })),
      ...standaloneAlerts.map((a) => ({
        ts: a.first_seen_ts,
        active: a.active,
      })),
      ...standaloneObs.map((o) => ({
        ts: o.first_seen_ts || o.ts,
        active: o.active,
      })),
    ];

    let activeCount = 0;
    let weeklyCount = 0;
    let monthlyCount = 0;
    let count90d = 0;
    for (const inc of incidents) {
      if (inc.active) activeCount++;
      if (inc.ts >= weekAgo) weeklyCount++;
      if (inc.ts >= monthAgo) monthlyCount++;
      if (inc.ts >= ninetyAgo) count90d++;
    }

    const disruption = computeDisruptionMinutes(b.alerts, b.observations, {
      now,
      windowDays: 30,
      lines: [{ kind, line: route }],
    });

    return {
      route,
      activeCount,
      weeklyCount,
      monthlyCount,
      count90d,
      disruptionMinutes: disruption.disruptedMinutes,
      disruptionRatio: disruption.ratio,
      alerts: b.alerts,
      observations: b.observations,
    };
  });

  // Line-like modes (train/Regional Rail) keep the full canonical roster; buses filter
  // to routes with material recent activity.
  if (lineLike) return rows;
  return rows.filter((r) => r.count90d >= BUS_GRID_MIN_INCIDENTS_90D);
}

function RouteLabel({ kind, route }) {
  if (kind === 'metro') {
    const info = METRO_LINES[route];
    return (
      <span
        className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold flex-shrink-0"
        style={{ backgroundColor: info?.color ?? '#64748b', color: info?.textColor ?? '#fff' }}
      >
        {info?.label ?? route}
      </span>
    );
  }
  if (kind === 'rail') {
    // Colored route-code pill + the full line name beside it (mirrors the bus
    // "#route + name" layout), since Regional Rail's full names are too long for a pill.
    const info = RAIL_LINES[route];
    return (
      <span className="inline-flex items-baseline gap-1.5 min-w-0">
        <span
          className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold flex-shrink-0"
          style={{ backgroundColor: info?.color ?? '#64748b', color: info?.textColor ?? '#fff' }}
        >
          {String(route).toUpperCase()}
        </span>
        {info?.label && (
          <span className="text-xs text-slate-500 dark:text-slate-400 truncate">{info.label}</span>
        )}
      </span>
    );
  }
  const name = BUS_ROUTE_NAMES[route];
  return (
    <span className="inline-flex items-baseline gap-1.5 min-w-0">
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold bg-slate-100 dark:bg-gh-subtle text-slate-700 dark:text-slate-200 flex-shrink-0">
        {formatBusRoute(route)}
      </span>
      {name && <span className="text-xs text-slate-500 dark:text-slate-400 truncate">{name}</span>}
    </span>
  );
}

const SORT_OPTIONS = [
  { key: 'default', label: 'Route' },
  { key: 'weekly', label: '7-day' },
  { key: 'monthly', label: '30-day' },
  { key: 'disruption', label: 'Disrupted time' },
];

function sortRows(rows, sortKey, kind) {
  const sorted = [...rows];
  switch (sortKey) {
    case 'weekly':
      sorted.sort((a, b) => b.weeklyCount - a.weeklyCount || b.monthlyCount - a.monthlyCount);
      break;
    case 'monthly':
      sorted.sort((a, b) => b.monthlyCount - a.monthlyCount || b.weeklyCount - a.weeklyCount);
      break;
    case 'disruption':
      sorted.sort((a, b) => b.disruptionMinutes - a.disruptionMinutes);
      break;
    default:
      if (isLineLike(kind)) {
        // Preserve canonical line order (already applied during build).
        return rows;
      }
      sorted.sort((a, b) => compareBusRoutes(a.route, b.route));
  }
  return sorted;
}

// Per-route grid: one row per train line / bus route with current status,
// 7d count, 30d count, 30d disruption hours, and a 30d trend sparkline.
// Sortable header — click any column to re-sort. Rows link to the
// individual line/route page so the grid acts as a directory too.
function RouteGrid({ kind, rows, sortKey, onSortChange }) {
  if (rows.length === 0) {
    return (
      <div className="bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border p-6 text-center text-sm text-slate-500 dark:text-slate-400">
        No routes with recent incidents.
      </div>
    );
  }
  const lineLike = isLineLike(kind);
  const hrefFor = (route) => routeHref(kind, route);

  // Two layouts. Mobile drops the sparkline + trend-% column entirely
  // (180px is the bulk of the row width and was overflowing on phones —
  // the same trend info is visible on the per-line page one tap away).
  // The numeric columns are also tightened on mobile to claw back space.
  // Worst-case content: "12h 49m" in the 30d column, "11" in the 7d
  // column, "•1" / "—" in the active column.
  const ROW_GRID =
    'grid items-center gap-2 sm:gap-3 px-3 sm:px-4 py-2.5 ' +
    'grid-cols-[minmax(0,1fr)_36px_32px_64px] ' +
    'sm:grid-cols-[minmax(0,1fr)_56px_48px_72px_180px]';

  return (
    <div className="bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border overflow-hidden">
      {/* Sort tabs — buttons rather than column-header clicks so the
          control is obvious at small widths where the table header
          truncates. */}
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-2 border-b border-slate-100 dark:border-gh-border bg-slate-50/60 dark:bg-gh-canvas/40">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mr-1">
          Sort
        </span>
        {SORT_OPTIONS.map((opt) => (
          <button
            type="button"
            key={opt.key}
            onClick={() => onSortChange(opt.key)}
            className={`min-h-[24px] px-2 py-0.5 rounded-full text-xs font-medium transition-colors ${
              sortKey === opt.key
                ? 'bg-slate-700 dark:bg-slate-200 text-white dark:text-slate-900'
                : 'bg-slate-100 dark:bg-gh-subtle text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-gh-border'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
      {/* Column header — short numeric labels so the empty cells in the
          data rows read as "no value" rather than dead space. Mobile
          uses a 4-col variant matching the row template (no trend
          column). */}
      <div
        className={`${ROW_GRID} py-2 border-b border-slate-100 dark:border-gh-border text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400`}
      >
        <span>{lineLike ? 'Line' : 'Route'}</span>
        <span className="text-right">Active</span>
        <span className="text-right">7d</span>
        <span className="text-right">30d hrs</span>
        <span className="text-right hidden sm:inline">30d trend</span>
      </div>
      <div className="divide-y divide-slate-100 dark:divide-gh-border">
        {rows.map((row) => (
          <a
            key={row.route}
            href={hrefFor(row.route)}
            className={`${ROW_GRID} hover:bg-slate-50 dark:hover:bg-gh-canvas transition-colors`}
          >
            <div className="min-w-0">
              <RouteLabel kind={kind} route={row.route} />
            </div>
            <div className="text-xs tabular-nums text-right" title="Active incidents right now">
              {row.activeCount > 0 ? (
                <span className="inline-flex items-center gap-1 text-red-500 font-semibold">
                  <span
                    className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse"
                    aria-hidden="true"
                  />
                  {row.activeCount}
                </span>
              ) : (
                <span className="text-slate-300 dark:text-slate-600">—</span>
              )}
            </div>
            <div
              className="text-xs tabular-nums text-slate-600 dark:text-slate-300 text-right"
              title="Incidents in the last 7 days"
            >
              {row.weeklyCount > 0 ? (
                row.weeklyCount
              ) : (
                <span className="text-slate-300 dark:text-slate-600">0</span>
              )}
            </div>
            <div
              className="text-xs tabular-nums text-slate-600 dark:text-slate-300 text-right"
              title="Disrupted time in the last 30 days"
            >
              {row.disruptionMinutes > 0 ? (
                formatMinutesAsHours(row.disruptionMinutes)
              ) : (
                <span className="text-slate-300 dark:text-slate-600">—</span>
              )}
            </div>
            <div className="hidden sm:flex justify-end">
              <TrendSparkline alerts={row.alerts} observations={row.observations} reserveLabel />
            </div>
          </a>
        ))}
      </div>
      <div className="sm:hidden px-4 py-2 border-t border-slate-100 dark:border-gh-border text-[11px] text-slate-500 dark:text-slate-400">
        Tap a row for the 30-day trend.
      </div>
    </div>
  );
}

// Compact leaderboard: top-N rows by a single metric. Both views drive
// off the same grid rows (computed once on the page) so the orderings stay
// consistent with what the grid sort would produce.
function Leaderboard({ kind, title, rows, metric, formatValue, emptyLabel }) {
  const ranked = rows
    .filter((r) => (metric === 'monthly' ? r.monthlyCount > 0 : r.disruptionMinutes > 0))
    .slice(0, LEADERBOARD_LIMIT);
  const hrefFor = (route) => routeHref(kind, route);

  if (ranked.length === 0) {
    return (
      <div className="bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border p-4">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
          {title}
        </p>
        <p className="text-sm text-slate-500 dark:text-slate-400 italic">{emptyLabel}</p>
      </div>
    );
  }
  return (
    <div className="bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border">
      <div className="px-4 pt-3 pb-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          {title}
        </p>
      </div>
      <div className="divide-y divide-slate-100 dark:divide-gh-border">
        {ranked.map((row) => (
          <a
            key={row.route}
            href={hrefFor(row.route)}
            className="flex items-center gap-3 px-4 py-2 hover:bg-slate-50 dark:hover:bg-gh-canvas transition-colors"
          >
            <div className="min-w-0 flex-1">
              <RouteLabel kind={kind} route={row.route} />
            </div>
            <span className="text-sm font-semibold tabular-nums text-slate-700 dark:text-slate-200 flex-shrink-0">
              {formatValue(row)}
            </span>
          </a>
        ))}
      </div>
    </div>
  );
}

// SystemHealthPage — `/system/trains` and `/system/buses`. A mode-wide
// dashboard that complements the homepage (all modes) and LinePage (one
// route). Sections: active disruptions, system aggregates, per-route grid,
// leaderboards.
export default function SystemHealthPage({ kind }) {
  const [dark, toggleDark] = useDarkMode();
  const now = useNow();
  const [data, setData] = useState(null);
  const [aggregates, setAggregates] = useState(null);
  const [error, setError] = useState(null);
  const [sortKey, setSortKey] = useState('default');
  const [search, setSearch] = useState('');
  // Date scope for the incident list: 'all' (no cutoff), 'today' (incidents
  // whose [start, end] span overlaps the current Philadelphia calendar day), or
  // '7d' (last 7 days, matching the homepage default).
  const [dateScope, setDateScope] = useState('all');

  const lineLike = isLineLike(kind);
  const modeLabel = kind === 'metro' ? 'SEPTA Metro' : kind === 'rail' ? 'Regional Rail' : 'Bus';

  useEffect(() => {
    // Recent slice powers every ≤90d aggregate on the page; per-mode YoY (the
    // one >90d computation) comes precomputed from aggregates.json.
    loadRecent()
      .then((fresh) => setData({ ...fresh, incidents: fresh.incidents || [] }))
      .catch(setError);
    loadAggregates()
      .then(setAggregates)
      .catch(() => setAggregates(null));
  }, []);

  // Flat view feeds every aggregate on the page; the incident list reads the
  // nested `modeIncidents` slice below.
  const flat = useMemo(() => (data ? incidentRecords(data.incidents) : null), [data]);

  useEffect(() => {
    document.title = `${modeLabel} system health · ${SITE_NAME}`;
    return () => {
      document.title = SITE_NAME;
    };
  }, [modeLabel]);

  // Mode-scoped slice of the dataset — every aggregate below operates on
  // this slice rather than the full alerts.json, so the page consistently
  // reports "just trains" or "just buses" without per-call filtering.
  const modeAlerts = useMemo(() => {
    if (!flat) return [];
    return flat.officialRecords.filter((a) => a.kind === kind);
  }, [flat, kind]);

  const modeObservations = useMemo(() => {
    if (!flat) return [];
    return flat.detectionRecords.filter((o) => o.kind === kind);
  }, [flat, kind]);

  // Nested incidents for this mode — drives the incident list.
  const modeIncidents = useMemo(() => {
    if (!data) return [];
    return data.incidents.filter((inc) => legacyKind(inc) === kind);
  }, [data, kind]);

  const activeIncidents = useMemo(
    () =>
      modeIncidents
        .filter((inc) => incidentLifecycle(inc).active)
        .sort((a, b) => incidentLifecycle(b).first_seen_ts - incidentLifecycle(a).first_seen_ts),
    [modeIncidents],
  );

  const { recentActive, longRunningActive } = useMemo(() => {
    const recent = [];
    const longRunning = [];
    for (const i of activeIncidents) {
      // Upcoming single-train cancellations get their own forward-looking strip,
      // not the "active disruptions" cards or the long-running framing.
      if (cancellationInfo(i)) continue;
      const startTs = incidentLifecycle(i).first_seen_ts;
      if (startTs != null && now - startTs >= LONG_RUNNING_THRESHOLD_MS) longRunning.push(i);
      else recent.push(i);
    }
    return { recentActive: recent, longRunningActive: longRunning };
  }, [activeIncidents, now]);

  const summary = useMemo(() => {
    if (!data) return null;
    return computeSummaryStats(modeAlerts, modeObservations, now);
  }, [data, modeAlerts, modeObservations, now]);

  // Per-mode year-over-year, precomputed server-side (the recent slice can't
  // supply the prior-year window). `kind` is already the train/bus/rail key
  // aggregates.by_mode is keyed on.
  const yoy = aggregates?.yoy?.by_mode?.[kind] ?? null;

  const worstDay = useMemo(() => {
    if (!data) return null;
    return computeWorstDay(modeAlerts, modeObservations, { now, windowDays: 90 });
  }, [data, modeAlerts, modeObservations, now]);

  const routeRows = useMemo(() => {
    if (!flat) return [];
    return buildRouteStats({
      kind,
      alerts: flat.officialRecords,
      observations: flat.detectionRecords,
      now,
    });
  }, [flat, kind, now]);

  // System-wide disruption hours: feeds the helper the union of every
  // route's lines so the service-hours denominator scales with the actual
  // scope (e.g. all 13 Metro lines, or every active bus route).
  const systemDisruption = useMemo(() => {
    if (!data) return null;
    const lines = routeRows.map((r) => ({ kind, line: r.route }));
    return computeDisruptionMinutes(modeAlerts, modeObservations, {
      now,
      windowDays: 30,
      lines,
    });
  }, [data, kind, modeAlerts, modeObservations, routeRows, now]);

  const trend = useMemo(() => {
    if (!data) return null;
    return buildDailyTrend(modeAlerts, modeObservations);
  }, [data, modeAlerts, modeObservations]);

  const stationIndex = useMemo(() => {
    if (!flat) return null;
    return buildStationIndex(flat.officialRecords, flat.detectionRecords, { now, windowDays: 90 });
  }, [flat, now]);

  const sortedRows = useMemo(() => sortRows(routeRows, sortKey, kind), [routeRows, sortKey, kind]);

  // Narrow the incident list by search + the selected date scope. The mode
  // is already locked by the modeAlerts/modeObservations slice. 'today'
  // pins to the current Philadelphia calendar day (so an incident that started
  // yesterday and is still active still shows up — overlapping the day),
  // '7d' uses a rolling 7-day cutoff.
  const listFiltered = useMemo(() => {
    const selectedDay = dateScope === 'today' ? phillyDayUTC(now) : null;
    const startTs = dateScope === '7d' ? now - 7 * DAY_MS : null;
    return filterIncidents(modeIncidents, {
      lines: null,
      startTs,
      showBus: true,
      busRoutes: null,
      selectedDay,
      signals: null,
      sources: null,
      search,
      now,
    });
  }, [modeIncidents, search, dateScope, now]);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-gh-canvas">
        <p className="text-red-600 text-sm">Failed to load alert data.</p>
      </div>
    );
  }

  const headline =
    kind === 'metro'
      ? 'SEPTA Metro system health'
      : kind === 'rail'
        ? 'Regional Rail system health'
        : 'Bus system health';
  const subhead =
    kind === 'metro'
      ? 'Every SEPTA Metro line — the L, B, M, T, G, and D — at a glance: active disruptions, recent activity, and disruption time over the last 30 days.'
      : kind === 'rail'
        ? 'Every Regional Rail line at a glance — active disruptions, cancellations, and delays over the last 30 days.'
        : 'Every bus route with recent incidents — active disruptions, recent activity, and disruption time over the last 30 days.';

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-gh-canvas flex flex-col">
      <Header
        generatedAt={data?.generated_at}
        dark={dark}
        onToggleDark={toggleDark}
        onResetFilters={() => {
          window.location.href = '/';
        }}
        alerts={flat?.alerts}
        observations={flat?.observations}
      />
      <main id="main" tabIndex={-1} className="max-w-5xl mx-auto px-4 py-6 space-y-6 w-full flex-1">
        <div>
          <Breadcrumb items={topLevelTrail(headline)} className="mb-3" />
          <h1 className="text-xl font-bold text-slate-800 dark:text-slate-100">{headline}</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">{subhead}</p>
        </div>

        {!data && (
          <div className="space-y-4 animate-pulse">
            <div className="h-16 bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border" />
            <div className="h-48 bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border" />
            <div className="h-64 bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border" />
          </div>
        )}

        {data && (
          <>
            {kind === 'rail' && (
              <RailUpcomingCancellations incidents={modeIncidents} now={now} showLine />
            )}

            {(recentActive.length > 0 || longRunningActive.length > 0) && (
              <ActiveAlerts
                incidents={recentActive}
                longRunningIncidents={longRunningActive}
                now={now}
                stationIndex={stationIndex}
              />
            )}

            {summary && (
              <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 px-1">
                <div className="space-y-1">
                  <p className="text-sm text-slate-600 dark:text-slate-300">
                    <strong className="text-slate-800 dark:text-slate-100">
                      {summary.weeklyCount}
                    </strong>{' '}
                    {modeLabel.toLowerCase()} incident{summary.weeklyCount === 1 ? '' : 's'} in the
                    last 7 days
                    {summary.activeCount > 0 && (
                      <>
                        <span className="mx-2 text-slate-300 dark:text-slate-600">·</span>
                        <span className="text-red-500 font-semibold">
                          {summary.activeCount} active now
                        </span>
                      </>
                    )}
                  </p>
                  {systemDisruption && systemDisruption.disruptedMinutes > 0 && (
                    <p
                      className="text-xs text-slate-500 dark:text-slate-400"
                      title="Total line-time spent in a detected disruption over the last 30 days, summed across every route in this mode."
                    >
                      <strong className="text-slate-700 dark:text-slate-200">
                        {formatMinutesAsHours(systemDisruption.disruptedMinutes)}
                      </strong>{' '}
                      disrupted across all {modeLabel.toLowerCase()} over the last 30 days
                      {systemDisruption.ratio > 0 && (
                        <>
                          {' · '}
                          <strong className="text-slate-700 dark:text-slate-200">
                            {systemDisruption.ratio < 0.001
                              ? '<0.1%'
                              : `${(systemDisruption.ratio * 100).toFixed(systemDisruption.ratio < 0.01 ? 2 : 1)}%`}
                          </strong>{' '}
                          of service hours
                        </>
                      )}
                    </p>
                  )}
                  {yoy?.enoughData && yoy.pctChange != null && (
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      <strong
                        className={
                          yoy.pctChange > 0
                            ? 'text-red-500'
                            : yoy.pctChange < 0
                              ? 'text-green-600 dark:text-green-500'
                              : 'text-slate-700 dark:text-slate-200'
                        }
                      >
                        {yoy.pctChange === 0
                          ? 'Unchanged'
                          : `${Math.abs(Math.round(yoy.pctChange * 100))}% ${yoy.pctChange > 0 ? 'busier' : 'quieter'}`}
                      </strong>{' '}
                      than the same 30 days a year ago ({yoy.priorCount} → {yoy.currentCount})
                    </p>
                  )}
                  {worstDay && worstDay.count >= 2 && (
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      Worst {modeLabel.toLowerCase()} day in 90d:{' '}
                      <a
                        href={`/day/${new Date(worstDay.dayUtc).toISOString().slice(0, 10)}`}
                        className="text-blue-500 hover:text-blue-400 hover:underline"
                      >
                        <strong>{formatPhillyDay(worstDay.dayUtc)}</strong>
                      </a>{' '}
                      ({worstDay.count} incident{worstDay.count === 1 ? '' : 's'})
                    </p>
                  )}
                </div>
                {trend && (
                  <TrendSparkline
                    alerts={modeAlerts}
                    observations={modeObservations}
                    trend={trend}
                  />
                )}
              </div>
            )}

            <section>
              <h2 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-3">
                {lineLike ? 'Every line' : 'Routes with recent activity'}
              </h2>
              <RouteGrid
                kind={kind}
                rows={sortedRows}
                sortKey={sortKey}
                onSortChange={setSortKey}
              />
            </section>

            {/* Leaderboards + heatmap are retrospective views — and the
                leaderboards just re-rank the sortable grid above — so they're
                collapsed by default, matching the homepage and line page. The
                live status board (grid) and the incident list stay primary. */}
            <CollapsibleSection
              title="Trends & history"
              subtitle="Leaderboards · when incidents happen"
              className="pt-4 mt-2 border-t border-slate-200 dark:border-gh-border"
            >
              <section>
                <h2 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-3">
                  Leaderboards (30d)
                </h2>
                <div className="grid sm:grid-cols-2 gap-3">
                  <Leaderboard
                    kind={kind}
                    title="Most incidents"
                    rows={[...routeRows].sort((a, b) => b.monthlyCount - a.monthlyCount)}
                    metric="monthly"
                    formatValue={(row) =>
                      `${row.monthlyCount} incident${row.monthlyCount === 1 ? '' : 's'}`
                    }
                    emptyLabel={`No ${modeLabel.toLowerCase()} incidents in the last 30 days.`}
                  />
                  <Leaderboard
                    kind={kind}
                    title="Most disrupted time"
                    rows={[...routeRows].sort((a, b) => b.disruptionMinutes - a.disruptionMinutes)}
                    metric="disruption"
                    formatValue={(row) => formatMinutesAsHours(row.disruptionMinutes)}
                    emptyLabel={`No disruption time logged for ${modeLabel.toLowerCase()} in the last 30 days.`}
                  />
                </div>
              </section>

              <HourOfWeekHeatmap
                alerts={modeAlerts}
                observations={modeObservations}
                title={`When do ${modeLabel.toLowerCase()} incidents happen?`}
              />
            </CollapsibleSection>

            <section>
              <div className="flex flex-wrap items-center gap-1.5 mb-3">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mr-1">
                  Show
                </span>
                {[
                  { key: 'today', label: 'Today' },
                  { key: '7d', label: 'Last 7 days' },
                  { key: 'all', label: 'All time' },
                ].map((opt) => (
                  <button
                    type="button"
                    key={opt.key}
                    onClick={() => setDateScope(opt.key)}
                    className={`min-h-[24px] px-2.5 py-0.5 rounded-full text-xs font-medium transition-colors ${
                      dateScope === opt.key
                        ? 'bg-slate-700 dark:bg-slate-200 text-white dark:text-slate-900'
                        : 'bg-slate-100 dark:bg-gh-subtle text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-gh-border'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <IncidentList
                incidents={listFiltered}
                search={search}
                onSearchChange={setSearch}
                stationIndex={stationIndex}
                isFiltered
              />
            </section>

            {modeAlerts.length === 0 && modeObservations.length === 0 && (
              <div className="bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border p-8 text-center text-slate-500 dark:text-slate-400 text-sm">
                No {modeLabel.toLowerCase()} incidents on record.
              </div>
            )}
          </>
        )}
      </main>
      <Footer />
    </div>
  );
}
