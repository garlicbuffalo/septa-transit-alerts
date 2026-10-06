import { useState } from 'react';
import { formatBusRoute } from '../lib/busRoutes.js';
import { formatDuration, formatEstimatedEnd } from '../lib/format.js';
import {
  incidentHeadlineText,
  incidentLifecycle,
  legacyKind,
  officialAlert,
  splitObservations,
} from '../lib/incidents.js';
import { METRO_LINES } from '../lib/metroLines.js';
import { RAIL_LINES } from '../lib/railLines.js';
import { displayStationName } from '../lib/stations.js';
import LinePill from './LinePill.jsx';

const DAY_MS = 24 * 60 * 60 * 1000;

// Threshold above which an active incident gets lifted out of the regular
// ActiveAlerts stack. 12h is the point where a disruption stops being "what
// just happened" and starts being "the state of this line for a while now"
// — usually a planned reroute, weekend slow zone, or multi-day construction.
export const LONG_RUNNING_THRESHOLD_MS = 12 * 60 * 60 * 1000;

// Cap on how many route pills render inline before collapsing into a "+N".
// A SEPTA "Temporary Reroute" alert can touch a dozen bus routes; rendering
// all of them blows the row vertically and pushes the headline off-screen.
// Mirrors the same cap used by ActiveRow in ActiveAlerts.jsx.
const COMPACT_PILL_LIMIT = 1;

// Cap on how many unique route pills appear in the collapsed header peek
// before collapsing into a "+N". The header is a single quiet line; a busy
// multi-day stretch can have a dozen affected routes, and showing them all
// would defeat the point of collapsing the section in the first place.
const HEADER_PILL_LIMIT = 4;

// Non-interactive colored pill for the collapsed header summary. We can't
// reuse LinePill here: it renders <a> links, and the header is a <button>
// toggle — nesting links inside a button is invalid HTML and would also
// fight the expand/collapse click. These are pure visual indicators of
// which lines/routes are stuck; the expanded Day-N rows carry the real
// links. Both variants stay numeric/short — train pills drop the " Line"
// suffix and bus pills show just `#<route>` (not the full route name) — so
// a multi-route stretch still fits on the one quiet header line. The
// expanded Day-N rows carry the full LinePill labels.
function SummaryPill({ kind, routeKey }) {
  const info =
    kind === 'metro' ? METRO_LINES[routeKey] : kind === 'rail' ? RAIL_LINES[routeKey] : null;
  if (info) {
    return (
      <span
        className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold"
        style={{ backgroundColor: info.color, color: info.textColor }}
      >
        {info.label}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-slate-700 text-white">
      {kind === 'bus' ? formatBusRoute(routeKey) : routeKey}
    </span>
  );
}

// Collect the unique kind+route pairs across the long-running set, in
// first-seen order, for the collapsed header's at-a-glance peek. A single
// incident can touch several routes, and several incidents can share a
// route, so we dedupe on `${kind}:${key}`.
function summarizeRoutes(incidents) {
  const seen = new Set();
  const out = [];
  for (const incident of incidents) {
    const routes = Array.isArray(incident.routes) ? incident.routes : [];
    const kind = legacyKind(incident);
    for (const key of routes) {
      const id = `${kind}:${key}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ kind, routeKey: key });
    }
  }
  return out;
}

// Compact row list for active incidents older than the threshold. Lives
// inside the "Active Now" section (under a sub-label) so users see all
// active state in one place, but visually quieter than the red ActiveCards
// — these are structural conditions, not breaking news, and the
// pulsing-red treatment trained on them stops feeling actionable. The
// "Day N" framing makes the duration the headline number.
//
// Collapsed by default: these are slow-moving structural conditions, so the
// section opens as a single quiet header line (count + a peek at which
// lines/routes are affected) and expands on click to the full Day-N rows.
// State intentionally isn't persisted — the section re-collapses on every
// load so it stays out of the way unless the reader asks for it.
export default function LongRunningBanner({ incidents, now = Date.now() }) {
  const [open, setOpen] = useState(false);
  if (!incidents || incidents.length === 0) return null;

  const routeSummary = summarizeRoutes(incidents);
  const shownPills = routeSummary.slice(0, HEADER_PILL_LIMIT);
  const pillOverflow = routeSummary.length - shownPills.length;

  return (
    <div className="pt-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-1 py-1 rounded-md text-left hover:bg-slate-50 dark:hover:bg-gh-subtle/50 transition-colors"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 12 12"
          className={`h-3 w-3 flex-shrink-0 text-slate-500 dark:text-slate-400 transition-transform ${
            open ? 'rotate-90' : ''
          }`}
        >
          <path
            d="M4 2.5 L8 6 L4 9.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 flex-shrink-0">
          Long-running ({incidents.length})
        </span>
        {!open && shownPills.length > 0 && (
          <span className="flex flex-wrap items-center gap-1 min-w-0">
            {shownPills.map(({ kind, routeKey }) => (
              <SummaryPill key={`${kind}:${routeKey}`} kind={kind} routeKey={routeKey} />
            ))}
            {pillOverflow > 0 && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-semibold bg-slate-200 dark:bg-gh-subtle text-slate-600 dark:text-slate-300">
                +{pillOverflow}
              </span>
            )}
          </span>
        )}
      </button>
      {open && (
        <div className="space-y-1.5">
          {/* Full affected-route roster, uncapped. The collapsed peek caps
              pills at HEADER_PILL_LIMIT to stay on one quiet line; once the
              section is open there's room to show every line/route at a
              glance, so a reader can see the full footprint without opening
              each incident (whose own pills are still capped at one). */}
          {routeSummary.length > HEADER_PILL_LIMIT && (
            <div className="flex flex-wrap items-center gap-1 px-1 pt-1">
              <span className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 mr-1">
                All routes
              </span>
              {routeSummary.map(({ kind, routeKey }) => (
                <SummaryPill key={`${kind}:${routeKey}`} kind={kind} routeKey={routeKey} />
              ))}
            </div>
          )}
          {incidents.map((incident) => {
            const { primary } = splitObservations(incident);
            const kind = legacyKind(incident);
            const alert = officialAlert(incident);
            const startTs = incidentLifecycle(incident).first_seen_ts;
            const elapsed = now - startTs;
            const dayN = Math.floor(elapsed / DAY_MS) + 1;
            const duration = formatDuration(elapsed) ?? '';
            const eventId = incident.id;
            const headline =
              (alert ? incidentHeadlineText(incident) : null) ??
              (primary?.from_station && primary?.to_station
                ? `${displayStationName(primary.from_station)} → ${displayStationName(primary.to_station)}`
                : 'Ongoing disruption');
            const allRoutes = Array.isArray(incident.routes) ? incident.routes : [];
            const shownRoutes = allRoutes.slice(0, COMPACT_PILL_LIMIT);
            const overflowCount = allRoutes.length - shownRoutes.length;
            const estimatedEndText = formatEstimatedEnd(alert?.agency_event_window?.end_ts, now, {
              dateOnly: alert?.agency_event_window?.end_is_date_only === true,
            });
            const content = (
              // biome-ignore lint/correctness/useJsxKeyInIterable: returned wrapper (<a> / <div>) carries the key for each iteration
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 mt-2 rounded-md border border-slate-200 dark:border-gh-border bg-white dark:bg-gh-surface hover:border-slate-300 dark:hover:border-slate-600 transition-colors">
                {/* Meta cluster wraps internally on narrow screens so the
                  SEPTA posted-end chip doesn't push the row off-screen.
                  Headline sits in its own flex item with flex-1 so it
                  drops to a second visual line on small viewports. */}
                <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                  <LinePill kind={kind} routes={shownRoutes} />
                  {overflowCount > 0 && (
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-semibold bg-slate-200 dark:bg-gh-subtle text-slate-600 dark:text-slate-300">
                      +{overflowCount}
                    </span>
                  )}
                  <span className="text-xs font-semibold text-slate-600 dark:text-slate-300 whitespace-nowrap">
                    Day {dayN}
                  </span>
                  <span
                    className="text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap"
                    title={`Started ${duration} ago`}
                  >
                    · {duration}
                  </span>
                  {estimatedEndText && (
                    <span
                      className="text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap"
                      title="SEPTA posted an end time for this alert."
                    >
                      · SEPTA expects it to end {estimatedEndText}
                    </span>
                  )}
                </div>
                <p className="flex-1 min-w-0 text-sm text-slate-700 dark:text-slate-200 truncate whitespace-nowrap">
                  {headline}
                </p>
              </div>
            );
            return eventId ? (
              <a key={incident.id} href={`/event/${eventId}`}>
                {content}
              </a>
            ) : (
              <div key={incident.id}>{content}</div>
            );
          })}
        </div>
      )}
    </div>
  );
}
