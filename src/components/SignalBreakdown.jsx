import { useMemo } from 'react';
import { buildSignalsByLine } from '../lib/aggregate.js';
import { observationSignals, SIGNAL_LABELS, SIGNAL_TYPES } from '../lib/incidents.js';
import { METRO_LINE_ORDER, METRO_LINES, metroLineFullName } from '../lib/metroLines.js';
import { normalizeRailLine, RAIL_LINE_ORDER, RAIL_LINES } from '../lib/railLines.js';

// Distinct, accessible colors for each signal category. Tied to the
// disruption "feel" — gap/ghost (absence) sit cool, bunching (excess) sits
// warm, pulse subtypes sit muted to read as a related family.
const SIGNAL_COLORS = {
  gap: '#0ea5e9', // sky-500
  bunching: '#f97316', // orange-500
  ghost: '#6366f1', // indigo-500
  'pulse-cold': '#94a3b8', // slate-400
  'pulse-held': '#64748b', // slate-500
  'thin-gap': '#8b5cf6', // violet-500 — most extreme absence (whole route silent)
};

// Regional Rail's signal vocabulary is cancellations + delays, not SEPTA gap/ghost
// set. Matches the colors used on the Compare page's Regional Rail signal mix.
const RAIL_SIGNAL_TYPES = ['cancellation', 'cancellation-inferred', 'delay'];
const RAIL_SIGNAL_COLORS = {
  cancellation: '#dc2626', // red-600 — confirmed cancellation
  'cancellation-inferred': '#fb923c', // orange-400 — inferred (hedged)
  delay: '#eab308', // yellow-500 — running late
};

// `counts` may be undefined: buildRailSignalsByLine only creates a key for
// lines that actually had observations, so probing a quiet line yields
// nothing. (buildSignalsByLine pre-seeds every train line, hence train rows
// never hit this.)
function lineTotal(counts, types = SIGNAL_TYPES) {
  if (!counts) return 0;
  return types.reduce((sum, sig) => sum + (counts[sig] || 0), 0);
}

// One stacked-bar row in the signal-mix chart. Reused by the all-trains
// homepage chart and the single-route bus pages — same visual, scoped data.
function SignalBar({
  labelText,
  labelColor,
  counts,
  total,
  ariaPrefix,
  types = SIGNAL_TYPES,
  colors = SIGNAL_COLORS,
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-12 flex-shrink-0 text-right">
        <span className="text-xs font-semibold" style={{ color: labelColor }}>
          {labelText}
        </span>
      </div>
      <div
        className="flex-1 flex h-4 rounded-sm overflow-hidden bg-slate-100 dark:bg-gh-subtle"
        role="img"
        aria-label={`${ariaPrefix}: ${types
          .map((s) => `${counts[s] || 0} ${SIGNAL_LABELS[s]}`)
          .filter((part) => !part.startsWith('0 '))
          .join(', ')}`}
      >
        {types.map((sig) => {
          const c = counts[sig] || 0;
          if (c === 0) return null;
          const pct = (c / total) * 100;
          return (
            <div
              key={sig}
              title={`${SIGNAL_LABELS[sig]}: ${c} (${Math.round(pct)}%)`}
              style={{ width: `${pct}%`, backgroundColor: colors[sig] }}
            />
          );
        })}
      </div>
      <div className="w-10 text-right flex-shrink-0">
        <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">{total}</span>
      </div>
    </div>
  );
}

function SignalLegend({ types = SIGNAL_TYPES, colors = SIGNAL_COLORS }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-4 pt-3 border-t border-slate-100 dark:border-gh-border">
      {types.map((sig) => (
        <div key={sig} className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: colors[sig] }} />
          <span className="text-xs text-slate-500 dark:text-slate-400">{SIGNAL_LABELS[sig]}</span>
        </div>
      ))}
    </div>
  );
}

// Tally Regional Rail cancellation/delay observations per line → { lineKey: { src: n } }.
function buildRailSignalsByLine(observations) {
  const byLine = {};
  for (const o of observations || []) {
    if (o.kind !== 'rail' || !o.line) continue;
    const src = o.detection_source;
    if (!RAIL_SIGNAL_TYPES.includes(src)) continue;
    const key = normalizeRailLine(o.line);
    if (!byLine[key]) byLine[key] = {};
    byLine[key][src] = (byLine[key][src] || 0) + 1;
  }
  return byLine;
}

// Build a flat `{ signalKey: count }` tally for an arbitrary observation
// list. Mirrors the per-line bookkeeping in `buildSignalsByLine` but for
// one arbitrary cohort — used by the single-row bus-route variant below.
function tallySignals(observations) {
  const counts = {};
  for (const sig of SIGNAL_TYPES) counts[sig] = 0;
  for (const o of observations || []) {
    for (const sig of observationSignals(o)) {
      if (sig in counts) counts[sig] += 1;
    }
  }
  return counts;
}

// The default homepage variant: one row per train line, hidden when no
// signals fired anywhere in the dataset. Bus routes are excluded because
// there are too many to chart usefully at the system level — single bus
// routes get the dedicated `<SignalBreakdown.SingleRoute>` variant below.
export default function SignalBreakdown({ observations }) {
  const { byLine, totals } = useMemo(() => buildSignalsByLine(observations), [observations]);
  const railByLine = useMemo(() => buildRailSignalsByLine(observations), [observations]);

  const linesWithData = METRO_LINE_ORDER.filter((line) => lineTotal(byLine[line]) > 0);
  const grandTotal = SIGNAL_TYPES.reduce((s, sig) => s + (totals[sig] || 0), 0);

  const railLinesWithData = RAIL_LINE_ORDER.filter(
    (line) => lineTotal(railByLine[line], RAIL_SIGNAL_TYPES) > 0,
  );

  // Nothing on either agency → render nothing (keeps the homepage quiet).
  if (grandTotal === 0 && railLinesWithData.length === 0) return null;

  return (
    <div className="space-y-6">
      {grandTotal > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-3">
            Signal mix by Metro line
          </h2>
          <div className="bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border p-4">
            <div className="space-y-2">
              {linesWithData.map((line) => {
                const info = METRO_LINES[line];
                const counts = byLine[line];
                const total = lineTotal(counts);
                return (
                  <SignalBar
                    key={line}
                    labelText={info.label}
                    labelColor={info.color}
                    counts={counts}
                    total={total}
                    ariaPrefix={metroLineFullName(line)}
                  />
                );
              })}
            </div>
            <SignalLegend />
          </div>
        </section>
      )}

      {railLinesWithData.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-3">
            Regional Rail signal mix by line
          </h2>
          <div className="bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border p-4">
            <div className="space-y-2">
              {railLinesWithData.map((line) => {
                const info = RAIL_LINES[line];
                const counts = railByLine[line];
                const total = lineTotal(counts, RAIL_SIGNAL_TYPES);
                return (
                  <SignalBar
                    key={line}
                    labelText={line.toUpperCase()}
                    labelColor={info.color}
                    counts={counts}
                    total={total}
                    ariaPrefix={`${info.label} Line`}
                    types={RAIL_SIGNAL_TYPES}
                    colors={RAIL_SIGNAL_COLORS}
                  />
                );
              })}
            </div>
            <SignalLegend types={RAIL_SIGNAL_TYPES} colors={RAIL_SIGNAL_COLORS} />
          </div>
        </section>
      )}
    </div>
  );
}

// Single-row variant for /route/:id pages. The route is already locked, so
// just one bar and the same legend. Hidden when the route has no signals
// to break down (e.g. a bus route that only has SEPTA alerts but no bot
// observations yet).
export function SignalBreakdownSingleRoute({ observations, label, labelColor }) {
  const counts = useMemo(() => tallySignals(observations), [observations]);
  const total = lineTotal(counts);
  if (total === 0) return null;
  return (
    <section>
      <h2 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-3">
        Signal mix
      </h2>
      <div className="bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border p-4">
        <SignalBar
          labelText={label}
          labelColor={labelColor}
          counts={counts}
          total={total}
          ariaPrefix={label}
        />
        <SignalLegend />
      </div>
    </section>
  );
}
