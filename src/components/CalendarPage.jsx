import { useEffect, useMemo, useState } from 'react';
import { useDarkMode } from '../hooks/useDarkMode.js';
import { useNow } from '../hooks/useNow.js';
import { topLevelTrail } from '../lib/breadcrumbs.js';
import { buildCalendarWeeks } from '../lib/calendar.js';
import { dataUrl } from '../lib/dataSource.js';
import { formatPhillyDay } from '../lib/format.js';
import { loadRecent } from '../lib/incidentStore.js';
import { incidentRecords, SOURCE_TYPES } from '../lib/incidents.js';
import { SITE_NAME } from '../lib/site.js';
import { buildSearch, parseUrlState } from '../lib/urlState.js';
import Breadcrumb from './Breadcrumb.jsx';
import Filters from './Filters.jsx';
import Footer from './Footer.jsx';
import Header from './Header.jsx';

// Days × weeks layout — rows are weekdays (Sun..Sat), columns are weeks
// moving rightward through the year. Same shape as a GitHub contributions
// heatmap. This is intentional: keeping a single weekday on each row makes
// patterns like "Mondays are dark in April" visually obvious, which the
// previous per-month strip layout (where column N meant a different
// weekday in every row) hid.
const WINDOW_DAYS = 364; // 52 weeks
const WEEKDAY_LABELS = ['', 'Mon', '', 'Wed', '', 'Fri', '']; // sparse to keep the row compact

// "2 Metro, 1 bus, 3 Regional Rail" — omitting modes with no incidents.
function modeBreakdown(cell) {
  const parts = [
    [cell.metroCount, 'Metro'],
    [cell.busCount, 'bus'],
    [cell.railCount, 'Regional Rail'],
  ]
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n} ${label}`);
  return parts.join(', ') || 'no breakdown';
}

const NO_DATA_STYLE = {
  backgroundImage:
    'repeating-linear-gradient(-45deg, var(--no-data-stripe1) 0px, var(--no-data-stripe1) 1px, var(--no-data-stripe2) 1px, var(--no-data-stripe2) 4px)',
};

// Five intensity stops keyed off the max count, so the busiest day is fully
// saturated and the rest scale linearly. Mirrors HourOfWeekHeatmap's pattern
// for visual consistency across the site.
function cellBg(count, maxCount) {
  if (count === 0 || maxCount <= 0) return 'var(--timeline-empty)';
  const ratio = count / maxCount;
  if (ratio < 0.2) return 'rgba(100, 116, 139, 0.25)';
  if (ratio < 0.4) return 'rgba(100, 116, 139, 0.45)';
  if (ratio < 0.7) return 'rgba(100, 116, 139, 0.65)';
  if (ratio < 0.9) return 'rgba(100, 116, 139, 0.85)';
  return 'rgb(71, 85, 105)';
}

function CalendarCell({ cell, maxCount }) {
  if (cell.future) {
    return (
      <div
        aria-hidden="true"
        className="w-3 h-3 rounded-sm opacity-40"
        style={{ backgroundColor: 'var(--timeline-empty)' }}
      />
    );
  }
  if (cell.noData) {
    const label = `${formatPhillyDay(cell.dayUtc)}: no data`;
    return (
      <div
        role="img"
        title={label}
        aria-label={label}
        className="w-3 h-3 rounded-sm"
        style={NO_DATA_STYLE}
      />
    );
  }
  const dayLabel = formatPhillyDay(cell.dayUtc);
  const label =
    cell.count === 0
      ? `${dayLabel}: no incidents`
      : `${dayLabel}: ${cell.count} incident${cell.count === 1 ? '' : 's'} (${modeBreakdown(cell)})`;
  if (cell.count === 0) {
    return (
      <div
        role="img"
        title={label}
        aria-label={label}
        className="w-3 h-3 rounded-sm"
        style={{ backgroundColor: cellBg(0, maxCount) }}
      />
    );
  }
  return (
    <a
      href={`/day/${cell.date}`}
      title={label}
      aria-label={label}
      className="w-3 h-3 rounded-sm hover:ring-1 hover:ring-slate-400 dark:hover:ring-slate-500 transition-all"
      style={{ backgroundColor: cellBg(cell.count, maxCount) }}
    >
      <span className="sr-only">{label}</span>
    </a>
  );
}

export default function CalendarPage() {
  const [dark, toggleDark] = useDarkMode();
  const now = useNow();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  // Calendar respects the same filter chips the homepage exposes so a user
  // moving from "L1" on the homepage to the calendar keeps the lens.
  // Date-range and pinned-day are intentionally ignored — the 12-month grid
  // is its own time scope. Signal filter is read from the URL for state
  // continuity but doesn't change cell counts (daily-counts.json carries no
  // per-signal breakdown); a small note explains that when active.
  const initial = useMemo(() => parseUrlState(), []);
  const [selectedLines, setSelectedLines] = useState(initial.selectedLines);
  const [showBus, setShowBus] = useState(initial.showBus);
  const [selectedBusRoutes, setSelectedBusRoutes] = useState(initial.selectedBusRoutes);
  const [selectedSignals, setSelectedSignals] = useState(initial.selectedSignals);
  const [selectedSources, setSelectedSources] = useState(initial.selectedSources);

  useEffect(() => {
    const url = dataUrl('daily-counts.json');
    fetch(url, { cache: 'no-store' })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setData)
      .catch(setError);
  }, []);

  // Also load the recent slice so the Header's Browse menu works on this page
  // (the menu is 90d-windowed, so the recent file covers it), matching the
  // pattern used by LinePage / StationPage. Cheaper than refactoring Header to
  // make data optional everywhere.
  const [browseData, setBrowseData] = useState(null);
  useEffect(() => {
    loadRecent()
      .then((payload) =>
        setBrowseData(payload?.incidents ? incidentRecords(payload.incidents) : null),
      )
      .catch(() => {});
  }, []);

  useEffect(() => {
    document.title = `Calendar · ${SITE_NAME}`;
    return () => {
      document.title = SITE_NAME;
    };
  }, []);

  // Mirror filter selections to the URL so calendar views stay shareable.
  useEffect(() => {
    const qs = buildSearch({
      selectedLines,
      showBus,
      selectedBusRoutes,
      dateRange: 7, // calendar ignores dateRange — pin to default so it's omitted from the URL
      selectedDay: null,
      selectedSignals,
      selectedSources,
      search: '',
    });
    const next = `${window.location.pathname}${qs}${window.location.hash}`;
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (next !== current) window.history.replaceState(null, '', next);
  }, [selectedLines, showBus, selectedBusRoutes, selectedSignals, selectedSources]);

  const availableBusRoutes = useMemo(() => {
    const routes = new Set();
    for (const d of data?.days || []) {
      if (d.by_route && typeof d.by_route === 'object') {
        for (const k of Object.keys(d.by_route)) routes.add(k);
      }
    }
    return [...routes].sort((a, b) => {
      const na = parseInt(a, 10);
      const nb = parseInt(b, 10);
      if (Number.isNaN(na) && Number.isNaN(nb)) return a.localeCompare(b);
      if (Number.isNaN(na)) return 1;
      if (Number.isNaN(nb)) return -1;
      return na - nb || a.localeCompare(b);
    });
  }, [data]);

  // Filters object passed to buildCalendarWeeks. Null sentinel when every
  // chip is at default — keeps the original "all train + all bus" path so
  // the most common load doesn't pay for `by_line`/`by_route` traversal.
  const isFiltered =
    selectedLines !== null ||
    !showBus ||
    selectedBusRoutes.length > 0 ||
    selectedSignals.length > 0 ||
    selectedSources.length < SOURCE_TYPES.length;
  const filterArgs = useMemo(
    () => (isFiltered ? { selectedLines, showBus, selectedBusRoutes } : null),
    [isFiltered, selectedLines, showBus, selectedBusRoutes],
  );

  const grid = useMemo(() => {
    if (!data) return null;
    return buildCalendarWeeks(data.days || [], {
      now,
      windowDays: WINDOW_DAYS,
      dataStartTs: data.data_start_ts ?? null,
      filters: filterArgs,
    });
  }, [data, now, filterArgs]);

  const totalCount = useMemo(() => {
    if (!grid) return 0;
    let s = 0;
    for (const week of grid.weeks) {
      for (const cell of week) {
        if (!cell.inRange || cell.noData) continue;
        s += cell.count;
      }
    }
    return s;
  }, [grid]);

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-gh-canvas flex flex-col">
      <Header
        generatedAt={data?.generated_at}
        dark={dark}
        onToggleDark={toggleDark}
        onResetFilters={() => {
          window.location.href = '/';
        }}
        alerts={browseData?.officialRecords}
        observations={browseData?.detectionRecords}
      />
      <main id="main" tabIndex={-1} className="max-w-5xl mx-auto px-4 py-6 space-y-6 w-full flex-1">
        <div>
          <Breadcrumb items={topLevelTrail('Calendar')} className="mb-3" />
          <div className="flex flex-wrap items-baseline gap-3">
            <h1 className="text-xl font-bold text-slate-800 dark:text-slate-100">Calendar</h1>
            {grid && (
              <span className="text-sm text-slate-500 dark:text-slate-400">
                {totalCount} incident{totalCount === 1 ? '' : 's'}
                {isFiltered ? ' match the current filters' : ' on record'} · click a day to drill in
              </span>
            )}
          </div>
        </div>

        {data && (
          <div className="bg-slate-100/60 dark:bg-gh-surface/60 rounded-lg border border-slate-200 dark:border-gh-border px-3 py-2">
            <Filters
              selectedLines={selectedLines}
              onLinesChange={(next) =>
                setSelectedLines(typeof next === 'function' ? next(selectedLines) : next)
              }
              showBus={showBus}
              onShowBusChange={(val) => {
                setShowBus(val);
                if (!val) setSelectedBusRoutes([]);
              }}
              availableBusRoutes={availableBusRoutes}
              selectedBusRoutes={selectedBusRoutes}
              onBusRoutesChange={(next) =>
                setSelectedBusRoutes(typeof next === 'function' ? next(selectedBusRoutes) : next)
              }
              // Calendar's time scope is fixed at 12 months — hide the
              // range/pinned-day controls so users don't click inert chips.
              hideDateRange
              dateRange={7}
              onDateRangeChange={() => {}}
              selectedDay={null}
              onClearSelectedDay={() => {}}
              selectedSignals={selectedSignals}
              onSignalsChange={(next) =>
                setSelectedSignals(typeof next === 'function' ? next(selectedSignals) : next)
              }
              selectedSources={selectedSources}
              onSourcesChange={(next) =>
                setSelectedSources(typeof next === 'function' ? next(selectedSources) : next)
              }
            />
            {(selectedSignals.length > 0 || selectedSources.length < SOURCE_TYPES.length) && (
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-2">
                Signal and source filters don't apply to the calendar — daily breakdowns aren't kept
                per signal or source. Cell counts reflect line/route filters only.
              </p>
            )}
          </div>
        )}

        {error && <p className="text-red-600 text-sm">Failed to load calendar data.</p>}

        {!error && !data && (
          <div className="h-32 bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border animate-pulse" />
        )}

        {grid && <CalendarGrid grid={grid} />}
      </main>
      <Footer />
    </div>
  );
}

// Weekday-aligned year heatmap. CSS grid: an 8-column layout (one weekday-
// label column + N week columns rendered via subgrid-ish nested grids).
// Implemented as a flex of (label-col, weeks-flex-of-cols) so the weekday
// labels stick at the left while the weeks scroll horizontally on narrow
// viewports.
function CalendarGrid({ grid }) {
  const { weeks, monthLabels, maxCount } = grid;
  return (
    <section>
      <div className="bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border p-4">
        <div className="overflow-x-auto">
          <div className="inline-flex flex-col">
            {/* Month label row — one label slot per week column, only filled at
                the column where each month starts. Uses the same template
                grid as the cell rows below so labels align. */}
            <div className="flex items-end gap-[3px] mb-1 pl-7">
              {weeks.map((cells, wi) => {
                const label = monthLabels.find((m) => m.weekIndex === wi)?.label;
                return (
                  <div
                    key={`monthlabel-${cells[0].date}`}
                    className="w-3 text-left"
                    style={{ minWidth: 12 }}
                  >
                    {label && (
                      <span
                        className="text-slate-500 dark:text-slate-400 whitespace-nowrap"
                        style={{ fontSize: 10 }}
                      >
                        {label}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="flex gap-1">
              {/* Weekday label column. Sparse (Mon/Wed/Fri only) so the
                  row stays readable without crowding every cell with text. */}
              <div className="flex flex-col gap-[3px] pr-1">
                {WEEKDAY_LABELS.map((label, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: fixed seven weekdays, position is the key
                  <div key={i} className="h-3 flex items-center" style={{ minWidth: 24 }}>
                    {label && (
                      <span className="text-slate-500 dark:text-slate-400" style={{ fontSize: 10 }}>
                        {label}
                      </span>
                    )}
                  </div>
                ))}
              </div>
              {/* Week columns — one column per week, each containing 7 cells
                  Sun→Sat. */}
              {weeks.map((cells) => (
                <div key={cells[0].date} className="flex flex-col gap-[3px]">
                  {cells.map((cell) => (
                    <CalendarCell key={cell.date} cell={cell} maxCount={maxCount} />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Legend */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-4 pt-3 border-t border-slate-100 dark:border-gh-border">
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500 dark:text-slate-400">Less</span>
            <div className="flex gap-0.5">
              {[0, 0.1, 0.3, 0.55, 0.8, 1].map((r) => {
                const count = Math.ceil(r * Math.max(maxCount, 1));
                return (
                  <div
                    key={r}
                    className="w-3 h-3 rounded-sm"
                    style={{
                      backgroundColor:
                        r === 0 ? 'var(--timeline-empty)' : cellBg(count, Math.max(maxCount, 1)),
                    }}
                  />
                );
              })}
            </div>
            <span className="text-xs text-slate-500 dark:text-slate-400">More</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-sm" style={NO_DATA_STYLE} />
            <span className="text-xs text-slate-500 dark:text-slate-400">No data</span>
          </div>
          <span className="text-xs text-slate-300 dark:text-slate-600">
            · Each cell = one calendar day · Rows are weekdays, columns are weeks
          </span>
        </div>
      </div>
    </section>
  );
}
