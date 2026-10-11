// PCC trolleys on the G1. Most G1 (Girard Ave, formerly Route 15) trips run
// with buses, but on some days SEPTA puts its restored PCC trolleys on the
// line. The collector picks them out of TransitView's G1 positions by fleet
// number (src/lib/pcc.js) every tick and hands the result to the bot.
//
// The metro account posts when the day's first PCC comes out, with a map, and
// replies in the same thread for each car that comes out after it (each car
// once a day). A car must have been out CONFIRM_MS before it's posted, so a
// one-poll blip never posts. Each post links to the G Trolley Tracker
// (github.com/cristofer-slotoroff/g-trolley-tracker), which follows the cars live.
import { easternDateKey } from '../../collector/lib/time.js';
import { PCC_LINE, PCC_TRACKER_URL } from '../../src/lib/pcc.js';
import { firstThatFits, linkFacets } from '../lib/text.js';
import { bboxOf, fitView } from '../map/projection.js';
import { MAP_SIZE, renderRouteMap, routeColor } from '../map/routeMap.js';

// A car out this long is posted.
export const CONFIRM_MS = 3 * 60 * 1000;
const KEYCAPS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
const TRACKER_HOST = new URL(PCC_TRACKER_URL).host;

function carLine(car, tag, { stop = true } = {}) {
  const where = [
    car.direction,
    car.destination ? `to ${car.destination}` : null,
    stop && car.next_stop ? `· next stop ${car.next_stop}` : null,
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

const hasPosition = (car) => Number.isFinite(car.lat) && Number.isFinite(car.lon);

/** The whole G1, drawn under the PCC cars, numbered in list order. */
function planPccMap({ cars, shapes, title }) {
  const lines = (shapes?.shapes(PCC_LINE) ?? []).filter((p) => p?.length >= 2);
  const markers = cars
    .map((car, i) => ({ car, tag: String(i + 1) }))
    .filter(({ car }) => hasPosition(car))
    .map(({ car, tag }) => ({ lat: car.lat, lon: car.lon, tag }));
  if (!markers.length || !lines.length) return null;
  const focus = [...lines.flat(), ...markers.map((m) => [m.lat, m.lon])];
  const color = routeColor('metro', PCC_LINE);
  return {
    routes: lines.map((points) => ({ points, color })),
    markers,
    stretch: null,
    title,
    view: fitView(bboxOf(focus), MAP_SIZE, MAP_SIZE, { pad: 120, minZoom: 11, maxZoom: 16 }),
  };
}

/**
 * Text, link facets, alt text, and map plan for a PCC post.
 * @param {{ cars: object[], newIds: string[], first: boolean, buses: number | null,
 *   shapes?: object | null }} opts
 *   cars: every PCC out now (pcc.json's shape); newIds: the ones this post announces;
 *   first: the day's first post (shows only its cars; a reply shows every car out)
 */
export function composePccPost({ cars, newIds, first, buses, shapes = null }) {
  const shown = first ? cars.filter((c) => newIds.includes(c.id)) : cars;
  const fresh = shown.filter((c) => newIds.includes(c.id));
  const plural = fresh.length > 1;
  const title = first
    ? `G1 · ${plural ? `${fresh.length} PCC trolleys` : `PCC #${fresh[0].id}`} out now`
    : `G1 · ${cars.length} PCC trolley${cars.length === 1 ? '' : 's'} out now`;
  const plan = planPccMap({ cars: shown, shapes, title });
  const tag = (car) => (plan ? KEYCAPS[shown.indexOf(car)] : null);

  const head = first
    ? plural
      ? `🚋✨ ${fresh.length} vintage PCC trolleys are out on the G1 today!`
      : '🚋✨ A vintage PCC trolley is out on the G1 today!'
    : `🚋 Another PCC is out on the G1: ${listIds(fresh.map((c) => c.id))}`;
  const nowLine = first ? null : `PCCs out now (${cars.length}):`;
  const block = (lines) => [nowLine, ...lines].filter(Boolean).join('\n');
  const fullCars = block(shown.map((c) => carLine(c, tag(c))));
  const shortCars = block(shown.map((c) => carLine(c, tag(c), { stop: false })));
  const idsOnly = block([shown.map((c) => `${tag(c) ? `${tag(c)} ` : ''}#${c.id}`).join(' · ')]);
  const busLine =
    buses > 0
      ? `The other ${buses === 1 ? 'G1 vehicle out is a bus' : `${buses} G1 vehicles out are buses`}.`
      : null;
  const link = `📍 Follow ${shown.length > 1 ? 'them' : 'it'} live: ${TRACKER_HOST}`;
  const render = (...parts) => parts.filter(Boolean).join('\n\n');
  const text = firstThatFits([
    render(head, fullCars, busLine, link),
    render(head, shortCars, busLine, link),
    render(head, shortCars, link),
    render(head, idsOnly, link),
  ]);

  const marked = plan ? shown.filter(hasPosition) : [];
  const alt = plan
    ? `Map of the G1 along Girard Avenue with ${marked.length === 1 ? 'PCC trolley' : 'PCC trolleys'} ` +
      `${listIds(marked.map((c) => c.id))} marked` +
      (marked.length > 1
        ? ` (${marked.map((c) => `#${c.id} is ${shown.indexOf(c) + 1}`).join(', ')})`
        : '') +
      '.'
    : '';
  return {
    text,
    facets: linkFacets(text, [{ text: TRACKER_HOST, uri: PCC_TRACKER_URL }]),
    plan,
    alt,
  };
}

/**
 * Post on the metro account when PCC cars come out.
 * @param {{ poster: object, pcc: { cars: object[], buses: number } | null,
 *   shapes?: object | null, basemap: Function, now: number, log?: (m: string) => void }} opts
 *   pcc: the collector's PCC status this tick (null when TransitView didn't come through)
 */
export async function maybePostPcc({ poster, pcc, shapes = null, basemap, now, log = () => {} }) {
  const account = 'metro';
  if (!pcc || !poster.client.hasAccount(account)) return null;
  const today = easternDateKey(now);
  const daySubject = `pcc:${today}`;
  const carSubject = (id) => `pcc:${today}:${id}`;
  const newIds = pcc.cars
    .filter((c) => now - c.first_seen_ts >= CONFIRM_MS)
    .map((c) => c.id)
    .filter((id) => !poster.find(carSubject(id), 'pcc'));
  const result = { cars: pcc.cars.length, posted: 0 };
  if (!newIds.length) return result;

  const dayPost = poster.find(daySubject, 'pcc-day');
  const { text, facets, plan, alt } = composePccPost({
    cars: pcc.cars,
    newIds,
    first: !dayPost,
    buses: pcc.buses,
    shapes,
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
            url: PCC_TRACKER_URL,
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
