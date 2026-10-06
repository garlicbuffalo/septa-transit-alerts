import { useMemo } from 'react';
import { formatBusRoute } from '../../lib/busRoutes.js';
import { formatPhillyDay, hexToRgba, phillyDayUTC } from '../../lib/format.js';
import { formatRoutesLabel, incidentLifecycle, legacyKind } from '../../lib/incidents.js';
import { METRO_LINES } from '../../lib/metroLines.js';
import { RAIL_LINES } from '../../lib/railLines.js';
import { incidentRoutes } from './incidentText.jsx';

const DAY_MS = 24 * 60 * 60 * 1000;
const BUS_COLOR = '#64748b'; // slate-500 — mirrors Timeline's bus row tint.

// Build a fixed-window day-by-day count of incidents on the given line/route,
// centered on the event's day. Used for the mini timeline that puts the event
// in the context of the surrounding ~2 weeks of activity on the same line.
//
// When the incident affects multiple routes, counts are kept *per route* so
// the renderer can draw one row per affected line. Collapsing into a single
// row paints "any of these routes had an incident" with one color, which
// misrepresents alerts that touch the lines unevenly (e.g. B1+B2 where
// only B1 had prior days of trouble).
function buildEventLineWindow(incident, incidents, numDays = 14, now = Date.now()) {
  const routes = incidentRoutes(incident);
  const kind = legacyKind(incident);
  const startTs = incidentLifecycle(incident).first_seen_ts;
  if (routes.length === 0 || startTs == null) return null;
  const centerDayUtc = phillyDayUTC(startTs);
  const todayUtc = phillyDayUTC(now);
  // Center the window on the event day, but never show future days past today
  // — they'd be misleading "no data" cells. If centering would clip a long-
  // ago event's window, the window slides forward to extend further past the
  // event instead.
  const halfBefore = Math.floor((numDays - 1) / 2);
  const halfAfter = numDays - 1 - halfBefore;
  const desiredEnd = centerDayUtc + halfAfter * DAY_MS;
  const endDay = Math.min(desiredEnd, todayUtc);
  const startDay = endDay - (numDays - 1) * DAY_MS;

  const dayUtcs = [];
  for (let i = 0; i < numDays; i++) dayUtcs.push(startDay + i * DAY_MS);

  // perRoute[route] = number[] aligned to dayUtcs.
  const perRoute = Object.fromEntries(routes.map((r) => [r, new Array(numDays).fill(0)]));
  const routeSet = new Set(routes);

  function bump(ts, incRoutes, incKind) {
    if (incKind !== kind) return;
    const dayUtc = phillyDayUTC(ts);
    const idx = Math.round((dayUtc - startDay) / DAY_MS);
    if (idx < 0 || idx >= numDays) return;
    for (const r of incRoutes) {
      if (routeSet.has(r)) perRoute[r][idx] += 1;
    }
  }
  for (const inc of incidents || []) {
    bump(incidentLifecycle(inc).first_seen_ts, inc.routes || [], legacyKind(inc));
  }

  return { dayUtcs, perRoute, routes, centerDayUtc };
}

// Color picker for a single route's cell. Train and Regional Rail routes get their
// brand color; bus routes share the slate tint Timeline uses for the bus row.
function routeColor(kind, route) {
  if (kind === 'metro') {
    const info = METRO_LINES[route];
    if (info) return info.color;
  } else if (kind === 'rail') {
    const info = RAIL_LINES[route];
    if (info) return info.color;
  }
  return BUS_COLOR;
}

// Compact pill label for the row gutter — just the line name, no link. The
// EventDetail card above already has linked LinePills for navigation; here
// the pill is purely a legend so the reader can match row to color.
export function RowLabel({ kind, route }) {
  // Train and Regional Rail rows get a brand-colored pill. Regional Rail shows the short route
  // code (UP-N) so it fits the narrow gutter; its full name rides on `title`.
  const info = kind === 'metro' ? METRO_LINES[route] : kind === 'rail' ? RAIL_LINES[route] : null;
  if (info) {
    return (
      <span
        className="inline-flex items-center justify-center px-2 py-0.5 rounded-full text-[10px] font-semibold whitespace-nowrap"
        style={{ backgroundColor: info.color, color: info.textColor }}
        title={kind === 'rail' ? `${info.label} Line` : info.name}
      >
        {kind === 'rail' ? info.code : info.label}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center justify-center px-2 py-0.5 rounded-full text-[10px] font-semibold whitespace-nowrap bg-slate-700 text-white">
      {kind === 'bus' ? formatBusRoute(route) : route}
    </span>
  );
}

// Cell opacity ramp for the count heatmap. Absolute (not relative to the
// window's max) so the same count always paints the same shade across events.
// Saturates at 5+ because the printed number disambiguates anything denser.
function cellOpacity(count) {
  if (count <= 0) return 0;
  if (count === 1) return 0.3;
  if (count === 2) return 0.5;
  if (count === 3) return 0.7;
  if (count === 4) return 0.85;
  return 1;
}

// Pick black/white for the count label by the cell's *perceived* luminance —
// the brand color blended over the current theme's page background at the
// cell's opacity. A fixed text color can't work: cells run from a pale tint
// (count 2) to full saturation (count 5), and dark mode inverts the blend.
function cellTextColor(hex, opacity, dark) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  // Page background per theme: #ffffff (light) / #21262d gh-canvas (dark).
  const [br, bg, bb] = dark ? [33, 38, 45] : [255, 255, 255];
  const mix = (c, base) => c * opacity + base * (1 - opacity);
  const lum = 0.299 * mix(r, br) + 0.587 * mix(g, bg) + 0.114 * mix(b, bb);
  return lum > 150 ? '#000' : '#fff';
}

// Day link, scoped to this row's line/route so the destination day page opens
// filtered to the line in question rather than the whole system. Trains use
// ?lines=<line>; buses set ?lines=none (drop trains) plus ?routes=<route>;
// Regional Rail sets ?rail=<line>. Mirrors the canonical query scheme
// parseUrlState/DayPage read.
function scopedDayHref(dateStr, kind, route) {
  const query =
    kind === 'bus'
      ? `?lines=none&routes=${encodeURIComponent(route)}`
      : kind === 'rail'
        ? `?rail=${encodeURIComponent(route)}`
        : `?lines=${encodeURIComponent(route)}`;
  return `/day/${dateStr}${query}`;
}

// One day = one square cell, shaded by incident count (darker = more) and
// stamped with the exact count when it's 2+. Single-incident and empty days
// stay unlabeled so the row reads as a heatmap with numbers only where the
// magnitude is worth spelling out.
function TimelineRow({ counts, dayUtcs, centerDayUtc, color, dark, kind, route }) {
  return (
    <div
      className="grid gap-1 flex-1 min-w-0"
      style={{ gridTemplateColumns: `repeat(${dayUtcs.length}, minmax(0, 1fr))` }}
    >
      {dayUtcs.map((dayUtc, i) => {
        const count = counts[i];
        const isPinned = dayUtc === centerDayUtc;
        const label = `${formatPhillyDay(dayUtc)}: ${count} incident${count === 1 ? '' : 's'}`;
        const opacity = cellOpacity(count);
        const cellClass = `aspect-square rounded-sm flex items-center justify-center text-[11px] font-bold leading-none ${
          isPinned ? 'ring-1 ring-slate-700 dark:ring-slate-200' : ''
        }`;
        const cellStyle = {
          backgroundColor: count > 0 ? hexToRgba(color, opacity) : 'var(--timeline-empty)',
        };
        const inner = count >= 2 && (
          <span style={{ color: cellTextColor(color, opacity, dark) }}>{count}</span>
        );
        // Days with at least one incident link to that day's page; empty days
        // stay inert squares (a /day page for them is just a "nothing
        // happened" shell, so there's nothing to drill into). dayUtc is a
        // UTC-midnight epoch, so toISOString().slice(0,10) reads back the
        // YYYY-MM-DD the /day route expects — same pattern CalendarPage and
        // the leaderboard "worst day" links use.
        if (count > 0) {
          const dateStr = new Date(dayUtc).toISOString().slice(0, 10);
          return (
            <a
              key={dayUtc}
              href={scopedDayHref(dateStr, kind, route)}
              title={`${label} — view day`}
              aria-label={`${label} — view day`}
              className={`${cellClass} cursor-pointer transition-shadow hover:ring-2 hover:ring-blue-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400`}
              style={cellStyle}
            >
              {inner}
            </a>
          );
        }
        return (
          <div key={dayUtc} title={label} className={cellClass} style={cellStyle}>
            {inner}
          </div>
        );
      })}
    </div>
  );
}

export function MiniTimeline({ incident, incidents, dark }) {
  const kind = legacyKind(incident);
  const windowData = useMemo(
    () => buildEventLineWindow(incident, incidents),
    [incident, incidents],
  );
  if (!windowData) return null;
  const { dayUtcs, perRoute, routes, centerDayUtc } = windowData;
  const multi = routes.length > 1;

  // Short month/day labels for the range endpoints. The full formatDate
  // ("Apr 24, 2026") is overkill at 14-day scale and crowds the row, but the
  // year is needed when the range straddles a year boundary so a Dec→Jan
  // window doesn't read as 2026 → 2026.
  const firstDay = dayUtcs[0];
  const lastDay = dayUtcs[dayUtcs.length - 1];
  const sameYear = new Date(firstDay).getUTCFullYear() === new Date(lastDay).getUTCFullYear();
  // dayUtc is a UTC-midnight epoch by construction (phillyDayUTC builds it
  // from Philadelphia Y/M/D), so format it as UTC to read those date components
  // back. Using timeZone='America/New_York' would shift it back 5-6 h and
  // render the previous calendar day.
  const labelFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: sameYear ? undefined : 'numeric',
  });
  const firstLabel = labelFmt.format(new Date(firstDay));
  const lastLabel = labelFmt.format(new Date(lastDay));

  return (
    <div className="mt-4 pt-4 border-t border-slate-100 dark:border-gh-border">
      <p className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-2">
        Surrounding {dayUtcs.length} days on {formatRoutesLabel(kind, routes)}
      </p>
      {multi ? (
        // Stacked rows: one per route. A fixed-width label column keeps every
        // row's grid aligned so cells stack vertically by day.
        <div className="space-y-1">
          {routes.map((route) => (
            <div key={route} className="flex items-center gap-2">
              <div className="w-12 flex-shrink-0 flex justify-end">
                <RowLabel kind={kind} route={route} />
              </div>
              <TimelineRow
                counts={perRoute[route]}
                dayUtcs={dayUtcs}
                centerDayUtc={centerDayUtc}
                color={routeColor(kind, route)}
                dark={dark}
                kind={kind}
                route={route}
              />
            </div>
          ))}
          <div className="flex">
            <div className="w-12 flex-shrink-0" />
            <div className="flex-1 flex justify-between mt-1.5 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
              <span>{firstLabel}</span>
              <span>{lastLabel}</span>
            </div>
          </div>
        </div>
      ) : (
        <>
          <TimelineRow
            counts={perRoute[routes[0]]}
            dayUtcs={dayUtcs}
            centerDayUtc={centerDayUtc}
            color={routeColor(kind, routes[0])}
            dark={dark}
            kind={kind}
            route={routes[0]}
          />
          <div className="flex justify-between mt-1.5 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
            <span>{firstLabel}</span>
            <span>{lastLabel}</span>
          </div>
        </>
      )}
    </div>
  );
}
