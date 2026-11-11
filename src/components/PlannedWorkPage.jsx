import { useEffect, useMemo, useState } from 'react';
import { useDarkMode } from '../hooks/useDarkMode.js';
import { useNow } from '../hooks/useNow.js';
import { topLevelTrail } from '../lib/breadcrumbs.js';
import { formatPhillyDay } from '../lib/format.js';
import { loadRecent } from '../lib/incidentStore.js';
import { incidentRecords } from '../lib/incidents.js';
import {
  AHEAD_DAYS,
  dayText,
  filterPlanned,
  LONG_RUNNING_DAYS,
  layoutPlanned,
  plannedItems,
  windowText,
} from '../lib/plannedWork.js';
import { loadScheduleChanges } from '../lib/publishedFiles.js';
import {
  phillyDateKey,
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
const LINK = 'text-blue-500 hover:text-blue-400 hover:underline';
const CHIP =
  'inline-flex items-center min-h-[32px] px-3 py-1 rounded-full text-sm font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500';
const CHIP_ON = 'bg-slate-800 dark:bg-slate-200 text-white dark:text-slate-800';
const CHIP_OFF =
  'bg-white dark:bg-gh-surface text-slate-600 dark:text-slate-300 ring-1 ring-slate-200 dark:ring-gh-border hover:bg-slate-50 dark:hover:bg-gh-subtle';

const KINDS = [
  { key: null, label: 'All' },
  { key: 'metro', label: 'SEPTA Metro' },
  { key: 'bus', label: 'Bus' },
  { key: 'rail', label: 'Regional Rail' },
];
const DAY_MS = 24 * 60 * 60 * 1000;

function Item({ item, now, tag = null }) {
  return (
    <li className="p-4">
      <div className="flex flex-wrap items-center gap-1.5">
        {item.parts.map((part) => (
          <LinePill
            key={`${part.kind}-${part.routes.join('-')}`}
            kind={part.kind}
            routes={part.routes}
          />
        ))}
        {tag && (
          <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-800 dark:bg-blue-400/15 dark:text-blue-200">
            {tag}
          </span>
        )}
      </div>
      <p className="mt-1.5 font-medium text-slate-800 dark:text-slate-100">
        <a href={`/event/${encodeURIComponent(item.id)}`} className="hover:underline">
          {item.headline}
        </a>
      </p>
      <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">{windowText(item, now)}</p>
    </li>
  );
}

function Section({ id, title, note, children }) {
  return (
    <section className={`${CARD} overflow-hidden`} aria-labelledby={id}>
      <div className="p-4 border-b border-slate-100 dark:border-gh-border">
        <h2 id={id} className={H2}>
          {title}
        </h2>
        {note && <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">{note}</p>}
      </div>
      {children}
    </section>
  );
}

const List = ({ children }) => (
  <ul className="divide-y divide-slate-100 dark:divide-gh-border">{children}</ul>
);

export default function PlannedWorkPage() {
  const [dark, toggleDark] = useDarkMode();
  const now = useNow();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [schedule, setSchedule] = useState(null);
  const [kind, setKind] = useState(() => {
    const k = new URLSearchParams(window.location.search).get('mode');
    return ['metro', 'bus', 'rail'].includes(k) ? k : null;
  });

  useEffect(() => {
    loadRecent()
      .then((fresh) => setData({ ...fresh, incidents: fresh.incidents || [] }))
      .catch(setError);
    loadScheduleChanges().then(setSchedule);
  }, []);

  useEffect(() => {
    document.title = `Planned work · ${SITE_NAME}`;
    return () => {
      document.title = SITE_NAME;
    };
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (kind) params.set('mode', kind);
    else params.delete('mode');
    const qs = params.toString();
    const url = `${window.location.pathname}${qs ? `?${qs}` : ''}`;
    if (url !== `${window.location.pathname}${window.location.search}`) {
      window.history.replaceState(null, '', url);
    }
  }, [kind]);

  const flat = useMemo(() => (data ? incidentRecords(data.incidents) : null), [data]);
  const items = useMemo(
    () => (data ? filterPlanned(plannedItems(data.incidents, now), kind) : []),
    [data, now, kind],
  );
  const layout = useMemo(() => layoutPlanned(items, now), [items, now]);
  // Holiday timetables are bus and Metro only, so they sit out a Regional Rail view.
  const special = useMemo(
    () =>
      kind === 'rail'
        ? []
        : upcomingSpecialDays(schedule, phillyDateKey(now)).filter(
            (d) => d.date <= phillyDateKey(now + 21 * DAY_MS),
          ),
    [schedule, now, kind],
  );
  const { saturday, sunday } = layout.weekend;
  const nothing = data && items.length === 0;

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
      <main id="main" tabIndex={-1} className="max-w-3xl mx-auto px-4 py-6 space-y-5 w-full flex-1">
        <div>
          <Breadcrumb items={topLevelTrail('Planned work')} className="mb-3" />
          <h1 className="text-xl font-bold text-slate-800 dark:text-slate-100">
            Planned work ahead
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            The service changes SEPTA has announced in advance: shuttle buses, closures, diversions
            and construction, by when they happen. Unplanned disruptions are on the{' '}
            <a href="/" className={LINK}>
              alerts page
            </a>
            .
          </p>
        </div>

        <fieldset className="flex flex-wrap items-center gap-1.5">
          <legend className="sr-only">Mode</legend>
          {KINDS.map((k) => (
            <button
              key={k.label}
              type="button"
              onClick={() => setKind(k.key)}
              aria-pressed={kind === k.key}
              className={`${CHIP} ${kind === k.key ? CHIP_ON : CHIP_OFF}`}
            >
              {k.label}
            </button>
          ))}
        </fieldset>

        {error && <p className="text-red-600 text-sm">Failed to load alert data.</p>}

        {!error && !data && (
          <div className="space-y-3 animate-pulse" role="status" aria-label="Loading planned work">
            <div className={`${CARD} h-32`} />
            <div className={`${CARD} h-48`} />
          </div>
        )}

        {special.length > 0 && (
          <Section
            id="special-heading"
            title="Holiday and special timetables"
            note="From SEPTA's published bus and Metro timetable. Regional Rail isn't covered."
          >
            <List>
              {special.map((d) => (
                <li key={d.date} className="p-4">
                  <p className="font-medium text-slate-800 dark:text-slate-100">
                    {shortDate(d.date)}
                    {d.holiday ? ` · ${d.holiday.replace(/^the /, 'The ')}` : ''}
                  </p>
                  <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
                    {specialDayText(d)}
                  </p>
                </li>
              ))}
            </List>
            <p className="p-4 pt-0 text-xs">
              <a href="/schedule-changes" className={LINK}>
                Schedule changes and special days →
              </a>
            </p>
          </Section>
        )}

        {nothing && (
          <p className={`${CARD} p-4 text-sm text-slate-600 dark:text-slate-300`}>
            SEPTA has no planned work posted{kind ? ' for this mode' : ''} right now.
          </p>
        )}

        {data && items.length > 0 && (
          <>
            <Section
              id="weekend-heading"
              title={`This weekend · ${formatPhillyDay(saturday).replace(/, \d{4}$/, '')} – ${formatPhillyDay(sunday).replace(/, \d{4}$/, '')}`}
              note="Planned work that covers Saturday or Sunday."
            >
              {layout.weekend.items.length ? (
                <List>
                  {layout.weekend.items.map((item) => (
                    <Item
                      key={item.id}
                      item={item}
                      now={now}
                      tag={item.startsThen ? 'Starts this weekend' : null}
                    />
                  ))}
                </List>
              ) : (
                <p className="p-4 text-sm text-slate-500 dark:text-slate-400">
                  {layout.weekend.longRunning
                    ? 'Nothing new covers this weekend.'
                    : 'Nothing planned covers this weekend.'}
                </p>
              )}
              {layout.weekend.longRunning > 0 && (
                <p className="px-4 pb-4 text-xs text-slate-500 dark:text-slate-400">
                  Plus {layout.weekend.longRunning} long-running change
                  {layout.weekend.longRunning === 1 ? '' : 's'} still in effect,{' '}
                  <a href="#ongoing-heading" className={LINK}>
                    listed below
                  </a>
                  .
                </p>
              )}
            </Section>

            <Section
              id="starting-heading"
              title={`Starting in the next ${AHEAD_DAYS} days`}
              note="By the day each change begins."
            >
              {layout.days.length ? (
                layout.days.map(({ day, items: starting }) => (
                  <div key={day}>
                    <h3 className="px-4 pt-3 text-sm font-semibold text-slate-700 dark:text-slate-200">
                      {dayText(starting[0].startTs, now)}
                    </h3>
                    <List>
                      {starting.map((item) => (
                        <Item key={item.id} item={item} now={now} />
                      ))}
                    </List>
                  </div>
                ))
              ) : (
                <p className="p-4 text-sm text-slate-500 dark:text-slate-400">
                  Nothing new starts in the next {AHEAD_DAYS} days.
                </p>
              )}
            </Section>

            {layout.now.length > 0 && (
              <Section id="now-heading" title={`In effect now (${layout.now.length})`}>
                <List>
                  {layout.now.map((item) => (
                    <Item key={item.id} item={item} now={now} />
                  ))}
                </List>
              </Section>
            )}

            {layout.later.length > 0 && (
              <Section id="later-heading" title={`Later (${layout.later.length})`}>
                <List>
                  {layout.later.map((item) => (
                    <Item key={item.id} item={item} now={now} />
                  ))}
                </List>
              </Section>
            )}

            {layout.ongoing.length > 0 && (
              <Section
                id="ongoing-heading"
                title={`Long-running (${layout.ongoing.length})`}
                note={`Began more than ${LONG_RUNNING_DAYS} days ago and still in effect.`}
              >
                <List>
                  {layout.ongoing.map((item) => (
                    <Item key={item.id} item={item} now={now} />
                  ))}
                </List>
              </Section>
            )}
          </>
        )}

        <section
          className={`${CARD} p-4 text-sm leading-relaxed text-slate-600 dark:text-slate-300`}
        >
          <h2 className={`${H2} mb-2`}>What's listed</h2>
          <p>
            SEPTA's service advisories and short detours that carry dates or describe scheduled
            work. Multi-month construction detours and station-amenity notices are left out of this
            archive, as on the rest of the site. Dates are the ones SEPTA posted, and it revises
            them: check the linked alert before you travel.
          </p>
        </section>
      </main>
      <Footer />
    </div>
  );
}
