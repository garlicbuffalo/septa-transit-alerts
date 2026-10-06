// Vehicle detections on the metro and bus accounts: one post per new gap,
// bunch, stuck-vehicle cluster, or silent route, with a map of the vehicles
// involved; hourly "still" replies and a ✅ reply for the outage-style ones
// (stuck vehicles, silent routes); and a quote of the post into the alerts
// account's thread when the detection is attached to a SEPTA alert.
//
// Adapted from cta-insights' bunching, gap, pulse, and thin-gap bins (ISC):
// daily caps per route, an hour's cooldown per route and kind that a clearly
// worse event can override, and historical callouts.

import { vehicleNoun } from '../../collector/lib/vehicles.js';
import { SITE_ORIGIN } from '../../src/lib/site.js';
import { cleanStopName } from '../../src/lib/stops.js';
import { acquireCooldown, clearCooldown } from '../lib/db.js';
import { formatDistance, maxPairDistance } from '../lib/geo.js';
import { routeEmoji, routeShortLabel } from '../lib/routes.js';
import { firstThatFits, graphemeLength, linkFacets, POST_MAX_GRAPHEMES } from '../lib/text.js';
import { planRouteMap, renderRouteMap, routeColor, stretchBetween } from '../map/routeMap.js';
import { eventUrl } from './alerts.js';
import {
  callouts,
  formatCallouts,
  markPosted,
  postedSince,
  RECORD_PHRASE,
  recordEvent,
  startOfEasternDay,
} from './history.js';

export const POSTED_SOURCES = new Set(['gap', 'bunching', 'pulse-held', 'thin-gap']);
// Outage-style detections get hourly progress replies and a ✅ when they end.
const FOLLOWED = new Set(['pulse-held', 'thin-gap']);
const ACCOUNT_FOR_MODE = { metro: 'metro', bus: 'bus' };
const DAILY_CAP = { gap: 3, bunching: 3, 'pulse-held': 4, 'thin-gap': 3 };
// Posts per account per kind per hour, system-wide (cta-insights posted the
// single worst bunch or gap each 15–20 minutes).
const HOURLY_BUDGET = { gap: 3, bunching: 3, 'pulse-held': 4, 'thin-gap': 4 };
const COOLDOWN_MS = 60 * 60 * 1000;
// A capped or cooling-down event still posts when it's this much worse than
// everything already posted for the route today.
const OVERRIDE_FACTOR = 1.25;
const UPDATE_EVERY_MS = 55 * 60 * 1000;
const CLEARED_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const MAX_QUOTES_PER_THREAD = 3;
const KEYCAPS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
const SITE_HOST = new URL(SITE_ORIGIN).host;

export { formatDistance };
export const accountFor = (mode) => ACCOUNT_FOR_MODE[mode] ?? null;
export const subjectOf = (det) => `det:${det.id}`;

/** Headline number used to rank events of a kind: higher is worse. */
export function scoreOf(source, details) {
  if (!details) return 0;
  if (source === 'gap') return details.headway_min ? details.gap_min / details.headway_min : 0;
  if (source === 'thin-gap') return details.silent_min ?? 0;
  return details.vehicle_count ?? details.busCount ?? 0;
}

function metricOf(source, d) {
  if (source === 'gap') return d?.gap_min ?? null;
  if (source === 'thin-gap') return d?.silent_min ?? null;
  return d?.vehicle_count ?? null;
}

function lateness(v) {
  if (v?.lateMin == null) return null;
  if (v.lateMin >= 2) return `${Math.round(v.lateMin)} min late`;
  if (v.lateMin <= -2) return `${Math.round(-v.lateMin)} min early`;
  return 'on time';
}

function vehicleRef(v, tag = null) {
  const extra = [tag, lateness(v)].filter(Boolean).join(', ');
  return `#${v.label}${extra ? ` (${extra})` : ''}`;
}

// Assemble a post: the first two lines (headline and main fact) and the
// footer always; the optional lines after them only while the post still
// fits, most important first (`priority` lists their indexes, best first),
// keeping their original order in the text.
function finish(lines, incident, priority = null) {
  const tail = `🔗 ${SITE_HOST}`;
  const render = (keep) =>
    [...lines.filter((l, i) => l && (i < 2 || keep.has(i))), tail].join('\n\n');
  const keep = new Set();
  const order = priority ?? lines.map((_, i) => i).slice(2);
  for (const i of order) {
    if (!lines[i]) continue;
    keep.add(i);
    if (graphemeLength(render(keep)) > POST_MAX_GRAPHEMES) keep.delete(i);
  }
  const text = firstThatFits([render(keep), [lines[0], tail].join('\n\n')]);
  return { text, facets: linkFacets(text, [{ text: SITE_HOST, uri: eventUrl(incident.id) }]) };
}

/**
 * Text, alt text, and map plan for a detection's post, plus the vehicles a
 * timelapse would follow (`focus`, tagged as on the map).
 * @returns {{ text: string, facets: object[], alt: string, plan: object | null,
 *   focus?: Array<{ v: object, tag: string }> }}
 */
export function composeDetection({ incident, det, vehicles, shapes, calloutLine }) {
  const mode = incident.mode;
  const route = det.scope.route;
  const d = det.evidence?.details ?? {};
  const label = routeShortLabel(mode, route);
  const emoji = routeEmoji(mode, route);
  const noun = vehicleNoun(mode, route);
  const found = (d.vehicles ?? []).map((id) => vehicles.get(String(id))).filter(Boolean);
  const toward = det.scope.direction_label ? ` — ${det.scope.direction_label}` : '';
  const color = routeColor(mode, route);
  const shape = (dir) => shapes?.shape(route, dir) ?? null;
  const allShapes = () => (shapes?.shapes(route) ?? []).map((points) => ({ points, color }));

  if (det.source === 'gap') {
    const [ahead, behind] = [
      vehicles.get(String(d.vehicles?.[0])),
      vehicles.get(String(d.vehicles?.[1])),
    ];
    const from = cleanStopName(behind?.nextStopName);
    const to = cleanStopName(ahead?.nextStopName);
    const between = from && to && from !== to ? ` Nothing between ${from} and ${to}.` : '';
    const lines = [
      `🕳️ ${label}${toward}`,
      `~${d.gap_min} min between ${noun} — scheduled every ~${d.headway_min} min.${between}`,
      d.cancelled_between
        ? `${d.cancelled_between === 1 ? '1 cancelled trip' : `${d.cancelled_between} cancelled trips`} in between.`
        : null,
      ahead && behind ? `Last seen: ${vehicleRef(ahead)} · Next up: ${vehicleRef(behind)}` : null,
      calloutLine,
    ];
    const { text, facets } = finish(lines, incident, [3, 4, 2]);
    let plan = null;
    if (ahead && behind) {
      const line = shape(d.direction_id ?? 0);
      const stretch = stretchBetween(line, behind, ahead);
      plan = planRouteMap({
        routes: line ? [{ points: line, color }] : allShapes(),
        markers: [
          { lat: ahead.lat, lon: ahead.lon, tag: 'L' },
          { lat: behind.lat, lon: behind.lon, tag: 'N' },
        ],
        stretch: stretch ? { points: stretch } : null,
        title: `⚠ ${label} · ~${d.gap_min} min gap`,
      });
    }
    const alt =
      `Map of ${label} with the last ${noun.replace(/s$/, '')} seen (L) and the next one up (N) ` +
      `~${d.gap_min} minutes apart${plan?.stretch ? ', the empty stretch between them dashed' : ''}.`;
    const focus =
      ahead && behind
        ? [
            { v: ahead, tag: 'L' },
            { v: behind, tag: 'N' },
          ]
        : [];
    return { text, facets, alt, plan, focus };
  }

  if (det.source === 'bunching') {
    // Lead vehicle first: furthest along its trip.
    const ordered = [...found].sort(
      (a, b) => (b.nextStopSequence ?? 0) - (a.nextStopSequence ?? 0),
    );
    const span = ordered.length >= 2 ? maxPairDistance(ordered) : (d.distance_m ?? null);
    const near = det.scope.from_station ?? cleanStopName(ordered[0]?.nextStopName);
    const lines = [
      `${emoji} ${label}${toward}`,
      `${d.vehicle_count} ${noun} within ${span != null ? formatDistance(span) : 'a few hundred feet'}${near ? ` near ${near}` : ''}, scheduled ~${d.scheduled_spacing_min} min apart`,
      ordered.length
        ? `${noun[0].toUpperCase()}${noun.slice(1)}: ${ordered.map((v, i) => vehicleRef(v, KEYCAPS[i])).join(', ')}`
        : null,
      calloutLine,
    ];
    const { text, facets } = finish(lines, incident);
    const plan = ordered.length
      ? planRouteMap({
          routes: shape(d.direction_id ?? 0)
            ? [{ points: shape(d.direction_id ?? 0), color }]
            : allShapes(),
          markers: ordered.map((v, i) => ({ lat: v.lat, lon: v.lon, tag: String(i + 1) })),
          title: `⚠ ${label} · ${d.vehicle_count} ${noun} bunched`,
        })
      : null;
    const alt = `Map of ${label} with ${d.vehicle_count} ${noun} numbered in order, running together${near ? ` near ${near}` : ''}.`;
    const focus = ordered.map((v, i) => ({ v, tag: String(i + 1) }));
    return { text, facets, alt, plan, focus };
  }

  if (det.source === 'pulse-held') {
    const n = d.vehicle_count ?? d.busCount ?? found.length;
    const minutes = Math.floor((d.stationaryMs ?? 0) / 60000);
    const near = det.scope.from_station ?? cleanStopName(found[0]?.nextStopName);
    const lines = [
      `${emoji}🚨 ${label}: ${noun} stuck`,
      `🛑 ${n} ${noun} stopped ${minutes}+ min${near ? ` near ${near}` : ''}.`,
      found.length ? found.map((v, i) => vehicleRef(v, KEYCAPS[i])).join(', ') : null,
    ];
    const { text, facets } = finish(lines, incident);
    const plan = found.length
      ? planRouteMap({
          routes: allShapes(),
          markers: found.map((v, i) => ({ lat: v.lat, lon: v.lon, tag: String(i + 1) })),
          title: `⚠ ${label} · ${n} ${noun} stuck`,
        })
      : null;
    const alt = `Map of ${label} with ${n} stopped ${noun} marked${near ? ` near ${near}` : ''}.`;
    return { text, facets, alt, plan };
  }

  // thin-gap
  const lines = [
    `🕳️ ${label}: no ${noun} on the tracker for ~${d.silent_min} min`,
    `Scheduled every ~${d.headway_min} min, so ~${d.missed_trips} trips have gone by unseen.`,
  ];
  const { text, facets } = finish(lines, incident);
  return { text, facets, alt: '', plan: null };
}

/** Hourly progress reply for an ongoing outage-style detection. */
export function progressText(incident, det, now) {
  const route = det.scope.route;
  const label = routeShortLabel(incident.mode, route);
  const noun = vehicleNoun(incident.mode, route);
  const emoji = routeEmoji(incident.mode, route);
  const start = det.lifecycle.onset_ts ?? det.lifecycle.first_seen_ts;
  const hours = Math.max(1, Math.round((now - start) / 3_600_000));
  if (det.source === 'thin-gap') {
    const headway = det.evidence?.details?.headway_min;
    const missed = headway ? Math.floor((now - start) / 60000 / headway) : null;
    return `${emoji} ${label} · still no ${noun} on the tracker — ~${hours}h in${missed ? `, ~${missed} scheduled trips missed so far` : ''}.`;
  }
  return `${emoji} ${label} · ${noun} still stopped — ~${hours}h in.`;
}

/**
 * Post new detections, progress replies, ✅ replies, and related quotes.
 * @param {{ incidents: Map<string, object>, poster: object, db: object,
 *   vehicles: Map<string, object>, shapes: object | null, basemap: Function,
 *   timelapse?: ((opts: object) => unknown) | null, now: number, maxAgeMs: number,
 *   log?: (m: string) => void }} opts
 *   vehicles: the latest positions by vehicle label; timelapse: starts a
 *   timelapse capture after a gap or bunching post (features/timelapse.js)
 */
export async function postDetections({
  incidents,
  poster,
  db,
  vehicles,
  shapes,
  basemap,
  timelapse = null,
  now,
  maxAgeMs,
  log = () => {},
}) {
  const stats = {
    posted: 0,
    skipped: 0,
    deferred: 0,
    updates: 0,
    cleared: 0,
    quoted: 0,
    failed: 0,
  };
  const since = poster.since();
  const candidates = [];
  for (const inc of incidents.values()) {
    for (const det of inc.detections ?? []) {
      if (!POSTED_SOURCES.has(det.source)) continue;
      if (det.lifecycle.active) noteDetection(db, inc, det, vehicles);
      const account = accountFor(inc.mode);
      if (!account || !poster.client.hasAccount(account)) continue;
      const subject = subjectOf(det);
      try {
        const posted = poster.find(subject, 'detection');
        if (posted) {
          if (!FOLLOWED.has(det.source)) continue;
          const r = await followUp({ inc, det, account, subject, posted, poster, now });
          if (r === 'update') stats.updates++;
          if (r === 'cleared') stats.cleared++;
          continue;
        }
        if (poster.skipped(subject)) continue;
        const first = det.lifecycle.first_seen_ts;
        const reason = !det.lifecycle.active
          ? 'resolved-before-post'
          : first < since
            ? 'before-posting-started'
            : now - first > maxAgeMs
              ? 'stale'
              : null;
        if (reason) {
          poster.skip(subject, reason);
          stats.skipped++;
          continue;
        }
        candidates.push({
          inc,
          det,
          account,
          subject,
          score: scoreOf(det.source, det.evidence?.details),
        });
      } catch (err) {
        stats.failed++;
        log(`detections: following up ${det.id} failed: ${err.message}`);
      }
    }
  }

  // New posts, worst first, within each account's hourly budget per kind and
  // at most one per kind per tick. The rest wait for a later tick (until
  // they go stale).
  candidates.sort((a, b) => b.score - a.score);
  const usedThisTick = new Set();
  for (const c of candidates) {
    const budgetKey = `${c.account}|${c.det.source}`;
    if (
      usedThisTick.has(budgetKey) ||
      postedInLastHour(db, c.inc.mode, c.det.source, now) >= (HOURLY_BUDGET[c.det.source] ?? 3)
    ) {
      stats.deferred++;
      continue;
    }
    try {
      const r = await postNew({
        ...c,
        poster,
        db,
        vehicles,
        shapes,
        basemap,
        timelapse,
        now,
        log,
      });
      if (r === 'skipped') stats.skipped++;
      if (r !== 'posted') continue;
      stats.posted++;
      usedThisTick.add(budgetKey);
      if (await quoteIntoAlertThread({ inc: c.inc, subject: c.subject, poster, log }))
        stats.quoted++;
    } catch (err) {
      stats.failed++;
      log(`detections: posting ${c.det.id} failed: ${err.message}`);
    }
  }
  return stats;
}

async function postNew({
  inc,
  det,
  account,
  subject,
  poster,
  db,
  vehicles,
  shapes,
  basemap,
  timelapse,
  now,
  log,
}) {
  const skip = (reason) => {
    poster.skip(subject, reason);
    return 'skipped';
  };
  const route = det.scope.route;
  const d = det.evidence?.details ?? {};
  const score = scoreOf(det.source, d);
  noteDetection(db, inc, det, vehicles);

  // Caps and cooldowns, unless this is clearly the worst of the day.
  const today = postedSince(db, { source: det.source, route, since: startOfEasternDay(now) });
  const worst = today.every((r) => score >= scoreOfEvent(det.source, r) * OVERRIDE_FACTOR);
  if (today.length >= (DAILY_CAP[det.source] ?? 3) && !worst) return skip('daily-cap');
  const key = `det:${det.source}:${inc.mode}:${route}`;
  if (!acquireCooldown(db, [key], now, COOLDOWN_MS)) {
    if (!worst) return skip('cooldown');
    clearCooldown(db, [key]);
    acquireCooldown(db, [key], now, COOLDOWN_MS);
  }

  const label = routeShortLabel(inc.mode, route);
  const found = callouts(db, {
    source: det.source,
    route,
    label,
    ts: now,
    score,
    scoreOf: (r) => scoreOfEvent(det.source, r),
  });
  const calloutLine = formatCallouts(found);
  const { text, facets, alt, plan, focus } = composeDetection({
    incident: inc,
    det,
    vehicles,
    shapes,
    calloutLine,
  });
  let image = null;
  if (plan) {
    try {
      image = { data: await renderRouteMap(plan, { basemap }), alt };
    } catch (err) {
      log(`detections: map for ${det.id} failed: ${err.message}`);
    }
  }
  const post = await poster.post({
    account,
    kind: 'detection',
    subject,
    text,
    facets,
    // The worst on this route in 30 days, even if the callout didn't fit.
    highlight: found.includes(RECORD_PHRASE[det.source]) ? 'record' : null,
    ...(image
      ? { image }
      : {
          link: {
            url: eventUrl(inc.id),
            title: det.description,
            description: 'Live status and history on SEPTA Transit Alerts.',
            fallbackThumbUrl: `${SITE_ORIGIN}/og-image.png`,
          },
        }),
  });
  markPosted(db, subject, now);
  // Follow the vehicles for a timelapse reply (gaps and bunches with a map).
  if (timelapse && image && focus?.length >= 2) {
    try {
      timelapse({
        kind: det.source,
        subject,
        account,
        mode: inc.mode,
        routes: [route],
        directionId: d.direction_id ?? null,
        title: plan.title.replace(/^⚠\s*/, ''),
        header: `🎬 ${label}${det.scope.direction_label ? ` — ${det.scope.direction_label}` : ''} · the next 10 minutes`,
        noun: vehicleNoun(inc.mode, route),
        vehicles: focus.map(({ v, tag }) => ({
          id: String(v.id),
          label: String(v.label),
          tag,
          route: v.route,
        })),
        post,
        now,
      });
    } catch (err) {
      log(`detections: starting the timelapse for ${det.id} failed: ${err.message}`);
    }
  }
  return 'posted';
}

/**
 * Record a detection in the history (once; later calls only keep it), where
 * its first vehicle is: the recaps count every detection seen, posted or not.
 */
function noteDetection(db, inc, det, vehicles) {
  const d = det.evidence?.details ?? {};
  const anchor = vehicles.get(String(d.vehicles?.[0]));
  recordEvent(db, {
    subject: subjectOf(det),
    source: det.source,
    mode: inc.mode,
    route: det.scope.route,
    metric: metricOf(det.source, d),
    ratio: det.source === 'gap' ? scoreOf(det.source, d) : null,
    near: det.scope.from_station ?? cleanStopName(anchor?.nextStopName),
    lat: anchor?.lat ?? null,
    lon: anchor?.lon ?? null,
    ts: det.lifecycle.first_seen_ts,
  });
}

function postedInLastHour(db, mode, source, now) {
  return db
    .prepare(
      'SELECT COUNT(*) AS n FROM detection_events WHERE mode = ? AND source = ? AND posted = 1 AND posted_ts >= ?',
    )
    .get(mode, source, now - 60 * 60 * 1000).n;
}

function scoreOfEvent(source, row) {
  return source === 'gap' ? (row.ratio ?? 0) : (row.metric ?? 0);
}

async function followUp({ inc, det, account, subject, posted, poster, now }) {
  if (det.lifecycle.active) {
    const last = poster.find(subject, 'update') ?? posted;
    if (now - last.ts < UPDATE_EVERY_MS) return null;
    await poster.post({
      account,
      kind: 'update',
      subject,
      reply: posted.uri,
      text: progressText(inc, det, now),
    });
    return 'update';
  }
  if (poster.find(subject, 'cleared') || poster.skipped(`${subject}:cleared`)) return null;
  if (now - (det.lifecycle.resolved_ts ?? now) > CLEARED_MAX_AGE_MS) {
    poster.skip(`${subject}:cleared`, 'stale');
    return null;
  }
  const resolved = det.evidence?.resolved_description ?? 'Back to normal.';
  await poster.post({
    account,
    kind: 'cleared',
    subject,
    reply: posted.uri,
    text: `✅ ${resolved}`,
  });
  return 'cleared';
}

// When the detection is part of a SEPTA alert's incident, quote it into the
// alerts account's thread for that alert (at most a few per thread).
async function quoteIntoAlertThread({ inc, subject, poster, log }) {
  const alertId = inc.official_alert?.id;
  if (!alertId || !poster.client.hasAccount('alerts')) return false;
  const alertSubject = `septa-alert:${alertId}`;
  const alertPost = poster.find(alertSubject, 'alert');
  const detPost = poster.find(subject, 'detection');
  if (!alertPost || !detPost) return false;
  if (poster.count(alertSubject, 'related-quote') >= MAX_QUOTES_PER_THREAD) return false;
  try {
    await poster.post({
      account: 'alerts',
      kind: 'related-quote',
      subject: alertSubject,
      reply: alertPost.uri,
      text: '🕵 Related observation',
      quote: { uri: detPost.uri, cid: detPost.cid },
    });
    return true;
  } catch (err) {
    log(`detections: quoting ${subject} into the alert thread failed: ${err.message}`);
    return false;
  }
}

/**
 * Write detection post links into the published incidents: post_url (its
 * own post, or the rollup it appeared in) and resolved_post_url (✅ reply).
 */
export function linkDetectionPosts(incidents, poster) {
  if (poster.dryRun) return 0;
  let linked = 0;
  for (const inc of incidents.values()) {
    let touched = false;
    const detections = (inc.detections ?? []).map((det) => {
      const subject = subjectOf(det);
      const post = poster.find(subject, 'detection') ?? poster.find(subject, 'rollup');
      if (!post) return det;
      const cleared = poster.find(subject, 'cleared');
      const postUrl = post.url;
      const resolvedUrl = cleared?.url ?? null;
      if (det.post_url === postUrl && (det.resolved_post_url ?? null) === resolvedUrl) return det;
      touched = true;
      return { ...det, post_url: postUrl, resolved_post_url: resolvedUrl };
    });
    if (touched) {
      incidents.set(inc.id, { ...inc, detections });
      linked++;
    }
  }
  return linked;
}
