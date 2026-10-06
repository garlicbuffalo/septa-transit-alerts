import ActiveAlerts from './ActiveAlerts.jsx';
import RailUpcomingCancellations from './RailUpcomingCancellations.jsx';

// The homepage "All" view's live-status block, split into a Metro & Bus lane
// and a Regional Rail lane that sit side-by-side and never interleave. Each lane answers
// "is anything wrong on this system right now?" on its own — the core fix for
// a single mixed stream, where a wall of Regional Rail delays and bus detours
// would blur together. A single selected network skips this and renders one full
// ActiveAlerts upstream (in App), so this component is All-view only.

// Per-lane status pill shown beside the network name in the lane header.
function LaneStatus({ activeCount, scheduledCount }) {
  if (activeCount > 0) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-red-600 dark:text-red-400">
        <span aria-hidden="true" className="h-2 w-2 rounded-full bg-red-500" />
        {activeCount} active
      </span>
    );
  }
  if (scheduledCount > 0) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400">
        <span aria-hidden="true" className="h-2 w-2 rounded-full bg-slate-400" />
        {scheduledCount} scheduled
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-green-700 dark:text-green-400">
      <span aria-hidden="true" className="h-2 w-2 rounded-full bg-green-500" />
      All clear
    </span>
  );
}

// Quiet-lane filler shown when a network has nothing live (and, for Regional Rail, no
// upcoming cancellations either). Calmer than the old full-width green banner —
// it just needs to confirm the lane is empty, not shout it.
function LaneAllClear({ label }) {
  return (
    <div className="rounded-lg border border-green-200 dark:border-green-900 bg-green-50/60 dark:bg-green-950/20 px-3 py-2.5 text-xs text-green-700/90 dark:text-green-400/90">
      No active {label} disruptions right now.{' '}
      <span className="opacity-75">Go get yourself a wooder ice.</span>
    </div>
  );
}

function Lane({ name, status, children }) {
  return (
    <section className="min-w-0 space-y-3">
      <div className="flex items-baseline justify-between gap-2 border-b border-slate-200 dark:border-gh-border pb-1.5">
        <h3 className="text-sm font-bold uppercase tracking-wider text-slate-700 dark:text-slate-200">
          {name}
        </h3>
        {status}
      </div>
      {children}
    </section>
  );
}

export default function RightNow({
  transitRecent,
  transitLong,
  railRecent,
  railLong,
  activeIncidents,
  upcomingCount = 0,
  now,
  highlightedIds,
  typicalDurations,
  stationIndex,
  burst,
}) {
  const transitActiveCount = transitRecent.length + transitLong.length;
  const railActiveCount = railRecent.length + railLong.length;
  const burstActive =
    burst != null && burst.recentCount >= 3 && burst.ratio != null && burst.ratio >= 2;

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          Right now
        </h2>
        {burstActive && (
          <span
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-900 tracking-normal"
            title="Recent incident rate vs. the 30-day baseline rate over the same window length."
          >
            {`${burst.recentCount} in ${burst.windowHours}h · ${burst.ratio.toFixed(1)}× typical rate`}
          </span>
        )}
      </div>

      <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
        <Lane
          name="Metro & Bus"
          status={<LaneStatus activeCount={transitActiveCount} scheduledCount={0} />}
        >
          <ActiveAlerts
            incidents={transitRecent}
            longRunningIncidents={transitLong}
            now={now}
            highlightedIds={highlightedIds}
            typicalDurations={typicalDurations}
            stationIndex={stationIndex}
            showHeader={false}
            showGantt={false}
            emptyState={<LaneAllClear label="Metro & Bus" />}
          />
        </Lane>

        <Lane
          name="Regional Rail"
          status={<LaneStatus activeCount={railActiveCount} scheduledCount={upcomingCount} />}
        >
          <RailUpcomingCancellations incidents={activeIncidents} now={now} showLine />
          <ActiveAlerts
            incidents={railRecent}
            longRunningIncidents={railLong}
            now={now}
            highlightedIds={highlightedIds}
            typicalDurations={typicalDurations}
            stationIndex={stationIndex}
            showHeader={false}
            showGantt={false}
            // When cancellations are already shown above, skip the green filler
            // so the lane doesn't say "all clear" directly under a heads-up.
            emptyState={upcomingCount > 0 ? null : <LaneAllClear label="Regional Rail" />}
          />
        </Lane>
      </div>
    </section>
  );
}
