import { useEffect, useMemo, useState } from 'react';
import { useDarkMode } from '../hooks/useDarkMode.js';
import { useNow } from '../hooks/useNow.js';
import {
  currentlyOut,
  elevatorReliability,
  fetchAccessibilityData,
  formatUptime,
  groupOutagesByStation,
  kindLabel,
  outageDuration,
  outageHasLine,
  outageKind,
  reliabilitySummary,
  stationHref,
  stationReliability,
  summarizeOutages,
} from '../lib/accessibility.js';
import { topLevelTrail } from '../lib/breadcrumbs.js';
import { formatDate, formatDuration } from '../lib/format.js';
import { METRO_LINE_ORDER } from '../lib/metroLines.js';
import { RAIL_LINE_ORDER } from '../lib/railLines.js';
import { SITE_NAME } from '../lib/site.js';
import Breadcrumb from './Breadcrumb.jsx';
import Footer from './Footer.jsx';
import Header from './Header.jsx';
import LinePill from './LinePill.jsx';

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'metro', label: 'SEPTA Metro' },
  { key: 'rail', label: 'Regional Rail' },
];

function StationLink({ outage }) {
  const name = outage.station?.name || 'Unmatched station';
  const href = stationHref(outage);
  if (!href) return <span>{name}</span>;
  return (
    <a href={href} className="hover:underline">
      {name}
    </a>
  );
}

function KindTag({ kind }) {
  return (
    <span className="text-xs font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
      {kindLabel(kind)}
    </span>
  );
}

function StationLines({ outage }) {
  const lineKind = outageKind(outage);
  return (
    <span className="flex flex-wrap gap-1">
      {(outage.station?.lines || []).map((line) => (
        <LinePill key={`${lineKind}-${line}`} kind={lineKind} line={line} />
      ))}
    </span>
  );
}

function UnitDetail({ outage }) {
  return (
    <>
      <span className="capitalize">{outage.unit_type}</span>
      {outage.unit_label ? ` · ${outage.unit_label}` : ''} · out{' '}
      {formatDuration(outage.durationMs) || 'just now'}
    </>
  );
}

function StationOutageGroup({ group }) {
  const href = stationHref(group);
  const lineKind = group.kind;
  const multi = group.outages.length > 1;
  return (
    <div className="px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-semibold text-slate-800 dark:text-slate-100">
          {href ? (
            <a href={href} className="hover:underline">
              {group.name}
            </a>
          ) : (
            <span>{group.name}</span>
          )}
        </span>
        {group.lines.length > 0 ? (
          <span className="flex flex-wrap items-center gap-1">
            {group.lines.map((line) => (
              <LinePill key={`${group.kind}-${line}`} kind={lineKind} line={line} compact />
            ))}
          </span>
        ) : (
          <KindTag kind={group.kind} />
        )}
        {multi ? (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-400/15 dark:text-amber-200">
            {group.outages.length} out
          </span>
        ) : (
          <span className="text-sm text-slate-500 dark:text-slate-400">
            · <UnitDetail outage={group.outages[0]} />
          </span>
        )}
      </div>
      {multi && (
        <ul className="mt-1 space-y-0.5 text-sm text-slate-500 dark:text-slate-400">
          {group.outages.map((outage) => (
            <li key={outage.id}>
              <UnitDetail outage={outage} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SummaryBar({ summary, kind }) {
  if (summary.total === 0) {
    return (
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800 dark:border-emerald-400/20 dark:bg-emerald-400/10 dark:text-emerald-200">
        No accessibility outages in this view right now.
      </div>
    );
  }
  const parts = [];
  if (!kind || kind === 'metro') parts.push(`SEPTA Metro ${summary.metro}`);
  if (!kind || kind === 'rail') parts.push(`Regional Rail ${summary.rail}`);
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-100">
      <span className="font-semibold">
        {summary.total} {summary.total === 1 ? 'unit' : 'units'} out
      </span>
      <span className="text-amber-700/70 dark:text-amber-200/70">·</span>
      <span>
        {summary.stations} {summary.stations === 1 ? 'station' : 'stations'}
      </span>
      {kind == null && (
        <>
          <span className="text-amber-700/70 dark:text-amber-200/70">·</span>
          <span>{parts.join(' / ')}</span>
        </>
      )}
    </div>
  );
}

function RecentNoticeRow({ outage }) {
  const active = !!outage.lifecycle?.active;
  return (
    <div className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="font-semibold text-slate-800 dark:text-slate-100">
            <StationLink outage={outage} />
          </span>
          <KindTag kind={outageKind(outage)} />
          <StationLines outage={outage} />
        </div>
        <span
          className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-semibold ${
            active
              ? 'bg-amber-100 text-amber-800 dark:bg-amber-400/15 dark:text-amber-200'
              : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-400/15 dark:text-emerald-200'
          }`}
        >
          {active ? 'Active' : 'Restored'}
        </span>
      </div>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
        <span className="capitalize">{outage.unit_type}</span>
        {outage.unit_label ? ` · ${outage.unit_label}` : ''} ·{' '}
        {active
          ? `out ${formatDuration(outage.durationMs) || 'just now'}`
          : `down ${formatDuration(outage.durationMs) || 'briefly'}`}
      </p>
      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
        {active
          ? `Reported ${formatDate(outage.lifecycle?.first_seen_ts)}`
          : `Restored ${formatDate(outage.lifecycle?.restored_ts)}`}
      </p>
      {outage.headline && (
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{outage.headline}</p>
      )}
    </div>
  );
}

function Sparkline({ values }) {
  const max = Math.max(...values, 1);
  return (
    <span className="inline-flex h-8 items-end gap-0.5" aria-hidden="true">
      {values.map((v, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed weekly buckets
          key={i}
          className="w-1.5 rounded-sm bg-blue-500/70 dark:bg-blue-400/70"
          style={{ height: `${Math.max(2, (v / max) * 28)}px` }}
        />
      ))}
    </span>
  );
}

function Filters({ kind, line, onKind, onLine }) {
  const showLines = kind === 'metro' || kind === 'rail';
  const lineOrder = kind === 'metro' ? METRO_LINE_ORDER : RAIL_LINE_ORDER;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => onKind(f.key)}
            aria-pressed={kind === f.key}
            className={`inline-flex min-h-[28px] items-center rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
              kind === f.key
                ? 'bg-slate-800 text-white dark:bg-slate-100 dark:text-slate-900'
                : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50 dark:bg-gh-surface dark:text-slate-300 dark:ring-gh-border dark:hover:bg-gh-subtle'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>
      {showLines && (
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => onLine(null)}
            aria-pressed={line === null}
            className={`inline-flex min-h-[28px] items-center rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
              line === null
                ? 'bg-slate-800 text-white dark:bg-slate-100 dark:text-slate-900'
                : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50 dark:bg-gh-surface dark:text-slate-300 dark:ring-gh-border dark:hover:bg-gh-subtle'
            }`}
          >
            All lines
          </button>
          {lineOrder.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => onLine(key)}
              aria-pressed={line === key}
              className={`rounded-full transition-opacity ${line && line !== key ? 'opacity-45' : ''}`}
            >
              <LinePill kind={kind} line={key} linked={false} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function AccessibilityPage() {
  const [dark, toggleDark] = useDarkMode();
  const now = useNow();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [kind, setKind] = useState('all');
  const [line, setLine] = useState(null);

  useEffect(() => {
    fetchAccessibilityData().then(setData).catch(setError);
  }, []);

  useEffect(() => {
    document.title = `Accessibility · ${SITE_NAME}`;
    return () => {
      document.title = SITE_NAME;
    };
  }, []);

  const outages = data?.outages || [];
  const kindFilter = kind === 'all' ? null : kind;
  const activeOutages = useMemo(
    () => currentlyOut(outages, { now, kind: kindFilter, line }),
    [outages, now, kindFilter, line],
  );
  const activeSummary = useMemo(() => summarizeOutages(activeOutages), [activeOutages]);
  const activeGroups = useMemo(() => groupOutagesByStation(activeOutages), [activeOutages]);
  const recentOutages = useMemo(
    () =>
      outages
        .filter((o) => !kindFilter || outageKind(o) === kindFilter)
        .filter((o) => outageHasLine(o, line))
        .map((o) => ({ ...o, durationMs: outageDuration(o, now) }))
        .sort((a, b) => (b.lifecycle?.first_seen_ts || 0) - (a.lifecycle?.first_seen_ts || 0))
        .slice(0, 20),
    [outages, now, kindFilter, line],
  );
  const reliability = useMemo(
    () => stationReliability(outages, { now, windowDays: 90, kind: kindFilter, line }),
    [outages, now, kindFilter, line],
  );

  const reliabilityOpts = {
    now,
    windowDays: 90,
    dataStartTs: data?.data_start_ts ?? null,
    kind: kindFilter,
    line,
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: the options are spelled out
  const elevators = useMemo(
    () => elevatorReliability(outages, reliabilityOpts),
    [outages, now, data?.data_start_ts, kindFilter, line],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: the options are spelled out
  const summary = useMemo(
    () => reliabilitySummary(outages, reliabilityOpts),
    [outages, now, data?.data_start_ts, kindFilter, line],
  );
  const [allElevators, setAllElevators] = useState(false);

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-gh-canvas flex flex-col">
      <Header
        generatedAt={data?.generated_at}
        dark={dark}
        onToggleDark={toggleDark}
        onResetFilters={() => {
          window.location.href = '/';
        }}
      />
      <main id="main" tabIndex={-1} className="max-w-5xl mx-auto px-4 py-6 space-y-5 w-full flex-1">
        <div>
          <Breadcrumb items={topLevelTrail('Accessibility')} className="mb-3" />
          <h1 className="text-xl font-bold text-slate-800 dark:text-slate-100">
            Accessibility outages
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            Elevator outages at SEPTA Metro and Regional Rail stations, archived separately from
            general service disruptions.
          </p>
        </div>

        <Filters
          kind={kind}
          line={line}
          onKind={(key) => {
            setKind(key);
            setLine(null);
          }}
          onLine={setLine}
        />

        {error && <p className="text-red-600 text-sm">Failed to load accessibility data.</p>}

        {!error && !data && (
          <div className="space-y-3 animate-pulse">
            <div className="h-32 bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border" />
            <div className="h-48 bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border" />
          </div>
        )}

        {data && (
          <>
            <SummaryBar summary={activeSummary} kind={kindFilter} />

            {activeOutages.length > 0 && (
              <section className="bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border overflow-hidden">
                <div className="p-4 border-b border-slate-100 dark:border-gh-border">
                  <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                    Active outages ({activeOutages.length})
                  </h2>
                </div>
                <div className="divide-y divide-slate-100 dark:divide-gh-border">
                  {activeGroups.map((group) => (
                    <StationOutageGroup key={group.key} group={group} />
                  ))}
                </div>
              </section>
            )}

            <section className="bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border">
              <div className="p-4 border-b border-slate-100 dark:border-gh-border">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  Recent notices
                </h2>
              </div>
              {recentOutages.length === 0 ? (
                <p className="p-4 text-sm text-slate-500 dark:text-slate-400">
                  No accessibility notices in this view yet.
                </p>
              ) : (
                <div className="divide-y divide-slate-100 dark:divide-gh-border">
                  {recentOutages.map((outage) => (
                    <RecentNoticeRow key={outage.id} outage={outage} />
                  ))}
                </div>
              )}
            </section>

            {elevators.length > 0 && (
              <section
                aria-labelledby="elevator-reliability-heading"
                className="bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border overflow-hidden"
              >
                <div className="p-4 border-b border-slate-100 dark:border-gh-border">
                  <h2
                    id="elevator-reliability-heading"
                    className="text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400"
                  >
                    Elevator reliability · last {summary.coveredDays} days
                  </h2>
                  <dl className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                    <div>
                      <dt className="text-xs text-slate-500 dark:text-slate-400">
                        Elevators that went out
                      </dt>
                      <dd className="text-lg font-semibold tabular-nums text-slate-800 dark:text-slate-100">
                        {summary.elevators}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-slate-500 dark:text-slate-400">
                        Out more than once
                      </dt>
                      <dd className="text-lg font-semibold tabular-nums text-slate-800 dark:text-slate-100">
                        {summary.repeat}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-slate-500 dark:text-slate-400">
                        Typical time to repair
                      </dt>
                      <dd className="text-lg font-semibold tabular-nums text-slate-800 dark:text-slate-100">
                        {summary.typicalRepairMs != null
                          ? formatDuration(summary.typicalRepairMs) || 'under 1m'
                          : '–'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-slate-500 dark:text-slate-400">Longest repair</dt>
                      <dd className="text-lg font-semibold tabular-nums text-slate-800 dark:text-slate-100">
                        {summary.longestRepairMs != null
                          ? formatDuration(summary.longestRepairMs) || 'under 1m'
                          : '–'}
                      </dd>
                    </div>
                  </dl>
                </div>
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
                      <tr className="border-b border-slate-100 dark:border-gh-border">
                        <th scope="col" className="text-left font-semibold p-3">
                          Elevator
                        </th>
                        <th scope="col" className="text-right font-semibold p-3">
                          Outages
                        </th>
                        <th scope="col" className="text-right font-semibold p-3">
                          Uptime
                        </th>
                        <th
                          scope="col"
                          className="hidden sm:table-cell text-right font-semibold p-3"
                        >
                          Typical repair
                        </th>
                        <th
                          scope="col"
                          className="hidden sm:table-cell text-right font-semibold p-3"
                        >
                          Longest outage
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-gh-border">
                      {(allElevators ? elevators : elevators.slice(0, 10)).map((row) => {
                        const href = stationHref(row);
                        return (
                          <tr key={row.key}>
                            <td className="p-3 text-slate-800 dark:text-slate-100">
                              <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                {href ? (
                                  <a href={href} className="font-medium hover:underline">
                                    {row.name}
                                  </a>
                                ) : (
                                  <span className="font-medium">{row.name}</span>
                                )}
                                <span className="text-slate-500 dark:text-slate-400">
                                  {row.unit}
                                </span>
                                {row.currentlyOut && (
                                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-400/15 dark:text-amber-200">
                                    out now
                                  </span>
                                )}
                              </span>
                            </td>
                            <td className="p-3 text-right tabular-nums text-slate-600 dark:text-slate-300">
                              {row.outageCount}
                            </td>
                            <td className="p-3 text-right tabular-nums text-slate-600 dark:text-slate-300">
                              {formatUptime(row.uptime)}
                            </td>
                            <td className="hidden sm:table-cell p-3 text-right tabular-nums text-slate-600 dark:text-slate-300">
                              {row.typicalRepairMs != null
                                ? formatDuration(row.typicalRepairMs) || 'under 1m'
                                : '–'}
                            </td>
                            <td className="hidden sm:table-cell p-3 text-right tabular-nums text-slate-600 dark:text-slate-300">
                              {formatDuration(row.longestMs) || 'under 1m'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {elevators.length > 10 && (
                  <div className="p-3 border-t border-slate-100 dark:border-gh-border">
                    <button
                      type="button"
                      onClick={() => setAllElevators((v) => !v)}
                      aria-expanded={allElevators}
                      className="text-sm text-blue-500 hover:text-blue-400 hover:underline"
                    >
                      {allElevators ? 'Show fewer' : `Show all ${elevators.length} elevators`}
                    </button>
                  </div>
                )}
                <p className="p-4 pt-2 text-xs text-slate-500 dark:text-slate-400">
                  Most outages first. Uptime is the share of the period an elevator wasn’t reported
                  out. SEPTA lists only the elevators that are out, so one that never appears here
                  was, as far as this archive can tell, working throughout.
                </p>
              </section>
            )}

            <section className="bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border overflow-hidden">
              <div className="p-4 border-b border-slate-100 dark:border-gh-border">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  By station · last 90 days
                </h2>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
                    <tr className="border-b border-slate-100 dark:border-gh-border">
                      <th className="text-left font-semibold p-3">Station</th>
                      <th className="text-right font-semibold p-3">Outages</th>
                      <th className="text-right font-semibold p-3">Total downtime</th>
                      <th className="text-left font-semibold p-3">Weekly</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-gh-border">
                    {reliability.map((row) => {
                      const href = stationHref(row);
                      return (
                        <tr key={`${row.kind}:${row.slug || row.name}`}>
                          <td className="p-3 text-slate-800 dark:text-slate-100">
                            <span className="flex flex-wrap items-center gap-2">
                              {href ? (
                                <a href={href} className="font-medium hover:underline">
                                  {row.name}
                                </a>
                              ) : (
                                <span className="font-medium">{row.name}</span>
                              )}
                              <KindTag kind={row.kind} />
                              {row.currentlyOut > 0 && (
                                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-400/15 dark:text-amber-200">
                                  {row.currentlyOut} active
                                </span>
                              )}
                            </span>
                          </td>
                          <td className="p-3 text-right tabular-nums text-slate-600 dark:text-slate-300">
                            {row.outageCount}
                          </td>
                          <td className="p-3 text-right tabular-nums text-slate-600 dark:text-slate-300">
                            {formatDuration(row.totalDownMs) || '0m'}
                          </td>
                          <td className="p-3">
                            <Sparkline values={row.weeklyDownMs} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="rounded-lg border border-slate-200 dark:border-gh-border bg-white dark:bg-gh-surface p-4 text-sm leading-relaxed text-slate-600 dark:text-slate-300 space-y-2">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                What's captured
              </h2>
              <p>
                SEPTA publishes <strong>elevator</strong> outages at SEPTA Metro and Regional Rail
                stations as a real-time feed, so each one is archived here as an outage with start
                and restore times. A unit that fails again after being restored is recorded as a new
                outage, so the history shows each episode.
              </p>
              <p>
                <strong>Escalators aren't included.</strong> SEPTA's real-time feed covers elevators
                only. An empty escalator history would reflect the data SEPTA makes public, not an
                outage-free system.
              </p>
            </section>
          </>
        )}
      </main>
      <Footer />
    </div>
  );
}
