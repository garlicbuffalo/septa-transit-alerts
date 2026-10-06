import { useMemo } from 'react';
import { useNow } from '../../hooks/useNow.js';
import {
  computeCohortDurationStats,
  computeHourOfDayContext,
  computeLineDurationRank,
  computeStretchRecurrence,
} from '../../lib/aggregate.js';
import {
  cancellationInfo,
  cancellationSchedulePhrase,
  cancellationStatusLabel,
} from '../../lib/cancellation.js';
import {
  formatDate,
  formatDuration,
  formatEstimatedEnd,
  formatStabilizationDelta,
  formatTime,
} from '../../lib/format.js';
import {
  affectedLineSegments,
  agencyLabel,
  formatEvidenceChip,
  formatRoutesLabel,
  groupIncidentRecords,
  incidentLifecycle,
  incidentRecords,
  isPlannedIncident,
  legacyKind,
  officialAlert,
  railIncidentStatus,
  railPointEvent,
  SIGNAL_LABELS,
  splitObservations,
} from '../../lib/incidents.js';
import { stationsServingLines } from '../../lib/stations.js';
import EventMap from '../EventMap.jsx';
import EventReplay from '../EventReplay.jsx';
import LinePill from '../LinePill.jsx';
import MultiLineEventMap from '../MultiLineEventMap.jsx';
import OfficialBadge from '../OfficialBadge.jsx';
import RailPointBadge from '../RailPointBadge.jsx';
import ShareLink from '../ShareLink.jsx';
import StationName from '../StationName.jsx';
import {
  collectAffectedStations,
  expandSharedTrackageSegments,
  groupAffectedStationsByLine,
  linkifyMentionedStations,
  StationChips,
  StationsByLine,
} from './AffectedStations.jsx';
import CancelledTrips from './CancelledTrips.jsx';
import CopySummary from './CopySummary.jsx';
import {
  buildEventSummaryText,
  computeAgencyEstimate,
  computeAgencyPlanned,
  computeBotLead,
} from './callouts.js';
import { describe, describeText, incidentRoutes } from './incidentText.jsx';
import { MiniTimeline } from './MiniTimeline.jsx';

// 0–23 Philadelphia clock hour → "3 PM" / "12 AM". Used by the time-of-day context
// line; kept local since it's the only consumer.
function formatHourLabel(hour) {
  const period = hour < 12 ? 'AM' : 'PM';
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12} ${period}`;
}

// Compact pill for a severity tier. amber = notable, red = the worst.
function SeverityBadge({ children, tone = 'amber', title }) {
  const cls =
    tone === 'red'
      ? 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300'
      : 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300';
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${cls}`}
      title={title}
    >
      {children}
    </span>
  );
}

// The affected_* stations now render as chips at the top of the card;
// formatAffected is only left to surface the direction string (e.g.
// "Northbound only") for alerts that carry one without station scoping.
// Upstream stores the direction as a lowercase keyword (north/south/east/
// west/in/out) — title-case it so the rendered chip reads "South" not
// "south".
function formatAffected(incident) {
  const d = officialAlert(incident)?.scope?.direction;
  if (!d) return null;
  return d.charAt(0).toUpperCase() + d.slice(1);
}

// Compact horizontal scale showing where this incident's duration sits in
// its cohort of similar resolved incidents (same kind/line/signal). Gives a
// "was this bad or normal?" gut check beyond the bare duration number.
// Hidden when:
//   - The incident is still active (no final duration yet).
//   - The cohort is below the helper's minCohort threshold (any median is
//     too volatile to anchor a comparison).
//   - The incident has no signal to bucket on (official-only alerts).
function DurationScale({ stats }) {
  if (!stats || stats.thisMs == null) return null;
  // Scale extends to the max of (this incident, cohort p90) so a much-
  // worse-than-normal incident pushes the bar past the cohort's whisker
  // without inflating the median's apparent position.
  const scaleMax = Math.max(stats.thisMs, stats.p90Ms, stats.medianMs * 2);
  if (scaleMax <= 0) return null;
  const pct = (v) => Math.min(100, Math.max(0, (v / scaleMax) * 100));

  const ratio = stats.medianMs > 0 ? stats.thisMs / stats.medianMs : null;
  let summary;
  if (ratio == null) summary = null;
  else if (ratio >= 1.5) summary = `${ratio.toFixed(1)}× longer than typical`;
  else if (ratio <= 0.67) summary = `${(1 / ratio).toFixed(1)}× shorter than typical`;
  else summary = 'about typical';

  return (
    <div
      className="mt-4 pt-4 border-t border-slate-100 dark:border-gh-border"
      title={`Cohort: ${stats.count} resolved incidents of this signal type on this line in the last 90 days. Median ${formatDuration(stats.medianMs)}, p90 ${formatDuration(stats.p90Ms)}.`}
    >
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <p className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
          Duration vs typical
        </p>
        {summary && (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            <strong className="text-slate-700 dark:text-slate-200">{summary}</strong> ({stats.count}{' '}
            similar in 90d)
          </p>
        )}
      </div>
      <div className="relative h-2 rounded-full bg-slate-100 dark:bg-gh-subtle">
        {/* Median tick */}
        <div
          className="absolute top-0 bottom-0 w-px bg-slate-400 dark:bg-slate-500"
          style={{ left: `${pct(stats.medianMs)}%` }}
          title={`Cohort median: ${formatDuration(stats.medianMs)}`}
        />
        {/* p90 tick */}
        <div
          className="absolute top-0 bottom-0 w-px bg-slate-300 dark:bg-slate-600"
          style={{ left: `${pct(stats.p90Ms)}%` }}
          title={`Cohort p90: ${formatDuration(stats.p90Ms)}`}
        />
        {/* This incident's marker — colored, on top of the cohort ticks */}
        <div
          className="absolute -top-0.5 -bottom-0.5 w-1 rounded-sm bg-blue-500"
          style={{ left: `calc(${pct(stats.thisMs)}% - 2px)` }}
        />
      </div>
      {/* Inline legend for the blue marker — the ticks rely on hover titles,
          which don't exist on touch, so name the marker explicitly. */}
      <div className="flex items-center gap-1.5 mt-1.5 text-xs text-slate-500 dark:text-slate-400">
        <span aria-hidden="true" className="inline-block w-2 h-2 rounded-sm bg-blue-500" />
        <span>
          This incident
          {stats.thisMs != null && (
            <>
              {' · '}
              <strong className="text-slate-700 dark:text-slate-200">
                {formatDuration(stats.thisMs)}
              </strong>
            </>
          )}
        </span>
      </div>
      <div className="flex justify-between mt-1 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
        <span>0</span>
        <span>median {formatDuration(stats.medianMs)}</span>
        <span>p90 {formatDuration(stats.p90Ms)}</span>
      </div>
    </div>
  );
}

export function EventDetail({ incident, incidents, alerts, observations, stationIndex, dark }) {
  // Reconstruct the older display record for just this incident so helpers and
  // display branches that read incident-derived rows keep working without
  // mutating the v2 incident.
  const flatSubject = useMemo(() => {
    const f = incidentRecords([incident]);
    const { merged, standaloneAlerts, standaloneObs } = groupIncidentRecords(
      f.officialRecords,
      f.detectionRecords,
    );
    return merged[0] ?? standaloneAlerts[0] ?? standaloneObs[0] ?? null;
  }, [incident]);
  const official = flatSubject?.alert_id ? flatSubject : null;
  const kind = legacyKind(incident);
  const lifecycle = incidentLifecycle(incident);
  // The official source for this incident's alert block — always "SEPTA".
  // Threaded through all the "Per SEPTA" / "via SEPTA" copy.
  const agency = agencyLabel(kind);
  const { primary, extras } = splitObservations(incident);
  const isMerged = !!official && !!primary;
  const isAlert = !!official && !primary;
  const isObsOnly = !official;
  // A route's day of cancelled trips (collector/lib/tripCancellations.js),
  // read from SEPTA's real-time trip feed rather than vehicle positions.
  const cancelledTrips =
    isObsOnly && primary?.detection_source === 'trip-cancellations'
      ? (primary.evidence?.trips ?? [])
      : null;

  // For absence-style observations (pulse-cold/thin-gap) the export publishes an
  // onset_ts back-dated to the last observed train; use it as the start so
  // "First seen" lines up with the back-dated duration_ms instead of showing
  // the same minute for first/last seen.
  const startTs = (isObsOnly ? (primary?.onset_ts ?? null) : null) ?? lifecycle.first_seen_ts;
  const endTs = lifecycle.resolved_ts ?? null;
  // Prefer the exported duration_ms when present — it reconciles with onset_ts
  // (resolved_ts - (onset_ts ?? ts)); the raw subtraction is the fallback.
  const durationMs =
    (isObsOnly ? (primary?.duration_ms ?? null) : null) ?? (endTs != null ? endTs - startTs : null);
  const duration = endTs ? formatDuration(durationMs) : null;
  const cohortStats = useMemo(
    () => computeCohortDurationStats(flatSubject, alerts, observations, { windowDays: 90 }),
    [flatSubject, alerts, observations],
  );

  // Wall-clock ticker (1-minute cadence) so an active incident shows a running
  // "ongoing for…" that advances without waiting on the 5-minute data poll.
  const now = useNow();
  // Planned/advance-notice work (track construction, multi-day reroutes) is
  // dated by its scheduled window, not an elapsed clock — the disruption may
  // not have started yet. So we suppress the "Ongoing for" timer and the red
  // "ongoing" pill for these and relabel "First seen" as "Announced" (the
  // moment SEPTA posted the notice). Mirrors the homepage's planned-work band,
  // which also drops the timer.
  const isPlanned = isPlannedIncident(incident, now);
  const elapsedMs =
    lifecycle.active && !isPlanned && startTs != null ? Math.max(0, now - startTs) : null;

  // ── Severity / context insights ──────────────────────────────────────────
  // All windowed off Date.now() at compute time (no `now` tick dependency) so
  // they recompute on data poll, not every minute. The label they share.
  const routes = incidentRoutes(incident);
  const lineLabel = formatRoutesLabel(kind, routes);

  // Line-wide severity: where this incident's duration ranks among ALL
  // incidents on the line over 30d (any signal, incl. official-only alerts).
  const lineRank = useMemo(
    () => computeLineDurationRank(incident, incidents, { windowDays: 30 }),
    [incident, incidents],
  );

  // Signal-cohort severity: derived from the same cohort the DurationScale
  // bar draws (same kind+line+signal, 90d). "Longest" when at/above the
  // cohort max, "top 10%" when at/above p90. Pure SEPTA alerts have no cohort
  // (cohortStats null) and get no signal badge.
  const signalSeverity = useMemo(() => {
    if (!cohortStats || cohortStats.thisMs == null || cohortStats.count < 5) return null;
    if (cohortStats.thisMs >= cohortStats.maxMs)
      return { tier: 'longest', count: cohortStats.count };
    if (cohortStats.thisMs >= cohortStats.p90Ms) return { tier: 'top10', count: cohortStats.count };
    return null;
  }, [cohortStats]);
  const signalLabel = primary?.detection_source
    ? (SIGNAL_LABELS[primary.detection_source] ?? primary.detection_source)
    : null;

  // Place recurrence: has this exact stretch flared up repeatedly lately?
  const stretchRecurrence = useMemo(
    () =>
      computeStretchRecurrence(incidents, {
        line: primary?.line ?? null,
        fromStation: primary?.from_station ?? null,
        toStation: primary?.to_station ?? null,
        selfId: incident.id,
        windowDays: 90,
      }),
    [incidents, primary, incident.id],
  );

  // Time-of-day: is the hour this started in a busy/quiet one for the line?
  const hourContext = useMemo(
    () => computeHourOfDayContext(incident, incidents, { windowDays: 90 }),
    [incident, incidents],
  );

  // Bot-lead-time callout. When our bot's earliest observation (back-dated to
  // the last train through the cold stretch / earliest signal) predates the
  // SEPTA alert's post time, surface the lead so the UI doesn't read as if SEPTA
  // detected first. Skipped under 2 min (SEPTA effectively kept pace).
  const botLead = computeBotLead({
    isMerged,
    agencyFirstSeenTs: official?.first_seen_ts ?? null,
    observations: [primary, ...extras].filter(Boolean),
  });
  const botLeadPhrase = botLead?.phrase ?? null;
  const botLeadOnsetTs = botLead?.onsetTs ?? null;

  // SEPTA-planned-start callout. When SEPTA tagged the alert with a posted start
  // that meaningfully predates our first sighting, the disruption was a
  // planned event scheduled in advance rather than a live reactive post.
  // Skipped when the gap is < 10 minutes (SEPTA fired effectively in real
  // time) or > 14 days (a stale posted start from a long-running planned
  // alert isn't informative).
  const agencyStart = official?.agency_event_start_ts ?? null;
  const agencyPlannedPhrase = computeAgencyPlanned({ agencyStartTs: agencyStart, startTs });

  // SEPTA's claimed end-time vs actual resolution. Pure SEPTA alerts and merged
  // records carry `agency_event_end_ts` when SEPTA originally tagged the alert
  // with a posted end. When the alert resolved before the stated end, SEPTA
  // beat their own estimate; when it resolved after, they were optimistic.
  // Skip when only one side is known or the values are >1 week apart (a
  // stale posted end from a multi-day planned alert isn't a useful comparison).
  // For still-active incidents, surface SEPTA's posted end-time as a
  // forward-looking "expected to clear" line rather than the retrospective
  // comparison below. `formatEstimatedEnd` returns null when the estimate
  // is already past or imminent (≤2 min), so an alert running past its
  // estimate quietly hides the now-stale label instead of advertising it.
  const agencyEndIsDateOnly = official?.agency_event_end_is_date_only === true;
  const activeEndPhrase =
    lifecycle.active && official?.agency_event_end_ts != null
      ? formatEstimatedEnd(official.agency_event_end_ts, undefined, {
          dateOnly: agencyEndIsDateOnly,
        })
      : null;
  // Only show the parenthetical when it adds genuinely new info (a short
  // countdown like "in ~45m", or "later today"). For far-future estimates
  // it falls back to "Mon 4:00 AM", which just duplicates the time and date
  // we already render in bold.
  const showRelativeParenthetical =
    activeEndPhrase != null &&
    (activeEndPhrase.startsWith('in ~') || activeEndPhrase === 'later today');

  // The retrospective "X min early/late" comparison is only meaningful when
  // SEPTA posted a time. Whole-day posted end ("through Dec 19") has no minute
  // precision to compare against, so it's skipped (and the date shown as
  // context elsewhere). See computeAgencyEstimate.
  const agencyEnd = official?.agency_event_end_ts ?? null;
  const agencyEstimateBlock = computeAgencyEstimate({
    agencyEndTs: agencyEnd,
    resolvedTs: lifecycle.resolved_ts ?? null,
    dateOnly: agencyEndIsDateOnly,
  });

  // Stabilization delta: only meaningful when the SEPTA alert cleared before
  // the bot saw service return. The bot's resolved_ts represents sustained
  // recovery (CLEAR_TICKS_TO_RESET consecutive clean passes upstream); SEPTA
  // often clears its alert the moment the underlying incident ends, even if
  // there's still a backlog working through. The gap between the two is the
  // honest "service back to normal" delay riders feel.
  // While the incident is active, a paired obs's prior resolution doesn't end
  // it — surfacing it would imply a "back to normal" that hasn't happened, so
  // the obs resolution side is suppressed until the alert clears.
  const obsResolvedTs = isMerged && !lifecycle.active ? (primary?.resolved_ts ?? null) : null;
  let stabilizationDelta = null;
  if (
    isMerged &&
    lifecycle.resolved_ts != null &&
    obsResolvedTs != null &&
    obsResolvedTs > lifecycle.resolved_ts
  ) {
    stabilizationDelta = formatStabilizationDelta(obsResolvedTs - lifecycle.resolved_ts);
  }
  const description = describe(incident, stationIndex);
  const affected = formatAffected(incident);
  const affectedStations = collectAffectedStations(incident);
  // Affected stretches as { line, from, to } segments. A bot scopes its
  // detection to one line, but on shared trackage the same stations carry the
  // incident's other lines too — fan the stretch onto them so a T1+T2
  // event lists (and maps) both lines, not just whichever one the bot fired on.
  const { segments, expanded: sharedTrackage } = expandSharedTrackageSegments(
    affectedLineSegments(incident),
    incidentRoutes(incident),
  );
  // Multi-line incidents split the station list per line (mirrors the map);
  // null for single-line / pure-SEPTA incidents, which keep the flat chips.
  const stationsByLine = groupAffectedStationsByLine(segments);
  const resolvedUrl = official
    ? (official.resolved_reply_url ?? null)
    : (primary?.resolved_post_url ?? null);
  const obsResolvedUrl =
    isMerged && !lifecycle.active ? (primary?.resolved_post_url ?? null) : null;
  const eventId = incident.id;
  // The main post link: SEPTA's announcement post when present, else the bot
  // post. SEPTA alerts have no permalinks of their own, so an unposted alert
  // links the route's SEPTA.org page instead (`sourceUrl`).
  const primaryUrl = official ? official.post_url : (primary?.post_url ?? null);
  const sourceUrl = official && !official.post_url ? (official.source_url ?? null) : null;

  // Single-train Regional Rail cancellation: replaces the ongoing/resolved pill and the
  // duration framing with the train's schedule (this isn't an open disruption
  // with a duration — it's an annulled train tied to a timetable slot).
  const cancel = cancellationInfo(incident);
  const cancelPhrase = cancellationSchedulePhrase(cancel);
  // Regional Rail point event (late / cancelled / not-seen-running train): a status pill
  // in place of the resolved/ongoing pill (the title already leads with the
  // pre-rendered sentence via describe()). Null for the timetable-cancellation
  // path above, which has its own schedule summary.
  const pointEvent = !cancel ? railPointEvent(incident) : null;
  const railStatus = !cancel ? railIncidentStatus(incident) : null;
  // The timetable cancellation and every bot point event (late / cancelled /
  // not-seen-running) describe a single scheduled train at a point in time, not
  // a running disruption — so none of them get a map, a "last seen", a duration,
  // or duration-ranked severity. The rider-facing magnitude (how late, or that
  // it was cancelled) is already in the title sentence.
  const isPointInTime = !!cancel || !!pointEvent;
  // For a bot point event the "start" timestamp is the train's scheduled
  // departure (onset_ts = scheduledDepTs upstream), not a "first seen" — relabel
  // it when we have that anchor.
  const startIsScheduledDep = !!pointEvent && primary?.onset_ts != null;

  return (
    <article className="bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border p-6">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <LinePill kind={kind} routes={incident.routes} />
        {isMerged && (
          <>
            <span className="text-xs text-slate-500 dark:text-slate-400 italic">
              via {agencyLabel(kind)}
            </span>
            <span className="text-xs text-slate-300 dark:text-slate-600">·</span>
            <span className="text-xs text-slate-500 dark:text-slate-400 italic">
              via auto-detection
            </span>
          </>
        )}
        {isAlert && (
          <span className="text-xs text-slate-500 dark:text-slate-400 italic">
            via {agencyLabel(kind)}
          </span>
        )}
        {isObsOnly && (
          <span className="text-xs text-slate-500 dark:text-slate-400 italic">
            via auto-detection
          </span>
        )}
        {cancel ? (
          <span
            className={`text-xs font-semibold ${
              cancel.isUpcoming
                ? 'text-amber-600 dark:text-amber-400'
                : 'text-slate-500 dark:text-slate-400'
            }`}
          >
            {cancellationStatusLabel(cancel)}
          </span>
        ) : railStatus ? (
          <>
            {/* The Regional Rail status badge already reads "planned work" for planned
                incidents, so don't also tack on a "planned" pill — just drop
                the "ongoing" marker, which doesn't apply before the work
                starts. */}
            <RailPointBadge source={railStatus.source} />
            {lifecycle.active && !isPlanned && (
              <span className="text-xs font-semibold text-red-500">ongoing</span>
            )}
          </>
        ) : (
          <>
            {lifecycle.active &&
              (isPlanned ? (
                <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                  planned
                </span>
              ) : (
                <span className="text-xs font-semibold text-red-500">ongoing</span>
              ))}
            {!lifecycle.active && lifecycle.resolved_ts != null && (
              <span className="text-xs font-semibold text-green-600 dark:text-green-400">
                resolved
              </span>
            )}
          </>
        )}
      </div>

      {/* Schedule-anchored cancellation summary — the cancelled train's
          timetable slot, in place of a "duration" that doesn't apply to a
          train that never ran. */}
      {cancel && cancelPhrase && (
        <div className="mb-3 text-sm text-slate-600 dark:text-slate-300">
          <span className="font-medium">
            {cancel.trainNumber ? `Train #${cancel.trainNumber}` : 'Train'}
          </span>{' '}
          scheduled {cancelPhrase}
          {cancel.origin ? ` from ${cancel.origin}` : ''}
          {cancel.isUpcoming ? ' — will not operate.' : ' — did not operate.'}
        </div>
      )}

      {/* Severity badges — "was this a bad one?" at a glance. The line-wide
          badge ranks duration against every incident on the line (30d); the
          signal badge ranks it against the same-signal cohort the
          DurationScale below draws (90d). Both only appear when notable. */}
      {!isPointInTime && (lineRank || signalSeverity) && (
        <div className="flex flex-wrap items-center gap-2 mb-3">
          {lineRank && (
            <SeverityBadge
              tone={lineRank.tier === 'longest' ? 'red' : 'amber'}
              title={`Ranked by duration against all ${lineLabel} incidents resolved in the last ${lineRank.windowDays} days (cohort of ${lineRank.count}).`}
            >
              {lineRank.tier === 'longest'
                ? `Longest ${lineLabel} incident in ${lineRank.windowDays}d`
                : `Top 10% longest on ${lineLabel} (${lineRank.windowDays}d)`}
            </SeverityBadge>
          )}
          {signalSeverity && signalLabel && (
            <SeverityBadge
              tone="amber"
              title={`Ranked against ${signalSeverity.count} similar ${signalLabel.toLowerCase()} incidents on ${lineLabel} in the last 90 days.`}
            >
              {signalSeverity.tier === 'longest'
                ? `Longest ${signalLabel.toLowerCase()} on ${lineLabel} (90d)`
                : `Top 10% ${signalLabel.toLowerCase()} on ${lineLabel} (90d)`}
            </SeverityBadge>
          )}
        </div>
      )}

      <h1 className="text-lg font-semibold text-slate-800 dark:text-slate-100 leading-snug mb-2">
        {description}
      </h1>

      {/* Bot-only incidents had no matching official SEPTA alert — say so
          plainly. The bot caught something SEPTA's own channels didn't
          announce, which is the point of the auto-detection layer. Neutral
          phrasing: plenty of minor disruptions legitimately don't warrant a
          SEPTA post. */}
      {isObsOnly && (
        <p className="text-xs text-slate-500 dark:text-slate-400 mb-2 italic">
          {cancelledTrips
            ? `No matching ${agency} rider alert — from ${agency}'s real-time trip feed, which marks each cancelled trip.`
            : `No matching ${agency} alert — surfaced from live vehicle tracking only.`}
        </p>
      )}

      {cancelledTrips && <CancelledTrips trips={cancelledTrips} now={now} />}

      {pointEvent?.lede && pointEvent.lede !== description && (
        <p className="text-sm text-slate-600 dark:text-slate-300 mb-2">{pointEvent.lede}</p>
      )}

      {/* Point events lead the title with the lateness/cancellation sentence and
          draw no map, so the train's run (origin → destination) would otherwise
          be lost. Show it here as a compact line. */}
      {pointEvent?.fromStation && pointEvent.toStation && (
        <p className="text-sm text-slate-600 dark:text-slate-300 mb-2">
          <StationName name={pointEvent.fromStation} kind="rail" stationIndex={stationIndex} /> →{' '}
          <StationName name={pointEvent.toStation} kind="rail" stationIndex={stationIndex} />
          {pointEvent.directionLabel && (
            <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">
              ({pointEvent.directionLabel})
            </span>
          )}
        </p>
      )}

      {/* Chips only when the headline isn't already the station pair. For
          pure observations the description IS "From → To" — rendering the
          same stations a second time as chunky chips is just redundant
          visual noise. SEPTA alerts (headlines like "Temporary Reroute" or
          "Service Change") are the case where the chips actually add
          information that isn't already in the headline.
          Skipped for bus events: upstream's affected_from/to_station for
          bus alerts holds cross-street labels (e.g. "Wacker", "Randolph"),
          not rail-station names. The station index is train-only by
          design — linking them produces /station/wacker pages with no
          incidents on record. The cross-street info is already in the bus
          alert headline, so the chips row adds nothing useful. */}
      {official &&
        kind === 'metro' &&
        (stationsByLine ? (
          <StationsByLine
            groups={stationsByLine}
            direction={official.affected_direction}
            sharedTrackage={sharedTrackage}
          />
        ) : (
          <StationChips stations={affectedStations} direction={official.affected_direction} />
        ))}

      {/* Regional Rail: stations referenced in the alert text, resolved upstream
          (by the collector) to canonical GTFS names — free-text station names
          don't match the roster, so this can't be done in-line. Each links to
          its Regional Rail station page. */}
      {official && kind === 'rail' && official.mentioned_stations?.length > 0 && (
        <p className="text-sm text-slate-600 dark:text-slate-300 mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <span className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 mr-1">
            Stations
          </span>
          {official.mentioned_stations.map((name, i) => (
            <span key={name} className="inline-flex items-center">
              <StationName name={name} kind="rail" />
              {i < official.mentioned_stations.length - 1 ? ',' : ''}
            </span>
          ))}
        </p>
      )}

      {isObsOnly && primary?.signals?.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mt-2">
          <span className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
            Signals
          </span>
          {primary.signals.map((signal) => (
            <span
              key={signal}
              className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 dark:bg-gh-subtle text-slate-700 dark:text-slate-300"
            >
              {SIGNAL_LABELS[signal] ?? signal}
            </span>
          ))}
        </div>
      )}

      {/* Bot-confidence chip — same string the IncidentList row shows
          ("5 stations cold · 2 trains missed"). Without this the event page
          dropped the "why was this detected" context that the row carried,
          which made bot-only incidents look unexplained. Returns null for
          alerts and roundups, so the section silently disappears when
          there's no evidence payload to summarize. */}
      {(() => {
        const chip = isObsOnly ? formatEvidenceChip(primary) : null;
        if (!chip) return null;
        return (
          <div
            className="flex flex-wrap items-center gap-2 mt-2"
            title="The auto-detection signal that triggered this incident. These are derived from the bot's evidence payload at first sighting."
          >
            <span className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Detection
            </span>
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 dark:bg-gh-subtle text-slate-700 dark:text-slate-300">
              {chip}
            </span>
          </div>
        );
      })()}

      {affected && (
        <p className="text-sm text-slate-600 dark:text-slate-300 mt-2">
          <span className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 mr-2">
            Direction
          </span>
          {affected}
        </p>
      )}

      {/* SEPTA's own body text for the alert — the reroute/closure details the
          SEPTA published alongside the headline. Rendered verbatim in a quoted
          block so it's visually distinct from the page's derived data and
          attributable to SEPTA. Newlines preserved via whitespace-pre-line
          since the SEPTA feed sometimes uses line breaks to separate
          instructions. */}
      {/* Plain-English narrative for pure bot observations — the "Per bot"
          counterpart to "Per SEPTA" below. Both sentences are pre-rendered
          server-side in official-insights/bin/export-web.js so this stays a dumb
          renderer. When the observation is resolved, the detection +
          resolution sentences become two entries on a LinkedIn-style rail
          matching the "Per SEPTA · N updates" pattern. */}
      {(() => {
        // Regional Rail point events lead the title with this exact sentence and carry
        // no onset/resolution/evidence rail, so the "Per bot" entry would just
        // restate the title — suppress it for them.
        const detection = isObsOnly && !pointEvent ? primary?.bot_description : null;
        const resolution = isObsOnly ? primary?.bot_resolved_description : null;
        const bullets = isObsOnly ? primary?.bot_evidence_bullets : null;
        const onsetText = isObsOnly ? (primary?.onset_description ?? null) : null;
        const onsetTs = isObsOnly ? (primary?.onset_ts ?? null) : null;
        // Hourly progress updates posted while the incident was still open
        // ("still no buses — ~3h in"). They sit between the detection and the
        // resolution on the rail; absent for short or pre-feature incidents.
        const updates = (
          isObsOnly && Array.isArray(primary?.bot_updates) ? primary.bot_updates : []
        ).filter((u) => u?.description && u.ts != null);
        if (!detection) return null;
        const joinBullets = (items) => items.map((b) => b.replace(/\.\s*$/, '')).join('; ') + '.';
        const bulletsBlock =
          Array.isArray(bullets) && bullets.length > 0 ? (
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400 leading-relaxed">
              {joinBullets(bullets)}
            </p>
          ) : null;
        // Onset entry — the back-dated start of the gap, oldest on the rail.
        // Absence detections (pulse-cold/thin-gap) post only after the stretch
        // has been cold a while, so the detection dot lands well after the gap
        // actually began; this anchors a "started here" dot at onset_ts so the
        // timeline lines up with "First seen". Only when the export supplied
        // the sentence AND the start is ≥5 min before the post (mirrors the
        // server's own gate, so a stale field can't draw a dot under detection).
        const hasOnset =
          !!onsetText &&
          onsetTs != null &&
          primary?.ts != null &&
          primary.ts - onsetTs >= 5 * 60 * 1000;
        if (!resolution && !hasOnset && updates.length === 0) {
          return (
            <blockquote className="mt-4 border-l-2 border-slate-300 dark:border-gh-border pl-4 py-1">
              <p className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
                Per bot
              </p>
              <p className="text-sm text-slate-700 dark:text-slate-200 leading-relaxed">
                {detection}
              </p>
              {bulletsBlock}
            </blockquote>
          );
        }
        // Newest first: resolution (if cleared), progress updates, detection,
        // onset (if known). Bullets only belong on the detection entry — the
        // resolution post is a single "back to normal" sentence, the onset is a
        // one-line marker, and each update is its own one-line "still going" beat.
        const entries = [];
        if (resolution)
          entries.push({ key: 'resolved', ts: lifecycle.resolved_ts, text: resolution });
        for (const u of updates)
          entries.push({ key: `update-${u.ts}`, ts: u.ts, text: u.description });
        entries.push({ key: 'detect', ts: primary.ts, text: detection, bullets });
        if (hasOnset) entries.push({ key: 'onset', ts: onsetTs, text: onsetText });
        // Updates and resolution all sit after detection in time; sort the whole
        // rail strictly newest-first so an out-of-order update can't jump the line.
        entries.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
        return (
          <section className="mt-4">
            <p className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-2">
              Per bot · {entries.length} updates
            </p>
            <ol className="space-y-6">
              {entries.map((e, i) => {
                const isLatest = i === 0;
                const isOldest = i === entries.length - 1;
                // The detection entry is the moment the bot raised the alarm —
                // give it an amber dot + ALERTED badge so the "this is a problem"
                // beat is the visual anchor of the rail. "Alerted" (not
                // "Detected") because the gap may have begun earlier — the onset
                // entry below carries the real start; this marks when we posted.
                // It wins over the Latest badge when it's also the newest entry
                // (an active, not-yet-resolved incident).
                const isDetect = e.key === 'detect';
                return (
                  <li key={e.key} className="relative pl-6">
                    {!isOldest && (
                      <span
                        aria-hidden="true"
                        className="absolute left-[3px] top-2 w-px bg-slate-200 dark:bg-gh-border"
                        style={{ bottom: '-1.5rem' }}
                      />
                    )}
                    <span
                      aria-hidden="true"
                      className={`absolute left-0 top-1.5 w-[7px] h-[7px] rounded-full ring-2 ring-white dark:ring-gh-surface ${
                        isDetect
                          ? 'bg-amber-500'
                          : isLatest
                            ? 'bg-blue-500'
                            : 'bg-slate-400 dark:bg-slate-500'
                      }`}
                    />
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 mb-1">
                      <p className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                        {formatDate(e.ts)} · {formatTime(e.ts)}
                      </p>
                      {isDetect && (
                        <span className="text-[10px] uppercase tracking-wider font-semibold text-amber-600 dark:text-amber-400">
                          Alerted
                        </span>
                      )}
                      {isLatest && !isDetect && (
                        <span className="text-[10px] uppercase tracking-wider font-semibold text-blue-500">
                          Latest
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-slate-700 dark:text-slate-200 leading-relaxed">
                      {e.text}
                    </p>
                    {Array.isArray(e.bullets) && e.bullets.length > 0 && (
                      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400 leading-relaxed">
                        {joinBullets(e.bullets)}
                      </p>
                    )}
                  </li>
                );
              })}
            </ol>
          </section>
        );
      })()}

      {(() => {
        // Linkify pool — same set used for the single-version block below,
        // hoisted so multi-version rendering can apply it per entry without
        // recomputing.
        const linkPool = [
          ...(official?.mentioned_stations || []),
          ...stationsServingLines(incidentRoutes(incident)),
        ];
        // Normalize to a versions list. The export omits `versions` for a
        // single-version alert, so synthesize one entry from the alert's own
        // fields when there's SEPTA body text to anchor the section.
        const rawVersions = Array.isArray(official?.versions) ? official.versions : null;
        const versions =
          rawVersions && rawVersions.length > 0
            ? rawVersions
            : official?.short_description
              ? // No headline on the synthesized entry — the page <h1> already
                // shows it, so repeating it in the rail would just duplicate.
                [{ ts: official.first_seen_ts, short_description: official.short_description }]
              : [];

        // Build the timeline: SEPTA's text versions (newest first) plus a
        // synthesized "cleared" entry when the alert is no longer active.
        // Without it, a resolved alert ends on a stale "trains standing"
        // message tagged as the Latest update, which reads as if it's still
        // happening. The clear entry only makes sense once there's SEPTA copy to
        // anchor the rail, so a content-less alert stays untouched.
        //
        // For merged SEPTA+bot incidents, interleave bot detection entries
        // (back-dated to obs.onset_ts) so the chronology answers "who detected
        // this first." Each entry is tagged with its source label below.
        // A cancellation is terminal but not "cleared" — no resolution entry
        // (and an annulment Regional Rail dropped from the feed before this lifecycle
        // shipped may carry an old "resolved" reply we must not surface).
        const hasResolved = !cancel && !lifecycle.active && lifecycle.resolved_ts != null;
        const obsDetections = isMerged
          ? [primary, ...extras].filter(Boolean).map((o) => ({
              type: 'obs-detect',
              ts: o.onset_ts ?? o.ts,
              obs: o,
            }))
          : [];
        const entries = [
          ...versions.map((v) => ({ type: 'version', ...v })),
          ...obsDetections,
        ].sort((a, b) => b.ts - a.ts);
        if (hasResolved && entries.length > 0) {
          entries.unshift({ type: 'cleared', ts: lifecycle.resolved_ts });
        }
        if (entries.length === 0) return null;

        const hasObsEntries = obsDetections.length > 0;
        const sectionTitle = hasObsEntries
          ? `Timeline · ${entries.length} updates`
          : `Per ${agency} · ${entries.length} updates`;
        const sourceLabel = (e) => (e.type === 'obs-detect' ? 'Per bot' : `Per ${agency}`);
        const joinBullets = (items) => items.map((b) => b.replace(/\.\s*$/, '')).join('; ') + '.';

        // A single SEPTA message with no clear yet — and no bot entries to
        // interleave — stays a simple quote block. Merged incidents always
        // get the rail since they carry at least one obs detection.
        if (entries.length === 1 && !hasObsEntries) {
          const v = entries[0];
          if (!v.short_description) return null;
          return (
            <blockquote className="mt-4 border-l-2 border-slate-300 dark:border-gh-border pl-4 py-1">
              <p className="flex items-center text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
                Per {agency}
                <OfficialBadge agency={agency} className="ml-1" />
              </p>
              <p className="text-sm text-slate-700 dark:text-slate-200 whitespace-pre-line leading-relaxed">
                {linkifyMentionedStations(v.short_description, linkPool, stationIndex)}
              </p>
            </blockquote>
          );
        }

        return (
          <section className="mt-4">
            <p className="flex items-center text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-2">
              {sectionTitle}
              {/* Badge only on the agency-scoped title ("Per SEPTA · N updates");
                  the mixed "Timeline" variant tags official entries inline via
                  the per-entry source label below. */}
              {!hasObsEntries && <OfficialBadge agency={agency} className="ml-1" />}
            </p>
            {/* LinkedIn-style rail: each <li> renders its own connector
                segment running from just below its dot down into the
                space-y gap to meet the next dot. The last (oldest)
                entry skips the segment so the rail ends cleanly at its
                dot instead of trailing past it. */}
            <ol className="space-y-6">
              {entries.map((e, i) => {
                const isLatest = i === 0;
                const isOldest = i === entries.length - 1;
                const isCleared = e.type === 'cleared';
                const isObsDetect = e.type === 'obs-detect';
                // Headline only re-shown when it changed from the next OLDER
                // version (skip non-version entries, which carry no headline).
                // Most edits keep the headline and only revise the body, so
                // reprinting it on every entry would be noise.
                const prevVersion = entries.slice(i + 1).find((x) => x.type === 'version');
                const showHeadline =
                  e.type === 'version' && (!prevVersion || prevVersion.headline !== e.headline);
                return (
                  <li
                    key={e.type === 'obs-detect' ? `obs-${e.obs.id}` : `${e.type}-${e.ts}`}
                    className="relative pl-6"
                  >
                    {!isOldest && (
                      <span
                        aria-hidden="true"
                        className="absolute left-[3px] top-2 w-px bg-slate-200 dark:bg-gh-border"
                        style={{ bottom: '-1.5rem' }}
                      />
                    )}
                    <span
                      aria-hidden="true"
                      className={`absolute left-0 top-1.5 w-[7px] h-[7px] rounded-full ring-2 ring-white dark:ring-gh-surface ${
                        isLatest ? 'bg-blue-500' : 'bg-slate-400 dark:bg-slate-500'
                      }`}
                    />
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 mb-1">
                      <p className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                        {formatDate(e.ts)} · {formatTime(e.ts)}
                      </p>
                      {hasObsEntries && (
                        <span className="inline-flex items-center text-[10px] uppercase tracking-wider font-medium text-slate-500 dark:text-slate-400">
                          {sourceLabel(e)}
                          {!isObsDetect && <OfficialBadge agency={agency} className="ml-1" />}
                        </span>
                      )}
                      {isLatest && (
                        <span className="text-[10px] uppercase tracking-wider font-semibold text-blue-500">
                          Latest
                        </span>
                      )}
                    </div>
                    {isCleared ? (
                      <p className="text-sm text-slate-700 dark:text-slate-200 leading-relaxed">
                        {agency} cleared this alert.
                      </p>
                    ) : isObsDetect ? (
                      <>
                        <p className="text-sm text-slate-700 dark:text-slate-200 leading-relaxed">
                          {e.obs.bot_description}
                        </p>
                        {/* The affected stretch — without it, multiple
                            pulse-cold detections on the same line read as
                            duplicates since the bot_description sentence is
                            generic ("L1 service appears degraded…"). */}
                        {e.obs.from_station && e.obs.to_station && (
                          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
                            <StationName
                              name={e.obs.from_station}
                              kind={kind}
                              stationIndex={stationIndex}
                            />{' '}
                            →{' '}
                            <StationName
                              name={e.obs.to_station}
                              kind={kind}
                              stationIndex={stationIndex}
                            />
                          </p>
                        )}
                        {Array.isArray(e.obs.bot_evidence_bullets) &&
                          e.obs.bot_evidence_bullets.length > 0 && (
                            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400 leading-relaxed">
                              {joinBullets(e.obs.bot_evidence_bullets)}
                            </p>
                          )}
                      </>
                    ) : (
                      <>
                        {showHeadline && e.headline && (
                          <p className="text-sm font-medium text-slate-800 dark:text-slate-100 mb-1">
                            {e.headline}
                          </p>
                        )}
                        {e.short_description && (
                          <p className="text-sm text-slate-700 dark:text-slate-200 whitespace-pre-line leading-relaxed">
                            {linkifyMentionedStations(e.short_description, linkPool, stationIndex)}
                          </p>
                        )}
                      </>
                    )}
                  </li>
                );
              })}
            </ol>
          </section>
        );
      })()}

      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm mt-4">
        <div>
          <dt className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
            {startIsScheduledDep ? 'Scheduled departure' : isPlanned ? 'Announced' : 'First seen'}
          </dt>
          <dd className="text-slate-700 dark:text-slate-200">
            {formatDate(startTs)} · {formatTime(startTs)}
          </dd>
        </div>
        {!isPointInTime && endTs && (
          <div>
            <dt className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Last seen
            </dt>
            <dd className="text-slate-700 dark:text-slate-200">
              {formatDate(endTs)} · {formatTime(endTs)}
            </dd>
          </div>
        )}
        {!isPointInTime && duration && (
          <div>
            <dt className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Duration
            </dt>
            <dd className="text-slate-700 dark:text-slate-200">{duration}</dd>
          </div>
        )}
        {/* Live elapsed time for an active incident — ticks each minute. The
            "Duration" row above only renders once resolved, so this is the
            running counterpart while it's still open. Suppressed for a
            cancellation — a train that won't run has no "ongoing" time. */}
        {!isPointInTime && elapsedMs != null && (
          <div title="Time since this incident was first seen — still ongoing.">
            <dt className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Ongoing for
            </dt>
            <dd className="flex items-center gap-1.5 text-slate-700 dark:text-slate-200 font-medium tabular-nums">
              {formatDuration(elapsedMs)}
              <span
                aria-hidden="true"
                className="inline-block w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse"
              />
            </dd>
          </div>
        )}
        {botLeadPhrase && (
          <div
            className="sm:col-span-2"
            title="Our bot's observation predates SEPTA's alert post time."
          >
            <dt className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Bot lead time
            </dt>
            <dd className="text-slate-700 dark:text-slate-200">
              Bot flagged this <strong>{botLeadPhrase}</strong> before {agency}{' '}
              <span className="text-slate-500 dark:text-slate-400 text-xs">
                (first observed {formatTime(botLeadOnsetTs)} on {formatDate(botLeadOnsetTs)};{' '}
                {agency} posted {formatTime(official.first_seen_ts)})
              </span>
            </dd>
          </div>
        )}
        {agencyPlannedPhrase && (
          <div
            className="sm:col-span-2"
            title="SEPTA's posted start predates our first sighting — the alert was planned in advance rather than fired live."
          >
            <dt className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
              SEPTA scheduled
            </dt>
            <dd className="text-slate-700 dark:text-slate-200">
              <strong>{agencyPlannedPhrase}</strong> of the first sighting{' '}
              <span className="text-slate-500 dark:text-slate-400 text-xs">
                (tagged {formatTime(agencyStart)} on {formatDate(agencyStart)})
              </span>
            </dd>
          </div>
        )}
        {activeEndPhrase && (
          <div className="sm:col-span-2" title="SEPTA posted an end time for this alert.">
            <dt className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
              SEPTA's posted end
            </dt>
            <dd className="text-slate-700 dark:text-slate-200">
              {agencyEndIsDateOnly ? (
                <>
                  <strong>{formatDate(agencyEnd)}</strong>
                  {showRelativeParenthetical && (
                    <>
                      {' '}
                      <span className="text-slate-500 dark:text-slate-400 text-xs">
                        ({activeEndPhrase})
                      </span>
                    </>
                  )}
                </>
              ) : (
                <>
                  <strong>{formatTime(agencyEnd)}</strong> on {formatDate(agencyEnd)}
                  {showRelativeParenthetical && (
                    <>
                      {' '}
                      <span className="text-slate-500 dark:text-slate-400 text-xs">
                        ({activeEndPhrase})
                      </span>
                    </>
                  )}
                </>
              )}
            </dd>
          </div>
        )}
        {/* Date-only posted end on a resolved alert: no minute-precision
            comparison to make, so just show SEPTA's stated through-date as
            context. Skipped when the active block already covered it. */}
        {!lifecycle.active &&
          agencyEndIsDateOnly &&
          agencyEnd != null &&
          lifecycle.resolved_ts != null && (
            <div
              className="sm:col-span-2"
              title="SEPTA posted this alert's end as a whole day, so there's no minute-level comparison to make."
            >
              <dt className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
                SEPTA's posted end
              </dt>
              <dd className="text-slate-700 dark:text-slate-200">{formatDate(agencyEnd)}</dd>
            </div>
          )}
        {agencyEstimateBlock && (
          <div
            className="sm:col-span-2"
            title="SEPTA posted an end time for this alert when it was first published. This compares that estimate to when the alert actually cleared."
          >
            <dt className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
              vs SEPTA's stated end
            </dt>
            <dd className="text-slate-700 dark:text-slate-200">
              {agencyEstimateBlock.phrase}{' '}
              <span className="text-slate-500 dark:text-slate-400 text-xs">
                (estimated {formatTime(agencyEnd)} on {formatDate(agencyEnd)})
              </span>
            </dd>
          </div>
        )}
        {stabilizationDelta && (
          <div
            className="sm:col-span-2"
            title="Time between SEPTA marking the alert cleared and the bot seeing sustained normal service. The bot's clear requires several consecutive clean passes, so this is closer to the felt return-to-normal than SEPTA's timestamp alone."
          >
            <dt className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Service stabilized
            </dt>
            <dd className="text-slate-700 dark:text-slate-200">
              {stabilizationDelta} after {agency} cleared the alert
            </dd>
          </div>
        )}
      </dl>

      {/* Geographic map for train incidents with at least one named
          station. Bus incidents (no geometry data) and alerts that don't
          tag a station fall through to just the mini timeline below.
          Multi-line incidents (a tunnel-wide alert that merged several
          per-line detections) use the combined map so every affected line
          shows its own stretch instead of one arbitrary line. */}
      {kind === 'metro' &&
        (incidentRoutes(incident).length > 1 ? (
          <MultiLineEventMap
            lineKeys={incidentRoutes(incident)}
            segments={segments}
            active={!!lifecycle.active}
            sharedTrackage={sharedTrackage}
          />
        ) : (
          <EventMap
            lineKey={Array.isArray(incident.routes) ? incident.routes[0] : null}
            fromStation={primary?.from_station ?? official?.affected_from_station ?? null}
            toStation={primary?.to_station ?? official?.affected_to_station ?? null}
            active={!!lifecycle.active}
          />
        ))}

      {/* Regional Rail incidents are single-line (one route key), so they always use
          the single-line EventMap — never the multi-line variant. A
          cancellation (timetable, confirmed, or inferred) describes a train that
          never ran, so there's no stretch to map — suppress it. */}
      {kind === 'rail' && !isPointInTime && (
        <EventMap
          kind="rail"
          lineKey={Array.isArray(incident.routes) ? incident.routes[0] : null}
          fromStation={primary?.from_station ?? official?.affected_from_station ?? null}
          toStation={primary?.to_station ?? official?.affected_to_station ?? null}
          active={!!lifecycle.active}
        />
      )}

      {/* Replay — animates the actual vehicle positions from this incident's
          window across the schematic. Renders only when a track file exists
          for this event on the R2 origin (train incidents archived before the
          7-day raw-observation rolloff); otherwise EventReplay returns null. */}
      {kind === 'metro' && (
        <EventReplay
          eventId={incident.id}
          // Prefer the affected observation's own line so a multi-route incident
          // (e.g. a shared B1/B2 stretch) projects onto the line the
          // segment is actually on, not whichever route sorts first.
          lineKey={primary?.line ?? (Array.isArray(incident.routes) ? incident.routes[0] : null)}
          fromStation={primary?.from_station ?? official?.affected_from_station ?? null}
          toStation={primary?.to_station ?? official?.affected_to_station ?? null}
          directionLabel={primary?.direction_label ?? official?.affected_direction ?? null}
        />
      )}

      {/* Context insights — place recurrence ("is this a chronic trouble
          spot?") and time-of-day ("a busy hour for this line?"). Both are
          drawn from the surrounding incident set and only render when they
          clear their notability thresholds, so a one-off in a quiet hour
          shows nothing here. */}
      {/* Context insights are anchored to when the incident started — which for
          planned work is just when SEPTA posted the advance notice, not when the
          disruption happens. "A quiet hour for disruptions" applied to a 4 AM
          construction post is noise, so suppress the whole section for planned
          work. */}
      {!isPlanned && (stretchRecurrence || hourContext) && (
        <div className="mt-4 pt-4 border-t border-slate-100 dark:border-gh-border">
          <p className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-2">
            Context
          </p>
          <ul className="space-y-1.5 text-sm text-slate-600 dark:text-slate-300">
            {stretchRecurrence && (
              <li>
                Recurring stretch:{' '}
                <StationName name={stretchRecurrence.fromStation} stationIndex={stationIndex} /> →{' '}
                <StationName name={stretchRecurrence.toStation} stationIndex={stationIndex} /> has
                had{' '}
                <strong className="text-slate-700 dark:text-slate-200">
                  {stretchRecurrence.count} disruptions
                </strong>{' '}
                detected here in the last {stretchRecurrence.windowDays} days.
              </li>
            )}
            {hourContext && (
              <li>
                {hourContext.tier === 'busy' ? (
                  <>
                    <strong className="text-slate-700 dark:text-slate-200">
                      {formatHourLabel(hourContext.hour)}
                    </strong>{' '}
                    is a relatively busy hour for {lineLabel} disruptions — {hourContext.count} of
                    the last {hourContext.total} (90d) landed around then.
                  </>
                ) : (
                  <>
                    An unusually quiet hour for {lineLabel} disruptions — only {hourContext.count}{' '}
                    of the last {hourContext.total} (90d) landed around{' '}
                    <strong className="text-slate-700 dark:text-slate-200">
                      {formatHourLabel(hourContext.hour)}
                    </strong>
                    .
                  </>
                )}
              </li>
            )}
          </ul>
        </div>
      )}

      {/* "Duration vs typical" ranks by elapsed duration; a cancelled train has
          none (its only timestamp delta is detection lag), so suppress it. */}
      {!isPointInTime && <DurationScale stats={cohortStats} />}

      <MiniTimeline incident={incident} incidents={incidents} dark={dark} />

      <div className="flex flex-wrap gap-3 mt-5 pt-4 border-t border-slate-100 dark:border-gh-border">
        <ShareLink eventId={eventId} title={description} />
        <CopySummary
          text={buildEventSummaryText({
            description: describeText(incident),
            lineLabel,
            dateText: formatDate(startTs),
            durationText: duration,
            active: !!lifecycle.active,
            url: typeof window !== 'undefined' ? `${window.location.origin}/event/${eventId}` : '',
          })}
        />
        {primaryUrl && (
          <a
            href={primaryUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-blue-500 hover:text-blue-400 hover:underline"
          >
            {isMerged ? `Via ${agency} →` : 'View post →'}
          </a>
        )}
        {sourceUrl && (
          <a
            href={sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-blue-500 hover:text-blue-400 hover:underline"
          >
            SEPTA.org →
          </a>
        )}
        {isMerged && primary?.post_url && (
          <a
            href={primary.post_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-blue-500 hover:text-blue-400 hover:underline"
          >
            {extras.length > 0 && primary.detection_source
              ? `Bot detection (${primary.detection_source}) →`
              : 'Bot detection →'}
          </a>
        )}
        {isMerged &&
          extras.map(
            (e) =>
              e.post_url && (
                <a
                  key={e.id}
                  href={e.post_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-blue-500 hover:text-blue-400 hover:underline"
                >
                  {e.detection_source
                    ? `Bot detection (${e.detection_source}) →`
                    : 'Bot detection →'}
                </a>
              ),
          )}
        {!cancel && resolvedUrl && (
          <a
            href={resolvedUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-blue-500 hover:text-blue-400 hover:underline"
          >
            Resolution post →
          </a>
        )}
        {!cancel && obsResolvedUrl && obsResolvedUrl !== resolvedUrl && (
          <a
            href={obsResolvedUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-blue-500 hover:text-blue-400 hover:underline"
          >
            Bot resolution →
          </a>
        )}
      </div>
    </article>
  );
}
