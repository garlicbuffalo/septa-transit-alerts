import { Fragment, useMemo, useState } from 'react';
import { buildHourOfWeek, describePeakWindow } from '../lib/aggregate.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HOURS = Array.from({ length: 24 }, (_, h) => h);

// Show every third hour as a column header so the 24-col grid stays legible
// without crowding. 0/3/6/.../21 mirrors how transit schedules pre-flag rush
// windows.
const HOUR_LABELS = [0, 3, 6, 9, 12, 15, 18, 21];

// CSS grid template: a fixed-width label column on the left + 24 equal-width
// hour columns. `minmax(0, 1fr)` lets the cells shrink past their intrinsic
// width on narrow screens while still stretching to fill on desktop.
const GRID_TEMPLATE = 'auto repeat(24, minmax(0, 1fr))';

function formatHour(h) {
  if (h === 0) return '12a';
  if (h === 12) return '12p';
  return h < 12 ? `${h}a` : `${h - 12}p`;
}

function cellBgAbsolute(count, maxCount) {
  if (count === 0) return 'var(--timeline-empty)';
  // Five intensity stops keyed off the max, so the busiest cell is fully
  // saturated and the rest scale linearly. Single-incident cells get a faint
  // tint rather than disappearing.
  const ratio = count / maxCount;
  if (ratio < 0.2) return 'rgba(100, 116, 139, 0.25)';
  if (ratio < 0.4) return 'rgba(100, 116, 139, 0.45)';
  if (ratio < 0.7) return 'rgba(100, 116, 139, 0.65)';
  if (ratio < 0.9) return 'rgba(100, 116, 139, 0.85)';
  return 'rgb(71, 85, 105)';
}

// Diverging palette for anomaly mode. Cool (blue) = quieter than typical,
// warm (red) = busier than typical. Five stops each side; z=0 is neutral
// gray so "exactly average" reads as not-interesting at a glance.
function cellBgZScore(z) {
  if (z == null) return 'var(--timeline-empty)';
  const a = Math.min(Math.abs(z), 3) / 3; // saturate at |z|=3
  if (Math.abs(z) < 0.25) return 'rgba(148, 163, 184, 0.18)';
  if (z > 0) {
    // red-ish (SEPTA brand red, dimmed)
    return `rgba(198, 12, 48, ${0.2 + a * 0.7})`;
  }
  // blue-ish
  return `rgba(0, 161, 222, ${0.2 + a * 0.7})`;
}

function computeZStats(grid) {
  const flat = [];
  for (let w = 0; w < 7; w++) {
    for (let h = 0; h < 24; h++) flat.push(grid[w][h]);
  }
  const n = flat.length;
  const mean = flat.reduce((a, b) => a + b, 0) / n;
  const variance = flat.reduce((acc, v) => acc + (v - mean) ** 2, 0) / n;
  const stddev = Math.sqrt(variance);
  return { mean, stddev };
}

// `title` controls the section heading. Pass `null` to suppress the heading
// entirely — used by /compare where one shared heading sits above three
// instances of this component.
export default function HourOfWeekHeatmap({
  alerts,
  observations,
  title = 'When do incidents happen?',
}) {
  const [mode, setMode] = useState('absolute'); // 'absolute' | 'anomaly'
  const { grid, maxCount, total } = useMemo(
    () => buildHourOfWeek(alerts, observations),
    [alerts, observations],
  );
  const zStats = useMemo(() => computeZStats(grid), [grid]);
  // Plain-language "when do they cluster" caption, derived from the same grid
  // so it never contradicts the cells. Null when there's no clear concentration
  // — and suppressed entirely in compact mode (title === null, e.g. /compare).
  const peak = useMemo(
    () => (title == null ? null : describePeakWindow(grid, total)),
    [grid, total, title],
  );

  if (total === 0) return null;

  const anomalyAvailable = zStats.stddev > 0;
  const effectiveMode = mode === 'anomaly' && anomalyAvailable ? 'anomaly' : 'absolute';

  return (
    <section>
      {title != null && (
        <div className="flex items-center justify-between mb-3 gap-2">
          <h2 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
            {title}
          </h2>
          <div className="flex items-center gap-0.5 bg-slate-100 dark:bg-gh-subtle rounded-full p-0.5">
            <button
              type="button"
              onClick={() => setMode('absolute')}
              className={`min-h-[24px] px-2.5 py-0.5 rounded-full text-[11px] font-semibold transition-colors ${
                effectiveMode === 'absolute'
                  ? 'bg-white dark:bg-gh-surface text-slate-700 dark:text-slate-100 shadow-sm'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
              }`}
              aria-pressed={effectiveMode === 'absolute'}
            >
              Absolute
            </button>
            <button
              type="button"
              onClick={() => setMode('anomaly')}
              disabled={!anomalyAvailable}
              className={`min-h-[24px] px-2.5 py-0.5 rounded-full text-[11px] font-semibold transition-colors ${
                effectiveMode === 'anomaly'
                  ? 'bg-white dark:bg-gh-surface text-slate-700 dark:text-slate-100 shadow-sm'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 disabled:opacity-40'
              }`}
              aria-pressed={effectiveMode === 'anomaly'}
              title={
                anomalyAvailable
                  ? 'Highlight hours that deviate from the grid average'
                  : 'Not enough variance yet'
              }
            >
              Anomaly
            </button>
          </div>
        </div>
      )}
      {peak && (
        <p className="text-xs text-slate-500 dark:text-slate-400 mb-3 -mt-1">
          Most incidents start on{' '}
          <span className="font-semibold text-slate-700 dark:text-slate-200">
            {peak.dayType} {peak.label}
          </span>{' '}
          ({peak.range}).
        </p>
      )}
      <div className="bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border p-4">
        <div className="grid gap-1" style={{ gridTemplateColumns: GRID_TEMPLATE }}>
          {/* Header row: empty corner cell + hour labels */}
          <div />
          {HOURS.map((h) => (
            <div key={h} className="pb-1 text-left">
              {HOUR_LABELS.includes(h) && (
                <span
                  className="text-slate-500 dark:text-slate-400 whitespace-nowrap"
                  style={{ fontSize: 10 }}
                >
                  {formatHour(h)}
                </span>
              )}
            </div>
          ))}

          {/* Day rows */}
          {DAYS.map((label, weekday) => (
            <Fragment key={label}>
              <div className="pr-2 flex items-center justify-end">
                <span
                  className="font-semibold text-slate-500 dark:text-slate-400"
                  style={{ fontSize: 11 }}
                >
                  {label}
                </span>
              </div>
              {HOURS.map((hour) => {
                const count = grid[weekday][hour];
                const z = anomalyAvailable ? (count - zStats.mean) / zStats.stddev : 0;
                const bg =
                  effectiveMode === 'anomaly' ? cellBgZScore(z) : cellBgAbsolute(count, maxCount);
                const incidentLabel = `${label} ${formatHour(hour)}: ${count} incident${
                  count === 1 ? '' : 's'
                }`;
                const tooltip =
                  effectiveMode === 'anomaly'
                    ? `${incidentLabel} (${z >= 0 ? '+' : ''}${z.toFixed(1)}σ vs. average ${zStats.mean.toFixed(1)})`
                    : incidentLabel;
                return (
                  <div
                    key={hour}
                    role="img"
                    title={tooltip}
                    aria-label={tooltip}
                    className="rounded-sm aspect-square"
                    style={{ backgroundColor: bg }}
                  />
                );
              })}
            </Fragment>
          ))}
        </div>

        {/* Legend */}
        {effectiveMode === 'absolute' ? (
          <div className="flex items-center gap-2 mt-4 pt-3 border-t border-slate-100 dark:border-gh-border">
            <span className="text-xs text-slate-500 dark:text-slate-400">Less</span>
            <div className="flex gap-0.5">
              {[0, 0.1, 0.3, 0.55, 0.8, 1].map((r) => (
                <div
                  key={r}
                  className="w-3 h-3 rounded-sm"
                  style={{
                    backgroundColor:
                      r === 0
                        ? 'var(--timeline-empty)'
                        : cellBgAbsolute(Math.ceil(r * maxCount), maxCount),
                  }}
                />
              ))}
            </div>
            <span className="text-xs text-slate-500 dark:text-slate-400">More</span>
            <span className="text-xs text-slate-300 dark:text-slate-600 ml-2">
              · Each cell = incidents starting in that hour
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-2 mt-4 pt-3 border-t border-slate-100 dark:border-gh-border">
            <span className="text-xs text-slate-500 dark:text-slate-400">Quieter</span>
            <div className="flex gap-0.5">
              {[-2.5, -1.5, -0.5, 0, 0.5, 1.5, 2.5].map((z) => (
                <div
                  key={z}
                  className="w-3 h-3 rounded-sm"
                  style={{ backgroundColor: cellBgZScore(z) }}
                />
              ))}
            </div>
            <span className="text-xs text-slate-500 dark:text-slate-400">Busier</span>
            <span className="text-xs text-slate-300 dark:text-slate-600 ml-2">
              · Cells colored by standard deviations from the grid average ({zStats.mean.toFixed(1)}
              )
            </span>
          </div>
        )}
      </div>
    </section>
  );
}
