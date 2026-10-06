import { useMemo, useState } from 'react';
import { cancellationInfo, cancellationStatusLabel } from '../../lib/cancellation.js';
import { formatDate, formatTime } from '../../lib/format.js';
import {
  agencyLabel,
  findContemporaneousOnOtherLines,
  findRelatedIncidents,
  formatRoutesLabel,
  incidentDetections,
  incidentLifecycle,
  isPlannedIncident,
  legacyKind,
  modeLabel,
  officialAlert,
  railIncidentStatus,
} from '../../lib/incidents.js';
import LinePill from '../LinePill.jsx';
import RailPointBadge from '../RailPointBadge.jsx';
import { describe, incidentRoutes } from './incidentText.jsx';

// Contemporaneous activity on OTHER lines/routes within ±1h of this event.
// Shared row layout for the "Surrounding 24h" and "Elsewhere on system"
// sections. Both render the same skeleton — date column, metadata chips,
// description, Details link — and both need the whole card to be a link to
// the row's event page. Uses the stretched-link pattern from IncidentList:
// an absolute-positioned overlay anchor sits behind the content; real
// interactive children (StationName, Details) re-enable pointer events so
// they keep their own destinations. Keeping `showLinePill` out of
// RelatedIncidents preserves the existing convention there (the section
// header already names the line, so a pill on every row would be noise).
function ContextRow({ other, stationIndex, showLinePill }) {
  const kind = legacyKind(other);
  const lifecycle = incidentLifecycle(other);
  const ts = lifecycle.first_seen_ts;
  const otherHasObs = incidentDetections(other).length > 0;
  const otherIsMerged = !!officialAlert(other) && otherHasObs;
  const otherIsAlert = !!officialAlert(other) && !otherHasObs;
  const detailsId = other.id;
  // Regional Rail delay/cancellation status badge, whether it came from an official
  // alert classification or an auto-detected point event.
  // Schedule-anchored single-train Regional Rail cancellation (from a Regional Rail alert) →
  // the same 'cancelled' / 'upcoming cancellation' badge the incident list and
  // event page show.
  const cancel = cancellationInfo(other);
  const railStatus = !cancel ? railIncidentStatus(other) : null;
  // Planned/advance-notice work isn't "ongoing" — the disruption may not have
  // started. Suppress the red "ongoing" marker for it (the Regional Rail status badge
  // already reads "planned work"; non-Regional Rail planned rows show no marker).
  const planned = isPlannedIncident(other);
  return (
    <div className="relative flex items-start gap-3 px-4 py-3 hover:bg-slate-50 dark:hover:bg-gh-subtle/40 transition-colors">
      {detailsId && (
        <a href={`/event/${detailsId}`} className="absolute inset-0 rounded">
          <span className="sr-only">View event details</span>
        </a>
      )}
      <div className="relative flex items-start gap-3 flex-1 min-w-0 pointer-events-none [&_a]:pointer-events-auto [&_button]:pointer-events-auto">
        <div className="flex-shrink-0 w-20 text-right">
          <p className="text-xs text-slate-500 dark:text-slate-400">{formatDate(ts)}</p>
          <p className="text-xs text-slate-500 dark:text-slate-400">{formatTime(ts)}</p>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-1.5 mb-1">
            {showLinePill && <LinePill kind={kind} routes={other.routes} />}
            {otherIsMerged && (
              <span className="text-xs text-slate-500 dark:text-slate-400 italic">
                via {agencyLabel(kind)} + auto-detection
              </span>
            )}
            {!otherIsMerged && otherIsAlert && (
              <span className="text-xs text-slate-500 dark:text-slate-400 italic">
                via {agencyLabel(kind)}
              </span>
            )}
            {!otherIsMerged && !otherIsAlert && (
              <span className="text-xs text-slate-500 dark:text-slate-400 italic">
                via auto-detection
              </span>
            )}
            {railStatus && <RailPointBadge source={railStatus.source} />}
            {cancel && (
              <span
                className={`text-xs font-semibold ${
                  cancel.isUpcoming
                    ? 'text-amber-600 dark:text-amber-400'
                    : 'text-slate-500 dark:text-slate-400'
                }`}
              >
                {cancellationStatusLabel(cancel)}
              </span>
            )}
            {lifecycle.active && !planned && (
              <span className="text-xs font-semibold text-red-500">ongoing</span>
            )}
          </div>
          <p className="text-sm text-slate-700 dark:text-slate-200 leading-snug">
            {describe(other, stationIndex)}
          </p>
          {/* No explicit "Details →" link — the whole row is already a stretched
              link to /event/:id (the overlay anchor above), so a second link to
              the same place was redundant chrome on every row. */}
        </div>
      </div>
    </div>
  );
}

function rowKey(other) {
  return other.id;
}

// Surrounding/cross-line lists can run long on a busy line (a Regional Rail trunk can
// surface ~20 same-line incidents in a 24h window). Cap the visible rows so the
// event page doesn't end in a wall, with a "Show all N" toggle to expand. The
// cap is generous enough that quiet incidents show every row without a toggle.
const CONTEXT_ROW_LIMIT = 6;

function ContextList({ rows, stationIndex, showLinePill }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? rows : rows.slice(0, CONTEXT_ROW_LIMIT);
  const hiddenCount = rows.length - CONTEXT_ROW_LIMIT;
  return (
    <div className="bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border divide-y divide-slate-100 dark:divide-gh-border overflow-hidden">
      {visible.map((other) => (
        <ContextRow
          key={rowKey(other)}
          other={other}
          stationIndex={stationIndex}
          showLinePill={showLinePill}
        />
      ))}
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          className="w-full px-4 py-2.5 text-center text-xs font-medium text-blue-500 hover:text-blue-400 hover:bg-slate-50 dark:hover:bg-gh-subtle/40 transition-colors"
        >
          {expanded ? 'Show fewer' : `Show all ${rows.length}`}
        </button>
      )}
    </div>
  );
}

// Companion to RelatedIncidents (which stays scoped to the same line) so a
// reader can tell at a glance whether this disruption sat alongside others
// across the system — a strong hint of a shared root cause (weather, power,
// big-event letout) vs. an isolated incident.
//
// Renders nothing when the time-adjacent window is empty. The window is
// tighter than RelatedIncidents (1h vs 24h) on purpose: cross-line
// causation is meaningful at hour-scale, not day-scale; widening it would
// dilute the signal into "things that happened today".
export function CrossLineContext({ incident, incidents, stationIndex }) {
  const others = useMemo(
    () => findContemporaneousOnOtherLines(incident, incidents),
    [incident, incidents],
  );
  if (others.length === 0) return null;
  return (
    <section className="mt-4">
      <h2 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-3">
        Elsewhere on the system (±1h)
      </h2>
      <ContextList rows={others} stationIndex={stationIndex} showLinePill={true} />
    </section>
  );
}

export function RelatedIncidents({ incident, incidents, stationIndex }) {
  const related = useMemo(() => findRelatedIncidents(incident, incidents), [incident, incidents]);
  if (related.length === 0) return null;
  // Routes the parent event affects — used to label the section without
  // re-deriving from each row (all rows share at least one of these).
  const kind = legacyKind(incident);
  const routes = incidentRoutes(incident);
  // A single-line parent names its line in the header, so per-row pills would be
  // noise. A multi-line parent (e.g. a system-wide Regional Rail construction notice on
  // 7 lines) can't name one line — "Surrounding 24 hours on 7 Regional Rail lines" is
  // both clumsy and drops which line each row is actually on. So for those we
  // generalize the header to the mode and turn the per-row pills on.
  const multiLine = routes.length > 1;
  const heading = !multiLine
    ? `Surrounding 24 hours on ${formatRoutesLabel(kind, routes)}`
    : kind === 'bus'
      ? 'Surrounding 24 hours on affected bus routes'
      : `Surrounding 24 hours on affected ${modeLabel(kind)} lines`;
  return (
    <section className="mt-4">
      <h2 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-3">
        {heading}
      </h2>
      <ContextList rows={related} stationIndex={stationIndex} showLinePill={multiLine} />
    </section>
  );
}
