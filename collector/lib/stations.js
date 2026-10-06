// Station matching for the collector:
//
//   findStationScope(text, mode, lines)  — which roster stations an alert's prose
//     names, and the affected stretch for "between X and Y" / "from X to Y"
//     phrasing, filled in along each line's stop order. Feeds
//     official_alert.scope, which drives the site's station pages and the
//     per-station heatmap on line maps.
//   canonicalRailStation(name, lines)    — map the free-form station names in
//     SEPTA's TrainView / RRSchedules APIs ("Fern Rock T C", "Temple U") onto
//     the GTFS roster names the site links to.
//
// Matching is alias-based on a normalized token string: lowercase, punctuation
// stripped, street-type abbreviations canonicalized on both sides, so "8th &
// Market", "8th-Market" and "8th and Market" all meet in the middle. Matches are
// scoped to the alert's own lines, which keeps short names ("Church", "Media")
// from matching across the whole system.

import { METRO_LINES } from '../../src/lib/metroLines.js';
import metroStations from '../../src/lib/metroStations.json' with { type: 'json' };
import { RAIL_LINES } from '../../src/lib/railLines.js';
import railStations from '../../src/lib/railStations.json' with { type: 'json' };

const CANON_TOKENS = {
  street: 'st',
  avenue: 'av',
  ave: 'av',
  road: 'rd',
  lane: 'ln',
  mount: 'mt',
  junction: 'jct',
  boulevard: 'blvd',
  center: 'ctr',
  centre: 'ctr',
};

/** Normalize text for alias matching (see module comment). */
export function normalizeForMatch(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’.]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => CANON_TOKENS[t] ?? t)
    .join(' ');
}

const SUFFIXES = [' transit ctr', ' transportation ctr', ' station', ' tc', ' t c', ' loop'];

function aliasesFor(name) {
  const base = normalizeForMatch(name);
  const out = new Set([base]);
  for (const suf of SUFFIXES) {
    if (base.endsWith(suf) && base.length - suf.length >= 4) out.add(base.slice(0, -suf.length));
  }
  // "8th-Market" also reads "8th and Market" in prose.
  if (String(name).includes('-')) {
    out.add(normalizeForMatch(String(name).replace(/-/g, ' and ')));
  }
  // "15th St/City Hall": each multi-word part stands alone ("City Hall").
  if (String(name).includes('/')) {
    for (const part of String(name).split('/')) {
      const p = normalizeForMatch(part);
      if (p.split(' ').length >= 2) out.add(p);
    }
  }
  // "Gray 30th St Station" is usually just "30th St" (or "William H. Gray III
  // 30th St Station") in SEPTA prose.
  if (base.startsWith('gray 30th')) {
    out.add('30th st station');
    out.add('30th st');
  }
  // GTFS suffixes the M1 stops that share a name with Regional Rail stations
  // ("Bryn Mawr South"); alerts just say "Bryn Mawr". Matching is line-scoped,
  // so the bare name can't collide with the Regional Rail station.
  const directional = /^(.+) (south|north)$/.exec(base);
  if (directional) out.add(directional[1]);
  // "Drexel Station at 30th St" is "30th St" (or "Drexel Station") in prose.
  const at = /^(.+ station) at (.+)$/.exec(base);
  if (at) {
    out.add(at[1]);
    out.add(at[2]);
  }
  return [...out].filter((a) => a.length >= 4);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const RAIL_LABEL_ALT = Object.values(RAIL_LINES)
  .map((i) => escapeRe(i.label))
  .sort((a, b) => b.length - a.length)
  .join('|');
// "Paoli/Thorndale, Cynwyd, Trenton, Chestnut Hill West, Fox Chase and West
// Trenton trains" — a list of line names, several of which are also terminal
// station names. Removed from the raw text before station matching.
const RAIL_LINE_LIST_RE = new RegExp(
  `(?:(?:${RAIL_LABEL_ALT})(?:\\s*,\\s*(?:and\\s+)?|\\s+(?:and|&)\\s+))+(?:${RAIL_LABEL_ALT})(?:\\s+lines?)?\\s+(?:lines?|trains?|service|riders)\\b`,
  'gi',
);

// --- Rosters -----------------------------------------------------------------
// Each roster record: { name, lines: [key], seq: { key: index }, aliases }.
function buildMetroRoster() {
  return metroStations.map((s) => ({
    name: s.name,
    lines: s.lines,
    seq: s.seq ?? {},
    aliases: aliasesFor(s.name.replace(/\s*\([^)]*\)\s*$/, '')),
  }));
}

function buildRailRoster() {
  const byName = new Map();
  for (const [line, list] of Object.entries(railStations)) {
    list.forEach((s, i) => {
      if (!byName.has(s.name)) {
        byName.set(s.name, { name: s.name, lines: [], seq: {}, aliases: aliasesFor(s.name) });
      }
      const rec = byName.get(s.name);
      rec.lines.push(line);
      rec.seq[line] = i;
    });
  }
  return [...byName.values()];
}

const ROSTERS = { metro: buildMetroRoster(), regional_rail: buildRailRoster() };

// Line names to blank out before matching, so "Media/Wawa Line riders" or "Fox
// Chase trains" don't register as the Media or Fox Chase *stations*. A
// two-part label ("Paoli/Thorndale") is never a single station, so it is
// blanked wherever it appears — including comma lists like "Paoli/Thorndale,
// Cynwyd … trains". A one-word label ("Warminster") is also a terminal's name,
// so it is only blanked when followed by a line/train noun.
function lineNamePhrases(mode, lines) {
  const phrases = [];
  if (mode === 'regional_rail') {
    for (const key of Object.keys(RAIL_LINES)) {
      const label = normalizeForMatch(RAIL_LINES[key].label);
      if (String(RAIL_LINES[key].label).includes('/')) phrases.push(label);
      if (!lines.includes(key)) continue;
      for (const tail of ['line', 'lines', 'train', 'trains', 'riders', 'service']) {
        phrases.push(`${label} ${tail}`);
      }
    }
  } else if (mode === 'metro') {
    for (const key of lines) {
      const info = METRO_LINES[key];
      if (info) phrases.push(normalizeForMatch(info.name));
    }
  }
  return phrases.sort((a, b) => b.length - a.length);
}

function blankPhrases(text, phrases) {
  let out = ` ${text} `;
  for (const p of phrases) {
    out = out.split(` ${p} `).join(` ${'#'.repeat(p.length)} `);
  }
  return out.slice(1, -1);
}

function findMentions(norm, candidates) {
  const aliasList = [];
  for (const st of candidates) for (const a of st.aliases) aliasList.push([a, st]);
  aliasList.sort((x, y) => y[0].length - x[0].length);
  const padded = ` ${norm} `;
  const taken = [];
  const mentions = [];
  for (const [alias, st] of aliasList) {
    const needle = ` ${alias} `;
    let from = 0;
    for (;;) {
      const idx = padded.indexOf(needle, from);
      if (idx < 0) break;
      // Spans index into `padded`; the needle's leading space is not the alias.
      const start = idx + 1;
      const end = start + alias.length;
      from = idx + 1;
      if (taken.some(([s, e]) => start < e && end > s)) continue;
      taken.push([start, end]);
      mentions.push({ start, end, station: st });
    }
  }
  return mentions.sort((a, b) => a.start - b.start);
}

function stationsBetween(roster, lines, fromName, toName) {
  for (const line of lines) {
    const onLine = roster.filter((s) => s.seq[line] != null);
    const a = onLine.find((s) => s.name === fromName);
    const b = onLine.find((s) => s.name === toName);
    if (!a || !b) continue;
    const lo = Math.min(a.seq[line], b.seq[line]);
    const hi = Math.max(a.seq[line], b.seq[line]);
    const span = onLine
      .filter((s) => s.seq[line] >= lo && s.seq[line] <= hi)
      .sort((x, y) => x.seq[line] - y.seq[line])
      .map((s) => s.name);
    return a.seq[line] <= b.seq[line] ? span : span.reverse();
  }
  return [];
}

/**
 * Station scope for an alert's text on the given lines. Bus alerts have no
 * station roster and always get the empty scope.
 * @param {string} text Headline + description, plain text.
 * @param {'metro' | 'bus' | 'regional_rail'} mode
 * @param {string[]} lines Line keys the alert applies to.
 * @returns {{ from_station: string|null, to_station: string|null, stations: string[], direction: null, mentioned_stations: string[] }}
 */
export function findStationScope(text, mode, lines) {
  const empty = {
    from_station: null,
    to_station: null,
    stations: [],
    direction: null,
    mentioned_stations: [],
  };
  const roster = ROSTERS[mode];
  if (!roster || !text || !lines?.length) return empty;
  const candidates = roster.filter((s) => s.lines.some((l) => lines.includes(l)));
  if (candidates.length === 0) return empty;

  const raw = mode === 'regional_rail' ? String(text).replace(RAIL_LINE_LIST_RE, ' ') : text;
  const norm = blankPhrases(normalizeForMatch(raw), lineNamePhrases(mode, lines));
  const mentions = findMentions(norm, candidates);
  if (mentions.length === 0) return empty;

  const padded = ` ${norm} `;
  let pair = null;
  for (let i = 0; i + 1 < mentions.length && !pair; i++) {
    const a = mentions[i];
    const b = mentions[i + 1];
    if (a.station.name === b.station.name) continue;
    const gap = padded.slice(a.end, b.start).trim();
    const before = padded.slice(Math.max(0, a.start - 12), a.start).trim();
    const joined = /^(and|to|through|thru|and the|to the)$/.test(gap);
    if (joined && (gap.startsWith('to') || /\b(between|from)$/.test(before))) pair = [a, b];
  }

  const mentioned = [];
  for (const m of mentions) if (!mentioned.includes(m.station.name)) mentioned.push(m.station.name);
  if (!pair) return { ...empty, mentioned_stations: mentioned };
  const fromName = pair[0].station.name;
  const toName = pair[1].station.name;
  return {
    from_station: fromName,
    to_station: toName,
    stations: stationsBetween(candidates, lines, fromName, toName),
    direction: null,
    mentioned_stations: mentioned,
  };
}

// TrainView / RRSchedules spellings with no clean alias path to the roster.
const RAIL_NAME_OVERRIDES = {
  airport: 'Airport Terminals E & F',
  'airport terminal e f': 'Airport Terminals E & F',
  'chestnut h east': 'Chestnut Hill East',
  'chestnut h west': 'Chestnut Hill West',
  'elm st': 'Norristown Elm Street',
  newark: 'Newark DE',
  'temple u': 'Temple University',
  'north philadelphia septa': 'North Philadelphia Septa',
};

/**
 * Map a TrainView/RRSchedules station spelling to its roster name. Prefers a
 * station on `lines` when several match; returns the input (trimmed) when
 * nothing matches so a delay still reads sensibly.
 * @param {string | null | undefined} raw
 * @param {string[]} [lines]
 * @returns {string | null}
 */
export function canonicalRailStation(raw, lines = []) {
  if (!raw || !String(raw).trim()) return null;
  const n = normalizeForMatch(raw);
  if (RAIL_NAME_OVERRIDES[n]) return RAIL_NAME_OVERRIDES[n];
  const roster = ROSTERS.regional_rail;
  const prefer = (list) => list.find((s) => s.lines.some((l) => lines.includes(l))) ?? list[0];
  const exact = roster.filter((s) => s.aliases.includes(n));
  if (exact.length) return prefer(exact).name;
  const stripped = SUFFIXES.reduce(
    (acc, suf) => (acc.endsWith(suf) ? acc.slice(0, -suf.length) : acc),
    n,
  );
  const loose = roster.filter((s) =>
    s.aliases.some((a) => a === stripped || a.startsWith(`${stripped} `)),
  );
  if (loose.length) return prefer(loose).name;
  return String(raw).trim();
}

/** Roster record for a Metro station by any spelling, or null. */
export function findMetroStation(raw) {
  const n = normalizeForMatch(raw);
  if (!n) return null;
  return (
    ROSTERS.metro.find((s) => s.aliases.includes(n)) ??
    ROSTERS.metro.find((s) => s.aliases.some((a) => a.startsWith(`${n} `))) ??
    null
  );
}

/** Roster record for a Regional Rail station by any spelling, or null. */
export function findRailStation(raw) {
  const name = canonicalRailStation(raw);
  return ROSTERS.regional_rail.find((s) => s.name === name) ?? null;
}
