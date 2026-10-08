// Regional Rail on the rail account, adapted from cta-insights' Metra bins
// (ISC):
//
// - An hourly roundup, 14 minutes past each hour, of the trains SEPTA
//   cancelled and the trains running 15+ minutes late that the collector
//   picked up in the hour that just ended. Silent when there were none. Each
//   train's incident on the site links to the roundup.
// - A weekly (Sundays) and monthly (the 1st) recap: the share of trains on
//   time, the least reliable lines, cancellations, and the worst delay, with
//   a chart of on-time share by line.
//
// The recaps count every train on SEPTA's TrainView feed, tallied as the
// service polls it (rail_trains), so they don't depend on what got posted.
import { railKeyForTrainViewLine } from '../../collector/lib/network.js';
import { formatClock } from '../../collector/lib/railTrains.js';
import { serviceDateKey } from '../../collector/lib/time.js';
import { RAIL_LINES } from '../../src/lib/railLines.js';
import { SITE_ORIGIN } from '../../src/lib/site.js';
import { clockRange, dayLabel, recapWindow } from '../lib/clock.js';
import { getMeta, setMeta } from '../lib/db.js';
import { linkFacets } from '../lib/text.js';
import { renderBarChart } from '../map/chart.js';
import { subjectOf } from './detections.js';
import { buildRollupThread } from './ghosts.js';

export { recapWindow };

const HOUR_MS = 60 * 60 * 1000;
export const RAIL_ROLLUP_MINUTE = 14;
// Late by this much counts as late (SEPTA's own on-time standard is 6 min;
// cta-insights' Metra recaps used 15, which is what riders feel as "late").
export const LATE_MIN = 15;
// Trains listed per kind in an hourly roundup before "+N more".
const LIST_CAP = 10;
// A line needs this many trains in a recap window to be ranked.
export const MIN_LINE_TRAINS = 30;
// Fewer trains than this in a window means the bot wasn't running for most
// of it: no recap.
export const MIN_RECAP_TRAINS = 200;
const SITE_HOST = new URL(SITE_ORIGIN).host;

const lineLabel = (key) => RAIL_LINES[key]?.label ?? key;

/**
 * Tally TrainView trains for the recaps: one row per train per service day,
 * with the worst lateness seen and whether SEPTA marked it cancelled (late
 * 999) or saw it run.
 * @returns {number} trains recorded
 */
export function recordTrains(db, ts, trains) {
  const upsert = db.prepare(`
    INSERT INTO rail_trains (service_date, train_no, line, origin, dest, max_late, ran, cancelled, first_seen, last_seen)
    VALUES (@service_date, @train_no, @line, @origin, @dest, @max_late, @ran, @cancelled, @ts, @ts)
    ON CONFLICT (service_date, train_no) DO UPDATE SET
      line = COALESCE(rail_trains.line, excluded.line),
      origin = COALESCE(rail_trains.origin, excluded.origin),
      dest = COALESCE(excluded.dest, rail_trains.dest),
      max_late = CASE
        WHEN excluded.max_late IS NULL THEN rail_trains.max_late
        WHEN rail_trains.max_late IS NULL THEN excluded.max_late
        ELSE MAX(rail_trains.max_late, excluded.max_late) END,
      ran = MAX(rail_trains.ran, excluded.ran),
      cancelled = MAX(rail_trains.cancelled, excluded.cancelled),
      last_seen = excluded.last_seen
  `);
  const serviceDate = serviceDateKey(ts);
  let n = 0;
  db.transaction(() => {
    for (const t of trains ?? []) {
      const trainNo = String(t.trainno ?? '').trim();
      if (!trainNo) continue;
      const late = Number(t.late);
      const cancelled = late === 999;
      const running = Number.isFinite(late) && late < 900;
      upsert.run({
        service_date: serviceDate,
        train_no: trainNo,
        line: railKeyForTrainViewLine(t.line),
        origin: t.SOURCE ?? null,
        dest: t.dest ?? null,
        max_late: running ? Math.max(0, late) : null,
        ran: running ? 1 : 0,
        cancelled: cancelled ? 1 : 0,
        ts,
      });
      n++;
    }
  })();
  return n;
}

// "5:10 PM Thorndale → Temple U (#9531)"
function trainPhrase(inc, det) {
  const dep = inc.status?.scheduled_departure_ts;
  const from = det.scope?.from_station ?? inc.status?.origin;
  const to = det.scope?.to_station;
  const route =
    from && to && from !== to ? `${from} → ${to}` : from ? `from ${from}` : to ? `to ${to}` : '';
  const when = dep != null ? `${formatClock(dep)} ` : '';
  const no = det.evidence?.train_number ?? inc.status?.train_number;
  return `${when}${route}`.trim() ? `${when}${route} (#${no})`.trim() : `#${no}`;
}

/** Roundup lines: cancellations, then delays worst first, each capped. */
export function rollupLines(items) {
  const cancels = items
    .filter((x) => x.det.source === 'cancellation')
    .sort(
      (a, b) =>
        (a.inc.status?.scheduled_departure_ts ?? 0) - (b.inc.status?.scheduled_departure_ts ?? 0),
    );
  const delays = items
    .filter((x) => x.det.source === 'delay')
    .sort((a, b) => (b.inc.status?.delay_min ?? 0) - (a.inc.status?.delay_min ?? 0));
  const lines = [];
  const listed = [];
  const add = (list, fmt, noun) => {
    for (const x of list.slice(0, LIST_CAP)) {
      lines.push(fmt(x));
      listed.push(x);
    }
    if (list.length > LIST_CAP) {
      const more = list.length - LIST_CAP;
      lines.push(`…and ${more} more ${noun}${more === 1 ? '' : 's'}`);
      listed.push(null);
    }
  };
  add(cancels, (x) => `❌ Cancelled: ${trainPhrase(x.inc, x.det)}`, 'cancellation');
  add(
    delays,
    (x) =>
      `🐌 ${x.inc.status?.delay_min ?? x.det.evidence?.details?.max_late_min} min late: ${trainPhrase(x.inc, x.det)}`,
    'delayed train',
  );
  return { lines, listed };
}

/**
 * Once per hour (RAIL_ROLLUP_MINUTE past), post the roundup of the previous
 * clock hour's new cancellations and delays.
 */
export async function maybePostRailRollup({ incidents, poster, db, now, log = () => {} }) {
  if (!poster.client.hasAccount('rail')) return null;
  const hourStart = Math.floor(now / HOUR_MS) * HOUR_MS;
  if (now - hourStart < RAIL_ROLLUP_MINUTE * 60 * 1000) return null;
  const metaKey = poster.dryRun ? 'rail_rollup_hour_dry' : 'rail_rollup_hour';
  if (Number(getMeta(db, metaKey)) >= hourStart) return null;
  setMeta(db, metaKey, hourStart);

  const from = Math.max(hourStart - HOUR_MS, poster.since());
  const items = [];
  for (const inc of incidents.values()) {
    if (inc.mode !== 'regional_rail') continue;
    for (const det of inc.detections ?? []) {
      if (det.source !== 'delay' && det.source !== 'cancellation') continue;
      const first = det.lifecycle?.first_seen_ts;
      if (first == null || first < from || first >= hourStart) continue;
      if (poster.find(subjectOf(det), 'rollup')) continue;
      items.push({ inc, det });
    }
  }
  if (items.length === 0) return { posts: 0, trains: 0 };
  const { lines, listed } = rollupLines(items);
  const header = `🚆 Regional Rail · ${clockRange(hourStart - HOUR_MS, hourStart)}`;
  const footer = `Per SEPTA's TrainView · 🔗 ${SITE_HOST}`;
  const thread = buildRollupThread(header, lines, { footer });
  const stats = { posts: 0, trains: 0 };
  let parent = null;
  for (const part of thread) {
    try {
      const res = await poster.post({
        account: 'rail',
        kind: 'rail-rollup',
        subject: `rail-rollup:${new Date(hourStart).toISOString().slice(0, 13)}`,
        text: part.text,
        facets: linkFacets(part.text, [{ text: SITE_HOST, uri: SITE_ORIGIN }]),
        ...(parent && { reply: parent.uri }),
      });
      parent = res;
      stats.posts++;
      for (const i of part.lines) {
        const x = listed[i];
        if (!x) continue;
        poster.alias({ account: 'rail', kind: 'rollup', subject: subjectOf(x.det), post: res });
        stats.trains++;
      }
    } catch (err) {
      log(`rail: roundup post failed: ${err.message}`);
      break;
    }
  }
  return stats;
}

/**
 * On-time figures for the service days fromKey..toKey (inclusive). A train
 * is on time when it ran less than LATE_MIN late; cancelled when SEPTA
 * marked it so and it never ran.
 */
export function railRecapStats(db, { fromKey, toKey }) {
  const rows = db
    .prepare('SELECT * FROM rail_trains WHERE service_date BETWEEN ? AND ?')
    .all(fromKey, toKey);
  const byLine = new Map();
  let late = 0;
  let cancelled = 0;
  let worst = null;
  for (const r of rows) {
    const line = r.line ?? 'unknown';
    if (!byLine.has(line)) byLine.set(line, { line, trains: 0, onTime: 0 });
    const l = byLine.get(line);
    l.trains++;
    if (!r.ran && r.cancelled) {
      cancelled++;
      continue;
    }
    if ((r.max_late ?? 0) >= LATE_MIN) late++;
    else l.onTime++;
    if (r.max_late != null && (!worst || r.max_late > worst.max_late)) worst = r;
  }
  const trains = rows.length;
  const lines = [...byLine.values()]
    .filter((l) => l.line !== 'unknown' && l.trains >= MIN_LINE_TRAINS)
    .map((l) => ({ ...l, pct: (100 * l.onTime) / l.trains }))
    .sort((a, b) => a.pct - b.pct);
  return {
    trains,
    onTime: trains - late - cancelled,
    late,
    cancelled,
    pct: trains ? (100 * (trains - late - cancelled)) / trains : null,
    lines,
    worst,
  };
}

const pct1 = (v) => `${v.toFixed(1)}%`;
const pct0 = (v) => `${Math.round(v)}%`;

/** Recap post text and chart for a window. */
export function composeRailRecap(stats, { label }) {
  const worst = stats.worst;
  const worstText =
    worst && worst.max_late >= LATE_MIN
      ? `Worst delay: ${worst.max_late} min, #${worst.train_no}${worst.origin ? ` from ${worst.origin}` : ''} (${dayLabel(worst.service_date)})`
      : null;
  const least = stats.lines
    .slice(0, 3)
    .map((l) => `${lineLabel(l.line)} ${pct0(l.pct)}`)
    .join(' · ');
  const text = [
    `🚆 Regional Rail recap · ${label}`,
    `On time (under ${LATE_MIN} min late, not cancelled): ${pct1(stats.pct)} of ${stats.trains.toLocaleString('en-US')} trains`,
    [least ? `Least reliable: ${least}` : null, `Cancelled: ${stats.cancelled}`, worstText]
      .filter(Boolean)
      .join('\n'),
    "Counts every train on SEPTA's TrainView.",
  ].join('\n\n');
  const chart = {
    title: `Regional Rail on time · ${label}`,
    subtitle: `Share of trains under ${LATE_MIN} min late and not cancelled`,
    rows: stats.lines.map((l) => ({
      label: lineLabel(l.line),
      value: l.pct,
      display: pct0(l.pct),
    })),
    max: 100,
    ticks: [0, 25, 50, 75, 100],
    tickFormat: (v) => `${v}%`,
    note: `Lines with ${MIN_LINE_TRAINS}+ trains · Source: SEPTA TrainView`,
  };
  const alt = `Bar chart of the share of trains on time on each Regional Rail line, ${label}, least reliable first: ${stats.lines.map((l) => `${lineLabel(l.line)} ${pct0(l.pct)}`).join(', ')}.`;
  return { text, chart, alt };
}

/** Post the weekly or monthly recap (once per window). */
export async function postRailRecap({ db, poster, now, period, log = () => {} }) {
  if (!poster.client.hasAccount('rail')) return null;
  const win = recapWindow(period, now);
  const subject = `rail-recap:${period}:${win.toKey}`;
  if (poster.find(subject, 'rail-recap')) return { skipped: 'posted' };
  const stats = railRecapStats(db, win);
  if (stats.trains < MIN_RECAP_TRAINS) {
    log(`rail: ${period} recap skipped, only ${stats.trains} trains recorded`);
    return { skipped: 'too-few-trains', trains: stats.trains };
  }
  const { text, chart, alt } = composeRailRecap(stats, win);
  let image = null;
  if (chart.rows.length) {
    try {
      image = { data: await renderBarChart(chart), alt };
    } catch (err) {
      log(`rail: recap chart failed: ${err.message}`);
    }
  }
  const res = await poster.post({
    account: 'rail',
    kind: 'rail-recap',
    subject,
    text,
    highlight: 'recap',
    ...(image && { image }),
  });
  return { posted: period, url: res.url, trains: stats.trains };
}
