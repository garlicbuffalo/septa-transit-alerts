// Regional Rail station roster + slug helpers — the Regional Rail parallel of
// the SEPTA Metro station system in stations.js. Built from railStations.json
// (generated from SEPTA's GTFS by scripts/build-reference-data.js). Regional
// Rail stations live under `/rail/station/:slug` to keep them isolated from the
// Metro `/station/:slug` namespace — several names (Olney, Wayne Junction's
// neighbors, 69th St area stops) exist on both networks.

import { normalizeRailLine } from './railLines.js';
import railStationsData from './railStations.json' with { type: 'json' };
import { slugifyStation } from './stations.js';

// slug → { slug, name, lines: [rail line keys] }, and slug → Set(line keys).
const RAIL_BY_SLUG = new Map();
const SERVED_LINES = new Map();

for (const [route, stations] of Object.entries(railStationsData)) {
  const lineKey = normalizeRailLine(route);
  for (const st of stations || []) {
    const slug = slugifyStation(st.name);
    if (!slug) continue;
    if (!SERVED_LINES.has(slug)) SERVED_LINES.set(slug, new Set());
    SERVED_LINES.get(slug).add(lineKey);
    if (!RAIL_BY_SLUG.has(slug)) {
      RAIL_BY_SLUG.set(slug, { slug, name: st.name, lines: [] });
    }
  }
}
for (const [slug, rec] of RAIL_BY_SLUG) {
  rec.lines = [...SERVED_LINES.get(slug)].sort();
}

/** True if `slug` matches a Regional Rail roster station. */
export function isKnownRailStationSlug(slug) {
  return slug != null && RAIL_BY_SLUG.has(slug);
}

/** Roster record `{ slug, name, lines }` for a Regional Rail station slug, or null. */
export function railStationBySlug(slug) {
  return RAIL_BY_SLUG.get(slug) ?? null;
}

/** Regional Rail line keys serving a station name (empty when unrecognized). */
export function railLinesServingStation(name) {
  const slug = slugifyStation(name);
  return slug ? [...(SERVED_LINES.get(slug) || [])] : [];
}

/** Roster stations served by a Regional Rail line key, in roster order. */
export function railStationsServingLine(lineKey) {
  return [...RAIL_BY_SLUG.values()].filter((s) => s.lines.includes(lineKey));
}

/** Every Regional Rail roster station `{ slug, name, lines }`, name-sorted. */
export function railStationRoster() {
  return [...RAIL_BY_SLUG.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * slug → { slug, name, lines, count } for Regional Rail stations referenced by
 * an incident in the rolling window. The Regional Rail analog of
 * `buildStationIndex` (stations.js): cancellation/delay observations carry the
 * train's origin/destination, and SEPTA alerts carry affected/mentioned
 * stations.
 * @param {Array} alerts
 * @param {Array} observations
 * @param {{ now?: number, windowDays?: number }} [opts]
 */
export function buildRailStationIndex(
  alerts,
  observations,
  { now = Date.now(), windowDays = 90 } = {},
) {
  const cutoff = now - windowDays * DAY_MS;
  const index = new Map();
  function bucket(name) {
    const slug = slugifyStation(name);
    if (!slug) return null;
    if (!index.has(slug)) {
      const roster = RAIL_BY_SLUG.get(slug);
      index.set(slug, {
        slug,
        name: roster?.name ?? name,
        // Seed every line that physically serves the station, like the Metro index.
        lines: new Set(SERVED_LINES.get(slug) || []),
        alerts: [],
        observations: [],
      });
    }
    return index.get(slug);
  }

  for (const o of observations || []) {
    if (o.kind !== 'rail' || o.ts < cutoff) continue;
    for (const name of [o.from_station, o.to_station]) {
      const rec = bucket(name);
      if (rec && !rec.observations.includes(o)) rec.observations.push(o);
    }
  }
  for (const a of alerts || []) {
    if (a.kind !== 'rail' || a.first_seen_ts < cutoff) continue;
    // affected_stations is the full stretch ("between Noble and Neshaminy
    // Falls" → every stop in between); it supersedes the bare endpoints.
    const segment = a.affected_stations?.length
      ? a.affected_stations
      : [a.affected_from_station, a.affected_to_station];
    const names = [...segment, ...(a.mentioned_stations || [])];
    for (const name of names) {
      const rec = bucket(name);
      if (rec && !rec.alerts.includes(a)) rec.alerts.push(a);
    }
  }

  const out = new Map();
  for (const [slug, rec] of index) {
    out.set(slug, {
      slug: rec.slug,
      name: rec.name,
      lines: [...rec.lines].sort(),
      count: rec.alerts.length + rec.observations.length,
    });
  }
  return out;
}
