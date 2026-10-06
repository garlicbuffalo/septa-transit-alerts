import { useMemo } from 'react';
import { collectUpcomingCancellations } from '../lib/cancellation.js';
import { formatTime } from '../lib/format.js';
import { RAIL_LINES } from '../lib/railLines.js';

// Forward-looking strip of Regional Rail trains announced as cancelled but not yet past
// their scheduled departure — the capability the schedule-anchored cancellation
// lifecycle adds that the retrospective bot detector can't (it only sees a train
// didn't run after the fact). Shown on the Regional Rail line page (one line) and system-
// health page (all lines, with a line pill). Renders nothing when none are upcoming.
//
// `incidents` are nested incidents; `showLine` adds a per-row line pill (system
// page, where rows span lines). Reads incident.cancellation via the shared helper.
export default function RailUpcomingCancellations({ incidents, now, showLine = false }) {
  const items = useMemo(() => collectUpcomingCancellations(incidents, { now }), [incidents, now]);
  if (items.length === 0) return null;

  return (
    <section className="rounded-lg border border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-500/10 p-4">
      <h2 className="flex items-center gap-1.5 text-sm font-semibold text-amber-700 dark:text-amber-300 mb-2">
        <span aria-hidden="true">⚠️</span>
        {items.length} upcoming cancellation{items.length === 1 ? '' : 's'}
      </h2>
      <p className="text-xs text-amber-700/80 dark:text-amber-300/80 mb-3">
        Trains SEPTA has marked cancelled that haven't reached their scheduled departure yet.
      </p>
      <ul className="space-y-1">
        {items.map((it) => {
          const info = it.line ? RAIL_LINES[it.line] : null;
          return (
            <li key={it.id}>
              <a
                href={`/event/${it.id}`}
                className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm text-slate-700 dark:text-slate-200 hover:underline"
              >
                {showLine && info && (
                  <span
                    className="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-bold flex-shrink-0"
                    style={{ backgroundColor: info.color, color: info.textColor }}
                  >
                    {String(it.line).toUpperCase()}
                  </span>
                )}
                <span className="font-medium">
                  {it.trainNumber ? `Train #${it.trainNumber}` : 'Train'}
                </span>
                <span className="text-slate-500 dark:text-slate-400">
                  {formatTime(it.departureTs)} departure
                  {it.origin ? ` · ${it.origin}` : ''}
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
