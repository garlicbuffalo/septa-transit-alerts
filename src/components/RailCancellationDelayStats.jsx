import { formatGap } from '../lib/format.js';

// Per-line Regional Rail cancellation + delay analytics, rendered on the Regional Rail line page
// from the stats computed by computeRailCancellationDelayStats. Three blocks,
// each shown only when it has data:
//   1. A stat grid (counts, per-week rates, recency).
//   2. Most-cancelled departures, grouped by originating terminal.
//   3. When cancellations happen, by part of day.
// Regional Rail delays are point events with no minutes-late magnitude, so there is no
// "typical delay length" stat (the MARTA analog has one; the feeds differ).
// Purely descriptive — counts and bars, no verdict.
export default function RailCancellationDelayStats({ stats }) {
  if (!stats || stats.total === 0) return null;
  const { windowDays, cancellations: c, delays: d } = stats;

  const cells = [];
  if (c.count > 0) {
    cells.push({ v: String(c.count), l: 'cancellations' });
    cells.push({ v: `${c.perWeek.toFixed(1)}/wk`, l: 'cancellation rate' });
    if (c.hoursSinceLast != null) {
      cells.push({ v: formatGap(c.hoursSinceLast), l: 'since last cancellation' });
    }
  }
  if (d.count > 0) {
    cells.push({ v: String(d.count), l: 'delay alerts' });
    cells.push({ v: `${d.perWeek.toFixed(1)}/wk`, l: 'delay-alert rate' });
  }

  // Bars are normalized to the busiest origin / part so the longest row fills
  // the track. Only parts that actually saw a cancellation are listed.
  const topOrigins = c.byOrigin.slice(0, 6);
  const maxOrigin = topOrigins.reduce((m, o) => (o.count > m ? o.count : m), 0);
  const activeParts = c.byPartOfDay.filter((p) => p.count > 0);
  const maxPart = activeParts.reduce((m, p) => (p.count > m ? p.count : m), 0);

  return (
    <section>
      <h2 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-3">
        Cancellations &amp; delays ({windowDays}d)
      </h2>
      <div className="space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {cells.map((cell) => (
            <div
              key={cell.l}
              className="rounded-lg border border-slate-200 dark:border-gh-border bg-white dark:bg-gh-surface px-3 py-2"
            >
              <div className="text-base font-semibold text-slate-800 dark:text-slate-100 tabular-nums leading-tight">
                {cell.v}
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-snug">
                {cell.l}
              </div>
            </div>
          ))}
        </div>

        {topOrigins.length > 0 && (
          <div className="bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border p-4">
            <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-3">
              Most-cancelled departures
            </h3>
            <div className="space-y-1.5">
              {topOrigins.map((o) => {
                const pct = maxOrigin > 0 ? (o.count / maxOrigin) * 100 : 0;
                return (
                  <div key={o.origin} className="flex items-center gap-3">
                    <div className="w-32 flex-shrink-0 text-xs text-slate-600 dark:text-slate-300 truncate">
                      {o.origin}
                    </div>
                    <div className="flex-1 h-4 rounded-sm bg-slate-100 dark:bg-gh-subtle overflow-hidden">
                      <div
                        className="h-full bg-slate-500 dark:bg-slate-400"
                        style={{ width: `${Math.max(pct, 4)}%` }}
                        role="img"
                        aria-label={`${o.origin}: ${o.count} cancellation${o.count === 1 ? '' : 's'}`}
                      />
                    </div>
                    <div className="w-8 text-right flex-shrink-0 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                      ×{o.count}
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-3 pt-3 border-t border-slate-100 dark:border-gh-border">
              Grouped by the terminal the cancelled train departs from.
            </p>
          </div>
        )}

        {activeParts.length > 0 && c.count >= 3 && (
          <div className="bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border p-4">
            <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-3">
              When cancellations happen
            </h3>
            <div className="space-y-1.5">
              {activeParts.map((p) => {
                const pct = maxPart > 0 ? (p.count / maxPart) * 100 : 0;
                return (
                  <div key={p.key} className="flex items-center gap-3">
                    <div className="w-32 flex-shrink-0 text-xs text-slate-600 dark:text-slate-300">
                      <span className="capitalize">{p.label}</span>{' '}
                      <span className="text-slate-400 dark:text-slate-500">{p.range}</span>
                    </div>
                    <div className="flex-1 h-4 rounded-sm bg-slate-100 dark:bg-gh-subtle overflow-hidden">
                      <div
                        className="h-full bg-slate-500 dark:bg-slate-400"
                        style={{ width: `${Math.max(pct, 4)}%` }}
                        role="img"
                        aria-label={`${p.label} (${p.range}): ${p.count} cancellation${p.count === 1 ? '' : 's'}`}
                      />
                    </div>
                    <div className="w-8 text-right flex-shrink-0 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                      {p.count}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
