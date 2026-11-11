// The insights account's look ahead, beside its digests of what happened:
//
// - A morning briefing (6:30 AM on weekdays, 8 AM at weekends): what's out
//   there before the commute. SEPTA's unplanned alerts in effect, the planned
//   changes riders must work around today, the bus and Metro trips cancelled
//   so far, Regional Rail trains cancelled, elevators out, and a holiday
//   timetable when there is one.
// - A weekend preview, Friday afternoon: the planned work that covers the
//   weekend (shuttle buses, closed stations, diversions), the changes that
//   start this weekend first.
// - A holiday heads-up, the afternoon before a day whose timetable isn't the
//   usual one for its weekday: a Sunday or Saturday timetable on a holiday, or
//   a set of routes that don't run (the school routes when schools are closed).
// - A post when new schedules are coming: what changes, route by route, from
//   the comparison the collector makes of SEPTA's published timetable.
//
// The last two read the collector's schedule-changes.json (bus and Metro
// only: Regional Rail's timetable is a separate feed the collector doesn't
// read), so they are a tick behind it at most.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SCHEDULE_CHANGES_FILE } from '../../collector/lib/scheduleChanges.js';
import { easternDateKey, easternParts, serviceDateKey } from '../../collector/lib/time.js';
import { TRIP_CANCELLATIONS } from '../../collector/lib/tripCancellations.js';
import { isPlannedIncident, isPlannedWork } from '../../src/lib/incidents.js';
import { SITE_ORIGIN } from '../../src/lib/site.js';
import { addDays, dayLabel, keyStart } from '../lib/clock.js';
import { getMeta, setMeta } from '../lib/db.js';
import { routeShortLabel } from '../lib/routes.js';
import { linkFacets, truncateSentence } from '../lib/text.js';
import { ALERTS_ACCOUNT, alertGate } from './alerts.js';
import { fitSections } from './insights.js';

export const OUTLOOK_ACCOUNT = ALERTS_ACCOUNT;
// Philadelphia times. `weekdays` are getUTCDay numbers of the date key.
export const OUTLOOK_SLOTS = {
  briefing: { weekday: { hour: 6, minute: 30 }, weekend: { hour: 8, minute: 0 } },
  weekend: { weekday: 5, hour: 15, minute: 30 },
  holiday: { hour: 16, minute: 0 },
};
export const OUTLOOK = {
  // A change set is posted from this many days before it takes effect until
  // this many days after.
  changeLeadDays: 10,
  changeLateDays: 2,
  // Planned work that started longer ago than this is "continuing", not news
  // for the weekend.
  longRunningMs: 10 * 24 * 60 * 60 * 1000,
};
const DAY_MS = 24 * 60 * 60 * 1000;
const SITE_HOST = new URL(SITE_ORIGIN).host;

const WEEKDAY = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long' });
const WEEKDAY_SHORT = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' });
const keyDate = (key) => new Date(`${key}T12:00:00Z`);
const weekdayOf = (key) => WEEKDAY.format(keyDate(key));
const shortDay = (key) => `${WEEKDAY_SHORT.format(keyDate(key))}, ${dayLabel(key)}`;
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const metaKey = (poster, key) => `outlook_${key}${poster.dryRun ? '_dry' : ''}`;
const minutesNow = (now) => {
  const { hour, minute } = easternParts(now);
  return hour * 60 + minute;
};

/** Read the collector's schedule-changes.json from the data directory, or null. */
export async function readScheduleChanges(dataDir) {
  try {
    return JSON.parse(await readFile(join(dataDir, SCHEDULE_CHANGES_FILE), 'utf8'));
  } catch {
    return null;
  }
}

/** Distinct route labels of some incidents, in order: ["L1", "Route 23", …]. */
function routeLabels(incidents) {
  const seen = new Set();
  const out = [];
  for (const inc of incidents) {
    for (const route of inc.routes ?? []) {
      const label = routeShortLabel(inc.mode, route);
      if (!seen.has(label)) {
        seen.add(label);
        out.push(label);
      }
    }
  }
  return out;
}

/** "L1, Route 23, Paoli/Thorndale Line +4" in versions, longest first. */
function namedList(labels, max = 4) {
  const versions = [];
  for (let n = Math.min(max, labels.length); n >= 1; n--) {
    const more = labels.length - n;
    versions.push(`${labels.slice(0, n).join(', ')}${more ? ` +${more}` : ''}`);
  }
  return versions;
}

// An official incident counts once, however many networks it spans.
function officialOnce(incidents, keep) {
  const byAlert = new Map();
  for (const inc of incidents.values()) {
    const a = inc.official_alert;
    if (!a || !keep(inc)) continue;
    if (!byAlert.has(a.id)) byAlert.set(a.id, []);
    byAlert.get(a.id).push(inc);
  }
  return [...byAlert.values()];
}

/** Whether a planned incident's stated window covers any of [from, to). */
function windowOverlaps(inc, from, to) {
  const w = inc.official_alert?.agency_event_window ?? {};
  const start = w.start_ts ?? inc.lifecycle?.first_seen_ts ?? 0;
  const end = w.end_ts ?? Number.POSITIVE_INFINITY;
  return start < to && end > from;
}

// ── Special days ────────────────────────────────────────────────────────────

const share = (day) => `${Math.round((100 * day.trips) / day.typical)}%`;
const routesList = (routes, max) => {
  const shown = routes.slice(0, max).map((r) => routeShortLabel('bus', r).replace(/^Route /, ''));
  const more = routes.length - shown.length;
  return `${shown.join(', ')}${more ? ` +${more} more` : ''}`;
};
const schoolRoutes = (routes) => routes.length > 0 && routes.every((r) => /^4\d\d$/.test(r));

/** One line on a special day's service, for the briefing: "buses and Metro run a Sunday timetable". */
export function specialDayPhrase(day) {
  if (day.kind === 'routes-off') {
    return schoolRoutes(day.routes_off)
      ? `the ${day.routes_off.length} school routes (400s) don't run`
      : `${plural(day.routes_off.length, 'bus route')} that usually run${day.routes_off.length === 1 ? 's' : ''} ${day.routes_off.length === 1 ? "doesn't" : "don't"}`;
  }
  if (day.like)
    return `buses and Metro run a ${day.like === 'sunday' ? 'Sunday' : 'Saturday'} timetable`;
  return day.kind === 'extra'
    ? `buses and Metro run extra service (${share(day)} of usual)`
    : `buses and Metro run a reduced timetable (${share(day)} of usual)`;
}

// ── Morning briefing ────────────────────────────────────────────────────────

/**
 * Everything the briefing says.
 * @param {{ incidents: Map<string, object>, outages?: Map<string, object>,
 *   scheduleChanges?: object | null, now: number }} opts
 */
export function briefingStats({ incidents, outages, scheduleChanges = null, now }) {
  const today = easternDateKey(now);
  const serviceDay = serviceDateKey(now);
  const active = (inc) => inc.lifecycle?.active;
  const unplanned = officialOnce(
    incidents,
    (inc) => active(inc) && alertGate(inc).post && !isPlannedWork(inc),
  );
  const dayStart = keyStart(today);
  const planned = officialOnce(
    incidents,
    (inc) =>
      active(inc) &&
      alertGate(inc).post &&
      isPlannedIncident(inc, now) &&
      windowOverlaps(inc, Math.max(now, dayStart), dayStart + DAY_MS),
  );
  const cancelledRoutes = [];
  let cancelledTrips = 0;
  let railCancelled = 0;
  for (const inc of incidents.values()) {
    const det = inc.detections?.[0];
    if (det?.source === TRIP_CANCELLATIONS) {
      const d = det.evidence?.details ?? {};
      if (d.service_date === serviceDay && d.cancelled > 0) {
        cancelledTrips += d.cancelled;
        cancelledRoutes.push({ mode: inc.mode, route: inc.routes?.[0], n: d.cancelled });
      }
    }
    if (inc.mode === 'regional_rail' && inc.status?.type === 'cancellation' && active(inc)) {
      const dep = inc.status.scheduled_departure_ts;
      if (dep == null || serviceDateKey(dep) === serviceDay) railCancelled++;
    }
  }
  cancelledRoutes.sort((a, b) => b.n - a.n);
  return {
    now,
    today,
    unplanned,
    planned,
    cancelledTrips,
    cancelledRoutes,
    railCancelled,
    elevators: [...(outages?.values() ?? [])].filter((o) => o.lifecycle?.active).length,
    special: scheduleChanges?.special_days?.find((d) => d.date === today) ?? null,
  };
}

/** The briefing's text and link facets. */
export function composeBriefing(stats) {
  const { today, unplanned, planned, cancelledTrips, cancelledRoutes, railCancelled, special } =
    stats;
  const head = `☀️ SEPTA this morning · ${weekdayOf(today)}, ${dayLabel(today)}`;
  const withNames = (count, groups) =>
    namedList(routeLabels(groups.flat())).map((names) => `${count}: ${names}`);
  const worst = cancelledRoutes
    .slice(0, 2)
    .map((r) => `${routeShortLabel(r.mode, r.route)} ${r.n}`)
    .join(', ');
  const tripsText = `🚫 ${plural(cancelledTrips, 'bus and Metro trip')} cancelled so far`;
  const lines = [
    {
      rank: 0,
      text: special
        ? `🗓️ ${special.holiday ? `${special.holiday}: ` : 'Today: '}${specialDayPhrase(special)}`
        : null,
    },
    {
      rank: 0,
      text: unplanned.length
        ? [
            ...withNames(`⚠️ ${plural(unplanned.length, 'unplanned alert')} in effect`, unplanned),
            `⚠️ ${plural(unplanned.length, 'unplanned alert')} in effect`,
          ]
        : '✅ No unplanned SEPTA alerts in effect',
    },
    {
      rank: 2,
      text: planned.length
        ? [
            ...withNames(`🚧 ${plural(planned.length, 'planned change')} today`, planned),
            `🚧 ${plural(planned.length, 'planned change')} today`,
          ]
        : null,
    },
    {
      rank: 1,
      text: cancelledTrips
        ? [worst ? `${tripsText} (${worst})` : null, tripsText].filter(Boolean)
        : null,
    },
    {
      rank: 3,
      text: railCancelled ? `🚆 ${plural(railCancelled, 'Regional Rail train')} cancelled` : null,
    },
    { rank: 4, text: stats.elevators ? `♿ ${plural(stats.elevators, 'elevator')} out` : null },
  ];
  const text = fitSections(head, [lines, [{ rank: 0, text: `🔗 ${SITE_HOST}` }]]);
  return { text, facets: linkFacets(text, [{ text: SITE_HOST, uri: SITE_ORIGIN }]) };
}

/** Post the morning briefing now (once per day). */
export async function postBriefing({ incidents, outages, scheduleChanges, poster, now }) {
  if (!poster.client.hasAccount(OUTLOOK_ACCOUNT)) return null;
  const stats = briefingStats({ incidents, outages, scheduleChanges, now });
  const subject = `briefing:${stats.today}`;
  if (poster.find(subject, 'briefing')) return { skipped: 'posted' };
  if (!incidents.size) return { skipped: 'no-data' };
  const { text, facets } = composeBriefing(stats);
  const res = await poster.post({
    account: OUTLOOK_ACCOUNT,
    kind: 'briefing',
    subject,
    text,
    facets,
  });
  return { posted: stats.today, url: res.url };
}

// ── Weekend preview ─────────────────────────────────────────────────────────

/** The Saturday and Sunday coming (or under way), as date keys, for a moment. */
export function weekendOf(now) {
  const today = easternDateKey(now);
  const wd = keyDate(today).getUTCDay();
  const saturday = wd === 0 ? addDays(today, -1) : addDays(today, 6 - wd);
  return { saturday, sunday: addDays(saturday, 1) };
}

/**
 * The planned work covering the weekend that riders must plan around, the
 * changes that start with it first: `fresh` (starting Friday evening or later,
 * or posted in the last few days) and `continuing` (long-running).
 */
export function weekendWork({ incidents, now, cfg = OUTLOOK }) {
  const { saturday, sunday } = weekendOf(now);
  const from = keyStart(saturday);
  // The service day runs on past midnight on Sunday night.
  const to = keyStart(addDays(sunday, 1)) + 3 * 60 * 60 * 1000;
  const groups = officialOnce(
    incidents,
    (inc) =>
      inc.lifecycle?.active &&
      alertGate(inc).post &&
      (isPlannedIncident(inc, now) || isPlannedWork(inc)) &&
      windowOverlaps(inc, from, to),
  );
  const startOf = (g) =>
    g[0].official_alert.agency_event_window?.start_ts ?? g[0].lifecycle?.first_seen_ts ?? 0;
  const fresh = [];
  const continuing = [];
  for (const g of groups) (from - startOf(g) > cfg.longRunningMs ? continuing : fresh).push(g);
  fresh.sort((a, b) => startOf(a) - startOf(b));
  return { saturday, sunday, fresh, continuing };
}

// "L1: Shuttle buses replace trains between 15th St and 69th St".
function workLine(group, max) {
  const labels = routeLabels(group);
  const prefix = namedList(labels, 2)[0];
  const headline = String(group[0].official_alert.headline ?? '').trim();
  const named = labels.some((l) =>
    headline.toLowerCase().includes(l.replace(/ Line$/, '').toLowerCase()),
  );
  return `· ${truncateSentence(named ? headline : `${prefix}: ${headline}`, max)}`;
}

/** The weekend preview's text and link facets; null when nothing covers the weekend. */
export function composeWeekend({ saturday, sunday, fresh, continuing }, special = []) {
  if (!fresh.length && !continuing.length && !special.length) return null;
  // "Nov 14–15", or "Oct 31 – Nov 1" across a month's end.
  const sameMonth = saturday.slice(0, 7) === sunday.slice(0, 7);
  const dates = sameMonth
    ? `${dayLabel(saturday)}–${Number(sunday.slice(8))}`
    : `${dayLabel(saturday)} – ${dayLabel(sunday)}`;
  const head = `🗓️ This weekend on SEPTA · ${dates}`;
  const listed = fresh.length ? fresh : continuing;
  const versions = [];
  for (const max of [90, 60]) {
    for (let n = Math.min(listed.length, 4); n >= 1; n--) {
      const more = listed.length - n;
      versions.push(
        [
          ...listed.slice(0, n).map((g) => workLine(g, max)),
          more ? `…and ${plural(more, 'more planned change')}` : null,
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }
  }
  const sections = [
    special.map((d) => ({
      rank: 1,
      text: `${d.holiday ?? weekdayOf(d.date)}: ${specialDayPhrase(d)}`,
    })),
    [{ rank: 0, text: versions.length ? versions : null }],
    [
      {
        rank: 2,
        text:
          fresh.length && continuing.length
            ? `Plus ${plural(continuing.length, 'longer-running change')} still in effect.`
            : null,
      },
      { rank: 0, text: `Dates and details: ${SITE_HOST}/planned` },
    ],
  ];
  const text = fitSections(head, sections);
  return {
    text,
    facets: linkFacets(text, [{ text: `${SITE_HOST}/planned`, uri: `${SITE_ORIGIN}/planned` }]),
  };
}

/** Post the weekend preview now (once per weekend). */
export async function postWeekend({ incidents, scheduleChanges, poster, now }) {
  if (!poster.client.hasAccount(OUTLOOK_ACCOUNT)) return null;
  const work = weekendWork({ incidents, now });
  const subject = `weekend:${work.saturday}`;
  if (poster.find(subject, 'weekend')) return { skipped: 'posted' };
  const special = (scheduleChanges?.special_days ?? []).filter(
    (d) => d.date === work.saturday || d.date === work.sunday,
  );
  const composed = composeWeekend(work, special);
  if (!composed) return { skipped: 'quiet' };
  const res = await poster.post({
    account: OUTLOOK_ACCOUNT,
    kind: 'weekend',
    subject,
    ...composed,
  });
  return { posted: work.fresh.length + work.continuing.length, url: res.url };
}

// ── Holiday heads-up ────────────────────────────────────────────────────────

/**
 * The special day to warn about the afternoon before: tomorrow, when its
 * timetable isn't the usual one. A day that only has routes off (schools
 * closed) is announced once, at the start of a run of them.
 */
export function headsUpFor(scheduleChanges, now) {
  const today = easternDateKey(now);
  const days = scheduleChanges?.special_days ?? [];
  const tomorrow = days.find((d) => d.date === addDays(today, 1));
  if (!tomorrow) return null;
  if (tomorrow.kind !== 'routes-off') return tomorrow;
  // The run of days off continues over a weekend: look back to the last weekday.
  let prev = today;
  while ([0, 6].includes(keyDate(prev).getUTCDay())) prev = addDays(prev, -1);
  return days.some((d) => d.date === prev) ? null : tomorrow;
}

/** The heads-up's text and link facets. */
export function composeHeadsUp(day) {
  const weekday = weekdayOf(day.date);
  // "tomorrow is Thanksgiving", but "tomorrow, Fri, Nov 27 (the day after Thanksgiving)".
  const head = !day.holiday
    ? `🗓️ Heads-up for tomorrow, ${shortDay(day.date)}`
    : day.holiday.startsWith('the ')
      ? `🗓️ Heads-up for tomorrow, ${shortDay(day.date)} (${day.holiday})`
      : `🗓️ Heads-up: tomorrow is ${day.holiday} (${shortDay(day.date)})`;
  const count = `${day.trips.toLocaleString('en-US')} trips, ${share(day)} of a usual ${weekday}`;
  let service;
  if (day.kind === 'routes-off') service = null;
  else if (day.like)
    service = `SEPTA buses and Metro run a ${day.like === 'sunday' ? 'Sunday' : 'Saturday'} timetable: ${count}.`;
  else if (day.kind === 'extra') service = `SEPTA buses and Metro run extra service: ${count}.`;
  else service = `SEPTA buses and Metro run a reduced timetable: ${count}.`;
  const off = day.routes_off;
  const school = schoolRoutes(off);
  // On a Sunday or Saturday timetable the count says enough; otherwise name some.
  const offLines = !off.length
    ? null
    : school
      ? `The ${off.length} school routes (400s) don't run.`
      : (day.like ? [0] : [8, 5, 0]).map((max) =>
          max
            ? `${plural(off.length, 'route')} that usually run on a ${weekday} don't: ${routesList(off, max)}.`
            : `${plural(off.length, 'route')} that usually run on a ${weekday} don't.`,
        );
  const text = fitSections(head, [
    [
      { rank: 0, text: service },
      { rank: 1, text: offLines },
    ],
    [
      {
        rank: 2,
        text: [
          "From SEPTA's published timetable. Regional Rail isn't covered here: check septa.org.",
          "From SEPTA's timetable; Regional Rail isn't covered.",
        ],
      },
      { rank: 0, text: `🔗 ${SITE_HOST}/schedule-changes` },
    ],
  ]);
  return {
    text,
    facets: linkFacets(text, [
      { text: `${SITE_HOST}/schedule-changes`, uri: `${SITE_ORIGIN}/schedule-changes` },
      { text: 'septa.org', uri: 'https://www.septa.org/' },
    ]),
  };
}

/** Post tomorrow's heads-up now, if tomorrow is a special day (once per day). */
export async function postHeadsUp({ scheduleChanges, poster, now }) {
  if (!poster.client.hasAccount(OUTLOOK_ACCOUNT)) return null;
  const day = headsUpFor(scheduleChanges, now);
  if (!day) return { skipped: 'ordinary-day' };
  const subject = `heads-up:${day.date}`;
  if (poster.find(subject, 'heads-up')) return { skipped: 'posted' };
  const res = await poster.post({
    account: OUTLOOK_ACCOUNT,
    kind: 'heads-up',
    subject,
    ...composeHeadsUp(day),
  });
  return { posted: day.date, url: res.url };
}

// ── Schedule changes ────────────────────────────────────────────────────────

/** "5:10 AM" for seconds past a service day's midnight (25:10:00 is 1:10 AM). */
export function secClock(sec) {
  if (sec == null) return null;
  const m = Math.round(sec / 60) % 1440;
  const h = Math.floor(m / 60);
  return `${h % 12 || 12}:${String(m % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

const DAY_WORD = { weekday: 'weekday', saturday: 'Saturday', sunday: 'Sunday' };

/** One route's change in a line: "Route 26: 183 → 153 weekday trips". */
export function changeLine(r) {
  const label = routeShortLabel(r.mode, r.route);
  // The kind of day whose trips change most; a weekday first among equals.
  const [type, d] = Object.entries(r.days).sort(
    (a, b) => Math.abs(b[1].trips[1] - b[1].trips[0]) - Math.abs(a[1].trips[1] - a[1].trips[0]),
  )[0];
  const word = DAY_WORD[type];
  const [before, after] = d.trips;
  if (r.kind === 'new') return `${label}: new, ${plural(after, `${word} trip`)}`;
  if (r.kind === 'ended')
    return `${label}: no longer scheduled (was ${plural(before, `${word} trip`)})`;
  if (!after) return `${label}: no ${word} service (was ${plural(before, 'trip')})`;
  if (!before) return `${label}: ${word} service added, ${plural(after, 'trip')}`;
  if (before !== after) return `${label}: ${before} → ${plural(after, `${word} trip`)}`;
  if (d.first[0] !== d.first[1]) {
    return `${label}: first ${word} trip ${secClock(d.first[0])} → ${secClock(d.first[1])}`;
  }
  return `${label}: last ${word} trip ${secClock(d.last[0])} → ${secClock(d.last[1])}`;
}

/** The change set to post now, if any: the nearest one within its posting window. */
export function dueChangeSet(scheduleChanges, now, cfg = OUTLOOK) {
  const today = easternDateKey(now);
  return (
    (scheduleChanges?.changes ?? [])
      .filter(
        (c) =>
          c.routes?.length &&
          c.effective <= addDays(today, cfg.changeLeadDays) &&
          c.effective >= addDays(today, -cfg.changeLateDays),
      )
      .sort((a, b) => a.effective.localeCompare(b.effective))[0] ?? null
  );
}

/** The schedule-change post's text and link facets. */
export function composeScheduleChange(set, now) {
  const today = easternDateKey(now);
  const started = set.effective <= today;
  const head = `🗓️ ${started ? 'New SEPTA schedules started' : 'New SEPTA schedules start'} ${shortDay(set.effective)}`;
  const [before, after] = set.totals.weekday;
  const delta = before ? ((after - before) / before) * 100 : 0;
  const sign = delta > 0 ? '+' : '−';
  const totals =
    before && after && before !== after
      ? `A usual weekday: ${before.toLocaleString('en-US')} → ${after.toLocaleString('en-US')} trips (${sign}${Math.abs(delta).toFixed(1)}%).`
      : null;
  const intro = `Buses and Metro: ${plural(set.routes.length, 'route')} ${set.routes.length === 1 ? 'changes' : 'change'}.`;
  const versions = [];
  for (let n = Math.min(set.routes.length, 5); n >= 1; n--) {
    const more = set.routes.length - n;
    versions.push(
      [
        ...set.routes.slice(0, n).map((r) => `· ${changeLine(r)}`),
        more ? `…and ${more} more` : null,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
  // The routes come before the totals when there isn't room for both in full.
  const text = fitSections(head, [
    [
      { rank: 0, text: intro },
      { rank: 2, text: totals },
    ],
    [{ rank: 1, text: versions.slice(-3) }],
    [{ rank: 0, text: `Every change: ${SITE_HOST}/schedule-changes` }],
  ]);
  return {
    text,
    facets: linkFacets(text, [
      { text: `${SITE_HOST}/schedule-changes`, uri: `${SITE_ORIGIN}/schedule-changes` },
    ]),
  };
}

/** Post the change set that's due, if it hasn't been (once per set). */
export async function postScheduleChange({ scheduleChanges, poster, now }) {
  if (!poster.client.hasAccount(OUTLOOK_ACCOUNT)) return null;
  const set = dueChangeSet(scheduleChanges, now);
  if (!set) return { skipped: 'none-due' };
  const subject = `schedule-change:${set.id}`;
  if (poster.find(subject, 'schedule-change')) return { skipped: 'posted' };
  const res = await poster.post({
    account: OUTLOOK_ACCOUNT,
    kind: 'schedule-change',
    subject,
    ...composeScheduleChange(set, now),
  });
  return { posted: set.id, routes: set.routes.length, url: res.url };
}

// ── Each tick ───────────────────────────────────────────────────────────────

/**
 * Run whichever of the outlook posts is due: each is tried once per day, after
 * its slot. Schedule changes are looked at once an hour, and by day only.
 * @param {{ incidents: Map<string, object>, outages?: Map<string, object>, dataDir: string,
 *   db: object, poster: object, now: number }} opts
 */
export async function maybePostOutlook({ incidents, outages, dataDir, db, poster, now }) {
  if (!poster.client.hasAccount(OUTLOOK_ACCOUNT)) return null;
  const today = easternDateKey(now);
  const wd = keyDate(today).getUTCDay();
  const minutes = minutesNow(now);
  const due = (name, slot) => {
    if (minutes < slot.hour * 60 + slot.minute) return false;
    const key = metaKey(poster, name);
    if (getMeta(db, key) === today) return false;
    setMeta(db, key, today);
    return true;
  };
  let file;
  const changes = async () => {
    if (file === undefined) file = await readScheduleChanges(dataDir);
    return file;
  };
  const out = {};
  const briefingSlot = OUTLOOK_SLOTS.briefing[wd === 0 || wd === 6 ? 'weekend' : 'weekday'];
  // Not after noon: a briefing the bot missed in the morning is no longer one.
  if (minutes < 12 * 60 && due('briefing', briefingSlot)) {
    out.briefing = await postBriefing({
      incidents,
      outages,
      scheduleChanges: await changes(),
      poster,
      now,
    });
  }
  if (wd === OUTLOOK_SLOTS.weekend.weekday && due('weekend', OUTLOOK_SLOTS.weekend)) {
    out.weekend = await postWeekend({ incidents, scheduleChanges: await changes(), poster, now });
  }
  if (due('holiday', OUTLOOK_SLOTS.holiday)) {
    out.headsUp = await postHeadsUp({ scheduleChanges: await changes(), poster, now });
  }
  const { hour } = easternParts(now);
  if (hour >= 9 && hour < 20) {
    const key = metaKey(poster, 'changes_hour');
    const stamp = `${today}T${hour}`;
    if (getMeta(db, key) !== stamp) {
      setMeta(db, key, stamp);
      out.scheduleChange = await postScheduleChange({
        scheduleChanges: await changes(),
        poster,
        now,
      });
    }
  }
  return Object.keys(out).length ? out : null;
}
