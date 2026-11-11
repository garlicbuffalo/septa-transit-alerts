import { useEffect, useMemo, useState } from 'react';
import { useBrowseData } from '../hooks/useBrowseData.js';
import { useDarkMode } from '../hooks/useDarkMode.js';
import { topLevelTrail } from '../lib/breadcrumbs.js';
import { loadRailTrains, loadScorecards } from '../lib/publishedFiles.js';
import {
  chronicTrains,
  dayStatus,
  findTrains,
  lateShare,
  MEASURES,
  measureCell,
  measureKeys,
  minutesLabel,
  mostCancelledTrains,
  routeIdentity,
  SCORE_MODES,
  scoreRows,
  sortRows,
  trainRoute,
  weekLabel,
  weightsText,
} from '../lib/scorecards.js';
import { SITE_NAME } from '../lib/site.js';
import Breadcrumb from './Breadcrumb.jsx';
import Footer from './Footer.jsx';
import Header from './Header.jsx';
import LinePill from './LinePill.jsx';

const CARD = 'bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border';
const H2 = 'text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400';
const LINK = 'text-blue-500 hover:text-blue-400 hover:underline';
const CHIP =
  'inline-flex items-center min-h-[32px] px-3 py-1 rounded-full text-sm font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500';
const CHIP_ON = 'bg-slate-800 dark:bg-slate-200 text-white dark:text-slate-800';
const CHIP_OFF =
  'bg-white dark:bg-gh-surface text-slate-600 dark:text-slate-300 ring-1 ring-slate-200 dark:ring-gh-border hover:bg-slate-50 dark:hover:bg-gh-subtle';

const MODE_KEYS = SCORE_MODES.map((m) => m.key);

function readParams() {
  const params = new URLSearchParams(window.location.search);
  const mode = params.get('mode');
  const train = params.get('train');
  return {
    // A link to a train opens on Regional Rail.
    mode: MODE_KEYS.includes(mode) ? mode : train ? 'rail' : 'bus',
    train: train ? train.replace(/[^0-9a-z]/gi, '') : '',
  };
}

// A score out of 100 as a bar with the number beside it. One measure, one hue;
// the number carries the value, so the bar never has to be read on its own.
function ScoreBar({ score }) {
  return (
    <span className="flex items-center gap-2">
      <span
        aria-hidden="true"
        className="hidden sm:block h-2 w-24 rounded-full bg-slate-100 dark:bg-gh-subtle overflow-hidden"
      >
        <span
          className="block h-full rounded-full bg-blue-500 dark:bg-blue-400"
          style={{ width: `${Math.max(2, Math.min(100, score))}%` }}
        />
      </span>
      <span className="tabular-nums font-semibold text-slate-800 dark:text-slate-100">
        {Math.round(score)}
      </span>
    </span>
  );
}

// The score week by week, oldest first, as a small line.
function Trend({ values }) {
  const points = values.map((v, i) => [i, v]).filter(([, v]) => v != null);
  if (points.length < 2) return <span className="text-slate-300 dark:text-slate-600">–</span>;
  const w = 64;
  const h = 20;
  const x = (i) => 2 + (i / (values.length - 1)) * (w - 4);
  const y = (v) => h - 2 - (v / 100) * (h - 4);
  const d = points.map(([i, v], n) => `${n ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const [lastI, lastV] = points.at(-1);
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" className="block">
      <path
        d={d.join(' ')}
        fill="none"
        strokeWidth="1.5"
        className="stroke-slate-400 dark:stroke-slate-500"
      />
      <circle cx={x(lastI)} cy={y(lastV)} r="2" className="fill-blue-500 dark:fill-blue-400" />
    </svg>
  );
}

function Change({ score, previous }) {
  if (previous == null) return <span className="text-slate-400 dark:text-slate-500">new</span>;
  const delta = Math.round(score) - Math.round(previous);
  if (delta === 0) return <span className="text-slate-400 dark:text-slate-500">±0</span>;
  return (
    <span
      className={
        delta > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
      }
    >
      {delta > 0 ? '▲' : '▼'} {Math.abs(delta)}
    </span>
  );
}

function SortHeader({ label, sortKey, sort, onSort, align = 'right' }) {
  const active = sort === sortKey;
  return (
    <th
      scope="col"
      aria-sort={active ? 'descending' : 'none'}
      className={`p-2 font-semibold ${align === 'left' ? 'text-left' : 'text-right'}`}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 uppercase tracking-wider hover:text-slate-700 dark:hover:text-slate-200 ${
          active ? 'text-slate-800 dark:text-slate-100' : ''
        }`}
      >
        {label}
        <span aria-hidden="true" className={active ? '' : 'opacity-0'}>
          ↓
        </span>
      </button>
    </th>
  );
}

function ScoreTable({ file, mode }) {
  const [sort, setSort] = useState('rank');
  const rows = useMemo(() => scoreRows(file, mode), [file, mode]);
  const sorted = useMemo(() => sortRows(rows, sort, mode), [rows, sort, mode]);
  const keys = measureKeys(file, mode);
  const pillKind = mode;
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="text-xs text-slate-500 dark:text-slate-400">
          <tr className="border-b border-slate-100 dark:border-gh-border">
            <SortHeader label="#" sortKey="rank" sort={sort} onSort={setSort} align="left" />
            <SortHeader
              label={mode === 'bus' ? 'Route' : 'Line'}
              sortKey="route"
              sort={sort}
              onSort={setSort}
              align="left"
            />
            <th scope="col" className="p-2 text-left font-semibold uppercase tracking-wider">
              Score
            </th>
            <th scope="col" className="p-2 text-right font-semibold uppercase tracking-wider">
              vs last week
            </th>
            {keys.map((key) => (
              <SortHeader
                key={key}
                label={MEASURES[key].heading}
                sortKey={key}
                sort={sort}
                onSort={setSort}
              />
            ))}
            <th
              scope="col"
              className="hidden md:table-cell p-2 text-left font-semibold uppercase tracking-wider"
            >
              Trend
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-gh-border">
          {sorted.map((row) => {
            const id = routeIdentity(mode, row.route);
            return (
              <tr key={row.route}>
                <td className="p-2 tabular-nums text-slate-500 dark:text-slate-400">{row.rank}</td>
                <td className="p-2">
                  <span className="flex items-center gap-2 min-w-0">
                    <LinePill kind={pillKind} line={row.route} />
                    {mode !== 'rail' && id.name && (
                      <span className="hidden lg:inline truncate text-xs text-slate-500 dark:text-slate-400 max-w-[14rem]">
                        {mode === 'metro' ? id.name.replace(`${id.label} `, '') : id.name}
                      </span>
                    )}
                  </span>
                </td>
                <td className="p-2">
                  <ScoreBar score={row.score} />
                </td>
                <td className="p-2 text-right tabular-nums text-xs">
                  <Change score={row.score} previous={row.previous} />
                </td>
                {keys.map((key) => (
                  <td
                    key={key}
                    className="p-2 text-right tabular-nums text-slate-600 dark:text-slate-300 whitespace-nowrap"
                  >
                    {measureCell(row, key, mode)}
                  </td>
                ))}
                <td className="hidden md:table-cell p-2">
                  <Trend values={row.trend} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const DAY_CELL = {
  'on-time': 'bg-emerald-500/80',
  late: 'bg-amber-500',
  cancelled: 'bg-red-500',
  none: 'bg-slate-200 dark:bg-gh-subtle',
};
const DAY_WORD = {
  'on-time': 'on time',
  late: 'late',
  cancelled: 'cancelled',
  none: 'not seen',
};
const dayTitle = (key, value, onTimeMax) => {
  const date = new Date(`${key}T12:00:00Z`).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  const status = dayStatus(value, onTimeMax);
  if (status === 'none') return `${date}: not seen`;
  if (status === 'cancelled') return `${date}: cancelled`;
  return `${date}: ${value ? `up to ${value} min late` : 'on time'}`;
};

// A train's four weeks, a cell a day: colour says how it went, the title and
// the list beneath it say the same in words.
function DayStrip({ train, days, onTimeMax }) {
  return (
    <div className="flex flex-wrap gap-[3px]" role="img" aria-label="Each day of the window">
      {days.map((key, i) => {
        const status = dayStatus(train.daily[i], onTimeMax);
        return (
          <span
            key={key}
            title={dayTitle(key, train.daily[i], onTimeMax)}
            className={`h-4 w-4 rounded-sm ${DAY_CELL[status]}`}
          />
        );
      })}
    </div>
  );
}

function TrainCard({ train, file }) {
  const when = minutesLabel(train.first_seen_min);
  const share = lateShare(train);
  return (
    <div className={`${CARD} p-4 space-y-3`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-lg font-bold text-slate-800 dark:text-slate-100">
          Train #{train.no}
        </span>
        <LinePill kind="rail" line={train.line} />
        <span className="text-sm text-slate-600 dark:text-slate-300">{trainRoute(train)}</span>
      </div>
      {when && (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Usually first on SEPTA's tracker around {when}.
        </p>
      )}
      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
        <div>
          <dt className="text-xs text-slate-500 dark:text-slate-400">Days it ran</dt>
          <dd className="font-semibold text-slate-800 dark:text-slate-100 tabular-nums">
            {train.ran}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500 dark:text-slate-400">Late</dt>
          <dd className="font-semibold text-slate-800 dark:text-slate-100 tabular-nums">
            {train.late}
            {share != null && train.ran > 0 && (
              <span className="font-normal text-slate-500 dark:text-slate-400">
                {' '}
                ({Math.round(share * 100)}%)
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500 dark:text-slate-400">Cancelled</dt>
          <dd className="font-semibold text-slate-800 dark:text-slate-100 tabular-nums">
            {train.cancelled}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500 dark:text-slate-400">Average / worst</dt>
          <dd className="font-semibold text-slate-800 dark:text-slate-100 tabular-nums">
            {train.avg_late ?? '–'} / {train.worst} min
          </dd>
        </div>
      </dl>
      <DayStrip train={train} days={file.days} onTimeMax={file.on_time_max} />
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
        {Object.keys(DAY_CELL).map((status) => (
          <li key={status} className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className={`h-3 w-3 rounded-sm ${DAY_CELL[status]}`} />
            {DAY_WORD[status]}
          </li>
        ))}
      </ul>
    </div>
  );
}

function TrainTable({ trains, onPick, cancelled = false }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
          <tr className="border-b border-slate-100 dark:border-gh-border">
            <th scope="col" className="p-2 text-left font-semibold">
              Train
            </th>
            <th scope="col" className="p-2 text-left font-semibold">
              Line
            </th>
            <th scope="col" className="hidden sm:table-cell p-2 text-left font-semibold">
              Runs
            </th>
            <th scope="col" className="p-2 text-right font-semibold">
              {cancelled ? 'Cancelled' : 'Late'}
            </th>
            <th scope="col" className="p-2 text-right font-semibold">
              {cancelled ? 'Days seen' : 'Avg late'}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-gh-border">
          {trains.map((t) => (
            <tr key={t.no}>
              <td className="p-2">
                <button
                  type="button"
                  onClick={() => onPick(t.no)}
                  className={`${LINK} font-semibold tabular-nums`}
                >
                  #{t.no}
                </button>
              </td>
              <td className="p-2">
                <LinePill kind="rail" line={t.line} compact />
              </td>
              <td className="hidden sm:table-cell p-2 text-slate-600 dark:text-slate-300">
                {trainRoute(t)}
                {minutesLabel(t.first_seen_min) && (
                  <span className="text-slate-400 dark:text-slate-500">
                    {' '}
                    · ~{minutesLabel(t.first_seen_min)}
                  </span>
                )}
              </td>
              <td className="p-2 text-right tabular-nums text-slate-700 dark:text-slate-200 whitespace-nowrap">
                {cancelled ? t.cancelled : `${t.late} of ${t.ran} days`}
              </td>
              <td className="p-2 text-right tabular-nums text-slate-600 dark:text-slate-300 whitespace-nowrap">
                {cancelled ? t.seen : `${t.avg_late} min`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Trains({ file, query, onQuery }) {
  const chronic = useMemo(() => chronicTrains(file.trains).slice(0, 15), [file]);
  const cancelled = useMemo(() => mostCancelledTrains(file.trains), [file]);
  const matches = useMemo(() => findTrains(file.trains, query), [file, query]);
  const exact =
    matches.find((t) => String(t.no) === query) ?? (matches.length === 1 ? matches[0] : null);
  return (
    <section className="space-y-4" aria-labelledby="trains-heading">
      <div>
        <h2 id="trains-heading" className={H2}>
          Train by train · {weekLabel(file.from, file.to)}
        </h2>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
          Every train number on SEPTA's TrainView over the past four weeks. A train is late on a day
          when it was more than {file.on_time_max} minutes behind at its worst.
        </p>
      </div>
      <div className={`${CARD} p-4`}>
        <label
          htmlFor="train-search"
          className="block text-sm font-medium text-slate-700 dark:text-slate-200"
        >
          Look up a train number
        </label>
        <input
          id="train-search"
          type="search"
          inputMode="numeric"
          value={query}
          onChange={(e) => onQuery(e.target.value.replace(/[^0-9a-z]/gi, ''))}
          placeholder="e.g. 9531"
          className="mt-1 w-full sm:w-64 px-3 py-2 text-sm rounded border border-slate-200 dark:border-gh-border bg-white dark:bg-gh-canvas text-slate-800 dark:text-slate-100"
        />
        {query && matches.length === 0 && (
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400" role="status">
            No train #{query} on the tracker in these four weeks.
          </p>
        )}
        {query && !exact && matches.length > 1 && (
          <ul className="mt-2 flex flex-wrap gap-2" aria-label="Matching trains">
            {matches.map((t) => (
              <li key={t.no}>
                <button
                  type="button"
                  onClick={() => onQuery(String(t.no))}
                  className={`${CHIP} ${CHIP_OFF}`}
                >
                  #{t.no}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {exact && <TrainCard train={exact} file={file} />}

      <div className={`${CARD} overflow-hidden`}>
        <div className="p-4 border-b border-slate-100 dark:border-gh-border">
          <h3 className={H2}>Late most often</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Trains that ran at least 8 days and were late on half of them or more.
          </p>
        </div>
        {chronic.length ? (
          <TrainTable trains={chronic} onPick={onQuery} />
        ) : (
          <p className="p-4 text-sm text-slate-500 dark:text-slate-400">
            No train was late that often in these four weeks.
          </p>
        )}
      </div>

      {cancelled.length > 0 && (
        <div className={`${CARD} overflow-hidden`}>
          <div className="p-4 border-b border-slate-100 dark:border-gh-border">
            <h3 className={H2}>Cancelled most often</h3>
          </div>
          <TrainTable trains={cancelled} onPick={onQuery} cancelled />
        </div>
      )}
    </section>
  );
}

export default function ScorecardsPage() {
  const [dark, toggleDark] = useDarkMode();
  const { officialRecords, detectionRecords } = useBrowseData();
  const [params] = useState(readParams);
  const [mode, setMode] = useState(params.mode);
  const [train, setTrain] = useState(params.train);
  const [cards, setCards] = useState(undefined);
  const [trains, setTrains] = useState(undefined);

  useEffect(() => {
    loadScorecards().then(setCards);
    loadRailTrains().then(setTrains);
  }, []);

  useEffect(() => {
    document.title = `Scorecards · ${SITE_NAME}`;
    return () => {
      document.title = SITE_NAME;
    };
  }, []);

  // The mode and the train looked up are in the URL, so a view is a link.
  useEffect(() => {
    const next = new URLSearchParams(window.location.search);
    if (mode === 'bus') next.delete('mode');
    else next.set('mode', mode);
    if (train && mode === 'rail') next.set('train', train);
    else next.delete('train');
    const qs = next.toString();
    const url = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`;
    if (url !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      window.history.replaceState(null, '', url);
    }
  }, [mode, train]);

  const loading = cards === undefined || trains === undefined;
  const latest = cards?.modes?.[mode]?.latest ?? null;
  const spec = SCORE_MODES.find((m) => m.key === mode);

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-gh-canvas flex flex-col">
      <Header
        generatedAt={cards?.generated_at ?? null}
        dark={dark}
        onToggleDark={toggleDark}
        onResetFilters={() => {
          window.location.href = '/';
        }}
        alerts={officialRecords}
        observations={detectionRecords}
      />
      <main id="main" tabIndex={-1} className="max-w-5xl mx-auto px-4 py-6 space-y-5 w-full flex-1">
        <div>
          <Breadcrumb items={topLevelTrail('Scorecards')} className="mb-3" />
          <h1 className="text-xl font-bold text-slate-800 dark:text-slate-100">Scorecards</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            Every bus route, SEPTA Metro line and Regional Rail line, scored out of 100 on how the
            past week went, and every Regional Rail train on how often it runs late.
          </p>
        </div>

        <fieldset className="flex flex-wrap items-center gap-1.5">
          <legend className="sr-only">Mode</legend>
          {SCORE_MODES.map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => setMode(m.key)}
              aria-pressed={mode === m.key}
              className={`${CHIP} ${mode === m.key ? CHIP_ON : CHIP_OFF}`}
            >
              {m.label}
            </button>
          ))}
        </fieldset>

        {loading && (
          <div className="space-y-3 animate-pulse" role="status" aria-label="Loading scorecards">
            <div className={`${CARD} h-24`} />
            <div className={`${CARD} h-64`} />
          </div>
        )}

        {!loading && (
          <>
            <section className={`${CARD} overflow-hidden`} aria-labelledby="scores-heading">
              <div className="p-4 border-b border-slate-100 dark:border-gh-border">
                <h2 id="scores-heading" className={H2}>
                  {spec.label}
                  {latest ? ` · week of ${weekLabel(latest.from, latest.to)}` : ''}
                </h2>
                {latest && (
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                    {latest.ranked} {spec.noun} ranked. The score weighs {weightsText(cards, mode)}.
                    Each measure is ranked against the week's other {spec.noun}, so a score says how
                    a {mode === 'bus' ? 'route' : 'line'} did beside the rest, not against a fixed
                    standard.
                  </p>
                )}
              </div>
              {latest ? (
                <ScoreTable key={mode} file={cards} mode={mode} />
              ) : (
                <p className="p-4 text-sm text-slate-500 dark:text-slate-400">
                  No week has been scored for {spec.label} yet. Scores come from the project's bot
                  server, which works them out each Sunday for the week just ended once it has seen
                  enough of it.
                </p>
              )}
            </section>

            {latest && (
              <section
                className={`${CARD} p-4 text-sm leading-relaxed text-slate-600 dark:text-slate-300 space-y-2`}
              >
                <h2 className={H2}>How to read it</h2>
                {mode === 'rail' ? (
                  <p>
                    <strong>On time</strong> is the share of trains that ran and were never more
                    than {cards.on_time?.rail?.lateMin ?? 5} minutes late.{' '}
                    <strong>Cancelled</strong> is the share SEPTA cancelled.{' '}
                    <strong>Avg late</strong> is the average of each train's worst lateness.{' '}
                    <strong>Mph</strong> is the average speed along the line, stops included. All
                    from SEPTA's TrainView as the bot server polls it.
                  </p>
                ) : (
                  <p>
                    <strong>On time</strong> is the share of vehicle reports between{' '}
                    {cards.on_time?.[mode]?.earlyMin ?? 1} minute early and{' '}
                    {cards.on_time?.[mode]?.lateMin ?? 5} minutes late, by SEPTA's own lateness.{' '}
                    <strong>Cancelled</strong> counts trips SEPTA cancelled in its trip feed.{' '}
                    <strong>Mph</strong> is the average speed, stops included.{' '}
                    <strong>Bunches</strong> and <strong>long gaps</strong> are what this site's
                    detectors saw. Those three counts are shown as counted, but scored per minute of
                    service seen, so a busy route isn't marked down for running more buses.
                  </p>
                )}
                <p>
                  The same scores are behind the bots' weekly Hall of Fame and Wall of Shame posts.
                  {mode === 'metro' &&
                    ' The Broad Street Line reports no positions, so it has no score.'}
                </p>
              </section>
            )}

            {mode === 'rail' &&
              (trains ? (
                <Trains file={trains} query={train} onQuery={setTrain} />
              ) : (
                <p className={`${CARD} p-4 text-sm text-slate-500 dark:text-slate-400`}>
                  The train-by-train record isn't available right now. It comes from the project's
                  bot server.
                </p>
              ))}
          </>
        )}
      </main>
      <Footer />
    </div>
  );
}
