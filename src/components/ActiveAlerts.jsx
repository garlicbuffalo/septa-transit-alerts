import { useMemo, useState } from 'react';
import { typicalDurationKey } from '../lib/aggregate.js';
import { formatBusRoute } from '../lib/busRoutes.js';
import {
  cancellationInfo,
  cancellationSchedulePhrase,
  cancellationStatusLabel,
} from '../lib/cancellation.js';
import { formatDuration, formatEstimatedEnd } from '../lib/format.js';
import {
  botSummaryText,
  formatEvidenceChip,
  incidentCategory,
  incidentHeadlineText,
  incidentLifecycle,
  isTripCancellations,
  legacyKind,
  modeLabel,
  officialAlert,
  railIncidentStatus,
  railPointEventTitle,
  splitObservations,
} from '../lib/incidents.js';
import { METRO_LINES } from '../lib/metroLines.js';
import { RAIL_LINES } from '../lib/railLines.js';
import { displayStationName } from '../lib/stations.js';
import LinePill from './LinePill.jsx';
import RailPointBadge from './RailPointBadge.jsx';
import ShareLink from './ShareLink.jsx';
import StationName from './StationName.jsx';

const BUS_COLOR = '#64748b';

// Per-incident colors for the gantt bar. Metro and Regional Rail incidents that
// touch multiple lines (e.g. B1+B2+B3 shared trackage) get one color per route so
// the bar renders as alternating bands rather than collapsing to the first
// line's color. Buses always slot into the shared slate tint — bus alerts can
// also span multiple routes, but the routes don't have per-route brand colors.
function incidentColors(incident) {
  // Brand-color palette by network. Buses (and any unknown kind) have no
  // per-route colors, so they fall back to the shared slate tint.
  const kind = legacyKind(incident);
  const palette = kind === 'metro' ? METRO_LINES : kind === 'rail' ? RAIL_LINES : null;
  if (palette && Array.isArray(incident.routes) && incident.routes.length > 0) {
    return incident.routes.map((r) => palette[r]?.color ?? BUS_COLOR);
  }
  const fallback = (Array.isArray(incident.routes) && incident.routes[0]) || incident.line;
  return [palette?.[fallback]?.color ?? BUS_COLOR];
}

// Background style for an N-color bar. One color → solid fill. Two-or-more
// → a 45° repeating gradient with stops sized in percentages (not pixels)
// so the tile period divides the gradient axis exactly. That guarantees
// each color renders with the same total area regardless of the bar's
// width — absolute-px stripes would leave one color with a partial stripe
// on the trailing end, biasing its area on bars whose width isn't an
// integer multiple of the tile period.
const STRIPE_CYCLES = 1;
function bandedBackground(colors) {
  if (colors.length === 1) return { backgroundColor: colors[0] };
  const total = colors.length * STRIPE_CYCLES;
  const stops = colors
    .map((c, i) => {
      const start = ((i / total) * 100).toFixed(4);
      const end = (((i + 1) / total) * 100).toFixed(4);
      return `${c} ${start}% ${end}%`;
    })
    .join(', ');
  return { backgroundImage: `repeating-linear-gradient(45deg, ${stops})` };
}

// Minimum visual span for the gantt — so two near-simultaneous active
// incidents don't render as a zero-width strip the moment they appear.
const GANTT_MIN_SPAN_MS = 15 * 60 * 1000;

// Snap-up ladder for the active-incidents gantt axis. The span anchors on
// the longest-running active incident, then ceiling-rounds to the next rung
// so the axis labels read as predictable round numbers ("1h ago", "6h ago")
// and don't jiggle every render as `now - earliest` ticks forward. Without
// this, a 3h47m-old alert produced a left-edge label of "3h 47m ago" that
// shifted every minute, and the longest bar always reached the literal left
// edge — making any 5-minute-old alert in the same view collapse to a dot.
const GANTT_SPAN_LADDER_MS = [
  15 * 60 * 1000, // 15m
  30 * 60 * 1000, // 30m
  60 * 60 * 1000, // 1h
  2 * 60 * 60 * 1000, // 2h
  3 * 60 * 60 * 1000, // 3h
  6 * 60 * 60 * 1000, // 6h
  12 * 60 * 60 * 1000, // 12h
];

// The ladder's top rung — the gantt axis never spans longer than this, and
// incidents older than it are dropped from the ribbon entirely (see below).
const GANTT_MAX_SPAN_MS = GANTT_SPAN_LADDER_MS[GANTT_SPAN_LADDER_MS.length - 1];

function ceilToGanttSpan(rawSpanMs) {
  for (const step of GANTT_SPAN_LADDER_MS) {
    if (rawSpanMs <= step) return step;
  }
  // Past 12h falls through — but callers filter out incidents older than
  // GANTT_MAX_SPAN_MS before computing the span, so this only guards against
  // float rounding right at the boundary. Cap at the ladder's top rung.
  return GANTT_MAX_SPAN_MS;
}

// Don't surface a median when fewer than this many past incidents back it.
// Below 5, a single outlier dominates and the hint is more noise than signal.
const TYPICAL_MIN_COUNT = 5;

// Above this count, switch from full red-bordered cards to compact one-line
// rows so a busy day doesn't push the rest of the homepage off the screen.
// The first FULL_CARD_LIMIT incidents stay full-size (most users care about
// the freshest one or two); the rest collapse to compact rows that link
// straight to /event/:id.
const FULL_CARD_LIMIT = 2;

// Caps on route pills rendered inline on a full ActiveCard before collapsing
// into a "+N". A "Temporary Reroute" can touch a dozen bus routes; without a
// cap the pills wrap into several rows and shove the headline and action
// links below the fold of the card. The cap is responsive — full route names
// are wide, so even 4 pills wrap to three rows on a phone — so mobile shows
// fewer and desktop, with more horizontal room, shows more. The card links
// to /event/:id, which lists every affected route in full.
const ACTIVE_CARD_PILL_LIMIT_MOBILE = 2;
const ACTIVE_CARD_PILL_LIMIT = 4;

// Pull the description out of an incident for both card and row variants.
// Returns a string-or-JSX `description` plus a flat `descriptionText` that
// the compact row can fall back to when stations are missing (compact rows
// are single-line, no nested links).
function describeIncident(incident, stationIndex) {
  if (officialAlert(incident)) {
    const headline = incidentHeadlineText(incident);
    return { description: headline, descriptionText: headline };
  }
  const { primary } = splitObservations(incident);
  const railTitle = railPointEventTitle(incident);
  if (railTitle) return { description: railTitle, descriptionText: railTitle };
  const hasStations = !!(primary?.from_station && primary?.to_station);

  if (hasStations) {
    return {
      description: (
        <>
          <StationName name={primary.from_station} stationIndex={stationIndex} /> →{' '}
          <StationName name={primary.to_station} stationIndex={stationIndex} />
        </>
      ),
      descriptionText: `${displayStationName(primary.from_station)} → ${displayStationName(primary.to_station)}`,
    };
  }
  if (primary?.from_station || primary?.to_station) {
    const name = primary.from_station ?? primary.to_station;
    return {
      description: <StationName name={name} stationIndex={stationIndex} />,
      descriptionText: displayStationName(name),
    };
  }
  const t = botSummaryText(incident);
  return { description: t, descriptionText: t };
}

function elapsed(now, startTs) {
  return formatDuration(now - startTs) ?? '0m';
}

// Full red-bordered card. Used for the freshest 1–2 active incidents. The
// whole card navigates to /event/:id via an absolutely-positioned link
// overlay — that pattern (rather than wrapping the card in an <a>) lets
// the inner source and Share links remain real <a>/<button> elements
// without nesting interactive content, which would be invalid HTML.
// The per-card pulsing dot has been dropped: the section header already has
// one, and stacking six of them reads as anxiety, not information.
function ActiveCard({ incident, now, isNew, typicalDurations, stationIndex, showAgency = true }) {
  const { primary } = splitObservations(incident);
  const kind = legacyKind(incident);
  const alert = officialAlert(incident);
  const lifecycle = incidentLifecycle(incident);
  const startTs = lifecycle.first_seen_ts;
  const elapsedText = elapsed(now, startTs);
  // Single-train cancellation: show the schedule, not an "ongoing" elapsed timer.
  const cancel = cancellationInfo(incident);
  const cancelPhrase = cancellationSchedulePhrase(cancel);
  const railStatus = !cancel ? railIncidentStatus(incident) : null;
  // The cohort key buckets on kind + line + signal; for a nested incident that
  // comes off the primary observation (official-only incidents have no signal key).
  const typicalKey = typicalDurationKey({
    kind,
    line: primary?.line,
    detection_source: primary?.detection_source,
  });
  const typical = typicalKey && typicalDurations ? typicalDurations.get(typicalKey) : null;
  const typicalText =
    typical && typical.count >= TYPICAL_MIN_COUNT ? formatDuration(typical.medianMs) : null;
  const estimatedEndText = formatEstimatedEnd(alert?.agency_event_window?.end_ts, now, {
    dateOnly: alert?.agency_event_window?.end_is_date_only === true,
  });
  const { description } = describeIncident(incident, stationIndex);
  const eventId = incident.id;
  const postUrl = alert ? alert.post_url : (primary?.post_url ?? null);
  // SEPTA alerts have no permalinks of their own; link the route's SEPTA.org
  // page alongside the bot's Bluesky post.
  const sourceUrl = alert?.source_url ?? null;

  const allRoutes = Array.isArray(incident.routes) ? incident.routes : [];
  // Responsive split: the first chunk shows at every width; the next chunk
  // only on sm+ (wrapped in a `hidden sm:contents` span). Two "+N" chips —
  // one per breakpoint — carry the right overflow count for each.
  const mobileRoutes = allRoutes.slice(0, ACTIVE_CARD_PILL_LIMIT_MOBILE);
  const desktopOnlyRoutes = allRoutes.slice(ACTIVE_CARD_PILL_LIMIT_MOBILE, ACTIVE_CARD_PILL_LIMIT);
  const mobileOverflow = allRoutes.length - ACTIVE_CARD_PILL_LIMIT_MOBILE;
  const desktopOverflow = allRoutes.length - ACTIVE_CARD_PILL_LIMIT;

  return (
    <div
      className={`relative bg-white dark:bg-gh-surface rounded-lg border border-red-200 dark:border-red-900 p-4 ${
        eventId ? 'hover:border-red-300 dark:hover:border-red-800 transition-colors' : ''
      } ${isNew ? 'animate-fade-highlight' : ''}`}
    >
      {/* Card-wide overlay link. Sits behind the inner content (z-0) so
          inner <a>/<button> elements (which get z-10 via .relative) keep
          working independently with middle-click, focus, etc. */}
      {eventId && (
        <a href={`/event/${eventId}`} className="absolute inset-0 z-0 rounded-lg">
          <span className="sr-only">View event details</span>
        </a>
      )}
      {/* `pointer-events-none` on the inner wrapper lets clicks fall through
          to the overlay <a> by default — so any blank pixel on the card
          navigates to /event/:id. The [&_a]:pointer-events-auto and
          [&_button]:pointer-events-auto selectors re-enable clicks on
          actual interactive children (LinePill, StationName links in the
          description, the source link, ShareLink button) so they keep
          their own destinations. Previously we set `pointer-events-auto`
          on whole wrapping rows, which made big chunks of the card
          unclickable for navigation. */}
      <div className="relative z-10 pointer-events-none [&_a]:pointer-events-auto [&_button]:pointer-events-auto">
        <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
          {showAgency && (
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
              {modeLabel(kind)}
            </span>
          )}
          <LinePill kind={kind} routes={mobileRoutes} />
          {/* Extra pills shown only on sm+ — `contents` so the <a>s flow into
              the same wrap row rather than nesting in a box. */}
          {desktopOnlyRoutes.length > 0 && (
            <span className="hidden sm:contents">
              <LinePill kind={kind} routes={desktopOnlyRoutes} />
            </span>
          )}
          {mobileOverflow > 0 && (
            <span className="sm:hidden inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-semibold bg-slate-200 dark:bg-gh-subtle text-slate-600 dark:text-slate-300">
              +{mobileOverflow}
            </span>
          )}
          {desktopOverflow > 0 && (
            <span className="hidden sm:inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-semibold bg-slate-200 dark:bg-gh-subtle text-slate-600 dark:text-slate-300">
              +{desktopOverflow}
            </span>
          )}
          {cancel ? (
            <span className="text-xs text-slate-500 dark:text-slate-400">
              <span className="font-semibold text-purple-600 dark:text-purple-400">
                {cancellationStatusLabel(cancel)}
              </span>
              {cancelPhrase && ` · ${cancelPhrase}`}
            </span>
          ) : railStatus ? (
            <>
              <RailPointBadge source={railStatus.source} />
              <span className="text-xs text-slate-500 dark:text-slate-400">
                · {elapsedText} ongoing
              </span>
            </>
          ) : (
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {elapsedText} ongoing
              {typicalText && (
                <>
                  {' · '}
                  <span
                    title={`Median over ${typical.count} past similar incidents (last 90 days)`}
                  >
                    typically {typicalText}
                  </span>
                </>
              )}
              {estimatedEndText && (
                <>
                  {' · '}
                  <span title="SEPTA posted an end time for this alert.">
                    SEPTA expects it to end {estimatedEndText}
                  </span>
                </>
              )}
            </span>
          )}
        </div>
        <p className="text-sm font-medium text-slate-800 dark:text-slate-200 leading-snug">
          {description}
        </p>
        {(() => {
          const chip = alert ? null : formatEvidenceChip(primary);
          if (!chip) return null;
          return (
            <span className="inline-flex items-center mt-1.5 px-2 py-0.5 rounded text-xs font-medium bg-slate-100 dark:bg-gh-subtle text-slate-600 dark:text-slate-300">
              {chip}
            </span>
          );
        })()}
        <div className="flex flex-wrap gap-3 mt-1.5">
          {postUrl && (
            <a
              href={postUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-blue-500 hover:text-blue-400 hover:underline"
            >
              View on Bluesky →
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
          <ShareLink eventId={eventId} />
        </div>
      </div>
    </div>
  );
}

// Cap on pills shown inside a compact row. A multi-route bus alert can
// touch a dozen routes — rendering them all blows the row up vertically and
// squeezes the description out. Show the first pill, then a "+N" chip; the
// /event/:id page lists every affected route in full.
const COMPACT_PILL_LIMIT = 1;

// Compact one-line variant. Shown for the 3rd+ active incident. Whole row
// links to /event/:id. No description-side links (they wouldn't fit), no
// typical-duration hint (signal-to-noise loss in a single line). Pills are
// capped and the description is truncated so the row stays exactly one line
// regardless of how many routes the alert touches.
// Border tint per row tone. Disruptions keep the urgent red treatment;
// delays — routine, lower-stakes "running late" events — get a calmer amber
// so a screen full of Regional Rail delays doesn't read as an emergency.
const ROW_TONE = {
  disruption: 'border-red-200 dark:border-red-900 hover:border-red-300 dark:hover:border-red-800',
  delay:
    'border-amber-200 dark:border-amber-900/60 hover:border-amber-300 dark:hover:border-amber-800',
};

function ActiveRow({ incident, now, isNew, tone = 'disruption', showAgency = false }) {
  const kind = legacyKind(incident);
  const startTs = incidentLifecycle(incident).first_seen_ts;
  const cancel = cancellationInfo(incident);
  const railStatus = !cancel ? railIncidentStatus(incident) : null;
  const elapsedText = cancel ? cancellationStatusLabel(cancel) : elapsed(now, startTs);
  const { descriptionText } = describeIncident(incident, null);
  const eventId = incident.id;

  const allRoutes = Array.isArray(incident.routes) ? incident.routes : [];
  const shownRoutes = allRoutes.slice(0, COMPACT_PILL_LIMIT);
  const overflowCount = allRoutes.length - shownRoutes.length;

  const className = `flex items-center gap-3 px-3 py-2 rounded-md border bg-white dark:bg-gh-surface text-sm transition-colors ${
    ROW_TONE[tone] ?? ROW_TONE.disruption
  } ${isNew ? 'animate-fade-highlight' : ''}`;
  const inner = (
    <>
      {/* The pill group shrinks (min-w-0) so a long route name truncates rather
          than shoving the elapsed-time chip off a phone screen. The network
          label and "+N" chip stay fixed (flex-shrink-0) — only the pill gives. */}
      <span className="flex items-center gap-1 min-w-0">
        {showAgency && (
          <span className="flex-shrink-0 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500 mr-0.5">
            {modeLabel(kind)}
          </span>
        )}
        <LinePill kind={kind} routes={shownRoutes} linked={false} />
        {overflowCount > 0 && (
          <span className="flex-shrink-0 inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-semibold bg-slate-200 dark:bg-gh-subtle text-slate-600 dark:text-slate-300">
            +{overflowCount}
          </span>
        )}
      </span>
      {/* Title is dropped on very narrow screens — the pill + elapsed time carry
          the row, and the full title lives on /event/:id. */}
      <span className="hidden min-[400px]:block flex-1 min-w-0 truncate whitespace-nowrap text-slate-700 dark:text-slate-200">
        {descriptionText}
      </span>
      <span className="ml-auto text-xs text-slate-500 dark:text-slate-400 flex-shrink-0 tabular-nums inline-flex items-center gap-1.5">
        {railStatus && <RailPointBadge source={railStatus.source} />}
        <span>{elapsedText}</span>
      </span>
    </>
  );
  if (eventId) {
    return (
      <a href={`/event/${eventId}`} className={className}>
        {inner}
      </a>
    );
  }
  return <div className={className}>{inner}</div>;
}

// Compact horizontal ribbon — one bar per active incident on a shared
// time axis. Earliest active incident anchors the left edge; right edge is
// "now". Lets a reader instantly see "this just started" vs "this has been
// running for two hours" without parsing seven separate elapsed-time chips.
// Skipped when only one incident is active (a single bar has nothing to
// compare against and the existing card already shows elapsed time).
function ActiveMiniGantt({ incidents, now }) {
  // The axis tops out at 12h (the ladder's max rung). An incident running
  // longer than that overshoots the axis — its bar's natural width exceeds
  // 100%, so it spills past the left edge and renders as a full-width slab
  // (the "~13h 5m" bars that looked broken). Drop those from the ribbon; they
  // still appear as cards/rows in the bands below. The ribbon is only for
  // comparing how long the *recent* live events have been running.
  const within = incidents.filter((i) => {
    const start = incidentLifecycle(i).first_seen_ts;
    return start != null && now - start <= GANTT_MAX_SPAN_MS;
  });
  if (within.length < 2) return null;
  const olderCount = incidents.length - within.length;

  const starts = within.map((i) => incidentLifecycle(i).first_seen_ts);
  const earliest = Math.min(...starts);
  const rawSpan = Math.max(now - earliest, GANTT_MIN_SPAN_MS);
  const span = ceilToGanttSpan(rawSpan);

  // Show three tick labels — left, midpoint, right — so the axis has
  // enough reference points to read against without crowding.
  const midLabel = formatDuration(span / 2);
  const leftLabel = formatDuration(span);

  // Oldest at top so the eye reads down the list as time progresses.
  const sorted = [...within].sort(
    (a, b) => incidentLifecycle(a).first_seen_ts - incidentLifecycle(b).first_seen_ts,
  );

  return (
    <div className="bg-white dark:bg-gh-surface rounded-lg border border-red-200 dark:border-red-900 px-3 py-2.5 mb-2">
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <p className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
          Started in last 12h
        </p>
        {olderCount > 0 && (
          <p className="text-xs text-slate-500 dark:text-slate-400 text-right">
            {olderCount} older active event{olderCount === 1 ? '' : 's'} listed below
          </p>
        )}
      </div>
      <div className="space-y-1">
        {sorted.map((incident) => {
          const kind = legacyKind(incident);
          const start = incidentLifecycle(incident).first_seen_ts;
          // Position bars against the bucketed axis: a bar's natural width
          // is its duration over the rounded span, anchored to the right edge
          // (`now`). The longest-running incident no longer pins to 0% — its
          // width is < span so its left edge sits at a small positive %, the
          // cue that the axis is rounded.
          const naturalWidthPct = ((now - start) / span) * 100;
          // Floor very-short bars so a just-started incident still renders
          // visibly. Anchor to the right edge (now) rather than the natural
          // start: a 4-minute bar grown to the 1.5% floor would otherwise
          // overshoot the chart's right edge (its natural left ≈ 99.7%, so
          // 99.7% + 1.5% = 101.2%). Aligning to `now` instead keeps every
          // bar's right edge on the same vertical line.
          const widthPct = Math.max(naturalWidthPct, 1.5);
          const leftPct = 100 - widthPct;
          const eventId = incident.id;
          const routesForLabel = Array.isArray(incident.routes) ? incident.routes : [];
          const routesLabel =
            kind === 'metro'
              ? routesForLabel.map((r) => METRO_LINES[r]?.label ?? r).join(' + ')
              : kind === 'rail'
                ? routesForLabel.map((r) => RAIL_LINES[r]?.label ?? r).join(' + ')
                : routesForLabel.map((r) => formatBusRoute(r)).join(' + ');
          const elapsedText = elapsed(now, start);
          const label = `${routesLabel}: ${elapsedText} ago`;
          // Only the colored bar is interactive — wrapping the whole track
          // would make empty time-of-day space (gray area on either side of
          // the bar) navigate to the incident, which is misleading.
          const barStyle = {
            left: `${leftPct}%`,
            width: `${widthPct}%`,
            ...bandedBackground(incidentColors(incident)),
          };
          return (
            <div key={eventId ?? start} className="flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <div
                  role="img"
                  aria-label={label}
                  className="relative h-2 rounded-full bg-slate-100 dark:bg-gh-subtle"
                >
                  {eventId ? (
                    <a
                      href={`/event/${eventId}`}
                      title={label}
                      className="absolute top-0 bottom-0 rounded-full hover:opacity-80 transition-opacity"
                      style={barStyle}
                    >
                      <span className="sr-only">{label}</span>
                    </a>
                  ) : (
                    <div
                      title={label}
                      className="absolute top-0 bottom-0 rounded-full"
                      style={barStyle}
                    />
                  )}
                </div>
              </div>
              <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums w-24 min-w-0 text-right flex-shrink-0 whitespace-nowrap overflow-hidden">
                {elapsedText}
              </span>
            </div>
          );
        })}
      </div>
      {/* Mirror the row layout (bar=flex-1, then gap-2, then w-24 elapsed
          column) so the axis labels track the bars exactly. The trailing
          spacer reserves the same width as the elapsed column, keeping
          `now` aligned with the bars' right edge. `min-w-0` on both the
          elapsed-text span and this spacer is needed because flex items
          default to `min-width: auto`, which lets `whitespace-nowrap`
          content blow past `w-24` and pull the axis out of alignment. */}
      <div className="flex items-center gap-2 mt-1.5">
        <div className="flex-1 flex justify-between text-xs text-slate-500 dark:text-slate-400 min-w-0">
          <span>{leftLabel} ago</span>
          <span>{midLabel ? `${midLabel} ago` : ''}</span>
          <span>now</span>
        </div>
        <div className="w-24 min-w-0 flex-shrink-0" aria-hidden="true" />
      </div>
    </div>
  );
}

// Floor + threshold for the burst chip. The relative ratio alone isn't
// enough — a single incident with zero baseline trivially crosses 2×, but
// "1 incident in 3h" isn't a burst. Require at least 3 in-window incidents
// before claiming anything unusual.
const BURST_RATIO_THRESHOLD = 2;
const BURST_MIN_RECENT = 3;

// Stable network order for the per-section sub-groups: SEPTA Metro, bus, then
// Regional Rail. Keeps the "Showing: All" view from reshuffling as incidents
// come and go.
const MODE_ORDER = ['metro', 'bus', 'rail'];

// Split a list into network sub-groups in MODE_ORDER, dropping empties. Lets a
// section render a "Bus" / "Regional Rail" label above each cluster so a reader
// scans by network without the page-level toggle.
function groupByMode(incidents) {
  const byMode = new Map();
  for (const inc of incidents) {
    const kind = legacyKind(inc);
    if (!byMode.has(kind)) byMode.set(kind, []);
    byMode.get(kind).push(inc);
  }
  const ordered = [];
  for (const kind of MODE_ORDER) {
    if (byMode.has(kind)) ordered.push({ kind, items: byMode.get(kind) });
  }
  // Any unknown kind falls through in insertion order after the known ones.
  for (const [kind, items] of byMode) {
    if (!MODE_ORDER.includes(kind)) ordered.push({ kind, items });
  }
  return ordered;
}

function startTsOf(inc) {
  return incidentLifecycle(inc).first_seen_ts ?? 0;
}

// Newest-first within a bucket so the freshest event reads at the top.
function byRecency(a, b) {
  return startTsOf(b) - startTsOf(a);
}

// A collapsible severity band: a toggle header (chevron + colored dot + label +
// count) over hide-able content. The dot color carries the section's tone (red
// for disruptions, amber for delays, slate for planned) so the bands stay
// distinguishable at a glance, and each collapses independently so a reader can
// fold away the parts they don't care about (e.g. a wall of routine delays).
function CollapsibleBand({ label, count, dotClass, textClass, defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 mb-1.5 -ml-0.5 px-0.5 py-0.5 rounded-md text-left hover:bg-slate-50 dark:hover:bg-gh-subtle/50 transition-colors"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 12 12"
          className={`h-3 w-3 flex-shrink-0 text-slate-400 dark:text-slate-500 transition-transform ${
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
        <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${dotClass}`} />
        <h3 className={`text-xs font-semibold uppercase tracking-wider ${textClass}`}>
          {label}
          <span className="ml-1.5 font-normal text-slate-400 dark:text-slate-500">({count})</span>
        </h3>
      </button>
      {open && children}
    </div>
  );
}

// Tiny network sub-label inside a mixed section ("Bus", "Regional Rail").
function NetworkHeader({ kind }) {
  return (
    <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500 mt-1 mb-1 px-0.5">
      {modeLabel(kind)}
    </p>
  );
}

// Routine in-progress delays — calmer amber rows, grouped by network. These are
// high-volume and low-stakes (a single train running late), so they sit below
// the red disruptions band and never get the full-card treatment.
function DelaySection({ incidents, now, highlightedIds }) {
  const groups = groupByMode(incidents);
  const labelGroups = groups.length > 1;
  return (
    <CollapsibleBand
      label={incidents.some(isTripCancellations) ? 'Delays & cancellations' : 'Delays'}
      count={incidents.length}
      dotClass="bg-amber-500"
      textClass="text-amber-700 dark:text-amber-500"
    >
      <div className="space-y-2">
        {groups.map(({ kind, items }) => (
          <div key={kind}>
            {labelGroups && <NetworkHeader kind={kind} />}
            <div className="space-y-1.5">
              {[...items].sort(byRecency).map((incident) => (
                <ActiveRow
                  key={incident.id}
                  incident={incident}
                  now={now}
                  tone="delay"
                  showAgency={!labelGroups}
                  isNew={incident.id != null && highlightedIds?.has(incident.id)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </CollapsibleBand>
  );
}

// One planned/scheduled row. The headline carries the human date range ("Sat
// Jun 13 through Sun Jun 14"); when the alert also has a machine-readable end
// we append a "through <date>" chip. No elapsed timer — for advance-notice
// work, "Day 1" is meaningless noise.
function PlannedRow({ incident, now }) {
  const kind = legacyKind(incident);
  const alert = officialAlert(incident);
  const headline =
    (alert ? incidentHeadlineText(incident) : null) ?? alert?.headline ?? 'Planned work';
  const windowEnd = formatEstimatedEnd(alert?.agency_event_window?.end_ts, now, {
    dateOnly: alert?.agency_event_window?.end_is_date_only === true,
  });
  const eventId = incident.id;
  const allRoutes = Array.isArray(incident.routes) ? incident.routes : [];
  const shownRoutes = allRoutes.slice(0, COMPACT_PILL_LIMIT);
  const overflowCount = allRoutes.length - shownRoutes.length;

  const content = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 rounded-md border border-slate-200 dark:border-gh-border bg-white dark:bg-gh-surface hover:border-slate-300 dark:hover:border-slate-600 transition-colors">
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <LinePill kind={kind} routes={shownRoutes} linked={false} />
        {overflowCount > 0 && (
          <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-semibold bg-slate-200 dark:bg-gh-subtle text-slate-600 dark:text-slate-300">
            +{overflowCount}
          </span>
        )}
        {windowEnd && (
          <span className="text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">
            through {windowEnd}
          </span>
        )}
      </div>
      <p className="flex-1 min-w-0 text-sm text-slate-700 dark:text-slate-200 truncate whitespace-nowrap">
        {headline}
      </p>
    </div>
  );
  return eventId ? <a href={`/event/${eventId}`}>{content}</a> : content;
}

// Planned & scheduled work — advance notices and multi-day reroutes, grouped
// by network. Lifted out of the live bands so a future "track construction this
// weekend" notice isn't mistimed as something ongoing right now.
function PlannedSection({ incidents, now }) {
  const groups = groupByMode(incidents);
  return (
    <CollapsibleBand
      label="Planned & scheduled"
      count={incidents.length}
      dotClass="bg-slate-400 dark:bg-slate-500"
      textClass="text-slate-500 dark:text-slate-400"
    >
      <div className="space-y-2">
        {groups.map(({ kind, items }) => (
          <div key={kind} className="space-y-1.5">
            {groups.length > 1 && <NetworkHeader kind={kind} />}
            {[...items].sort(byRecency).map((incident) => (
              <PlannedRow key={incident.id} incident={incident} now={now} />
            ))}
          </div>
        ))}
      </div>
    </CollapsibleBand>
  );
}

export default function ActiveAlerts({
  incidents,
  longRunningIncidents = [],
  now = Date.now(),
  highlightedIds,
  typicalDurations,
  stationIndex,
  burst,
  // Lane mode (the homepage's All view renders one ActiveAlerts per network
  // side-by-side, so transit and Regional Rail never interleave). The caller supplies its
  // own lane header, so we drop the page-level "Active Now" heading and the
  // cross-network mini-gantt, and render `emptyState` when the lane is quiet.
  showHeader = true,
  showGantt = true,
  emptyState = null,
}) {
  const burstActive =
    burst != null &&
    burst.recentCount >= BURST_MIN_RECENT &&
    burst.ratio != null &&
    burst.ratio >= BURST_RATIO_THRESHOLD;

  // The homepage now organizes the active set by the *nature* of each incident
  // — live disruption, routine delay, or planned/scheduled work — not by
  // elapsed time. Merge the time-split inputs the callers still pass and
  // re-bucket by category.
  const { disruptions, delays, planned } = useMemo(() => {
    const all = [...incidents, ...longRunningIncidents];
    const d = [];
    const dl = [];
    const p = [];
    for (const inc of all) {
      const c = incidentCategory(inc, now);
      if (c === 'planned') p.push(inc);
      else if (c === 'delay') dl.push(inc);
      else d.push(inc);
    }
    d.sort(byRecency);
    return { disruptions: d, delays: dl, planned: p };
  }, [incidents, longRunningIncidents, now]);

  // The "Started" ribbon compares how long live events have been running, so
  // it spans disruptions + delays only — planned work runs on a multi-day
  // scale that would crush the live bars into right-edge slivers.
  const live = useMemo(() => [...disruptions, ...delays], [disruptions, delays]);
  const totalActive = disruptions.length + delays.length + planned.length;

  // First 1-2 disruptions stay as full cards — the freshest, most-likely-to-
  // investigate events get visual weight. Beyond that we collapse to compact
  // rows so a system-wide bad afternoon doesn't push the page below the fold.
  const fullCount = Math.min(disruptions.length, FULL_CARD_LIMIT);
  const fullCards = disruptions.slice(0, fullCount);
  const compactRows = disruptions.slice(fullCount);
  const mixedAgencies = new Set(live.map((i) => legacyKind(i))).size > 1;

  // Lane mode with nothing live: render the caller's all-clear node in place of
  // an empty section, so each network lane always shows a definite answer.
  if (!showHeader && totalActive === 0) return emptyState;

  return (
    <section>
      {showHeader && (
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          <div aria-hidden="true" className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
          </div>
          <h2 className="text-sm font-semibold text-red-600 uppercase tracking-wider">
            Active Now
            <span className="ml-2 normal-case font-normal text-slate-500 dark:text-slate-400">
              ({totalActive})
            </span>
          </h2>
          {burstActive && (
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-900 normal-case tracking-normal"
              title="Recent incident rate vs. the 30-day baseline rate over the same window length."
            >
              {`${burst.recentCount} in ${burst.windowHours}h · ${burst.ratio.toFixed(1)}× typical rate`}
            </span>
          )}
        </div>
      )}
      {showGantt && <ActiveMiniGantt incidents={live} now={now} />}
      <div className="space-y-4">
        {disruptions.length > 0 && (
          <CollapsibleBand
            label="Disruptions"
            count={disruptions.length}
            dotClass="bg-red-500"
            textClass="text-red-600 dark:text-red-400"
          >
            <div className="space-y-2">
              {fullCards.map((incident) => (
                <ActiveCard
                  key={incident.id}
                  incident={incident}
                  now={now}
                  isNew={incident.id != null && highlightedIds?.has(incident.id)}
                  typicalDurations={typicalDurations}
                  stationIndex={stationIndex}
                  showAgency={mixedAgencies}
                />
              ))}
              {compactRows.length > 0 && (
                <div className="space-y-1.5">
                  {compactRows.map((incident) => (
                    <ActiveRow
                      key={incident.id}
                      incident={incident}
                      now={now}
                      tone="disruption"
                      showAgency={mixedAgencies}
                      isNew={incident.id != null && highlightedIds?.has(incident.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          </CollapsibleBand>
        )}
        {delays.length > 0 && (
          <DelaySection incidents={delays} now={now} highlightedIds={highlightedIds} />
        )}
        {planned.length > 0 && <PlannedSection incidents={planned} now={now} />}
      </div>
    </section>
  );
}
