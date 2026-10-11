// PCC trolleys on the G1. Most G1 (Girard Ave, formerly Route 15) trips run
// with buses, but on some days SEPTA puts its restored PCC trolleys (fleet
// numbers 23xx) on the line. The G Trolley Tracker
// (https://septa-g-trolley-tracker.netlify.app, source at
// github.com/cristofer-slotoroff/g-trolley-tracker) follows them; this reads
// its public feeds (src/lib/pcc.js, shared with the G1 page's banner):
//
//   widget-status  which PCC cars are out right now, and how many G1 buses
//   pcc-stats      each car's all-time record (days out, first seen)
//
// The metro account posts when the day's first PCC comes out, with a map, and
// replies in the same thread for each car that comes out after it (each car
// once a day). A car must be seen on two polls at least CONFIRM_MS apart, so a
// one-poll blip never posts. If the tracker can't be reached, the same rule it
// uses (a 4-digit fleet number starting "23") is applied to SEPTA's own G1
// positions, so a tracker outage doesn't lose the post.
import { easternDateKey, easternParts } from '../../collector/lib/time.js';
import {
  fetchPccStatus,
  isPccLabel,
  PCC_LINE,
  PCC_TRACKER_URL,
  pccTrackerEndpoint,
} from '../../src/lib/pcc.js';
import { dayLabel } from '../lib/clock.js';
import { getMeta, setMeta } from '../lib/db.js';
import { firstThatFits, linkFacets, ordinal } from '../lib/text.js';
import { bboxOf, fitView } from '../map/projection.js';
import { MAP_SIZE, renderRouteMap, routeColor } from '../map/routeMap.js';

export { isPccLabel, PCC_TRACKER_URL };
export const PCC_ROUTE = PCC_LINE;
// A car seen on polls this far apart is out; one unseen this long starts over.
export const CONFIRM_MS = 3 * 60 * 1000;
export const LOST_MS = 15 * 60 * 1000;
// Philadelphia hours the tracker is polled (PCCs run by day, about 7 AM to 7 PM).
export const POLL_HOURS = [5, 23];
const STATE_KEY = 'pcc_sightings';
const KEYCAPS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
const USER_AGENT = { 'user-agent': 'septa-transit-alerts bots' };

/** The PCC cars out now and the G1 bus count, from the tracker's widget feed. */
export function fetchTrackerStatus({ baseUrl = PCC_TRACKER_URL, fetchFn = fetch } = {}) {
  return fetchPccStatus({ base: baseUrl, fetchFn, headers: USER_AGENT });
}

/**
 * Each car's all-time record from the tracker, by fleet number:
 * { daysActive, firstSeen, lastSeen } (dates as YYYY-MM-DD, Philadelphia).
 * @returns {Promise<Map<string, { daysActive: number, firstSeen: string | null, lastSeen: string | null }>>}
 */
export async function fetchTrackerStats({ baseUrl = PCC_TRACKER_URL, fetchFn = fetch } = {}) {
  const res = await fetchFn(pccTrackerEndpoint('pcc-stats', baseUrl), {
    signal: AbortSignal.timeout(15000),
    headers: { accept: 'application/json', ...USER_AGENT },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  const stats = new Map();
  for (const v of Array.isArray(body?.vehicleAllTime) ? body.vehicleAllTime : []) {
    const days = Number(v?.daysActive);
    if (!isPccLabel(v?.vehicleId) || !Number.isFinite(days)) continue;
    stats.set(String(v.vehicleId), {
      daysActive: days,
      firstSeen: v.firstSeen ?? null,
      lastSeen: v.lastSeen ?? null,
    });
  }
  return stats;
}

/** The same picture from SEPTA's G1 positions (the fallback when the tracker is down). */
export function pccFromVehicles(vehicles) {
  const g1 = (vehicles ?? []).filter((v) => v.route === PCC_ROUTE);
  const cars = g1
    .filter((v) => isPccLabel(v.label))
    .map((v) => ({
      id: String(v.label),
      direction: /^(east|west)bound$/i.test(v.directionName ?? '') ? v.directionName : null,
      destination: v.destination || null,
    }));
  return { cars, buses: g1.length - cars.length };
}

/**
 * Fold one poll's cars into the day's sightings. A car is confirmed once it
 * has been seen continuously (no gap over LOST_MS) for CONFIRM_MS.
 * @param {{ date?: string, cars?: Record<string, { since: number, last: number }> } | null} prev
 * @returns {{ state: object, confirmed: string[] }}
 */
export function trackSightings(prev, ids, { now, date }) {
  const cars = prev?.date === date ? { ...prev.cars } : {};
  for (const id of ids) {
    const seen = cars[id];
    cars[id] =
      seen && now - seen.last <= LOST_MS ? { ...seen, last: now } : { since: now, last: now };
  }
  const confirmed = ids.filter((id) => now - cars[id].since >= CONFIRM_MS);
  return { state: { date, cars }, confirmed };
}

function carLine(car, pos, tag) {
  const where = [
    car.direction,
    car.destination ? `to ${car.destination}` : null,
    pos?.nextStopName ? `· next stop ${pos.nextStopName}` : null,
  ]
    .filter(Boolean)
    .join(' ');
  return `${tag ? `${tag} ` : ''}#${car.id}${where ? ` · ${where}` : ''}`;
}

const listIds = (ids) =>
  ids.length <= 2
    ? ids.map((id) => `#${id}`).join(' and ')
    : `${ids
        .slice(0, -1)
        .map((id) => `#${id}`)
        .join(', ')}, and #${ids.at(-1)}`;

/** "📊 #2324's 103rd day on the G1 since Feb 9", from the tracker's record. */
export function statsLine(ids, stats, today) {
  if (!stats?.size) return null;
  const since = (key) =>
    key.slice(0, 4) === today.slice(0, 4) ? dayLabel(key) : `${dayLabel(key)}, ${key.slice(0, 4)}`;
  const known = ids
    .map((id) => ({ id, s: stats.get(id) }))
    .filter(({ s }) => s?.firstSeen)
    .map(({ id, s }) => ({
      id,
      firstSeen: s.firstSeen,
      // The tracker's count includes today once it has recorded the car today.
      days: s.daysActive + (s.lastSeen === today ? 0 : 1),
      debut: s.firstSeen === today,
    }));
  if (!known.length) return null;
  const debuts = known.filter((k) => k.debut);
  if (debuts.length)
    return `🎉 A first: the tracker has never seen ${listIds(debuts.map((k) => k.id))} out before.`;
  if (known.length === 1) {
    const [k] = known;
    return `📊 #${k.id}'s ${ordinal(k.days)} day on the G1 since ${since(k.firstSeen)}, per the tracker`;
  }
  return `📊 Days on the G1, per the tracker: ${known.map((k) => `#${k.id} ${k.days}`).join(' · ')}`;
}

/** The whole G1, drawn under the PCC cars that have positions. */
function planPccMap({ cars, positions, shapes, title }) {
  const lines = (shapes?.shapes(PCC_ROUTE) ?? []).filter((p) => p?.length >= 2);
  const markers = cars
    .map((car, i) => ({ car, pos: positions.get(car.id), tag: String(i + 1) }))
    .filter(({ pos }) => pos && Number.isFinite(pos.lat) && Number.isFinite(pos.lon))
    .map(({ pos, tag }) => ({ lat: pos.lat, lon: pos.lon, tag }));
  if (!markers.length || !lines.length) return null;
  const focus = [...lines.flat(), ...markers.map((m) => [m.lat, m.lon])];
  const color = routeColor('metro', PCC_ROUTE);
  return {
    routes: lines.map((points) => ({ points, color })),
    markers,
    stretch: null,
    title,
    view: fitView(bboxOf(focus), MAP_SIZE, MAP_SIZE, { pad: 120, minZoom: 11, maxZoom: 16 }),
  };
}

/**
 * Text, link facets, and map plan for a PCC post.
 * @param {{ cars: Array<{ id: string, direction: string | null, destination: string | null }>,
 *   newIds: string[], first: boolean, buses: number | null, positions: Map<string, object>,
 *   stats?: Map<string, object> | null, today: string, shapes?: object | null,
 *   trackerUrl?: string }} opts
 *   cars: every PCC out now; newIds: the ones this post announces; first: the day's first post
 */
export function composePccPost({
  cars,
  newIds,
  first,
  buses,
  positions,
  stats = null,
  today,
  shapes = null,
  trackerUrl = PCC_TRACKER_URL,
}) {
  const host = new URL(trackerUrl).host;
  // The first post shows the cars it announces; a reply shows every car out now.
  const shown = first ? cars.filter((c) => newIds.includes(c.id)) : cars;
  const fresh = shown.filter((c) => newIds.includes(c.id));
  const plural = fresh.length > 1;
  const title = first
    ? `G1 · ${plural ? `${fresh.length} PCC trolleys` : `PCC #${fresh[0].id}`} out now`
    : `G1 · ${cars.length} PCC trolley${cars.length === 1 ? '' : 's'} out now`;
  const plan = planPccMap({ cars: shown, positions, shapes, title });
  const tag = (car) => (plan ? KEYCAPS[shown.indexOf(car)] : null);

  const head = first
    ? plural
      ? `🚋✨ ${fresh.length} vintage PCC trolleys are out on the G1 today!`
      : '🚋✨ A vintage PCC trolley is out on the G1 today!'
    : `🚋 Another PCC is out on the G1: ${listIds(fresh.map((c) => c.id))}`;
  const fullCars = (first ? fresh : shown).map((c) => carLine(c, positions.get(c.id), tag(c)));
  const shortCars = (first ? fresh : shown).map((c) => carLine(c, null, tag(c)));
  const idsOnly = (first ? fresh : shown).map((c) => `${tag(c) ? `${tag(c)} ` : ''}#${c.id}`);
  const nowLine = first ? null : `PCCs out now (${cars.length}):`;
  const busLine =
    buses > 0
      ? `The other ${buses === 1 ? 'G1 vehicle out is a bus' : `${buses} G1 vehicles out are buses`}.`
      : null;
  const stat = statsLine(
    fresh.map((c) => c.id),
    stats,
    today,
  );
  const link = `📍 Live: ${host}`;
  const render = (...parts) => parts.filter(Boolean).join('\n\n');
  const block = (list) => [nowLine, ...list].filter(Boolean).join('\n');
  const text = firstThatFits([
    render(head, block(fullCars), busLine, stat, link),
    render(head, block(fullCars), stat, link),
    render(head, block(shortCars), stat, link),
    render(head, block(shortCars), link),
    render(head, block([idsOnly.join(' · ')]), link),
  ]);

  const marked = plan ? shown.filter((c) => positions.get(c.id)) : [];
  const alt = plan
    ? `Map of the G1 along Girard Avenue with ${marked.length === 1 ? 'PCC trolley' : 'PCC trolleys'} ` +
      `${listIds(marked.map((c) => c.id))} marked${marked.length > 1 ? ` (${marked.map((c) => `#${c.id} is ${shown.indexOf(c) + 1}`).join(', ')})` : ''}.`
    : '';
  return { text, facets: linkFacets(text, [{ text: host, uri: trackerUrl }]), plan, alt };
}

/**
 * Poll the tracker and post on the metro account when PCC cars come out.
 * @param {{ poster: object, db: object, vehicles: object[], shapes?: object | null,
 *   basemap: Function, now: number, trackerUrl?: string | null, fetchFn?: typeof fetch,
 *   log?: (m: string) => void }} opts
 *   vehicles: the collector tick's screened positions (for the map, and the fallback);
 *   trackerUrl: null to skip the tracker (offline runs) and use SEPTA's positions only
 */
export async function maybePostPcc({
  poster,
  db,
  vehicles,
  shapes = null,
  basemap,
  now,
  trackerUrl = PCC_TRACKER_URL,
  fetchFn = fetch,
  log = () => {},
}) {
  const account = 'metro';
  if (!poster.client.hasAccount(account)) return null;
  const { hour } = easternParts(now);
  if (hour < POLL_HOURS[0] || hour >= POLL_HOURS[1]) return null;

  let status = null;
  let source = 'tracker';
  if (trackerUrl) {
    try {
      status = await fetchTrackerStatus({ baseUrl: trackerUrl, fetchFn });
    } catch (err) {
      log(`pcc: tracker unavailable (${err.message}); using SEPTA's G1 positions`);
    }
  }
  if (!status) {
    status = pccFromVehicles(vehicles);
    source = 'septa';
  }

  const today = easternDateKey(now);
  let prev = null;
  try {
    prev = JSON.parse(getMeta(db, STATE_KEY) ?? 'null');
  } catch {}
  const { state, confirmed } = trackSightings(
    prev,
    status.cars.map((c) => c.id),
    { now, date: today },
  );
  setMeta(db, STATE_KEY, JSON.stringify(state));

  const daySubject = `pcc:${today}`;
  const carSubject = (id) => `pcc:${today}:${id}`;
  const newIds = confirmed.filter((id) => !poster.find(carSubject(id), 'pcc')).sort();
  const result = { source, cars: status.cars.length, posted: 0 };
  if (!newIds.length) return result;

  const dayPost = poster.find(daySubject, 'pcc-day');
  let stats = null;
  if (trackerUrl) {
    try {
      stats = await fetchTrackerStats({ baseUrl: trackerUrl, fetchFn });
    } catch (err) {
      log(`pcc: tracker stats unavailable: ${err.message}`);
    }
  }
  const positions = new Map(
    (vehicles ?? [])
      .filter((v) => v.route === PCC_ROUTE && isPccLabel(v.label))
      .map((v) => [String(v.label), v]),
  );
  const cars = [...status.cars].sort((a, b) => a.id.localeCompare(b.id));
  const { text, facets, plan, alt } = composePccPost({
    cars,
    newIds,
    first: !dayPost,
    buses: status.buses,
    positions,
    stats,
    today,
    shapes,
    trackerUrl: trackerUrl ?? PCC_TRACKER_URL,
  });
  let image = null;
  if (plan) {
    try {
      image = { data: await renderRouteMap(plan, { basemap }), alt };
    } catch (err) {
      log(`pcc: map failed: ${err.message}`);
    }
  }
  // The day's first post is the thread's root; each later one is recorded under its first car.
  const kind = dayPost ? 'pcc' : 'pcc-day';
  const subject = dayPost ? carSubject(newIds[0]) : daySubject;
  const post = await poster.post({
    account,
    kind,
    subject,
    text,
    facets,
    ...(dayPost && { reply: dayPost.uri }),
    ...(image
      ? { image }
      : {
          link: {
            url: trackerUrl ?? PCC_TRACKER_URL,
            title: 'G Trolley Tracker',
            description: 'Where SEPTA’s vintage PCC trolleys are on the G1 right now.',
          },
        }),
  });
  const recorded = poster.find(subject, kind);
  for (const id of newIds) {
    if (carSubject(id) !== subject) {
      poster.alias({ account, kind: 'pcc', subject: carSubject(id), post: recorded });
    }
  }
  result.posted = newIds.length;
  result.url = post?.url ?? null;
  return result;
}
