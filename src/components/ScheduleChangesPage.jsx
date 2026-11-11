import { useEffect, useMemo, useState } from 'react';
import { useBrowseData } from '../hooks/useBrowseData.js';
import { useDarkMode } from '../hooks/useDarkMode.js';
import { useNow } from '../hooks/useNow.js';
import { topLevelTrail } from '../lib/breadcrumbs.js';
import { loadScheduleChanges } from '../lib/publishedFiles.js';
import {
  changeRoute,
  changeSummary,
  DAY_TYPE_LABELS,
  DAY_TYPES,
  dayChange,
  effectiveLabel,
  longDate,
  percentChange,
  phillyDateKey,
  routesFor,
  shortDate,
  specialDayText,
  upcomingSpecialDays,
} from '../lib/scheduleChanges.js';
import { SITE_NAME } from '../lib/site.js';
import Breadcrumb from './Breadcrumb.jsx';
import Footer from './Footer.jsx';
import Header from './Header.jsx';
import LinePill from './LinePill.jsx';

const CARD = 'bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border';
const H2 = 'text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400';
const CHIP =
  'inline-flex items-center min-h-[32px] px-3 py-1 rounded-full text-sm font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500';
const CHIP_ON = 'bg-slate-800 dark:bg-slate-200 text-white dark:text-slate-800';
const CHIP_OFF =
  'bg-white dark:bg-gh-surface text-slate-600 dark:text-slate-300 ring-1 ring-slate-200 dark:ring-gh-border hover:bg-slate-50 dark:hover:bg-gh-subtle';
const MODES = [
  { key: 'all', label: 'All' },
  { key: 'bus', label: 'Bus' },
  { key: 'metro', label: 'SEPTA Metro' },
];
const KIND_TAG = { new: 'New', ended: 'No longer scheduled' };

function DayCell({ day }) {
  if (!day) return <span className="text-slate-300 dark:text-slate-600">–</span>;
  const { trips, times } = dayChange(day);
  return (
    <span className="block space-y-0.5">
      {trips && <span className="block tabular-nums">{trips}</span>}
      {times.map((t) => (
        <span key={t} className="block text-xs text-slate-500 dark:text-slate-400">
          {t}
        </span>
      ))}
    </span>
  );
}

function ChangeSet({ set, mode, today }) {
  const routes = routesFor(set, mode);
  const summary = changeSummary(set);
  const when = effectiveLabel(set.effective, today);
  const [open, setOpen] = useState(false);
  const shown = open ? routes : routes.slice(0, 12);
  return (
    <section
      className={`${CARD} overflow-hidden`}
      aria-label={`Changes from ${longDate(set.effective)}`}
    >
      <div className="p-4 border-b border-slate-100 dark:border-gh-border space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-bold text-slate-800 dark:text-slate-100">
            From {longDate(set.effective)}
          </h2>
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
              when === 'in effect'
                ? 'bg-slate-100 text-slate-700 dark:bg-gh-subtle dark:text-slate-200'
                : 'bg-blue-100 text-blue-800 dark:bg-blue-400/15 dark:text-blue-200'
            }`}
          >
            {when}
          </span>
        </div>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {summary.routes} route{summary.routes === 1 ? '' : 's'} change
          {summary.routes === 1 ? 's' : ''}
          {summary.fewer ? ` · ${summary.fewer} with fewer trips` : ''}
          {summary.more ? ` · ${summary.more} with more` : ''}
          {summary.added ? ` · ${summary.added} new` : ''}
          {summary.ended ? ` · ${summary.ended} no longer scheduled` : ''}
        </p>
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          {DAY_TYPES.map((type) => {
            const pair = set.totals?.[type];
            if (!pair) return null;
            const pct = percentChange(pair);
            return (
              <div key={type} className="flex items-baseline gap-1.5">
                <dt className="text-xs text-slate-500 dark:text-slate-400">
                  {DAY_TYPE_LABELS[type]} trips
                </dt>
                <dd className="tabular-nums text-slate-800 dark:text-slate-100">
                  {pair[0].toLocaleString('en-US')} → {pair[1].toLocaleString('en-US')}
                  {pct && <span className="text-slate-500 dark:text-slate-400"> ({pct})</span>}
                </dd>
              </div>
            );
          })}
        </dl>
      </div>
      {routes.length === 0 ? (
        <p className="p-4 text-sm text-slate-500 dark:text-slate-400">
          Nothing changes for this mode.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
              <tr className="border-b border-slate-100 dark:border-gh-border">
                <th scope="col" className="p-3 text-left font-semibold">
                  Route
                </th>
                {DAY_TYPES.map((type) => (
                  <th key={type} scope="col" className="p-3 text-left font-semibold">
                    {DAY_TYPE_LABELS[type]} trips
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-gh-border">
              {shown.map((r) => {
                const id = changeRoute(r);
                return (
                  <tr key={`${r.mode}-${r.route}`} className="align-top">
                    <td className="p-3">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <LinePill kind={id.kind} line={r.route} />
                        {KIND_TAG[r.kind] && (
                          <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                            {KIND_TAG[r.kind]}
                          </span>
                        )}
                      </span>
                    </td>
                    {DAY_TYPES.map((type) => (
                      <td key={type} className="p-3 text-slate-700 dark:text-slate-200">
                        <DayCell day={r.days[type]} />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {routes.length > 12 && (
        <div className="p-3 border-t border-slate-100 dark:border-gh-border">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="text-sm text-blue-500 hover:text-blue-400 hover:underline"
          >
            {open ? 'Show fewer' : `Show all ${routes.length} routes`}
          </button>
        </div>
      )}
    </section>
  );
}

export default function ScheduleChangesPage() {
  const [dark, toggleDark] = useDarkMode();
  const now = useNow();
  const { officialRecords, detectionRecords } = useBrowseData();
  const [file, setFile] = useState(undefined);
  const [mode, setMode] = useState('all');

  useEffect(() => {
    loadScheduleChanges().then(setFile);
  }, []);

  useEffect(() => {
    document.title = `Schedule changes · ${SITE_NAME}`;
    return () => {
      document.title = SITE_NAME;
    };
  }, []);

  const today = phillyDateKey(now);
  const special = useMemo(() => upcomingSpecialDays(file, today), [file, today]);
  const changes = file?.changes ?? [];

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-gh-canvas flex flex-col">
      <Header
        generatedAt={file?.generated_at ?? null}
        dark={dark}
        onToggleDark={toggleDark}
        onResetFilters={() => {
          window.location.href = '/';
        }}
        alerts={officialRecords}
        observations={detectionRecords}
      />
      <main id="main" tabIndex={-1} className="max-w-4xl mx-auto px-4 py-6 space-y-5 w-full flex-1">
        <div>
          <Breadcrumb items={topLevelTrail('Schedule changes')} className="mb-3" />
          <h1 className="text-xl font-bold text-slate-800 dark:text-slate-100">Schedule changes</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            What changes when SEPTA's bus and Metro timetable does, route by route, and the days
            ahead that don't run the usual timetable for their weekday. Worked out from the
            timetable SEPTA publishes.
          </p>
        </div>

        {file === undefined && (
          <div
            className="space-y-3 animate-pulse"
            role="status"
            aria-label="Loading schedule changes"
          >
            <div className={`${CARD} h-24`} />
            <div className={`${CARD} h-56`} />
          </div>
        )}

        {file === null && (
          <p className={`${CARD} p-4 text-sm text-slate-600 dark:text-slate-300`}>
            Schedule changes aren't available right now. They appear once the collector has read
            SEPTA's timetable.
          </p>
        )}

        {file && (
          <>
            <section className={`${CARD} overflow-hidden`} aria-labelledby="special-heading">
              <div className="p-4 border-b border-slate-100 dark:border-gh-border">
                <h2 id="special-heading" className={H2}>
                  Holiday and special timetables · next 4 weeks
                </h2>
              </div>
              {special.length ? (
                <ul className="divide-y divide-slate-100 dark:divide-gh-border">
                  {special.map((d) => (
                    <li key={d.date} className="p-4">
                      <p className="font-medium text-slate-800 dark:text-slate-100">
                        {shortDate(d.date)}
                        {d.holiday ? ` · ${d.holiday.replace(/^the /, 'The ')}` : ''}
                      </p>
                      <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-300">
                        {specialDayText(d)}
                      </p>
                      {d.routes_off.length > 0 && (
                        <details className="mt-1 text-sm">
                          <summary className="cursor-pointer text-blue-500 hover:text-blue-400">
                            {d.routes_off.length} route{d.routes_off.length === 1 ? '' : 's'} not
                            running
                          </summary>
                          <span className="mt-2 flex flex-wrap gap-1">
                            {d.routes_off.map((route) => (
                              <LinePill
                                key={route}
                                kind={
                                  changeRoute({
                                    route,
                                    mode: /^[a-z]\d$/.test(route) ? 'metro' : 'bus',
                                  }).kind
                                }
                                line={route}
                                compact
                              />
                            ))}
                          </span>
                        </details>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="p-4 text-sm text-slate-500 dark:text-slate-400">
                  Every day in the next four weeks runs its usual timetable.
                </p>
              )}
            </section>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className={H2}>Timetable changes</h2>
              <fieldset className="flex flex-wrap items-center gap-1.5">
                <legend className="sr-only">Mode</legend>
                {MODES.map((m) => (
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
            </div>

            {changes.length ? (
              changes.map((set) => <ChangeSet key={set.id} set={set} mode={mode} today={today} />)
            ) : (
              <p className={`${CARD} p-4 text-sm text-slate-600 dark:text-slate-300`}>
                No timetable change is on record yet. One appears here when SEPTA publishes a
                timetable that differs from the one before it.
              </p>
            )}

            <section
              className={`${CARD} p-4 text-sm leading-relaxed text-slate-600 dark:text-slate-300 space-y-2`}
            >
              <h2 className={H2}>How this is worked out</h2>
              <p>
                {file.feed_version
                  ? `The timetable in use is SEPTA's ${file.feed_version}`
                  : "SEPTA's timetable"}
                {file.feed_start && file.feed_end
                  ? `, covering ${shortDate(file.feed_start)} to ${shortDate(file.feed_end)}. `
                  : '. '}
                A typical weekday, Saturday and Sunday is taken for each stretch of it, and
                consecutive stretches are compared: the trips each route runs, and its first and
                last trip when either moves ten minutes or more. Trips are counted in both
                directions.
              </p>
              <p>
                <strong>Buses and SEPTA Metro only.</strong> Regional Rail's timetable is a separate
                file this site doesn't read, so its changes and holiday service aren't here: see{' '}
                <a
                  href="https://www.septa.org/schedules/"
                  className="text-blue-500 hover:text-blue-400 hover:underline"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  septa.org
                </a>
                .
              </p>
            </section>
          </>
        )}
      </main>
      <Footer />
    </div>
  );
}
