// SEPTA's vintage PCC trolleys on the G1. Most G1 trips run with buses; on
// some days SEPTA puts its restored PCC cars on the line. They're told apart by
// fleet number: a PCC's is four digits starting "23", a bus's isn't.
// That's the rule the G Trolley Tracker (github.com/cristofer-slotoroff/g-trolley-tracker)
// uses too; riders are pointed at it to follow the cars live.
//
// The collector applies it to TransitView's G1 positions every tick and
// publishes the result as `pcc.json` (the G1 page's banner reads it); the bots
// post from the same result. Pure functions only: the collector runs in Node.

export const PCC_TRACKER_URL = 'https://septa-g-trolley-tracker.netlify.app/';
export const PCC_LINE = 'g1';
export const PCC_FILE = 'pcc.json';
// A car unseen this long, then seen again, is a new sighting (back out from the depot).
export const PCC_LOST_MS = 15 * 60 * 1000;

/** A PCC car's fleet number: four digits starting "23". */
export function isPccLabel(label) {
  return /^23\d\d$/.test(String(label ?? '').trim());
}

const direction = (name) => (/^(east|west)bound$/i.test(name ?? '') ? name : null);
const round = (n, places) => (Number.isFinite(n) ? Number(n.toFixed(places)) : null);

/**
 * The PCC cars among the G1's vehicles, with how long each has been out.
 * @param {Array<{ route: string, label: string, directionName?: string | null,
 *   destination?: string | null, nextStopName?: string | null, lat: number, lon: number,
 *   lateMin?: number | null }>} vehicles normalized positions (any routes)
 * @param {{ cars?: Record<string, { since: number, last: number }> } | null} prev the last
 *   call's `state`
 * @returns {{ status: { updated_ts: number, cars: Array<{ id: string, direction: string | null,
 *   destination: string | null, next_stop: string | null, lat: number | null, lon: number | null,
 *   late_min: number | null, first_seen_ts: number }>, buses: number },
 *   state: { cars: Record<string, { since: number, last: number }> } }}
 *   first_seen_ts: when the car's current spell on the line began
 */
export function pccSightings(vehicles, prev, now) {
  const g1 = (vehicles ?? []).filter((v) => v.route === PCC_LINE);
  const pccs = g1.filter((v) => isPccLabel(v.label));
  const cars = {};
  // Keep recently seen cars a while, so one missed poll doesn't restart a car's spell.
  for (const [id, seen] of Object.entries(prev?.cars ?? {})) {
    if (now - seen.last <= PCC_LOST_MS) cars[id] = seen;
  }
  for (const v of pccs) {
    const id = String(v.label).trim();
    cars[id] = cars[id] ? { ...cars[id], last: now } : { since: now, last: now };
  }
  const out = pccs
    .map((v) => {
      const id = String(v.label).trim();
      return {
        id,
        direction: direction(v.directionName),
        destination: v.destination || null,
        next_stop: v.nextStopName || null,
        lat: round(v.lat, 6),
        lon: round(v.lon, 6),
        late_min: Number.isFinite(v.lateMin) ? v.lateMin : null,
        first_seen_ts: cars[id].since,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    status: { updated_ts: now, cars: out, buses: g1.length - pccs.length },
    state: { cars },
  };
}

/**
 * The published `pcc.json` as the site reads it; throws on a payload that isn't one.
 * @returns {{ updatedTs: number | null, cars: object[], buses: number | null }}
 */
export function parsePccFile(body) {
  if (!Array.isArray(body?.cars)) throw new Error('pcc.json has no cars');
  const cars = body.cars.filter((c) => isPccLabel(c?.id));
  const buses = Number(body.buses);
  const updated = Number(body.updated_ts);
  return {
    updatedTs: Number.isFinite(updated) && updated > 0 ? updated : null,
    cars,
    buses: body.buses != null && Number.isFinite(buses) ? buses : null,
  };
}
