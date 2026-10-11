// SEPTA's vintage PCC trolleys on the G1. Most G1 trips run with buses; on
// some days SEPTA puts its restored PCC cars (fleet numbers 23xx) on the line.
// The G Trolley Tracker (github.com/cristofer-slotoroff/g-trolley-tracker)
// follows them and publishes which cars are out in a small public feed (CORS
// open, cached 60 seconds). The G1 page's banner reads it straight from the
// browser; the bots (bot/features/pcc.js) post from it.

export const PCC_TRACKER_URL = 'https://septa-g-trolley-tracker.netlify.app/';
export const PCC_LINE = 'g1';

/** A PCC car's fleet number: four digits starting "23" (the tracker's rule). */
export function isPccLabel(label) {
  return /^23\d\d$/.test(String(label ?? '').trim());
}

/** One of the tracker's Netlify functions, e.g. "widget-status". */
export function pccTrackerEndpoint(fn, base = PCC_TRACKER_URL) {
  return new URL(`.netlify/functions/${fn}`, base.endsWith('/') ? base : `${base}/`).href;
}

/**
 * The tracker's widget-status payload as the PCC cars out now and the G1 bus
 * count. Throws on a payload that isn't one.
 * @returns {{ cars: Array<{ id: string, direction: string | null, destination: string | null }>,
 *   buses: number | null, updatedAt: number | null }}
 */
export function parsePccStatus(body) {
  if (!Array.isArray(body?.vehicles)) throw new Error('tracker status has no vehicles');
  const cars = body.vehicles
    .filter((v) => isPccLabel(v?.id))
    .map((v) => ({
      id: String(v.id).trim(),
      direction: /^(east|west)bound$/i.test(v.direction ?? '') ? v.direction : null,
      destination: v.destination || null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const buses = Number(body.busCount);
  const updatedAt = Date.parse(body.updatedAt ?? '');
  return {
    cars,
    buses: body.busCount != null && Number.isFinite(buses) ? buses : null,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : null,
  };
}

/** Fetch and parse the tracker's widget-status feed. */
export async function fetchPccStatus({
  base = PCC_TRACKER_URL,
  fetchFn = fetch,
  timeoutMs = 15000,
  headers = {},
} = {}) {
  const res = await fetchFn(pccTrackerEndpoint('widget-status', base), {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json', ...headers },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parsePccStatus(await res.json());
}
