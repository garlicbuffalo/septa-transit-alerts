import { useEffect, useMemo, useState } from 'react';
import { useDarkMode } from '../hooks/useDarkMode.js';
import { useNow } from '../hooks/useNow.js';
import {
  computeDisruptionMinutes,
  computeDurationHistogram,
  computeLineReliability,
  computeYearOverYear,
  DURATION_BINS,
} from '../lib/aggregate.js';
import { topLevelTrail } from '../lib/breadcrumbs.js';
import { BUS_ROUTE_NAMES, busRouteDisplayId, formatBusRoute } from '../lib/busRoutes.js';
import { formatGap, formatMinutesAsHours } from '../lib/format.js';
import { loadLine, loadRecent } from '../lib/incidentStore.js';
import {
  incidentRecords,
  observationSignals,
  SIGNAL_LABELS,
  SIGNAL_TYPES,
} from '../lib/incidents.js';
import {
  METRO_LINE_ORDER,
  METRO_LINES,
  metroLineFullName,
  normalizeMetroLine,
} from '../lib/metroLines.js';
import {
  normalizeRailLine,
  RAIL_LINE_ORDER,
  RAIL_LINES,
  railLineFullName,
} from '../lib/railLines.js';
import { SITE_NAME } from '../lib/site.js';
import Breadcrumb from './Breadcrumb.jsx';
import Footer from './Footer.jsx';
import Header from './Header.jsx';
import HourOfWeekHeatmap from './HourOfWeekHeatmap.jsx';

const MAX_SELECTED = 3;

// Comparison palette: distinct, accessible-pair colors. Metro lines use their
// brand color so an "L1 vs B1" chart reads with SEPTA's actual hues — unless
// the selection shares a brand color (B1 vs B2, T1 vs T3), where the palette
// keeps them apart. Regional Rail lines all share one brand color, so they use
// their per-line chart color; bus routes (no brand color) use the palette.
const COMPARE_PALETTE = ['#0ea5e9', '#f97316', '#6366f1'];

function colorFor(kind, key, idx, selected = []) {
  if (kind === 'metro') {
    const brand = METRO_LINES[key]?.color;
    const shared = selected.some((k) => k !== key && METRO_LINES[k]?.color === brand);
    return brand && !shared ? brand : COMPARE_PALETTE[idx % COMPARE_PALETTE.length];
  }
  if (kind === 'rail') return RAIL_LINES[key]?.chartColor ?? COMPARE_PALETTE[idx];
  return COMPARE_PALETTE[idx % COMPARE_PALETTE.length];
}

function labelFor(kind, key) {
  if (kind === 'rail') return railLineFullName(key);
  if (kind === 'metro') return metroLineFullName(key);
  return formatBusRoute(key);
}

// Filter the dataset down to one line/route. Lines match on `routes`
// (alerts) and `line` (observations); bus routes match on the same fields
// using the route number as the key.
function scopeIncidents(payload, kind, key) {
  const alerts = payload.officialRecords.filter(
    (a) => a.kind === kind && Array.isArray(a.routes) && a.routes.includes(key),
  );
  const observations = payload.detectionRecords.filter((o) => o.kind === kind && o.line === key);
  return { alerts, observations };
}

// URL param name per mode. `?metro=l1,b1` → Metro mode; `?buses=17,33` → bus
// mode; `?rail=pao,wtr` → Regional Rail mode.
const PARAM_FOR_KIND = { metro: 'metro', bus: 'buses', rail: 'rail' };

// Read mode + selection from the URL. All empty → default to Metro mode with
// no selection (picker UI appears).
function readUrlState() {
  const params = new URLSearchParams(window.location.search);
  const metroParam = params.get('metro');
  const busesParam = params.get('buses');
  const railParam = params.get('rail');
  if (metroParam) {
    const valid = metroParam
      .split(',')
      .map((s) => normalizeMetroLine(s.trim()))
      .filter((s) => METRO_LINES[s]);
    return { kind: 'metro', selected: valid.slice(0, MAX_SELECTED) };
  }
  if (busesParam) {
    const valid = busesParam
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return { kind: 'bus', selected: valid.slice(0, MAX_SELECTED) };
  }
  if (railParam) {
    const valid = railParam
      .split(',')
      .map((s) => normalizeRailLine(s.trim()))
      .filter((s) => RAIL_LINES[s]);
    return { kind: 'rail', selected: valid.slice(0, MAX_SELECTED) };
  }
  return { kind: 'metro', selected: [] };
}

function writeUrlState(kind, selected) {
  const params = new URLSearchParams();
  if (selected.length > 0) {
    params.set(PARAM_FOR_KIND[kind] ?? 'metro', selected.join(','));
  }
  const s = params.toString();
  const next = `${window.location.pathname}${s ? `?${s}` : ''}${window.location.hash}`;
  if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
    window.history.replaceState(null, '', next);
  }
}

// `yoyByLine` is aligned to `selected`/`perLine` by index; each entry is the
// precomputed-style YoY for that line (from its all-time per-line file) or null
// while that file is still loading.
function StatTable({ kind, selected, perLine, yoyByLine }) {
  const haveYoy = yoyByLine.some((r) => r?.enoughData);

  // Helper to render a single value cell for a line.
  const cell = (text, idx) => (
    <td key={idx} className="py-2 pr-3 text-sm text-slate-700 dark:text-slate-200 tabular-nums">
      {text}
    </td>
  );

  return (
    <div className="bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border p-4 overflow-x-auto">
      <table className="w-full text-left">
        <caption className="sr-only">
          Reliability metrics over the last 90 days, comparing the selected lines or routes.
        </caption>
        <thead>
          <tr className="border-b border-slate-200 dark:border-gh-border">
            <th
              scope="col"
              className="py-2 pr-3 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 whitespace-nowrap sticky left-0 bg-white dark:bg-gh-surface z-10"
            >
              Metric (90 days)
            </th>
            {selected.map((key, idx) => (
              <th
                key={key}
                scope="col"
                className="py-2 pr-3 text-xs font-semibold whitespace-nowrap"
                style={{ color: colorFor(kind, key, idx, selected) }}
              >
                {labelFor(kind, key)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <th
              scope="row"
              className="py-2 pr-3 text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 sticky left-0 bg-white dark:bg-gh-surface z-10 whitespace-nowrap font-normal text-left"
            >
              Incident-free days
            </th>
            {perLine.map(({ reliability }, idx) =>
              cell(`${reliability.incidentFreeDays} / ${reliability.totalDays}`, idx),
            )}
          </tr>
          <tr>
            <th
              scope="row"
              className="py-2 pr-3 text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 sticky left-0 bg-white dark:bg-gh-surface z-10 whitespace-nowrap font-normal text-left"
            >
              Longest streak
            </th>
            {perLine.map(({ reliability }, idx) => cell(`${reliability.longestStreakDays}d`, idx))}
          </tr>
          <tr>
            <th
              scope="row"
              className="py-2 pr-3 text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 sticky left-0 bg-white dark:bg-gh-surface z-10 whitespace-nowrap font-normal text-left"
            >
              Median gap
            </th>
            {perLine.map(({ reliability }, idx) =>
              cell(
                reliability.medianGapHours == null ? '—' : formatGap(reliability.medianGapHours),
                idx,
              ),
            )}
          </tr>
          <tr>
            <th
              scope="row"
              className="py-2 pr-3 text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 sticky left-0 bg-white dark:bg-gh-surface z-10 whitespace-nowrap font-normal text-left"
            >
              Last 30 days
            </th>
            {yoyByLine.map((y, idx) => cell(y ? `${y.currentCount}` : '—', idx))}
          </tr>
          <tr title="Total line-time spent in an unplanned disruption over the last 30 days, against an assumed 20h/day service window. Planned work — scheduled closures, construction, and maintenance — isn't counted.">
            <th
              scope="row"
              className="py-2 pr-3 text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 sticky left-0 bg-white dark:bg-gh-surface z-10 whitespace-nowrap font-normal text-left"
            >
              Disrupted (30d)
            </th>
            {perLine.map(({ disruption30d }, idx) =>
              cell(
                disruption30d.disruptedMinutes === 0
                  ? '—'
                  : `${formatMinutesAsHours(disruption30d.disruptedMinutes)} · ${
                      disruption30d.ratio < 0.001
                        ? '<0.1%'
                        : `${(disruption30d.ratio * 100).toFixed(disruption30d.ratio < 0.01 ? 2 : 1)}%`
                    }`,
                idx,
              ),
            )}
          </tr>
          {haveYoy && (
            <tr>
              <th
                scope="row"
                className="py-2 pr-3 text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 sticky left-0 bg-white dark:bg-gh-surface z-10 whitespace-nowrap font-normal text-left"
              >
                YoY (vs 1y ago)
              </th>
              {yoyByLine.map((y, idx) => {
                if (!y?.enoughData || y.pctChange == null) return cell('—', idx);
                const pct = Math.round(y.pctChange * 100);
                const cls =
                  pct > 0
                    ? 'text-red-500'
                    : pct < 0
                      ? 'text-green-600 dark:text-green-500'
                      : 'text-slate-500';
                return (
                  <td
                    // biome-ignore lint/suspicious/noArrayIndexKey: column position is the key
                    key={idx}
                    className={`py-2 pr-3 text-sm tabular-nums ${cls}`}
                  >
                    {pct > 0 ? '+' : ''}
                    {pct}%
                  </td>
                );
              })}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// Overlaid duration histogram: one grouped bar per line within each bin.
// Reuses the same DURATION_BINS the per-line page uses so the bins are
// identical across the site.
function CompareDurationHistogram({ kind, selected, perLine }) {
  const histograms = perLine.map(({ alerts, observations }) =>
    computeDurationHistogram(alerts, observations, { windowDays: 90 }),
  );
  // Find the global max across all bins/lines so bars share a scale.
  let max = 0;
  for (const h of histograms) {
    for (const b of h.bins) if (b.count > max) max = b.count;
  }
  if (max === 0) return null;

  return (
    <section>
      <h2 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-3">
        Resolution time (last 90 days)
      </h2>
      <div className="bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border p-4 space-y-2">
        {DURATION_BINS.map((bin, binIdx) => (
          <div key={bin.label} className="flex items-center gap-3">
            <div className="w-16 flex-shrink-0 text-right">
              <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                {bin.label}
              </span>
            </div>
            <div className="flex-1 flex flex-col gap-0.5">
              {selected.map((key, idx) => {
                const c = histograms[idx].bins[binIdx].count;
                const pct = max > 0 ? (c / max) * 100 : 0;
                return (
                  <div key={key} className="flex items-center gap-2">
                    <div className="flex-1 h-3 rounded-sm bg-slate-100 dark:bg-gh-subtle overflow-hidden">
                      {c > 0 && (
                        <div
                          className="h-full"
                          style={{
                            width: `${pct}%`,
                            backgroundColor: colorFor(kind, key, idx, selected),
                          }}
                          role="img"
                          aria-label={`${labelFor(kind, key)} ${bin.label}: ${c} incidents`}
                        />
                      )}
                    </div>
                    <div className="w-8 text-right flex-shrink-0">
                      <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                        {c}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        <div className="flex flex-wrap gap-x-3 gap-y-1 mt-3 pt-3 border-t border-slate-100 dark:border-gh-border">
          {selected.map((key, idx) => (
            <div key={key} className="flex items-center gap-1.5">
              <div
                className="w-2.5 h-2.5 rounded-sm"
                style={{ backgroundColor: colorFor(kind, key, idx, selected) }}
              />
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {labelFor(kind, key)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

const SIGNAL_COLORS = {
  gap: '#0ea5e9',
  bunching: '#f97316',
  ghost: '#6366f1',
  'pulse-cold': '#94a3b8',
  'pulse-held': '#64748b',
  // Regional Rail detection sources — its signal vocabulary is cancellations + delays,
  // not SEPTA gap/bunching/ghost set.
  cancellation: '#dc2626',
  'cancellation-inferred': '#fb923c',
  delay: '#eab308',
};

// Regional Rail's signal mix is a different vocabulary from SEPTA's; pick the right set
// of detection sources to tally based on the comparison mode.
const RAIL_SIGNAL_TYPES = ['cancellation', 'cancellation-inferred', 'delay'];

// Stacked-bar per line — one row each, sharing a legend. Tally signals
// directly from the per-line observations rather than going through
// buildSignalsByLine (which is hardcoded to all 8 train lines).
function CompareSignalMix({ kind, selected, perLine }) {
  const sigTypes = kind === 'rail' ? RAIL_SIGNAL_TYPES : SIGNAL_TYPES;
  const rows = selected.map((key, idx) => {
    const counts = {};
    for (const sig of sigTypes) counts[sig] = 0;
    for (const o of perLine[idx].observations) {
      for (const sig of observationSignals(o)) {
        if (sig in counts) counts[sig] += 1;
      }
    }
    let total = 0;
    for (const sig of sigTypes) total += counts[sig];
    return { key, idx, counts, total };
  });

  if (rows.every((r) => r.total === 0)) return null;

  return (
    <section>
      <h2 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-3">
        Signal mix
      </h2>
      <div className="bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border p-4">
        <div className="space-y-2">
          {rows.map(({ key, idx, counts, total }) => (
            <div key={key} className="flex items-center gap-3">
              <div className="w-20 flex-shrink-0 text-right">
                <span
                  className="text-xs font-semibold whitespace-nowrap"
                  style={{ color: colorFor(kind, key, idx, selected) }}
                >
                  {labelFor(kind, key)}
                </span>
              </div>
              <div
                className="flex-1 flex h-4 rounded-sm overflow-hidden bg-slate-100 dark:bg-gh-subtle"
                role="img"
                aria-label={
                  total === 0
                    ? `${labelFor(kind, key)}: no signals`
                    : `${labelFor(kind, key)}: ${sigTypes
                        .map((s) => `${counts[s]} ${SIGNAL_LABELS[s]}`)
                        .filter((part) => !part.startsWith('0 '))
                        .join(', ')}`
                }
              >
                {total > 0 &&
                  sigTypes.map((sig) => {
                    const c = counts[sig];
                    if (c === 0) return null;
                    const pct = (c / total) * 100;
                    return (
                      <div
                        key={sig}
                        title={`${SIGNAL_LABELS[sig]}: ${c} (${Math.round(pct)}%)`}
                        style={{ width: `${pct}%`, backgroundColor: SIGNAL_COLORS[sig] }}
                      />
                    );
                  })}
              </div>
              <div className="w-10 text-right flex-shrink-0">
                <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                  {total}
                </span>
              </div>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-4 pt-3 border-t border-slate-100 dark:border-gh-border">
          {sigTypes.map((sig) => (
            <div key={sig} className="flex items-center gap-1.5">
              <div
                className="w-2.5 h-2.5 rounded-sm"
                style={{ backgroundColor: SIGNAL_COLORS[sig] }}
              />
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {SIGNAL_LABELS[sig]}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// Side-by-side mini hour-of-week heatmaps. Reuses `HourOfWeekHeatmap` —
// each column gets its own header. Stacked vertically on narrow viewports
// (the heatmap is wide enough that side-by-side three of them would be
// cramped on mobile anyway).
function CompareHourHeatmaps({ kind, selected, perLine }) {
  return (
    <section>
      <h2 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-3">
        When do incidents happen?
      </h2>
      <div className="grid gap-4 grid-cols-1 lg:grid-cols-3">
        {selected.map((key, idx) => (
          <div key={key} className="space-y-1">
            <p
              className="text-xs font-semibold text-center"
              style={{ color: colorFor(kind, key, idx, selected) }}
            >
              {labelFor(kind, key)}
            </p>
            <HourOfWeekHeatmap
              alerts={perLine[idx].alerts}
              observations={perLine[idx].observations}
              title={null}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

function ChipPicker({ kind, selected, available, onToggle, onClearAll }) {
  return (
    <div className="bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {available.map((key) => {
          const active = selected.includes(key);
          const disabled = !active && selected.length >= MAX_SELECTED;
          if (kind === 'metro' || kind === 'rail') {
            const info = (kind === 'rail' ? RAIL_LINES : METRO_LINES)[key];
            return (
              <button
                type="button"
                key={key}
                onClick={() => onToggle(key)}
                disabled={disabled}
                className={`px-3 py-1 rounded-full text-xs font-semibold transition-all ${
                  active
                    ? ''
                    : disabled
                      ? 'opacity-30 cursor-not-allowed bg-slate-100 dark:bg-gh-subtle text-slate-500 dark:text-slate-400'
                      : 'bg-slate-100 dark:bg-gh-subtle text-slate-500 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-gh-border'
                }`}
                style={active ? { backgroundColor: info.color, color: info.textColor } : undefined}
                title={labelFor(kind, key)}
              >
                {kind === 'rail' ? info.code : info.label}
              </button>
            );
          }
          return (
            <button
              type="button"
              key={key}
              onClick={() => onToggle(key)}
              disabled={disabled}
              className={`px-3 py-1 rounded-full text-xs font-semibold transition-colors ${
                active
                  ? 'bg-slate-800 dark:bg-slate-200 text-white dark:text-slate-800'
                  : disabled
                    ? 'opacity-30 cursor-not-allowed bg-slate-100 dark:bg-gh-subtle text-slate-500 dark:text-slate-400'
                    : 'bg-slate-100 dark:bg-gh-subtle text-slate-500 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-gh-border'
              }`}
            >
              {busRouteDisplayId(key)}
            </button>
          );
        })}
        {selected.length > 0 && (
          <button
            type="button"
            onClick={onClearAll}
            className="ml-2 text-xs text-slate-500 dark:text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
          >
            Clear
          </button>
        )}
      </div>
      <p className="text-xs text-slate-500 dark:text-slate-400 mt-2">
        Pick up to {MAX_SELECTED}.{' '}
        {kind === 'bus' && 'Only routes that have appeared in the data are shown.'}
      </p>
    </div>
  );
}

export default function ComparePage() {
  const [dark, toggleDark] = useDarkMode();
  const now = useNow();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  // All-time per-line records for the selected lines, keyed `${kind}:${key}` —
  // the only input needing >90d history (for YoY). Loaded lazily from the
  // bounded per-line files; everything else reads the recent slice.
  const [lineData, setLineData] = useState({});
  const initial = useMemo(() => readUrlState(), []);
  const [kind, setKind] = useState(initial.kind);
  const [selected, setSelected] = useState(initial.selected);

  useEffect(() => {
    document.title = `Compare · ${SITE_NAME}`;
    return () => {
      document.title = SITE_NAME;
    };
  }, []);

  useEffect(() => {
    // The recent slice powers the picker + every ≤90d stat; per-line YoY needs
    // year-old data, loaded separately from the all-time per-line files below.
    loadRecent()
      .then((fresh) => setData({ ...fresh, incidents: fresh.incidents || [] }))
      .catch(setError);
  }, []);

  // Lazily load each selected line's all-time file (memoized in the store, so a
  // re-selection or now-tick won't refetch). Keyed by `${kind}:${key}` so a
  // bus route and a train line that share a key never collide.
  useEffect(() => {
    let alive = true;
    for (const key of selected) {
      const id = `${kind}:${key}`;
      loadLine(key)
        .then((incidents) => {
          if (!alive) return;
          setLineData((prev) => (prev[id] ? prev : { ...prev, [id]: incidentRecords(incidents) }));
        })
        .catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, [kind, selected]);

  // Mirror selection to the URL so views are shareable.
  useEffect(() => {
    writeUrlState(kind, selected);
  }, [kind, selected]);

  // Analytics here read incident-derived official/detection records.
  const flat = useMemo(() => (data ? incidentRecords(data.incidents) : null), [data]);

  // Per-line YoY, computed from each line's all-time file (or null until it
  // loads). The global producer `data_start_ts` gates `enoughData`, matching the
  // pre-shard behavior. Aligned to `selected` by index for StatTable.
  const dataStartTs = data?.data_start_ts ?? null;
  const yoyByLine = useMemo(
    () =>
      selected.map((key) => {
        const records = lineData[`${kind}:${key}`];
        if (!records) return null;
        const scoped = scopeIncidents(records, kind, key);
        return computeYearOverYear(scoped.alerts, scoped.observations, {
          now,
          windowDays: 30,
          dataStartTs,
        });
      }),
    [selected, kind, lineData, now, dataStartTs],
  );

  const availableBusRoutes = useMemo(() => {
    if (!flat) return [];
    const routes = new Set([
      ...flat.detectionRecords.filter((o) => o.kind === 'bus').map((o) => String(o.line)),
      ...flat.officialRecords
        .filter((a) => a.kind === 'bus')
        .flatMap((a) => a.routes ?? [])
        .map(String),
    ]);
    return [...routes].sort((a, b) => {
      const na = parseInt(a, 10);
      const nb = parseInt(b, 10);
      if (Number.isNaN(na) && Number.isNaN(nb)) return a.localeCompare(b);
      if (Number.isNaN(na)) return 1;
      if (Number.isNaN(nb)) return -1;
      return na - nb || a.localeCompare(b);
    });
  }, [flat]);

  // Per-line precomputed bundle. Lifted to the page so each visualization
  // doesn't re-merge/re-filter the same data.
  const perLine = useMemo(() => {
    if (!flat || selected.length === 0) return [];
    return selected.map((key) => {
      const scoped = scopeIncidents(flat, kind, key);
      return {
        key,
        ...scoped,
        reliability: computeLineReliability(scoped.alerts, scoped.observations, {
          now,
          windowDays: 90,
        }),
        disruption30d: computeDisruptionMinutes(scoped.alerts, scoped.observations, {
          now,
          windowDays: 30,
          lines: [{ kind, line: key }],
        }),
      };
    });
  }, [flat, kind, selected, now]);

  function toggleKey(key) {
    setSelected((prev) => {
      if (prev.includes(key)) return prev.filter((k) => k !== key);
      if (prev.length >= MAX_SELECTED) return prev;
      return [...prev, key];
    });
  }

  function handleKindChange(next) {
    if (next === kind) return;
    setKind(next);
    setSelected([]);
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-gh-canvas flex flex-col">
      <Header
        generatedAt={data?.generated_at}
        dark={dark}
        onToggleDark={toggleDark}
        onResetFilters={() => {
          window.location.href = '/';
        }}
        alerts={flat?.alerts}
        observations={flat?.observations}
      />
      <main id="main" tabIndex={-1} className="max-w-5xl mx-auto px-4 py-6 space-y-4 w-full flex-1">
        <div>
          <Breadcrumb items={topLevelTrail('Compare')} className="mb-3" />
          <h1 className="text-xl font-bold text-slate-800 dark:text-slate-100">Compare</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            Side-by-side reliability and signal mix for up to {MAX_SELECTED} SEPTA Metro lines, bus
            routes, or Regional Rail lines. Stats cover the last 90 days.
          </p>
        </div>

        {error && <p className="text-red-600 text-sm">Failed to load alert data.</p>}

        {/* Mode toggle: Metro, bus, or Regional Rail only. Switching modes clears
            the current selection — mixing kinds isn't supported because
            the data shapes diverge enough that an apples-to-apples
            comparison wouldn't be meaningful. */}
        <div className="flex gap-1.5">
          {[
            { value: 'metro', label: 'Metro lines' },
            { value: 'bus', label: 'Bus routes' },
            { value: 'rail', label: 'Regional Rail lines' },
          ].map(({ value, label }) => (
            <button
              type="button"
              key={value}
              onClick={() => handleKindChange(value)}
              className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${
                kind === value
                  ? 'bg-slate-800 dark:bg-slate-200 text-white dark:text-slate-800'
                  : 'bg-slate-100 dark:bg-gh-subtle text-slate-500 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-gh-border'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <ChipPicker
          kind={kind}
          selected={selected}
          available={
            kind === 'bus'
              ? availableBusRoutes
              : kind === 'rail'
                ? RAIL_LINE_ORDER
                : METRO_LINE_ORDER
          }
          onToggle={toggleKey}
          onClearAll={() => setSelected([])}
        />

        {selected.length === 0 && (
          <div className="bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border p-8 text-center text-slate-500 dark:text-slate-400 text-sm">
            Pick two or three{' '}
            {kind === 'metro'
              ? 'Metro lines'
              : kind === 'rail'
                ? 'Regional Rail lines'
                : 'bus routes'}{' '}
            above to compare.
          </div>
        )}

        {selected.length > 0 && data && (
          <>
            <StatTable kind={kind} selected={selected} perLine={perLine} yoyByLine={yoyByLine} />
            <CompareSignalMix kind={kind} selected={selected} perLine={perLine} />
            <CompareDurationHistogram kind={kind} selected={selected} perLine={perLine} />
            <CompareHourHeatmaps kind={kind} selected={selected} perLine={perLine} />
          </>
        )}

        {selected.length > 0 && kind === 'bus' && selected.some((k) => BUS_ROUTE_NAMES[k]) && (
          <div className="text-xs text-slate-500 dark:text-slate-400 px-1">
            {selected
              .filter((k) => BUS_ROUTE_NAMES[k])
              .map((k) => `${formatBusRoute(k)}`)
              .join(' · ')}
          </div>
        )}
      </main>
      <Footer />
    </div>
  );
}
