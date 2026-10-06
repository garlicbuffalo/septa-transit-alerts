import { useEffect, useMemo, useRef } from 'react';
import {
  buildBusIncidentsByDay,
  buildIncidentsByDay,
  buildRailIncidentsByDay,
  computeLineReliability,
} from '../lib/aggregate.js';
import { busRouteName, formatBusRoute } from '../lib/busRoutes.js';
import { hexToRgba, phillyDayUTC } from '../lib/format.js';
import { METRO_LINE_ORDER, METRO_LINES, metroLineFullName } from '../lib/metroLines.js';
import { RAIL_LINE_ORDER, RAIL_LINES } from '../lib/railLines.js';

const CHICAGO_TZ = 'America/New_York';
const phillyDayMonthFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: CHICAGO_TZ,
  month: 'short',
  day: 'numeric',
});
function phillyDateLabel(ts) {
  return phillyDayMonthFmt.format(new Date(ts));
}
function phillyDateBits(ts) {
  const parts = phillyDayMonthFmt.formatToParts(new Date(ts));
  return {
    day: Number(parts.find((p) => p.type === 'day').value),
    month: parts.find((p) => p.type === 'month').value,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const BUS_COLOR = '#64748b'; // slate-500

// Cell background color based on incident count.
function cellBg(count, lineColor) {
  if (count === 0) return 'var(--timeline-empty)';
  if (count === 1) return hexToRgba(lineColor, 0.4);
  return lineColor;
}

const NO_DATA_STYLE = {
  backgroundImage:
    'repeating-linear-gradient(-45deg, var(--no-data-stripe1) 0px, var(--no-data-stripe1) 1px, var(--no-data-stripe2) 1px, var(--no-data-stripe2) 4px)',
};

function DayCell({ dayIdx, dayUTC, incidents, color, dataStartTs, inRange, isPinned, onClick }) {
  // dayUTC marks the start of this Philadelphia calendar day (as a UTC midnight).
  // Treat the day as "no data" if it ended on/before the cutoff.
  const dayEnd = dayUTC + DAY_MS;
  const noData = dataStartTs != null && dayEnd <= dataStartTs;
  const count = incidents[dayIdx] || 0;
  const dateStr = phillyDateLabel(dayUTC);
  const label = noData
    ? `${dateStr}: no data`
    : `${dateStr}: ${count} incident${count !== 1 ? 's' : ''}`;
  const dimClass = inRange || isPinned ? '' : 'opacity-30';
  // No-data cells can't usefully filter the list — keep them as inert squares.
  const clickable = !noData && onClick;
  const ringClass = isPinned ? 'ring-1 ring-slate-700 dark:ring-slate-200' : '';
  return (
    <td className="p-0 pr-0.5 pb-0.5">
      {clickable ? (
        <button
          type="button"
          title={label}
          aria-label={label}
          aria-pressed={isPinned}
          onClick={() => onClick(dayUTC)}
          className={`block w-2.5 h-2.5 rounded-sm cursor-pointer ${dimClass} ${ringClass}`}
          style={{ backgroundColor: cellBg(count, color) }}
        />
      ) : (
        <div
          title={label}
          className={`w-2.5 h-2.5 rounded-sm ${dimClass}`}
          style={noData ? NO_DATA_STYLE : { backgroundColor: cellBg(count, color) }}
        />
      )}
    </td>
  );
}

export default function Timeline({
  alerts,
  observations,
  selectedLines,
  numDays,
  selectedRangeDays,
  dataStartTs,
  // onLineClick / onBusRouteClick used to toggle filter selection; now the
  // labels are anchor links to dedicated pages. Props are still accepted for
  // backward compat with callers that pass them, but ignored here.
  onLineClick: _onLineClick,
  selectedDay = null,
  onDayClick,
  showBus,
  selectedBusRoutes,
  onBusRouteClick: _onBusRouteClick,
  now: nowProp,
}) {
  // Fall back to a fresh `Date.now()` when no `now` is supplied (e.g. test
  // renders). When the prop is provided, day-bucketing advances with the wall
  // clock so a tab open across midnight still shows the correct "today" column.
  const now = nowProp ?? Date.now();
  const scrollRef = useRef(null);

  // Scroll to the right (today) on mount and whenever numDays changes.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
    }
  }, []);

  const incidentsByDay = useMemo(
    () => buildIncidentsByDay(alerts, observations, numDays, now),
    [alerts, observations, numDays, now],
  );

  // Per-line reliability (incident-free days + current clean streak) for the
  // visible window. Scoped to train rows because bus rows are an aggregate
  // ("top 5 + Other") rather than a single route, so a per-row reliability
  // number would invite the obvious "Other = 45%" comparison and that's
  // meaningless across N≥6 routes lumped together.
  const reliabilityByLine = useMemo(() => {
    const out = {};
    for (const line of METRO_LINE_ORDER) {
      const lineAlerts = alerts.filter((a) => a.kind === 'metro' && a.routes?.includes(line));
      const lineObs = observations.filter((o) => o.kind === 'metro' && o.line === line);
      out[line] = computeLineReliability(lineAlerts, lineObs, { now, windowDays: numDays });
    }
    return out;
  }, [alerts, observations, numDays, now]);

  const busIncidentsByDay = useMemo(
    () => buildBusIncidentsByDay(alerts, observations, numDays, now),
    [alerts, observations, numDays, now],
  );

  const railIncidentsByDay = useMemo(
    () => buildRailIncidentsByDay(alerts, observations, numDays, now),
    [alerts, observations, numDays, now],
  );

  // col 0 = oldest day, col numDays-1 = today (Philadelphia calendar)
  const days = useMemo(() => {
    const todayUTC = phillyDayUTC(now);
    return Array.from({ length: numDays }, (_, col) => {
      const dayIdx = numDays - 1 - col;
      const dayUTC = todayUTC - dayIdx * DAY_MS;
      return { col, dayIdx, dayUTC, ...phillyDateBits(dayUTC) };
    });
  }, [numDays, now]);

  const linesToShow =
    selectedLines !== null && selectedLines.length > 0
      ? METRO_LINE_ORDER.filter((l) => selectedLines.includes(l))
      : selectedLines !== null && selectedLines.length === 0
        ? []
        : METRO_LINE_ORDER;

  // Bus rows: per-route when routes are selected; otherwise top-5 most-affected
  // routes + an "Other" aggregate for the long tail. The single all-routes
  // aggregate row gets so saturated it's noise, so we surface signal instead.
  const busRowsToShow = showBus
    ? selectedBusRoutes && selectedBusRoutes.length > 0
      ? selectedBusRoutes.map((r) => ({
          key: r,
          routeId: r,
          label: formatBusRoute(r),
          incidents: busIncidentsByDay.byRoute[r] || {},
        }))
      : [
          ...busIncidentsByDay.topRoutes.map((r) => ({
            key: r,
            routeId: r,
            label: formatBusRoute(r),
            incidents: busIncidentsByDay.byRoute[r] || {},
          })),
          ...(Object.keys(busIncidentsByDay.otherAggregate).length > 0
            ? [
                {
                  key: '_other',
                  routeId: null,
                  label: 'Other',
                  incidents: busIncidentsByDay.otherAggregate,
                },
              ]
            : []),
        ]
    : [];

  // Regional Rail rows: only lines that actually had activity in the window (avoids a
  // wall of 11 mostly-empty rows). Order follows RAIL_LINE_ORDER.
  const railRowsToShow = RAIL_LINE_ORDER.filter(
    (line) => Object.keys(railIncidentsByDay[line] || {}).length > 0,
  );

  const hasBusRows = busRowsToShow.length > 0;
  const hasMetroRows = linesToShow.length > 0;
  const hasRailRows = railRowsToShow.length > 0;

  return (
    <section>
      <h2 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-3">
        {numDays}-Day Timeline
      </h2>
      <div className="bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border p-4 relative">
        {/* Fade gradient on the right edge — affordance that the grid scrolls
            horizontally on narrow viewports. Inert (pointer-events: none) so
            it doesn't intercept clicks on the rightmost cells. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-0 right-0 bottom-0 w-8 rounded-r-lg bg-gradient-to-l from-white dark:from-gh-surface to-transparent sm:hidden"
        />
        <div ref={scrollRef} className="overflow-x-auto pt-1 pb-4">
          <table className="border-collapse">
            <caption className="sr-only">
              Incident timeline. Rows are Metro lines, bus routes, and Regional Rail lines; columns
              are days. Each cell links to that day's incidents.
            </caption>
            <thead>
              <tr>
                {/* Corner spacer — matches the width of line label cells */}
                <th className="sticky left-0 bg-white dark:bg-gh-surface z-10 w-12 min-w-[3rem] sm:w-16 sm:min-w-[4rem]" />
                {/* Month label: only render text on the 1st of each month */}
                {days.map(({ col, day, month }) => (
                  <th
                    key={col}
                    scope="col"
                    className="p-0 pr-0.5 pb-1 align-bottom text-left"
                    style={{ width: 12 }}
                  >
                    {day === 1 && (
                      <span
                        className="text-slate-500 dark:text-slate-400 whitespace-nowrap"
                        style={{ fontSize: 10 }}
                      >
                        {month}
                      </span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {/* Metro rows */}
              {linesToShow.map((lineKey) => {
                const info = METRO_LINES[lineKey];
                const incidents = incidentsByDay[lineKey] || {};
                const rel = reliabilityByLine[lineKey];
                const pctClean =
                  rel && rel.totalDays > 0
                    ? Math.round((rel.incidentFreeDays / rel.totalDays) * 100)
                    : null;
                const streak = rel?.currentStreakDays ?? 0;
                const relLabel =
                  pctClean != null
                    ? `${pctClean}% clean · current streak ${streak} day${streak === 1 ? '' : 's'} (${numDays}d window)`
                    : null;
                return (
                  <tr key={lineKey}>
                    <td className="sticky left-0 bg-white dark:bg-gh-surface z-10 pr-2 sm:pr-3 align-middle min-w-[3rem] sm:min-w-[4rem]">
                      {/* Anchor (not button) so the label is a real link —
                          middle-click opens in a new tab, link previews
                          work, and the URL is the dedicated /line/:id
                          page. The filter chips above remain for
                          narrowing the existing view. */}
                      <a
                        href={`/line/${lineKey}`}
                        title={relLabel ?? `Open ${metroLineFullName(lineKey)} page`}
                        className="text-xs font-semibold w-full text-right hover:opacity-70 transition-opacity inline-block leading-tight"
                        style={{ color: info.color }}
                      >
                        <span className="block">{info.label}</span>
                        {pctClean != null && (
                          <span
                            className="block font-normal text-slate-500 dark:text-slate-400 tabular-nums"
                            style={{ fontSize: 9 }}
                          >
                            {pctClean}% · {streak}d
                          </span>
                        )}
                      </a>
                    </td>
                    {days.map(({ col, dayIdx, dayUTC }) => (
                      <DayCell
                        key={col}
                        dayIdx={dayIdx}
                        dayUTC={dayUTC}
                        incidents={incidents}
                        color={info.color}
                        dataStartTs={dataStartTs}
                        inRange={selectedRangeDays == null || dayIdx < selectedRangeDays}
                        isPinned={selectedDay === dayUTC}
                        onClick={onDayClick}
                      />
                    ))}
                  </tr>
                );
              })}

              {/* Thin separator between trains and bus */}
              {hasMetroRows && hasBusRows && (
                <tr>
                  <td colSpan={numDays + 1} className="py-1" />
                </tr>
              )}

              {/* Bus rows */}
              {busRowsToShow.map(({ key, routeId, label, incidents }) => {
                const routeName = routeId ? busRouteName(routeId) : null;
                const tooltip = routeName ? `${label} ${routeName}` : label;
                const ariaLabel = routeName ? `Route ${routeId} ${routeName}` : label;
                return (
                  <tr key={key}>
                    <td className="sticky left-0 bg-white dark:bg-gh-surface z-10 pr-2 sm:pr-3 align-middle min-w-[3rem] sm:min-w-[4rem]">
                      {routeId ? (
                        // Anchor to the dedicated route page. The aggregate
                        // 'Other' row has no routeId and stays inert.
                        <a
                          href={`/route/${routeId}`}
                          title={tooltip}
                          aria-label={ariaLabel}
                          className="text-xs font-semibold w-full text-right hover:opacity-70 transition-opacity inline-block"
                          style={{ color: BUS_COLOR }}
                        >
                          {label}
                        </a>
                      ) : (
                        <span
                          className="text-xs font-semibold w-full block text-right"
                          style={{ color: BUS_COLOR }}
                        >
                          {label}
                        </span>
                      )}
                    </td>
                    {days.map(({ col, dayIdx, dayUTC }) => (
                      <DayCell
                        key={col}
                        dayIdx={dayIdx}
                        dayUTC={dayUTC}
                        incidents={incidents}
                        color={BUS_COLOR}
                        dataStartTs={dataStartTs}
                        inRange={selectedRangeDays == null || dayIdx < selectedRangeDays}
                        isPinned={selectedDay === dayUTC}
                        onClick={onDayClick}
                      />
                    ))}
                  </tr>
                );
              })}

              {/* Separator before the Regional Rail block */}
              {(hasMetroRows || hasBusRows) && hasRailRows && (
                <tr>
                  <td colSpan={numDays + 1} className="py-1" />
                </tr>
              )}

              {/* Regional Rail rows — one per line with activity in the window */}
              {railRowsToShow.map((lineKey) => {
                const info = RAIL_LINES[lineKey];
                const incidents = railIncidentsByDay[lineKey] || {};
                return (
                  <tr key={`rail-${lineKey}`}>
                    <td className="sticky left-0 bg-white dark:bg-gh-surface z-10 pr-2 sm:pr-3 align-middle min-w-[3rem] sm:min-w-[4rem]">
                      <a
                        href={`/rail/line/${lineKey}`}
                        title={`Open ${info.label} page`}
                        className="text-xs font-semibold w-full text-right hover:opacity-70 transition-opacity inline-block leading-tight"
                        style={{ color: info.color }}
                      >
                        {lineKey.toUpperCase()}
                      </a>
                    </td>
                    {days.map(({ col, dayIdx, dayUTC }) => (
                      <DayCell
                        key={col}
                        dayIdx={dayIdx}
                        dayUTC={dayUTC}
                        incidents={incidents}
                        color={info.color}
                        dataStartTs={dataStartTs}
                        inRange={selectedRangeDays == null || dayIdx < selectedRangeDays}
                        isPinned={selectedDay === dayUTC}
                        onClick={onDayClick}
                      />
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Legend */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 pt-3 border-t border-slate-100 dark:border-gh-border">
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500 dark:text-slate-400">Less</span>
            <div className="flex gap-0.5">
              <div
                className="w-2.5 h-2.5 rounded-sm"
                style={{ backgroundColor: 'var(--timeline-empty)' }}
              />
              <div
                className="w-2.5 h-2.5 rounded-sm"
                style={{ backgroundColor: hexToRgba('#64748b', 0.4) }}
              />
              <div className="w-2.5 h-2.5 rounded-sm bg-slate-500" />
            </div>
            <span className="text-xs text-slate-500 dark:text-slate-400">More</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={NO_DATA_STYLE} />
            <span className="text-xs text-slate-500 dark:text-slate-400">No data</span>
          </div>
          <span className="text-xs text-slate-300 dark:text-slate-600">
            · Click a day to filter · Under each line: % of days with no incident · current clean
            streak
          </span>
        </div>
      </div>
    </section>
  );
}
