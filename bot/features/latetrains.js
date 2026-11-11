// The Regional Rail trains that run late most often, on the rail account:
// one post each Sunday covering the four Sunday–Saturday weeks just ended.
// The weekly recap ranks lines and names the single worst delay; this names
// the train numbers riders meet day after day. From the TrainView tally
// (rail_trains), like the recaps: a train is late on a day when it was more
// than ON_TIME_MAX minutes behind at its worst.
import { RAIL_LINES } from '../../src/lib/railLines.js';
import { SITE_ORIGIN } from '../../src/lib/site.js';
import { addDays, dateRangeLabel, recapWindow } from '../lib/clock.js';
import { firstThatFits, linkFacets } from '../lib/text.js';
import { renderBarChart } from '../map/chart.js';
import { ON_TIME_MAX } from './rail.js';
import { railTrainStats } from './scorecards.js';

export const LATE_TRAINS = {
  weeks: 4,
  // A train must have run on this many days of the window…
  minRuns: 8,
  // …and been late on at least this share of them.
  minLateShare: 0.5,
  // Fewer trains than this and there's no post.
  minTrains: 3,
  listed: 5,
  charted: 10,
};
const SITE_HOST = new URL(SITE_ORIGIN).host;
const SCORECARDS_URL = `${SITE_ORIGIN}/scorecards?mode=rail`;

const lineLabel = (key) => RAIL_LINES[key]?.label ?? key;

/** "5:10 PM" for minutes past midnight, to the nearest five. */
export function minutesLabel(min) {
  if (min == null) return null;
  const m = (Math.round(min / 5) * 5) % 1440;
  const h = Math.floor(m / 60);
  return `${h % 12 || 12}:${String(m % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** The four full weeks before `now`'s, as date keys. */
export function lateTrainsWindow(now, weeks = LATE_TRAINS.weeks) {
  const { toKey } = recapWindow('week', now);
  const fromKey = addDays(toKey, -(7 * weeks - 1));
  return { fromKey, toKey, label: dateRangeLabel(fromKey, toKey) };
}

/** The trains late most often, worst first: by share of days late, then average lateness. */
export function chronicLateTrains(trains, cfg = LATE_TRAINS) {
  return trains
    .filter((t) => t.ran >= cfg.minRuns && t.late / t.ran >= cfg.minLateShare)
    .map((t) => ({ ...t, share: t.late / t.ran }))
    .sort((a, b) => b.share - a.share || (b.avg_late ?? 0) - (a.avg_late ?? 0));
}

const routeOf = (t) =>
  t.origin && t.dest && t.origin !== t.dest
    ? `${t.origin} → ${t.dest}`
    : t.dest
      ? `to ${t.dest}`
      : lineLabel(t.line);

/** Post text, chart, and alt text. */
export function composeLateTrains(trains, { label, weeks = LATE_TRAINS.weeks }) {
  const head = `🐌 Regional Rail's most-often-late trains · ${label}`;
  const full = (t, i) => {
    const when = minutesLabel(t.first_seen_min);
    return `${i + 1}. #${t.no} ${routeOf(t)}${when ? ` (~${when})` : ''}: late ${t.late} of ${t.ran} days, avg ${t.avg_late} min`;
  };
  const short = (t, i) => `${i + 1}. #${t.no} ${routeOf(t)}: late ${t.late} of ${t.ran} days`;
  const bare = (t, i) => `${i + 1}. #${t.no} (${lineLabel(t.line)}): ${t.late} of ${t.ran} days`;
  const note = `Late: over ${ON_TIME_MAX} min behind at its worst. Every train: ${SITE_HOST}/scorecards`;
  const candidates = [];
  for (const fmt of [full, short, bare]) {
    for (let n = Math.min(trains.length, LATE_TRAINS.listed); n >= 3; n--) {
      candidates.push([head, trains.slice(0, n).map(fmt).join('\n'), note].join('\n\n'));
    }
  }
  const text = firstThatFits(candidates);
  const rows = trains.slice(0, LATE_TRAINS.charted).map((t) => ({
    label: `#${t.no} · ${lineLabel(t.line)}`,
    value: 100 * t.share,
    display: `${t.late} of ${t.ran}`,
  }));
  return {
    text,
    facets: linkFacets(text, [{ text: `${SITE_HOST}/scorecards`, uri: SCORECARDS_URL }]),
    chart: {
      title: `Most-often-late trains · ${label}`,
      subtitle: `Share of the days each train ran that it was over ${ON_TIME_MAX} min late`,
      rows,
      max: 100,
      ticks: [0, 25, 50, 75, 100],
      tickFormat: (v) => `${v}%`,
      note: `Trains that ran ${LATE_TRAINS.minRuns}+ days in ${weeks} weeks · Source: SEPTA TrainView`,
    },
    alt: `Bar chart of the Regional Rail trains late most often, ${label}, by the share of days late: ${rows.map((r) => `${r.label} ${r.display} days`).join(', ')}.`,
  };
}

/** Post the past four weeks' most-often-late trains (once per window). */
export async function postLateTrains({ db, poster, now, log = () => {} }) {
  if (!poster.client.hasAccount('rail')) return null;
  const win = lateTrainsWindow(now);
  const subject = `late-trains:${win.toKey}`;
  if (poster.find(subject, 'late-trains')) return { skipped: 'posted' };
  const trains = chronicLateTrains(railTrainStats(db, win).trains);
  if (trains.length < LATE_TRAINS.minTrains) {
    log(`late trains: skipped, only ${trains.length} trains late that often`);
    return { skipped: 'too-few-trains', trains: trains.length };
  }
  const { text, facets, chart, alt } = composeLateTrains(trains, win);
  let image = null;
  try {
    image = { data: await renderBarChart(chart), alt };
  } catch (err) {
    log(`late trains: chart failed: ${err.message}`);
  }
  const res = await poster.post({
    account: 'rail',
    kind: 'late-trains',
    subject,
    text,
    facets,
    ...(image && { image }),
  });
  return { posted: trains.length, url: res.url };
}
