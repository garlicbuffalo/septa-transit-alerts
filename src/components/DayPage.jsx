import { useEffect, useMemo, useState } from 'react';
import { useDarkMode } from '../hooks/useDarkMode.js';
import { useNow } from '../hooks/useNow.js';
import { dayTrail } from '../lib/breadcrumbs.js';
import { formatBusRoute } from '../lib/busRoutes.js';
import { formatPhillyDay, phillyDayUTC } from '../lib/format.js';
import { loadIndex, loadRange, loadRecent } from '../lib/incidentStore.js';
import { filterIncidents, incidentRecords, legacyKind } from '../lib/incidents.js';
import { METRO_LINES } from '../lib/metroLines.js';
import { RAIL_LINES } from '../lib/railLines.js';
import { SITE_NAME } from '../lib/site.js';
import { buildStationIndex } from '../lib/stations.js';
import { dayStringToUtc, parseUrlState } from '../lib/urlState.js';
import Breadcrumb from './Breadcrumb.jsx';
import Footer from './Footer.jsx';
import Header from './Header.jsx';
import IncidentList from './IncidentList.jsx';
import LinePill from './LinePill.jsx';
import NotFoundPage from './NotFoundPage.jsx';

const DAY_MS = 24 * 60 * 60 * 1000;

// `/day/:date` — focused view of a single Philadelphia calendar day. Same data
// the homepage shows when you pin a day via the timeline, but as a proper
// permalink: clean URL, dedicated <title>, prerendered OG card.
//
// Rendered content is intentionally minimal — no filter bar (a single-day
// scope makes line/range chips less useful), no full visualizations. Just
// the incidents that touched this day, grouped by line.
export default function DayPage({ dateStr }) {
  const [dark, toggleDark] = useDarkMode();
  const now = useNow();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  // Parse the URL date once. Invalid strings (e.g. /day/foo) render a
  // not-found card without bothering to fetch.
  const dayUtc = useMemo(() => dayStringToUtc(dateStr), [dateStr]);
  const dayLabel = dayUtc != null ? formatPhillyDay(dayUtc) : null;

  // Optional line/route scope carried in the query string (?lines=l1,
  // ?lines=none&routes=17, ?rail=pao). Lets a "view this day" link from a line-scoped
  // surface — e.g. the event page's mini timeline — land filtered to the
  // line in question instead of the whole system. Parsed once: the page is
  // bootstrap-routed, so the query string is stable for its lifetime.
  const scope = useMemo(() => parseUrlState(), []);
  const scopedLines =
    scope.selectedLines && scope.selectedLines.length > 0 ? scope.selectedLines : null;
  const scopedBusRoutes = scope.selectedBusRoutes.length > 0 ? scope.selectedBusRoutes : null;
  const scopedRailLines =
    scope.selectedRailLines && scope.selectedRailLines.length > 0 ? scope.selectedRailLines : null;
  const isScoped = scopedLines != null || scopedBusRoutes != null || scopedRailLines != null;
  // Keep a scoped day view within one network: a Regional Rail-scoped link
  // shows only Regional Rail; a Metro line/bus route-scoped link shows only
  // Metro & Bus. Unscoped shows both.
  const scopedNetworks = scopedRailLines
    ? ['rail']
    : scopedLines || scopedBusRoutes
      ? ['transit']
      : null;

  // Future days never have data; show a friendly state rather than an empty
  // list. Past-but-out-of-window days fall through to the "no incidents"
  // branch (consistent with the rest of the site's 90-day archive).
  const isFuture = useMemo(() => {
    if (dayUtc == null) return false;
    return dayUtc > phillyDayUTC(now);
  }, [dayUtc, now]);

  useEffect(() => {
    if (dayUtc == null) return;
    // A day's view includes active incidents that started before it (their span
    // extends forward), so a day inside the recent window loads the recent slice
    // (which carries active-of-any-age); an older day loads its monthly shard,
    // where a span reaching in from an earlier month is the rare accepted gap.
    // The index supplies recent_from_ts (the window boundary) + generated_at.
    loadIndex()
      .then((index) => {
        const inRecentWindow = dayUtc >= (index.recent_from_ts ?? 0);
        const load = inRecentWindow
          ? loadRecent().then((payload) => payload.incidents)
          : loadRange(dayUtc, dayUtc + DAY_MS);
        return load.then((incidents) => setData({ incidents, generated_at: index.generated_at }));
      })
      .catch(setError);
  }, [dayUtc]);

  // Flat view for the station index and Header; the list reads nested incidents.
  const flat = useMemo(() => (data ? incidentRecords(data.incidents) : null), [data]);

  // Use the standard filter pipeline pinned to this day — incidents whose
  // [start, end] spans overlap. Active incidents that started before today
  // still surface (their span extends to now).
  const filtered = useMemo(() => {
    if (!data || dayUtc == null) return [];
    return filterIncidents(data.incidents, {
      // selectedLines: a real array (even empty) narrows Metro lines; null
      // shows all. A bus-route scope sets lines to [] so Metro drops out,
      // leaving just the scoped routes. showBus follows the same contextual
      // default the homepage uses (hidden once a Metro line is pinned).
      lines: scope.selectedLines,
      startTs: null,
      showBus: scope.showBus,
      busRoutes: scopedBusRoutes,
      railLines: scopedRailLines,
      networks: scopedNetworks,
      selectedDay: dayUtc,
      signals: null,
      search: '',
      now,
    });
  }, [data, dayUtc, now, scope, scopedBusRoutes, scopedRailLines, scopedNetworks]);

  const stationIndex = useMemo(() => {
    if (!flat) return null;
    return buildStationIndex(flat.officialRecords, flat.detectionRecords, { now, windowDays: 90 });
  }, [flat, now]);

  // Distinct lines/routes touched on this day — drives the breakdown chip
  // row at the top of the page. Lines use brand color pills; buses fall
  // back to plain route chips.
  const breakdown = useMemo(() => {
    const metro = new Set();
    const buses = new Set();
    const rail = new Set();
    for (const inc of filtered) {
      const kind = legacyKind(inc);
      if (kind === 'metro') for (const r of inc.routes ?? []) metro.add(r);
      else if (kind === 'bus') for (const r of inc.routes ?? []) buses.add(String(r));
      else if (kind === 'rail') for (const r of inc.routes ?? []) rail.add(String(r));
    }
    return { metro: [...metro], buses: [...buses].sort(), rail: [...rail].sort() };
  }, [filtered]);

  const totalCount = filtered.length;

  useEffect(() => {
    const base = SITE_NAME;
    if (!dayLabel) {
      document.title = base;
      return;
    }
    document.title = `${dayLabel} · ${base}`;
    return () => {
      document.title = base;
    };
  }, [dayLabel]);

  if (dayUtc == null) {
    return <NotFoundPage />;
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-gh-canvas">
        <p className="text-red-600 text-sm">Failed to load alert data.</p>
      </div>
    );
  }

  // Neighbor links — yesterday / tomorrow — so it's easy to walk through a
  // streak of bad days. Tomorrow is hidden when it'd land in the future.
  const prevStr = new Date(dayUtc - DAY_MS).toISOString().slice(0, 10);
  const nextStr = new Date(dayUtc + DAY_MS).toISOString().slice(0, 10);
  const showNext = dayUtc + DAY_MS <= phillyDayUTC(now);
  // Carry the scope filter onto the neighbor links so walking a streak of
  // days stays pinned to the same line/route instead of springing open to
  // the whole system on the next click.
  const scopeSuffix = isScoped ? window.location.search : '';

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
          <Breadcrumb items={dayTrail(dayUtc)} className="mb-3" />
          <div className="flex flex-wrap items-baseline gap-3">
            <h1 className="text-xl font-bold text-slate-800 dark:text-slate-100">{dayLabel}</h1>
            {data && (
              <span className="text-sm text-slate-500 dark:text-slate-400">
                {totalCount} incident{totalCount === 1 ? '' : 's'}
                {isFuture ? ' — future date' : ''}
              </span>
            )}
          </div>
          {/* Clarify the count's definition: it counts incidents active on the
              day, including ones that started earlier and were still ongoing —
              so it can exceed a "started this day" tally (e.g. the homepage's
              same-weekday comparison). */}
          {data && totalCount > 0 && !isFuture && (
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Includes incidents still ongoing from earlier days, not just ones that started this
              day.
            </p>
          )}
          {/* Scope banner — when the day view was opened filtered to a line
              or route, name the filter and offer a one-click escape to the
              full day. Without the escape hatch a scoped permalink looks like
              the day only had that line's incidents. */}
          {isScoped && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-3 text-sm text-slate-500 dark:text-slate-400">
              <span>Filtered to</span>
              {scopedLines ? (
                <LinePill kind="metro" routes={scopedLines} />
              ) : (
                <LinePill kind="bus" routes={scopedBusRoutes} />
              )}
              <span className="text-slate-300 dark:text-slate-600">·</span>
              <a
                href={`/day/${dateStr}`}
                className="text-blue-500 hover:text-blue-400 hover:underline"
              >
                Show all incidents this day →
              </a>
            </div>
          )}
          {/* Line/route pills touched this day — suppressed under a scope
              filter, where the banner above already names the single line. */}
          {!isScoped &&
            data &&
            (breakdown.metro.length > 0 ||
              breakdown.buses.length > 0 ||
              breakdown.rail.length > 0) && (
              <div className="flex flex-wrap gap-1.5 mt-3">
                {breakdown.metro.map((line) => {
                  const info = METRO_LINES[line];
                  if (!info) return null;
                  return (
                    <a
                      key={`metro-${line}`}
                      href={`/line/${line}`}
                      className="inline-flex items-center min-h-[24px] px-2 py-0.5 rounded-full text-xs font-bold hover:opacity-80 transition-opacity"
                      style={{ backgroundColor: info.color, color: info.textColor }}
                    >
                      {info.label}
                    </a>
                  );
                })}
                {breakdown.rail.map((line) => {
                  const info = RAIL_LINES[line];
                  return (
                    <a
                      key={`rail-${line}`}
                      href={`/rail/line/${line}`}
                      title={info ? `${info.label} Line` : line}
                      className="inline-flex items-center min-h-[24px] px-2 py-0.5 rounded-full text-xs font-bold hover:opacity-80 transition-opacity"
                      style={{
                        backgroundColor: info?.color ?? '#64748b',
                        color: info?.textColor ?? '#fff',
                      }}
                    >
                      {info?.code ?? line.toUpperCase()}
                    </a>
                  );
                })}
                {breakdown.buses.map((route) => (
                  <a
                    key={`bus-${route}`}
                    href={`/route/${route}`}
                    className="inline-flex items-center min-h-[24px] px-2 py-0.5 rounded-full text-xs font-bold bg-slate-500 text-white hover:opacity-80 transition-opacity"
                  >
                    {formatBusRoute(route)}
                  </a>
                ))}
              </div>
            )}
        </div>

        {!data && (
          <div className="space-y-4 animate-pulse">
            <div className="h-16 bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border" />
            <div className="h-48 bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border" />
          </div>
        )}

        {data && totalCount === 0 && !isFuture && (
          <div className="bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border p-8 text-center text-slate-500 dark:text-slate-400 text-sm">
            No incidents on record for {dayLabel}.
          </div>
        )}

        {data && totalCount > 0 && (
          <IncidentList
            incidents={filtered}
            search=""
            onSearchChange={null}
            stationIndex={stationIndex}
            isFiltered
          />
        )}

        {data && (
          <div className="flex justify-between items-center text-sm pt-2">
            <a
              href={`/day/${prevStr}${scopeSuffix}`}
              className="text-blue-500 hover:text-blue-400 hover:underline"
            >
              ← Previous day
            </a>
            {showNext ? (
              <a
                href={`/day/${nextStr}${scopeSuffix}`}
                className="text-blue-500 hover:text-blue-400 hover:underline"
              >
                Next day →
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
