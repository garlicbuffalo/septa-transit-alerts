// SEPTA Metro station discovery + slug helpers. Stations only show up on a
// slice of the data — SEPTA alerts that name a stretch ("Shuttle Busing
// Between Olney and Fern Rock") carry a scope the collector resolves against
// the roster, and Metro detections carry segment endpoints (`from_station`,
// `to_station`). Detours and most bus notices don't carry station info, so
// this index is naturally sparse.
//
// The roster (metroStations.json, generated from SEPTA GTFS) disambiguates
// physically distinct stations that share a name with a parenthetical line
// qualifier, mirroring how a rider would say it. We trust the literal string
// as station identity.

import { METRO_LINE_ORDER, normalizeMetroLine } from './metroLines.js';
// Node 22+ ESM requires the explicit import attribute when loading JSON;
// without it the postbuild prerender scripts (which import this file
// transitively via scripts/prerender-pages.js and scripts/generate-sitemap.js)
// crash with ERR_IMPORT_ATTRIBUTE_MISSING. Vite 6 understands the same syntax.
import metroStations from './metroStations.json' with { type: 'json' };

const DAY_MS = 24 * 60 * 60 * 1000;

// slug → array of normalized line keys that physically serve this station,
// derived from the bundled metroStations.json roster. Without this, the
// station's `lines` set would be inferred purely from incidents in the
// rolling window — so a shared station like 15th St/City Hall (L1, B1, and
// the T trolleys) would render only the L1 pill when only L1 had a recent
// incident, even though the station physically serves the others too.
const SERVED_LINES_BY_SLUG = (() => {
  const map = new Map();
  for (const s of metroStations) {
    const slug = slugifyStation(s.name);
    if (!slug) continue;
    map.set(
      slug,
      (s.lines || []).map(normalizeMetroLine).filter((l) => METRO_LINE_ORDER.includes(l)),
    );
  }
  return map;
})();

// True if `slug` matches a station in the bundled roster — regardless of
// whether any recent incidents touched it. Used to decide whether to render
// a name as a link to /station/:slug: every known station has a page,
// even one with zero recent activity.
export function isKnownStationSlug(slug) {
  return slug != null && SERVED_LINES_BY_SLUG.has(slug);
}

// slug → roster record (name + served lines). Used by StationPage as a
// fallback when the activity index doesn't carry the slug — the station
// page still renders, just in its "no recent activity" state.
const ROSTER_BY_SLUG = (() => {
  const map = new Map();
  for (const s of metroStations) {
    const slug = slugifyStation(s.name);
    if (!slug || map.has(slug)) continue;
    map.set(slug, {
      slug,
      name: s.name,
      lines: [...(SERVED_LINES_BY_SLUG.get(slug) || [])].sort(compareByMetroOrder),
      alerts: [],
      observations: [],
      count: 0,
    });
  }
  return map;
})();

export function rosterStationBySlug(slug) {
  return ROSTER_BY_SLUG.get(slug) ?? null;
}

// All roster station names that physically serve any of the given lines.
// Used to broaden the alert-text linkify pool beyond the upstream
// collector's `mentioned_stations` — SEPTA's prose often names stations in
// forms the matcher missed, and we still want them clickable. Line-scoped so cross-line same-named stops like
// "Halsted" don't bleed in.
export function stationsServingLines(lines) {
  if (!lines || lines.length === 0) return [];
  const wanted = new Set(lines.map(normalizeMetroLine));
  const out = [];
  for (const s of metroStations) {
    const served = (s.lines || []).map(normalizeMetroLine);
    if (served.some((l) => wanted.has(l))) out.push(s.name);
  }
  return out;
}

// Normalized line keys that physically serve the station named `name`,
// resolved via its slug against the bundled roster. Empty when the name
// doesn't match a known station. Used to spread a bot's single-line stretch
// onto the OTHER affected lines that share the same trackage — e.g. a
// detection scoped to T1 between 13th St and 33rd St also hit T2–T5, since
// every subway-surface trolley shares that tunnel.
/**
 * @param {string | null | undefined} name
 * @returns {string[]}
 */
export function linesServingStation(name) {
  const slug = slugifyStation(name);
  if (!slug) return [];
  return SERVED_LINES_BY_SLUG.get(slug) ?? [];
}

function compareByMetroOrder(a, b) {
  const ia = METRO_LINE_ORDER.indexOf(a);
  const ib = METRO_LINE_ORDER.indexOf(b);
  return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
}

// Drop the parenthetical line qualifier upstream uses to disambiguate
// same-named stations across lines: `Walnut St (D1)` → `Walnut St`. Used
// everywhere we display a station name *next to* a line pill or under a
// line-page heading — the suffix is redundant noise in those contexts.
// The StationPage heading still uses the raw name (with the suffix) since
// that page can be linked to standalone and needs to be unambiguous.
/**
 * @param {string | null | undefined} name
 * @returns {string}
 */
export function displayStationName(name) {
  if (!name) return '';
  return String(name)
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim();
}

// Slugify a station name for use in URLs. Lowercase, collapse runs of
// non-alphanumeric chars to '-', trim. `15th St/City Hall` → `15th-st-city-hall`,
// `8th-Market` → `8th-market`, `St. Davids` → `st-davids`.
export function slugifyStation(name) {
  if (!name) return null;
  const slug = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || null;
}

// Build a map of slug → station record covering the rolling window. Each
// record collects the raw alerts and observations that touched the station
// at either endpoint. Metro-only by design: bus has 0% station coverage on
// observations and a handful of stop-relocation alerts isn't enough to
// justify the added scope. Downstream consumers re-merge alerts/obs via
// `groupIncidentRecords`, the same way LinePage and IncidentList do.
/**
 * @param {import('./incidents.js').Alert[]} alerts
 * @param {import('./incidents.js').Observation[]} observations
 * @param {object} [options]
 * @param {number} [options.now]
 * @param {number} [options.windowDays]
 * @returns {Map<string, {
 *   slug: string,
 *   name: string,
 *   lines: string[],
 *   alerts: import('./incidents.js').Alert[],
 *   observations: import('./incidents.js').Observation[],
 *   count: number,
 * }>}
 */
export function buildStationIndex(
  alerts,
  observations,
  { now = Date.now(), windowDays = 90 } = {},
) {
  const cutoff = now - windowDays * DAY_MS;
  const index = new Map();

  function bucket(name, line) {
    const slug = slugifyStation(name);
    if (!slug) return null;
    if (!index.has(slug)) {
      index.set(slug, {
        slug,
        name,
        // Seed from the master roster so every line that physically serves
        // this station renders a pill, not just the ones that happened to
        // have an incident in the window.
        lines: new Set(SERVED_LINES_BY_SLUG.get(slug) || []),
        alerts: [],
        observations: [],
      });
    }
    const rec = index.get(slug);
    // Normalize so a raw short-code (`'p'`) coming from a caller that built
    // records by hand doesn't co-exist with the full-name (`'purple'`)
    // seeded from the master roster.
    if (line) rec.lines.add(normalizeMetroLine(line));
    return rec;
  }

  for (const o of observations || []) {
    if (o.kind !== 'metro') continue;
    if (o.ts < cutoff) continue;
    // `stations` is the full segment fill (endpoints + inner stops) enumerated
    // upstream — tie the incident to every stop on the stretch, not just the
    // two endpoints. Older payloads without it fall back to from/to.
    const names = o.stations?.length ? o.stations : [o.from_station, o.to_station];
    for (const name of names) {
      const rec = bucket(name, o.line);
      if (rec && !rec.observations.includes(o)) rec.observations.push(o);
    }
  }

  for (const a of alerts || []) {
    if (a.kind !== 'metro') continue;
    if (a.first_seen_ts < cutoff) continue;
    // affected_stations is the full segment fill (endpoints + inner stops)
    // enumerated upstream for "between X and Y" alerts; it supersedes the bare
    // affected_from/to_station endpoints (older payloads without it fall back).
    // mentioned_stations carries everything else — single-station impact
    // mentions ("delays at Monroe"). The Set on the bucket dedupes overlap.
    const segment = a.affected_stations?.length
      ? a.affected_stations
      : [a.affected_from_station, a.affected_to_station];
    const names = [...segment, ...(a.mentioned_stations || [])];
    for (const name of names) {
      for (const line of a.routes || []) {
        const rec = bucket(name, line);
        if (rec && !rec.alerts.includes(a)) rec.alerts.push(a);
      }
    }
  }

  // Finalize: convert `lines` to a sorted array and compute the headline
  // count. The count is what IncidentList uses to gate "should this name
  // become a clickable link"; it's the unique-incident total at the
  // station, pre-merge (close enough for that gating decision).
  const out = new Map();
  for (const [slug, rec] of index) {
    out.set(slug, {
      slug: rec.slug,
      name: rec.name,
      lines: [...rec.lines].sort(compareByMetroOrder),
      alerts: rec.alerts,
      observations: rec.observations,
      count: rec.alerts.length + rec.observations.length,
    });
  }
  return out;
}
