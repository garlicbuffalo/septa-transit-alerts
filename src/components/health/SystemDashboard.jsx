import { useMemo } from 'react';
import {
  activeAgeBreakdown,
  CATEGORIES,
  CATEGORY_LABELS,
  computeModeHealth,
  issueTypeBreakdown,
  MODE_LABELS,
  mostAffectedRoutes,
  routeHref,
  routeLabel,
} from '../../lib/systemHealth.js';
import LinePill from '../LinePill.jsx';
import ColumnChart from './ColumnChart.jsx';
import { ACCENT_BAR, CATEGORY_BAR } from './chartTokens.js';
import ModeHealthCard, { describeCounts } from './ModeHealthCard.jsx';

// The homepage's live "system health" dashboard: one tile per transit mode
// (status, counts, a line board, and a 24-hour activity strip), then a row of
// small charts on what's open and what's going wrong. It reads the same
// network-scoped incident list as the alert lists below it, so the All /
// Metro & Bus / Regional Rail control rescopes it too.

const NETWORK_MODES = {
  all: ['metro', 'bus', 'rail'],
  transit: ['metro', 'bus'],
  rail: ['rail'],
};

const TILE_GRID = {
  1: '',
  2: 'md:grid-cols-2',
  3: 'md:grid-cols-3',
};

function ChartCard({ title, subtitle, legend = false, children, className = '' }) {
  return (
    <section
      className={`min-w-0 rounded-xl border border-slate-200 bg-white p-4 dark:border-gh-border dark:bg-gh-surface ${className}`}
    >
      <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">{title}</h3>
      {subtitle && <p className="text-xs text-slate-500 dark:text-slate-400">{subtitle}</p>}
      {legend && <CategoryLegend />}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function CategoryLegend() {
  return (
    <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-600 dark:text-slate-300">
      {CATEGORIES.map((c) => (
        <li key={c} className="inline-flex items-center gap-1">
          <span
            aria-hidden="true"
            className={`inline-block h-2 w-2 rounded-sm ${CATEGORY_BAR[c]}`}
          />
          {CATEGORY_LABELS[c]}
        </li>
      ))}
    </ul>
  );
}

function EmptyNote({ children }) {
  return <p className="py-6 text-center text-xs text-slate-500 dark:text-slate-400">{children}</p>;
}

function AgeChart({ bins }) {
  const total = bins.reduce((s, b) => s + b.total, 0);
  if (total === 0) return <EmptyNote>Nothing is open right now.</EmptyNote>;
  return (
    <ColumnChart
      bins={bins.map((b) => ({
        key: b.key,
        label: b.label,
        tipTitle: `Open ${b.tip.toLowerCase()}`,
        segments: CATEGORIES.map((c) => ({
          key: c,
          label: CATEGORY_LABELS[c].toLowerCase(),
          value: b[c],
          className: CATEGORY_BAR[c],
        })),
      }))}
      height={96}
      capLabels
      showBinLabels
      ariaLabel={`${total} open alerts by how long they have been open. Use left and right arrow keys to read each bucket.`}
      tableHeaders={['Open for', 'Alerts']}
    />
  );
}

// Horizontal bars with the value at the tip. A bar's thickness is capped and
// its data end rounded; the baseline end stays square.
function BarRow({ label, value, max, children, href, title, ariaLabel }) {
  const inner = (
    <>
      <div className="w-28 min-w-0 flex-shrink-0 truncate text-xs text-slate-700 dark:text-slate-200 sm:w-32">
        {label}
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <div className="flex h-3 min-w-0 gap-[2px]" style={{ width: `${(value / max) * 100}%` }}>
          {children}
        </div>
        <span className="flex-shrink-0 text-xs font-medium tabular-nums text-slate-600 dark:text-slate-300">
          {value}
        </span>
      </div>
    </>
  );
  const cls = 'flex items-center gap-2 rounded-md px-1 py-1';
  return href ? (
    <a
      href={href}
      title={title}
      aria-label={ariaLabel}
      className={`${cls} hover:bg-slate-100 dark:hover:bg-gh-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500`}
    >
      {inner}
    </a>
  ) : (
    <div className={cls} title={title}>
      {inner}
    </div>
  );
}

function IssueTypesChart({ rows }) {
  if (rows.length === 0) return <EmptyNote>No incidents in the last 24 hours.</EmptyNote>;
  const max = Math.max(...rows.map((r) => r.count));
  return (
    <ul className="space-y-0.5">
      {rows.map((r) => (
        <li key={r.key}>
          <BarRow label={r.label} value={r.count} max={max} title={`${r.label}: ${r.count}`}>
            <div className={`h-full w-full rounded-r-[4px] ${ACCENT_BAR}`} />
          </BarRow>
        </li>
      ))}
    </ul>
  );
}

function MostAffectedChart({ rows }) {
  if (rows.length === 0)
    return <EmptyNote>No lines or routes had alerts in the last 24 hours.</EmptyNote>;
  const max = Math.max(...rows.map((r) => r.total));
  return (
    <ul className="space-y-0.5">
      {rows.map((r) => {
        const parts = CATEGORIES.filter((c) => r[c] > 0);
        const breakdown = describeCounts(r);
        return (
          <li key={r.key}>
            <BarRow
              label={
                <span className="flex min-w-0">
                  <LinePill kind={r.mode} line={r.route} linked={false} compact />
                </span>
              }
              value={r.total}
              max={max}
              href={routeHref(r.mode, r.route)}
              title={`${MODE_LABELS[r.mode]} — ${breakdown}`}
              ariaLabel={`${routeLabel(r.mode, r.route)} (${MODE_LABELS[r.mode]}): ${r.total} in the last 24 hours — ${breakdown}`}
            >
              {parts.map((c, i) => (
                <div
                  key={c}
                  className={`h-full ${CATEGORY_BAR[c]} ${i === parts.length - 1 ? 'rounded-r-[4px]' : ''}`}
                  style={{ width: `${(r[c] / r.total) * 100}%` }}
                />
              ))}
            </BarRow>
          </li>
        );
      })}
    </ul>
  );
}

export default function SystemDashboard({
  incidents,
  network = 'all',
  now,
  dataStartTs = null,
  burst,
}) {
  const modes = NETWORK_MODES[network] ?? NETWORK_MODES.all;

  const health = useMemo(
    () => modes.map((mode) => computeModeHealth(incidents, mode, { now, dataStartTs })),
    [incidents, modes, now, dataStartTs],
  );
  const ageBins = useMemo(() => activeAgeBreakdown(incidents, { now }), [incidents, now]);
  const issueRows = useMemo(() => issueTypeBreakdown(incidents, { now }), [incidents, now]);
  const affectedRows = useMemo(() => mostAffectedRoutes(incidents, { now }), [incidents, now]);

  const burstActive =
    burst != null && burst.recentCount >= 3 && burst.ratio != null && burst.ratio >= 2;
  const unplanned = health.reduce((s, h) => s + h.counts.disruption + h.counts.delay, 0);
  const planned = health.reduce((s, h) => s + h.counts.planned, 0);

  return (
    <section aria-labelledby="system-health-heading" className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2
          id="system-health-heading"
          className="text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400"
        >
          System health
        </h2>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          <strong className="font-semibold text-slate-700 dark:text-slate-200">{unplanned}</strong>{' '}
          unplanned · {planned} planned open now
        </p>
        {burstActive && (
          <span
            className="inline-flex items-center gap-1 rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
            title="Recent incident rate vs. the 30-day baseline rate over the same window length."
          >
            {`${burst.recentCount} in ${burst.windowHours}h · ${burst.ratio.toFixed(1)}× typical rate`}
          </span>
        )}
      </div>

      <div className={`grid gap-4 ${TILE_GRID[health.length] ?? ''}`}>
        {health.map((h) => (
          <ModeHealthCard key={h.mode} health={h} now={now} />
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <ChartCard title="How long alerts have been open" subtitle="Open right now, by age" legend>
          <AgeChart bins={ageBins} />
        </ChartCard>
        <ChartCard
          title="What's going wrong"
          subtitle="Incidents open in the last 24 hours, by type"
        >
          <IssueTypesChart rows={issueRows} />
        </ChartCard>
        <ChartCard
          title="Most affected"
          subtitle="Lines & routes with the most incidents, last 24 hours"
          legend
          className="md:col-span-2 lg:col-span-1"
        >
          <MostAffectedChart rows={affectedRows} />
        </ChartCard>
      </div>
    </section>
  );
}
