import { useEffect, useMemo, useRef, useState } from 'react';
import ActiveAlerts from './components/ActiveAlerts.jsx';
import CollapsibleSection from './components/CollapsibleSection.jsx';
import Footer from './components/Footer.jsx';
import Header from './components/Header.jsx';
import HomeFilters from './components/HomeFilters.jsx';
import HourOfWeekHeatmap from './components/HourOfWeekHeatmap.jsx';
import SystemDashboard from './components/health/SystemDashboard.jsx';
import IncidentList from './components/IncidentList.jsx';
import { LONG_RUNNING_THRESHOLD_MS } from './components/LongRunningBanner.jsx';
import RailUpcomingCancellations from './components/RailUpcomingCancellations.jsx';
import RecentActivityGantt from './components/RecentActivityGantt.jsx';
import RightNow from './components/RightNow.jsx';
import SignalBreakdown from './components/SignalBreakdown.jsx';
import SummaryStats from './components/SummaryStats.jsx';
import Timeline from './components/Timeline.jsx';
import { useDarkMode } from './hooks/useDarkMode.js';
import { useNow } from './hooks/useNow.js';
import {
  buildTodaySummary,
  computeRecentBurst,
  computeSummaryStats,
  computeTypicalDurations,
} from './lib/aggregate.js';
import { compareBusRoutes } from './lib/busRoutes.js';
import { cancellationInfo, collectUpcomingCancellations } from './lib/cancellation.js';
import { loadRecent } from './lib/incidentStore.js';
import {
  filterIncidents,
  incidentLifecycle,
  incidentNetwork,
  incidentRecords,
  NETWORK_LABELS,
  observationSignals,
  SOURCE_TYPES,
} from './lib/incidents.js';
import { SITE_NAME } from './lib/site.js';
import { buildStationIndex } from './lib/stations.js';
import {
  buildSearch,
  parseUrlState,
  readStoredFilters,
  writeStoredFilters,
} from './lib/urlState.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Page-level network scope options, in display order. The label is what the
// segmented control shows; the value is matched against an incident's network
// (`rail` for Regional Rail, else `transit` — SEPTA Metro + buses).
const NETWORK_SCOPES = ['all', 'transit', 'rail'];
const NETWORK_OPTIONS = [
  ['all', 'All'],
  ['transit', NETWORK_LABELS.transit],
  ['rail', NETWORK_LABELS.rail],
];

export default function App() {
  const [dark, toggleDark] = useDarkMode();
  const now = useNow();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  // Initial state precedence: URL > localStorage > defaults. The URL wins so
  // shareable links always render the same view. localStorage only fills in
  // when the URL is bare (the common case of a returning visitor opening "/")
  // — picks up their last line/bus/signal selections from the prior session.
  const initial = useMemo(() => {
    const fromUrl = parseUrlState();
    const hasAnyUrl = window.location.search.length > 1;
    if (hasAnyUrl) return fromUrl;
    const stored = readStoredFilters();
    if (!stored) return fromUrl;
    // Migration: a legacy localStorage payload from before the source-filter
    // flip carries `selectedSources: []`, which under the new "selected =
    // shown" semantics would render an empty page. Drop the empty value so
    // the URL/state default (all sources) takes over for that visitor.
    if (Array.isArray(stored.selectedSources) && stored.selectedSources.length === 0) {
      const { selectedSources: _drop, ...rest } = stored;
      return { ...fromUrl, ...rest };
    }
    return { ...fromUrl, ...stored };
  }, []);
  const [selectedLines, setSelectedLines] = useState(initial.selectedLines); // null = all lines; [] = no lines
  const [showBus, setShowBus] = useState(initial.showBus);
  const [selectedBusRoutes, setSelectedBusRoutes] = useState(initial.selectedBusRoutes);
  const [selectedRailLines, setSelectedRailLines] = useState(initial.selectedRailLines ?? []);
  const [dateRange, setDateRange] = useState(initial.dateRange); // days; null = all time
  // selectedDay is a Philadelphia-day UTC midnight epoch, or null. When set it
  // overrides dateRange for the incident list — the user is drilled into a
  // single day from the timeline.
  const [selectedDay, setSelectedDay] = useState(initial.selectedDay);
  const [selectedSignals, setSelectedSignals] = useState(initial.selectedSignals);
  const [selectedSources, setSelectedSources] = useState(initial.selectedSources);
  const [search, setSearch] = useState(initial.search);
  // Network scope for the All / Metro & Bus / Regional Rail control: 'all' |
  // 'transit' | 'rail'. This is a page-level scope (not just a list filter) —
  // it narrows the active-now banner, summary stats, timeline, and everything
  // else, since a rider almost always cares about one network at a time.
  // Persisted to localStorage; a stale or garbage stored value falls back to
  // 'all' rather than emptying the page.
  const [selectedNetwork, setSelectedNetwork] = useState(() =>
    NETWORK_SCOPES.includes(initial.selectedNetwork) ? initial.selectedNetwork : 'all',
  );

  function resetFilters() {
    setSelectedLines(null);
    setShowBus(true);
    setSelectedBusRoutes([]);
    setSelectedRailLines([]);
    setDateRange(7);
    setSelectedDay(null);
    setSelectedSignals([]);
    setSelectedSources([...SOURCE_TYPES]);
    setSearch('');
    setSelectedNetwork('all');
  }

  // Picking any range pill drops the day pin — the two are mutually exclusive
  // narrow modes, and a stale pin would silently override the user's choice.
  function handleDateRangeChange(next) {
    setDateRange(next);
    setSelectedDay(null);
  }

  // Auto-flip bus visibility on transitions in/out of a positive Metro-line
  // selection. So clicking "L1" hides buses (an L1 view almost never wants
  // unrelated bus disruptions); clicking it off restores them. The
  // "Buses" button still lets the user override.
  function handleLinesChange(next) {
    const resolved = typeof next === 'function' ? next(selectedLines) : next;
    setSelectedLines(resolved);
    const wasNarrowed = selectedLines !== null && selectedLines.length > 0;
    const willBeNarrowed = resolved !== null && resolved.length > 0;
    if (wasNarrowed !== willBeNarrowed) setShowBus(!willBeNarrowed);
  }

  // Mirror filter state to the URL so views are shareable. replaceState (not
  // pushState) so the back button doesn't traverse every filter toggle.
  useEffect(() => {
    const queryString = buildSearch({
      selectedLines,
      showBus,
      selectedBusRoutes,
      selectedRailLines,
      dateRange,
      selectedDay,
      selectedSignals,
      selectedSources,
      search,
    });
    const next = `${window.location.pathname}${queryString}${window.location.hash}`;
    if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      window.history.replaceState(null, '', next);
    }
  }, [
    selectedLines,
    showBus,
    selectedBusRoutes,
    selectedRailLines,
    dateRange,
    selectedDay,
    selectedSignals,
    selectedSources,
    search,
  ]);

  // Persist the sticky subset (lines, bus visibility, bus routes, signals)
  // to localStorage so a returning visitor sees the same scope they last
  // chose. dateRange / day pin / search are deliberately excluded — those
  // are momentary, not preferences.
  useEffect(() => {
    writeStoredFilters({
      selectedLines,
      showBus,
      selectedBusRoutes,
      selectedRailLines,
      selectedSignals,
      selectedSources,
      selectedNetwork,
    });
  }, [
    selectedLines,
    showBus,
    selectedBusRoutes,
    selectedRailLines,
    selectedSignals,
    selectedSources,
    selectedNetwork,
  ]);

  useEffect(() => {
    // Don't refetch on every unhide — a quick alt-tab away and back shouldn't
    // fire a request. Only revalidate on focus if it's been at least this long
    // since the last fetch; shorter toggles ride the data we already have.
    const MIN_REFETCH_GAP_MS = 60 * 1000;
    let lastFetchedAt = 0;

    function fetchData() {
      lastFetchedAt = Date.now();
      // loadRecent() fetches the bounded 93-day-∪-active recent slice (not the
      // full history) with revalidation. A quiet poll still comes back 304 with
      // no body.
      loadRecent()
        .then((fresh) => {
          setData((prev) => {
            // Only update if generated_at changed (or on first load).
            if (!prev || fresh.generated_at !== prev.generated_at) return fresh;
            return prev;
          });
        })
        .catch((err) => {
          // Only surface fetch errors on the initial load.
          setData((prev) => {
            if (!prev) setError(err);
            return prev;
          });
        });
    }

    // Poll every 5 minutes, but only while the tab is visible — a backgrounded
    // tab doesn't need a 5-min ticker doing fetch+parse work it can't show.
    // On return to the foreground we fetch once immediately (so the user never
    // looks at stale data while the next interval tick is pending) and resume.
    let intervalId = null;
    function startPolling() {
      if (intervalId == null) intervalId = setInterval(fetchData, 5 * 60 * 1000);
    }
    function stopPolling() {
      if (intervalId != null) {
        clearInterval(intervalId);
        intervalId = null;
      }
    }
    function handleVisibility() {
      if (document.visibilityState === 'visible') {
        if (Date.now() - lastFetchedAt >= MIN_REFETCH_GAP_MS) fetchData();
        startPolling();
      } else {
        stopPolling();
      }
    }

    fetchData(); // initial load regardless of visibility (e.g. background tab)
    if (document.visibilityState === 'visible') startPolling();
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);

  // The whole page is scoped to the selected network. Everything downstream
  // (flat view, active-now banner, summary stats, timeline, incident list)
  // derives from this slice, so toggling Metro & Bus / Regional Rail rescopes
  // the page as a unit rather than just filtering the list at the bottom.
  const networkIncidents = useMemo(() => {
    if (!data) return [];
    if (selectedNetwork === 'all') return data.incidents;
    return data.incidents.filter((inc) => incidentNetwork(inc) === selectedNetwork);
  }, [data, selectedNetwork]);

  // Incident-derived official/detection records for analytics helpers
  // (summary stats, station index, timeline, ActiveAlerts/Gantt). The incident
  // list path reads the nested `networkIncidents` directly.
  const flat = useMemo(
    () => (data ? incidentRecords(networkIncidents) : null),
    [data, networkIncidents],
  );

  const activeIncidents = useMemo(() => {
    // Each incident is already unified server-side, so the active set is just
    // the open incidents — no client-side merge needed.
    return networkIncidents
      .filter((inc) => incidentLifecycle(inc).active)
      .sort((a, b) => incidentLifecycle(b).first_seen_ts - incidentLifecycle(a).first_seen_ts);
  }, [networkIncidents]);

  // Split active incidents on the 12h elapsed mark. Long-runners (planned
  // reroutes, multi-day construction) get their own quieter banner — left
  // mixed with the breaking-news cards they trained users to ignore the
  // red treatment after a day or two.
  const { recentActive, longRunningActive } = useMemo(() => {
    const recent = [];
    const longRunning = [];
    for (const i of activeIncidents) {
      // Upcoming single-train cancellations are forward-looking, not live
      // disruptions — they get their own strip, not the "active disruptions"
      // cards (and never the long-running "Day N" framing).
      if (cancellationInfo(i)) continue;
      const startTs = incidentLifecycle(i).first_seen_ts;
      if (startTs != null && now - startTs >= LONG_RUNNING_THRESHOLD_MS) longRunning.push(i);
      else recent.push(i);
    }
    return { recentActive: recent, longRunningActive: longRunning };
  }, [activeIncidents, now]);

  // Per-network split of the active sets, for the All view's two-lane "Right
  // now" block (Metro & Bus lane | Regional Rail lane, never interleaved).
  // When a single network is selected the page is already scoped, so these
  // just mirror the full set.
  const lanes = useMemo(
    () => ({
      transitRecent: recentActive.filter((i) => incidentNetwork(i) === 'transit'),
      transitLong: longRunningActive.filter((i) => incidentNetwork(i) === 'transit'),
      railRecent: recentActive.filter((i) => incidentNetwork(i) === 'rail'),
      railLong: longRunningActive.filter((i) => incidentNetwork(i) === 'rail'),
    }),
    [recentActive, longRunningActive],
  );

  // Forward-looking cancellations announced for departures still ahead of now.
  // Drives the amber strip and suppresses the green "all clear" banner — a
  // pending cancellation isn't an active disruption, but it isn't "all clear".
  const upcomingCancellations = useMemo(
    () => collectUpcomingCancellations(activeIncidents, { now }),
    [activeIncidents, now],
  );

  // Surface the active count in the tab title so a pinned tab tells the user
  // something is wrong without them having to switch to it.
  useEffect(() => {
    const base = SITE_NAME;
    document.title = activeIncidents.length > 0 ? `(${activeIncidents.length}) ${base}` : base;
  }, [activeIncidents.length]);

  // Track which event ids have been seen on prior renders, so when the 5-min
  // poll brings in new ones we can briefly highlight them. The first data load
  // seeds the set without highlighting anything — otherwise every event would
  // flash on initial page render.
  const seenIdsRef = useRef(null);
  const [highlightedIds, setHighlightedIds] = useState(() => new Set());
  useEffect(() => {
    if (!data) return;
    const current = new Set();
    for (const inc of data.incidents) {
      if (inc.id) current.add(inc.id);
    }
    if (seenIdsRef.current === null) {
      seenIdsRef.current = current;
      return;
    }
    const fresh = new Set();
    for (const id of current) {
      if (!seenIdsRef.current.has(id)) fresh.add(id);
    }
    seenIdsRef.current = current;
    if (fresh.size === 0) return;
    setHighlightedIds(fresh);
    // Match the keyframe duration in tailwind.config.js — keep the React
    // state alive long enough for the CSS animation to run, then drop the
    // class so it doesn't replay if the component re-renders.
    const t = setTimeout(() => setHighlightedIds(new Set()), 5000);
    return () => clearTimeout(t);
  }, [data]);

  const availableBusRoutes = useMemo(() => {
    if (!flat) return [];
    const routes = new Set([
      ...flat.detectionRecords.filter((o) => o.kind === 'bus').map((o) => o.line),
      ...flat.officialRecords.filter((a) => a.kind === 'bus').flatMap((a) => a.routes),
    ]);
    return [...routes].sort(compareBusRoutes);
  }, [flat]);

  // Prune any selected bus routes that don't exist in the current data —
  // typically from a stale shareable URL (?routes=17,99 where 99 no longer
  // appears). Without this the bus-route filter silently filters everything
  // out and the user just sees an empty list.
  useEffect(() => {
    if (!data || selectedBusRoutes.length === 0) return;
    const available = new Set(availableBusRoutes);
    const valid = selectedBusRoutes.filter((r) => available.has(r));
    if (valid.length !== selectedBusRoutes.length) setSelectedBusRoutes(valid);
  }, [data, availableBusRoutes, selectedBusRoutes]);

  // Visualization data — `data` minus standalone official alerts that the signal
  // filter would drop, plus observations restricted to those carrying any of
  // the selected signal kinds. Used for the Timeline grid and the hour-of-
  // week heatmap so the signal chips actually narrow what those views show.
  // Other filters (lines, range, day pin, bus routes) intentionally aren't
  // applied here — the timeline has its own row-level filtering and dimming
  // for those.
  const vizAlerts = useMemo(() => {
    if (!flat) return [];
    if (selectedSignals.length === 0) return flat.officialRecords;
    return [];
  }, [flat, selectedSignals]);

  const vizObservations = useMemo(() => {
    if (!flat) return [];
    if (selectedSignals.length === 0) return flat.detectionRecords;
    const sigSet = new Set(selectedSignals);
    return flat.detectionRecords.filter((o) => observationSignals(o).some((s) => sigSet.has(s)));
  }, [flat, selectedSignals]);

  const summaryStats = useMemo(() => {
    if (!flat) return null;
    return computeSummaryStats(flat.officialRecords, flat.detectionRecords, now);
  }, [flat, now]);

  const todaySummary = useMemo(() => {
    if (!flat) return null;
    return buildTodaySummary(flat.officialRecords, flat.detectionRecords, now);
  }, [flat, now]);

  // 90-day typical-duration cohort lookup, used by ActiveAlerts to surface
  // a "typically ~Xm" hint next to elapsed time on each active card.
  const typicalDurations = useMemo(() => {
    if (!flat) return null;
    return computeTypicalDurations(flat.officialRecords, flat.detectionRecords, {
      now,
      windowDays: 90,
    });
  }, [flat, now]);

  // System-wide burst detector: incidents in the last 3h vs. the 30d baseline
  // rate, scaled to the same 3h window. Used by ActiveAlerts to flash a
  // "Z× typical rate" chip only when things are visibly worse than usual.
  const burst = useMemo(() => {
    if (!flat) return null;
    return computeRecentBurst(flat.officialRecords, flat.detectionRecords, {
      now,
      windowHours: 3,
      baselineDays: 30,
      dataStartTs: data?.data_start_ts ?? null,
    });
  }, [flat, now, data]);

  // Station index — used by IncidentList to turn station names into
  // /station/:slug links when the destination page is worth visiting.
  const stationIndex = useMemo(() => {
    if (!flat) return null;
    return buildStationIndex(flat.officialRecords, flat.detectionRecords, { now, windowDays: 90 });
  }, [flat, now]);

  const filtered = useMemo(() => {
    const startTs = dateRange ? now - dateRange * DAY_MS : null;
    // `networkIncidents` is already scoped to the selected network, so the
    // per-network line/route filters below just refine within it.
    return filterIncidents(networkIncidents, {
      lines: selectedLines,
      startTs,
      showBus,
      busRoutes: selectedBusRoutes.length > 0 ? selectedBusRoutes : null,
      railLines: selectedRailLines.length > 0 ? selectedRailLines : null,
      selectedDay,
      signals: selectedSignals.length > 0 ? selectedSignals : null,
      // Only narrow when the user picked a subset; default (all three) ⇒
      // pass null so the source filter is skipped.
      sources: selectedSources.length < SOURCE_TYPES.length ? selectedSources : null,
      search,
      now,
    });
  }, [
    networkIncidents,
    selectedLines,
    showBus,
    selectedBusRoutes,
    selectedRailLines,
    dateRange,
    selectedDay,
    selectedSignals,
    selectedSources,
    search,
    now,
  ]);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-gh-canvas">
        <p className="text-red-600 text-sm">Failed to load alert data.</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-gh-canvas flex flex-col">
      <Header
        generatedAt={data?.generated_at}
        dark={dark}
        onToggleDark={toggleDark}
        onResetFilters={resetFilters}
        alerts={flat?.alerts}
        observations={flat?.observations}
      />
      <main id="main" tabIndex={-1} className="max-w-5xl mx-auto px-4 py-6 space-y-6 w-full">
        {!data && (
          <div className="space-y-4 animate-pulse">
            <div className="h-16 bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border" />
            <div className="h-10 bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border" />
            <div className="h-48 bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border" />
            <div className="h-64 bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border" />
          </div>
        )}
        {data && (
          <>
            {/* Page-level network scope. Sits above the status banner so it
                governs the active-now count and every stat below — a rider
                almost always cares about one network at a time. */}
            <div className="flex items-center gap-2">
              <span className="hidden sm:inline text-xs text-slate-500 dark:text-slate-400">
                Showing
              </span>
              {/* Segmented control: full-width with equal segments on phones,
                  like a native app's scope switcher; compact from sm up. */}
              <div className="flex w-full sm:w-auto sm:inline-flex rounded-xl sm:rounded-lg bg-slate-200/70 dark:bg-gh-subtle p-1 sm:p-0.5 text-sm sm:text-xs font-semibold">
                {NETWORK_OPTIONS.map(([value, label]) => (
                  <button
                    type="button"
                    key={value}
                    onClick={() => setSelectedNetwork(value)}
                    className={`flex-1 sm:flex-none px-3 py-1.5 sm:py-1 rounded-lg sm:rounded-md transition-colors ${
                      selectedNetwork === value
                        ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-200 dark:text-slate-900'
                        : 'bg-transparent text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100'
                    }`}
                    aria-pressed={selectedNetwork === value}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Live system-health dashboard, top of page: per-mode status
                tiles and charts answer "is anything wrong right now, and
                where?" at a glance, before the detailed alert lists. Scoped
                to the selected network like everything else. */}
            <SystemDashboard
              incidents={networkIncidents}
              network={selectedNetwork}
              now={now}
              dataStartTs={data.data_start_ts ?? null}
              burst={burst}
            />

            {/* The alerts behind the dashboard. The All view splits them into
                a Metro & Bus lane and a Regional Rail lane so the two networks
                never blur into one stream; a single selected network renders
                one focused ActiveAlerts. The burst chip lives on the dashboard
                header above, so it isn't repeated here. */}
            {selectedNetwork === 'all' ? (
              <RightNow
                transitRecent={lanes.transitRecent}
                transitLong={lanes.transitLong}
                railRecent={lanes.railRecent}
                railLong={lanes.railLong}
                activeIncidents={activeIncidents}
                upcomingCount={upcomingCancellations.length}
                now={now}
                highlightedIds={highlightedIds}
                typicalDurations={typicalDurations}
                stationIndex={stationIndex}
              />
            ) : (
              <>
                {/* Forward-looking strip: trains SEPTA has announced won't run
                    but haven't yet reached their scheduled departure. */}
                <RailUpcomingCancellations incidents={activeIncidents} now={now} showLine />
                {recentActive.length > 0 || longRunningActive.length > 0 ? (
                  <ActiveAlerts
                    incidents={recentActive}
                    longRunningIncidents={longRunningActive}
                    now={now}
                    highlightedIds={highlightedIds}
                    typicalDurations={typicalDurations}
                    stationIndex={stationIndex}
                  />
                ) : upcomingCancellations.length > 0 ? null : (
                  <section className="flex items-center gap-3 rounded-lg border border-green-200 dark:border-green-900 bg-green-50 dark:bg-green-950/30 px-4 py-3">
                    <span
                      aria-hidden="true"
                      className="flex h-2.5 w-2.5 flex-shrink-0 rounded-full bg-green-500"
                    />
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-green-800 dark:text-green-300">
                        All clear
                      </p>
                      <p className="text-xs text-green-700/80 dark:text-green-400/80">
                        No active {NETWORK_LABELS[selectedNetwork]} disruptions right now. Go get
                        yourself a wooder ice.
                      </p>
                    </div>
                  </section>
                )}
              </>
            )}

            {/* Overview: today's narrative plus the headline stats, grouped
                into one block instead of two stacked text rows. */}
            {(todaySummary || summaryStats) && (
              <section className="space-y-3">
                {todaySummary && (
                  <div className="px-1">
                    <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
                      🗓️ {todaySummary.text}
                      {todaySummary.lastWeek && (
                        <>
                          {' · '}
                          {todaySummary.lastWeek.count} last{' '}
                          <a
                            href={`/day/${todaySummary.lastWeek.iso}/`}
                            className="text-blue-500 hover:text-blue-400 hover:underline"
                          >
                            {todaySummary.lastWeek.label}
                          </a>
                        </>
                      )}
                      .
                    </p>
                    {todaySummary.lastWeek && (
                      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                        Counts incidents that started each day; a day page can show more, since it
                        also includes ones still ongoing from earlier.
                      </p>
                    )}
                  </div>
                )}
                {summaryStats && (
                  <SummaryStats
                    {...summaryStats}
                    alerts={flat.officialRecords}
                    observations={flat.detectionRecords}
                    showActive={false}
                    network={selectedNetwork}
                    showLineCallouts={false}
                  />
                )}
              </section>
            )}

            {/* Incident list with its filter controls attached directly
                above it (the thing they narrow), collapsed by default. The
                sticky wrapper keeps the Filters trigger reachable while
                scrolling the list; the negative margin extends the backdrop
                past the main element's px-4 gutters. */}
            <section className="space-y-3">
              <div className="sticky top-0 z-30 -mx-4 px-4 py-2 bg-slate-50/95 dark:bg-gh-canvas/95 backdrop-blur-sm">
                <HomeFilters
                  network={selectedNetwork}
                  selectedLines={selectedLines}
                  onLinesChange={handleLinesChange}
                  showBus={showBus}
                  onShowBusChange={(val) => {
                    setShowBus(val);
                    if (!val) setSelectedBusRoutes([]);
                  }}
                  availableBusRoutes={availableBusRoutes}
                  selectedBusRoutes={selectedBusRoutes}
                  onBusRoutesChange={setSelectedBusRoutes}
                  selectedRailLines={selectedRailLines}
                  onRailLinesChange={setSelectedRailLines}
                  dateRange={dateRange}
                  onDateRangeChange={handleDateRangeChange}
                  selectedDay={selectedDay}
                  onClearSelectedDay={() => setSelectedDay(null)}
                  selectedSignals={selectedSignals}
                  onSignalsChange={setSelectedSignals}
                  selectedSources={selectedSources}
                  onSourcesChange={setSelectedSources}
                  onResetFilters={resetFilters}
                />
              </div>
              <IncidentList
                incidents={filtered}
                search={search}
                onSearchChange={setSearch}
                highlightedIds={highlightedIds}
                stationIndex={stationIndex}
                isFiltered={
                  // Out-of-scope network selections are hidden and don't narrow
                  // the list, so they don't count toward the "filtered" state.
                  (selectedNetwork !== 'rail' &&
                    (selectedLines !== null || !showBus || selectedBusRoutes.length > 0)) ||
                  (selectedNetwork !== 'transit' && selectedRailLines.length > 0) ||
                  dateRange !== 7 ||
                  selectedDay !== null ||
                  selectedSignals.length > 0 ||
                  selectedSources.length < SOURCE_TYPES.length
                }
              />
            </section>

            {/* Retrospective analytics, collapsed by default so the homepage
                opens on "now" instead of a wall of charts. Everything here is
                exploratory history a casual/mobile visitor rarely needs up
                front; one tap expands it. */}
            <CollapsibleSection
              title="Trends & history"
              subtitle="Last 24h · 90-day timeline · patterns"
              className="pt-4 mt-2 border-t border-slate-200 dark:border-gh-border"
            >
              <RecentActivityGantt incidents={networkIncidents} now={now} />
              <Timeline
                alerts={vizAlerts}
                observations={vizObservations}
                selectedLines={selectedLines}
                numDays={90}
                selectedRangeDays={dateRange}
                dataStartTs={data.data_start_ts ?? null}
                now={now}
                onLineClick={(line) =>
                  handleLinesChange((prev) =>
                    prev?.includes(line) ? prev.filter((l) => l !== line) : [line],
                  )
                }
                selectedDay={selectedDay}
                onDayClick={(dayUtc) => setSelectedDay((prev) => (prev === dayUtc ? null : dayUtc))}
                showBus={showBus}
                selectedBusRoutes={selectedBusRoutes}
                onBusRouteClick={(route) =>
                  setSelectedBusRoutes((prev) =>
                    prev.includes(route) ? prev.filter((r) => r !== route) : [...prev, route],
                  )
                }
              />
              <HourOfWeekHeatmap alerts={vizAlerts} observations={vizObservations} />
              <SignalBreakdown observations={flat.detectionRecords} />
            </CollapsibleSection>
          </>
        )}
      </main>
      <Footer />
    </div>
  );
}
