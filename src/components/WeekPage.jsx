import { useEffect, useMemo, useState } from 'react';
import { useDarkMode } from '../hooks/useDarkMode.js';
import { useNow } from '../hooks/useNow.js';
import { buildWeekSummary, weekStartUTC } from '../lib/aggregate.js';
import { weekTrail } from '../lib/breadcrumbs.js';
import { formatBusRoute } from '../lib/busRoutes.js';
import {
  formatDuration,
  formatPhillyDay,
  formatWeekRange,
  phillyDayIsoUTC,
  phillyDayUTC,
} from '../lib/format.js';
import { loadIndex, loadRange } from '../lib/incidentStore.js';
import { incidentLifecycle, incidentRecords } from '../lib/incidents.js';
import { METRO_LINES } from '../lib/metroLines.js';
import { RAIL_LINES } from '../lib/railLines.js';
import { SITE_NAME } from '../lib/site.js';
import { buildStationIndex } from '../lib/stations.js';
import { dayStringToUtc } from '../lib/urlState.js';
import Breadcrumb from './Breadcrumb.jsx';
import Footer from './Footer.jsx';
import Header from './Header.jsx';
import IncidentList from './IncidentList.jsx';
import NotFoundPage from './NotFoundPage.jsx';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

// `/week` (current week) and `/week/:date` — a recap of one Sun–Sat week.
// Part of the browsable weekly archive: each completed week is a permalink
// (the URL's date is the week's Sunday). Strictly descriptive — counts, a
// per-day breakdown, most-affected lines, the longest incident, and a plain
// week-over-week delta. No scoring or commentary.
export default function WeekPage({ weekParam }) {
  const [dark, toggleDark] = useDarkMode();
  const now = useNow();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  // Resolve the URL param to the Sunday of its week. No param → current week.
  // An invalid date string → null (renders not-found without fetching). Any
  // day in a week normalizes to that week's Sunday, so /week/2026-05-20 (a
  // Wednesday) still resolves to the week starting 2026-05-17.
  const weekStartUtc = useMemo(() => {
    if (weekParam == null) return weekStartUTC(phillyDayUTC(now));
    const dayUtc = dayStringToUtc(weekParam);
    return dayUtc == null ? null : weekStartUTC(dayUtc);
  }, [weekParam, now]);

  const isFuture = weekStartUtc != null && weekStartUtc > weekStartUTC(phillyDayUTC(now));
  const rangeLabel = weekStartUtc != null ? formatWeekRange(weekStartUtc, { year: true }) : null;

  useEffect(() => {
    if (weekStartUtc == null) return;
    // Load this week plus the prior week (buildWeekSummary's week-over-week needs
    // it) from the monthly shards overlapping that span; the index supplies the
    // generated_at the full file used to carry.
    const from = weekStartUtc - WEEK_MS;
    const to = weekStartUtc + 7 * DAY_MS;
    Promise.all([loadRange(from, to), loadIndex()])
      .then(([incidents, index]) => setData({ incidents, generated_at: index.generated_at }))
      .catch(setError);
  }, [weekStartUtc]);

  const flat = useMemo(() => (data ? incidentRecords(data.incidents) : null), [data]);

  const summary = useMemo(() => {
    if (!flat || weekStartUtc == null) return null;
    return buildWeekSummary(flat.officialRecords, flat.detectionRecords, weekStartUtc, now);
  }, [flat, weekStartUtc, now]);

  // Incidents that started in this week, newest first — the list under the
  // recap. Same start-in-week predicate (in phillyDayUTC space) as the
  // summary, so the list length matches the headline count.
  const weekIncidents = useMemo(() => {
    if (!data || weekStartUtc == null) return [];
    const end = weekStartUtc + 6 * DAY_MS;
    return data.incidents
      .filter((inc) => {
        const ts = incidentLifecycle(inc).first_seen_ts;
        if (ts == null) return false;
        const d = phillyDayUTC(ts);
        return d >= weekStartUtc && d <= end;
      })
      .sort((a, b) => incidentLifecycle(b).first_seen_ts - incidentLifecycle(a).first_seen_ts);
  }, [data, weekStartUtc]);

  const stationIndex = useMemo(() => {
    if (!flat) return null;
    return buildStationIndex(flat.officialRecords, flat.detectionRecords, { now, windowDays: 90 });
  }, [flat, now]);

  useEffect(() => {
    const base = SITE_NAME;
    if (!rangeLabel) {
      document.title = base;
      return;
    }
    document.title = `Week of ${rangeLabel} · ${base}`;
    return () => {
      document.title = base;
    };
  }, [rangeLabel]);

  if (weekStartUtc == null) return <NotFoundPage />;

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-gh-canvas">
        <p className="text-red-600 text-sm">Failed to load alert data.</p>
      </div>
    );
  }

  // Neighbor weeks. Next is hidden when it'd land in a future week.
  const prevIso = phillyDayIsoUTC(weekStartUtc - WEEK_MS);
  const nextWeekStart = weekStartUtc + WEEK_MS;
  const nextIso = phillyDayIsoUTC(nextWeekStart);
  const showNext = nextWeekStart <= weekStartUTC(phillyDayUTC(now));

  const maxDayCount = summary ? Math.max(1, ...summary.perDay.map((d) => d.count)) : 1;

  // Week-over-week delta — only voiced when the prior week had real volume, so
  // a 1→2 swing doesn't read as "+100%". Mirrors SummaryStats' gating.
  let wow = null;
  if (summary && summary.priorTotal >= 3) {
    const delta = summary.total - summary.priorTotal;
    const pct = Math.round((Math.abs(delta) / summary.priorTotal) * 100);
    if (pct >= 10) wow = { up: delta > 0, pct };
  }

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
          <Breadcrumb items={weekTrail(weekStartUtc)} className="mb-3" />
          <div className="flex flex-wrap items-baseline gap-3">
            <h1 className="text-xl font-bold text-slate-800 dark:text-slate-100">
              Week of {rangeLabel}
            </h1>
            {summary?.isCurrent && (
              <span className="text-sm text-slate-500 dark:text-slate-400">in progress</span>
            )}
          </div>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            Sunday–Saturday recap · incidents that started this week.
          </p>
        </div>

        {!data && (
          <div className="space-y-4 animate-pulse">
            <div className="h-16 bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border" />
            <div className="h-40 bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border" />
          </div>
        )}

        {isFuture && data && (
          <div className="bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border p-8 text-center text-slate-500 dark:text-slate-400 text-sm">
            This week is in the future — nothing on record yet.
          </div>
        )}

        {summary &&
          !isFuture &&
          (summary.total === 0 ? (
            <div className="bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border p-8 text-center text-slate-500 dark:text-slate-400 text-sm">
              No incidents started this week.
            </div>
          ) : (
            <>
              {/* Headline recap sentence */}
              <p className="text-sm text-slate-600 dark:text-slate-300">
                <strong className="text-slate-800 dark:text-slate-100">{summary.total}</strong>{' '}
                incident{summary.total === 1 ? '' : 's'}
                {summary.lineCount > 0 && (
                  <>
                    {' '}
                    across{' '}
                    <strong className="text-slate-800 dark:text-slate-100">
                      {summary.lineCount}
                    </strong>{' '}
                    line{summary.lineCount === 1 ? '' : 's'} &amp; route
                    {summary.lineCount === 1 ? '' : 's'}
                  </>
                )}
                {' · '}
                {summary.metroCount} Metro · {summary.busCount} bus · {summary.railCount} Regional
                Rail
                {wow && (
                  <>
                    {' · '}
                    <strong
                      className={wow.up ? 'text-red-500' : 'text-green-600 dark:text-green-500'}
                    >
                      {wow.pct}% {wow.up ? 'more' : 'fewer'}
                    </strong>{' '}
                    than the prior week
                  </>
                )}
                {!wow && summary.priorTotal > 0 && (
                  <span className="text-slate-400 dark:text-slate-500">
                    {' '}
                    (prior week: {summary.priorTotal})
                  </span>
                )}
              </p>

              {/* Per-day breakdown — one bar per Sun–Sat day, linked to that
                    day's page. Busiest day gets the darker fill. */}
              <section>
                <h2 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-3">
                  By day
                </h2>
                <div className="bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border p-4">
                  <div className="flex items-end justify-between gap-2 h-24">
                    {summary.perDay.map((d, i) => {
                      const isBusiest =
                        summary.busiestDay && d.dayUtc === summary.busiestDay.dayUtc;
                      const h = Math.round((d.count / maxDayCount) * 100);
                      return (
                        <a
                          key={d.dayUtc}
                          href={`/day/${phillyDayIsoUTC(d.dayUtc)}`}
                          className="flex-1 flex flex-col items-center justify-end h-full group"
                          title={`${formatPhillyDay(d.dayUtc)}: ${d.count} incident${d.count === 1 ? '' : 's'}`}
                        >
                          <span className="text-[10px] tabular-nums text-slate-500 dark:text-slate-400 mb-0.5">
                            {d.count > 0 ? d.count : ''}
                          </span>
                          <div
                            className={`w-full rounded-t-sm transition-colors ${
                              isBusiest
                                ? 'bg-slate-600 dark:bg-slate-300'
                                : 'bg-slate-300 dark:bg-gh-border group-hover:bg-slate-400 dark:group-hover:bg-slate-500'
                            }`}
                            style={{ height: `${Math.max(d.count > 0 ? 6 : 2, h)}%` }}
                          />
                          <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 mt-1">
                            {DAY_LETTERS[i]}
                          </span>
                        </a>
                      );
                    })}
                  </div>
                  {summary.busiestDay && summary.busiestDay.count > 0 && (
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-3 pt-3 border-t border-slate-100 dark:border-gh-border">
                      Busiest day:{' '}
                      <a
                        href={`/day/${phillyDayIsoUTC(summary.busiestDay.dayUtc)}`}
                        className="text-blue-500 hover:text-blue-400 hover:underline"
                      >
                        <strong>{formatPhillyDay(summary.busiestDay.dayUtc)}</strong>
                      </a>{' '}
                      ({summary.busiestDay.count} incident
                      {summary.busiestDay.count === 1 ? '' : 's'})
                    </p>
                  )}
                </div>
              </section>

              {/* Most-affected lines & routes */}
              {summary.mostAffected.length > 0 && (
                <section>
                  <h2 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-3">
                    Most affected
                  </h2>
                  <div className="flex flex-wrap gap-1.5">
                    {summary.mostAffected.slice(0, 8).map((m) => {
                      if (m.kind === 'metro') {
                        const info = METRO_LINES[m.id];
                        if (!info) return null;
                        return (
                          <a
                            key={`train:${m.id}`}
                            href={`/line/${m.id}`}
                            className="inline-flex items-center gap-1.5 min-h-[24px] px-2 py-0.5 rounded-full text-xs font-bold hover:opacity-80 transition-opacity"
                            style={{ backgroundColor: info.color, color: info.textColor }}
                          >
                            {info.label}
                            <span className="tabular-nums opacity-80">{m.count}</span>
                          </a>
                        );
                      }
                      if (m.kind === 'rail') {
                        const info = RAIL_LINES[m.id];
                        return (
                          <a
                            key={`rail:${m.id}`}
                            href={`/rail/line/${m.id}`}
                            title={info?.label ?? m.id}
                            className="inline-flex items-center gap-1.5 min-h-[24px] px-2 py-0.5 rounded-full text-xs font-bold hover:opacity-80 transition-opacity"
                            style={{
                              backgroundColor: info?.color ?? '#64748b',
                              color: info?.textColor ?? '#fff',
                            }}
                          >
                            {String(m.id).toUpperCase()}
                            <span className="tabular-nums opacity-80">{m.count}</span>
                          </a>
                        );
                      }
                      return (
                        <a
                          key={`bus:${m.id}`}
                          href={`/route/${m.id}`}
                          className="inline-flex items-center gap-1.5 min-h-[24px] px-2 py-0.5 rounded-full text-xs font-bold bg-slate-500 text-white hover:opacity-80 transition-opacity"
                        >
                          {formatBusRoute(m.id)}
                          <span className="tabular-nums opacity-80">{m.count}</span>
                        </a>
                      );
                    })}
                  </div>
                </section>
              )}

              {/* Longest incident of the week */}
              {summary.longest && (
                <section>
                  <h2 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-3">
                    Longest incident
                  </h2>
                  <div className="bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border px-4 py-3 text-sm">
                    <span className="font-semibold text-slate-800 dark:text-slate-100">
                      {formatDuration(summary.longest.durationMs)}
                    </span>
                    {summary.longest.active && (
                      <span className="text-red-500 font-semibold"> · still active</span>
                    )}
                    {summary.longest.headline && (
                      <span className="text-slate-600 dark:text-slate-300">
                        {' — '}
                        {summary.longest.id ? (
                          <a
                            href={`/event/${summary.longest.id}`}
                            className="text-blue-500 hover:text-blue-400 hover:underline"
                          >
                            {summary.longest.headline}
                          </a>
                        ) : (
                          summary.longest.headline
                        )}
                      </span>
                    )}
                  </div>
                </section>
              )}

              <section>
                <h2 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-3">
                  All incidents this week
                </h2>
                <IncidentList
                  incidents={weekIncidents}
                  search=""
                  onSearchChange={null}
                  stationIndex={stationIndex}
                  isFiltered
                />
              </section>
            </>
          ))}

        {data && (
          <div className="flex justify-between items-center text-sm pt-2">
            <a
              href={`/week/${prevIso}`}
              className="text-blue-500 hover:text-blue-400 hover:underline"
            >
              ← Previous week
            </a>
            {showNext ? (
              <a
                href={`/week/${nextIso}`}
                className="text-blue-500 hover:text-blue-400 hover:underline"
              >
                Next week →
              </a>
            ) : (
              <span />
            )}
          </div>
        )}
      </main>
      <Footer />
    </div>
  );
}
