import { compareBusRoutes } from '../../lib/busRoutes.js';
import { formatTime } from '../../lib/format.js';
import { METRO_LINES, metroLineFullName } from '../../lib/metroLines.js';
import { RAIL_LINES, railLineFullName } from '../../lib/railLines.js';
import {
  CATEGORIES,
  CATEGORY_LABELS,
  MODE_LABELS,
  MODE_UNITS,
  modeRoster,
  routeHref,
  routeLabel,
  STATUS_LABELS,
} from '../../lib/systemHealth.js';
import ColumnChart from './ColumnChart.jsx';
import {
  ACCENT_BAR,
  CATEGORY_BAR,
  CATEGORY_DISC,
  MUTED_BAR,
  STATUS_BADGE,
  STATUS_STRIPE,
} from './chartTokens.js';
import StatusIcon from './StatusIcon.jsx';

const SEVERITY = { disruption: 3, delay: 2, planned: 1 };
// Bus has ~150 routes, too many for a board; show the worst few as chips.
const BUS_CHIP_LIMIT = 8;

const plural = (n, [one, many]) => (n === 1 ? one : many);

function hourLabel(ts) {
  return formatTime(ts).replace(':00', '');
}

function lineTitle(mode, route) {
  if (mode === 'metro') return metroLineFullName(route);
  if (mode === 'rail') return railLineFullName(route);
  return routeLabel(mode, route);
}

// "1 disruption, 2 planned work items" — accessible-name text for a line.
const COUNT_NOUNS = {
  disruption: ['disruption', 'disruptions'],
  delay: ['delay or cancellation', 'delays or cancellations'],
  planned: ['planned work item', 'planned work items'],
};
export function describeCounts(counts) {
  const parts = CATEGORIES.filter((c) => counts[c] > 0).map(
    (c) => `${counts[c]} ${plural(counts[c], COUNT_NOUNS[c])}`,
  );
  return parts.length > 0 ? parts.join(', ') : 'good service';
}

// One cell of the line board: the line's brand-colored chip, with a status
// disc pinned to its corner when anything is open on it. The disc's 2px ring
// in the card surface color keeps it legible where it overlaps the chip.
function LineCell({ mode, route, entry }) {
  const info = mode === 'metro' ? METRO_LINES[route] : mode === 'rail' ? RAIL_LINES[route] : null;
  const status = entry?.status ?? 'ok';
  const label = mode === 'rail' ? (info?.code ?? route.toUpperCase()) : routeLabel(mode, route);
  const summary = entry ? describeCounts(entry.counts) : 'good service';
  return (
    <a
      href={routeHref(mode, route)}
      className="relative flex min-h-[28px] items-center justify-center rounded-md px-1 text-[11px] font-semibold leading-none transition-opacity hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
      style={
        info
          ? { backgroundColor: info.color, color: info.textColor }
          : { backgroundColor: '#334155', color: '#fff' }
      }
      title={`${lineTitle(mode, route)}: ${summary}`}
      aria-label={`${lineTitle(mode, route)}: ${summary}`}
    >
      <span className="truncate">{label}</span>
      {status !== 'ok' && (
        <span
          aria-hidden="true"
          className={`absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full ring-2 ring-white dark:ring-gh-surface ${CATEGORY_DISC[status]}`}
        >
          <StatusIcon name={status} className="h-3 w-3" />
        </span>
      )}
    </a>
  );
}

function LineBoard({ mode, lineStatus }) {
  const roster = modeRoster(mode);
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(2.75rem,1fr))] gap-x-2 gap-y-2.5 pt-1.5 pr-1.5">
      {roster.map((route) => (
        <li key={route} className="min-w-0">
          <LineCell mode={mode} route={route} entry={lineStatus.get(route)} />
        </li>
      ))}
    </ul>
  );
}

// Bus routes with something open, worst first, as chips; the rest fold into a
// "+N more" link to the routes index.
function BusChips({ lineStatus }) {
  const routes = [...lineStatus]
    .sort(([ra, a], [rb, b]) => SEVERITY[b.status] - SEVERITY[a.status] || compareBusRoutes(ra, rb))
    .map(([route, entry]) => ({ route, entry }));
  if (routes.length === 0) {
    return (
      <p className="text-xs text-slate-500 dark:text-slate-400">No bus routes have open alerts.</p>
    );
  }
  const shown = routes.slice(0, BUS_CHIP_LIMIT);
  const more = routes.length - shown.length;
  return (
    <ul className="flex flex-wrap items-center gap-x-2.5 gap-y-2.5 pt-1.5 pr-1.5">
      {shown.map(({ route, entry }) => (
        <li key={route}>
          <span className="relative inline-flex">
            <a
              href={routeHref('bus', route)}
              className="inline-flex min-h-[26px] items-center rounded-full bg-slate-700 px-2.5 text-[11px] font-semibold text-white transition-opacity hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
              title={`${routeLabel('bus', route)}: ${describeCounts(entry.counts)}`}
              aria-label={`${routeLabel('bus', route)}: ${describeCounts(entry.counts)}`}
            >
              {route}
            </a>
            <span
              aria-hidden="true"
              className={`pointer-events-none absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full ring-2 ring-white dark:ring-gh-surface ${CATEGORY_DISC[entry.status]}`}
            >
              <StatusIcon name={entry.status} className="h-3 w-3" />
            </span>
          </span>
        </li>
      ))}
      {more > 0 && (
        <li>
          <a
            href="/routes"
            className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            +{more} more
          </a>
        </li>
      )}
    </ul>
  );
}

// Stacked meter of the roster: share of lines in each worst-status bucket,
// on a track of the rest. Segments keep a 2px surface gap between them.
function AffectedMeter({ health }) {
  const { lineCounts, rosterSize, affected, unplannedLines, mode } = health;
  const units = MODE_UNITS[mode];
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
        <span className="text-slate-600 dark:text-slate-300">
          <strong className="font-semibold text-slate-900 dark:text-slate-100">{affected}</strong>{' '}
          of {rosterSize} {plural(rosterSize, units)} with alerts
        </span>
        <span className="text-slate-500 dark:text-slate-400">{unplannedLines} unplanned</span>
      </div>
      <div
        className="flex h-2 gap-[2px] overflow-hidden rounded-full bg-slate-100 dark:bg-gh-subtle"
        role="img"
        aria-label={`${affected} of ${rosterSize} ${plural(rosterSize, units)} have open alerts: ${CATEGORIES.map(
          (c) => `${lineCounts[c]} with ${CATEGORY_LABELS[c].toLowerCase()}`,
        ).join(', ')}.`}
      >
        {CATEGORIES.map((c) =>
          lineCounts[c] > 0 ? (
            <div
              key={c}
              className={`h-full ${CATEGORY_BAR[c]}`}
              style={{ width: `${(Math.min(lineCounts[c], rosterSize) / rosterSize) * 100}%` }}
            />
          ) : null,
        )}
      </div>
    </div>
  );
}

function HourlyTrend({ health, now }) {
  const { hourly, last24, prior24, mode } = health;
  const lastIdx = hourly.length - 1;
  const bins = hourly.map((b, i) => ({
    key: String(b.start),
    tipTitle:
      i === lastIdx ? `${hourLabel(b.start)} – now` : `${hourLabel(b.start)} – ${hourLabel(b.end)}`,
    noData: b.noData,
    segments: [
      {
        key: 'count',
        label: b.count === 1 ? 'new unplanned incident' : 'new unplanned incidents',
        value: b.count,
        className: i === lastIdx ? ACCENT_BAR : MUTED_BAR,
      },
    ],
  }));
  let delta = null;
  if (prior24 != null && prior24 >= 3) {
    const pct = Math.round(((last24 - prior24) / prior24) * 100);
    if (Math.abs(pct) >= 10) {
      const up = pct > 0;
      delta = (
        <span
          className={up ? 'text-red-600 dark:text-red-400' : 'text-green-700 dark:text-green-400'}
        >
          {up ? '↑' : '↓'} {Math.abs(pct)}% vs prior 24h
        </span>
      );
    }
  }
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2 text-xs">
        <span className="text-slate-600 dark:text-slate-300">
          <strong className="font-semibold text-slate-900 dark:text-slate-100">{last24}</strong>{' '}
          unplanned in last 24h
        </span>
        {delta}
      </div>
      <ColumnChart
        bins={bins}
        height={36}
        ariaLabel={`New unplanned ${MODE_LABELS[mode]} incidents per hour over the last 24 hours, ${last24} in total. Use left and right arrow keys to read each hour.`}
        tableHeaders={['Hour', 'New unplanned incidents']}
        axisStart="24h ago"
        axisEnd={`now · ${hourLabel(now)}`}
        noDataTip="Not collecting yet"
      />
    </div>
  );
}

export default function ModeHealthCard({ health, now }) {
  const { mode, status, counts, lineStatus, systemWide } = health;
  return (
    <article
      className="relative flex min-w-0 flex-col gap-4 overflow-hidden rounded-xl border border-slate-200 bg-white p-4 pt-5 dark:border-gh-border dark:bg-gh-surface"
      aria-labelledby={`health-${mode}`}
    >
      <span
        aria-hidden="true"
        className={`absolute inset-x-0 top-0 h-1 ${STATUS_STRIPE[status]}`}
      />
      <header className="flex items-start justify-between gap-2">
        <h3
          id={`health-${mode}`}
          className="text-sm font-bold uppercase tracking-wider text-slate-800 dark:text-slate-100"
        >
          {MODE_LABELS[mode]}
        </h3>
        <span
          className={`inline-flex flex-shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold ${STATUS_BADGE[status]}`}
        >
          <StatusIcon name={status} />
          {STATUS_LABELS[status]}
        </span>
      </header>

      {/* Active-incident counts by category. Doubles as the legend for the
          meter, board discs, and the charts below. */}
      <dl className="grid grid-cols-3 gap-2">
        {CATEGORIES.map((c) => (
          <div key={c} className="flex min-w-0 flex-col-reverse justify-end">
            <dt className="mt-1 flex items-start gap-1 text-[11px] leading-tight text-slate-500 dark:text-slate-400">
              <span
                aria-hidden="true"
                className={`mt-[3px] inline-block h-2 w-2 flex-shrink-0 rounded-sm ${CATEGORY_BAR[c]}`}
              />
              {CATEGORY_LABELS[c]}
            </dt>
            <dd className="text-2xl font-semibold leading-none text-slate-900 dark:text-slate-100">
              {counts[c]}
            </dd>
          </div>
        ))}
      </dl>

      <AffectedMeter health={health} />

      {mode === 'bus' ? (
        <BusChips lineStatus={lineStatus} />
      ) : (
        <LineBoard mode={mode} lineStatus={lineStatus} />
      )}
      {systemWide > 0 && (
        <p className="-mt-2 text-[11px] text-slate-500 dark:text-slate-400">
          + {systemWide} systemwide {systemWide === 1 ? 'alert' : 'alerts'}
        </p>
      )}

      <div className="mt-auto">
        <HourlyTrend health={health} now={now} />
      </div>
    </article>
  );
}
