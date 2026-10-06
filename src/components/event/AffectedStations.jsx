import { officialAlert, splitObservations } from '../../lib/incidents.js';
import { METRO_LINE_ORDER } from '../../lib/metroLines.js';
import { displayStationName, linesServingStation, slugifyStation } from '../../lib/stations.js';
import StationName from '../StationName.jsx';
import { RowLabel } from './MiniTimeline.jsx';

// Wrap each mention of a known station in the alert text with a StationName
// component so the same dotted-underline that links bot observations also
// links the inline names in SEPTA's own description ("delays at Race-Vine" →
// "delays at <link>Race-Vine</link>"). Match against the canonical names in
// `mentions` (already line-scoped upstream so "Erie" doesn't bleed across
// lines) plus their base form (without the parenthetical disambiguator),
// since SEPTA writes "Walnut St" not "Walnut St (D1)". Longest-first scan
// prevents "Erie" from matching inside "Erie-Torresdale". Whole-word boundaries
// on either side keep "Olney" from matching inside longer tokens.
export function linkifyMentionedStations(text, mentions, stationIndex) {
  if (!text) return text;
  // No aliases to match → return text as-is. Without this short-circuit,
  // the alternation below becomes `(?:)`, which matches the empty string
  // at every position and produces 2N entries in `parts` for a text of
  // length N — fast in isolation, but multiplied across every render of a
  // bus alert (which never has mentioned_stations and whose
  // stationsServingLines pool is empty) it blew the vitest worker's heap.
  if (!mentions || mentions.length === 0) return text;
  // Pair each canonical name with its display alias(es) that might appear in
  // the text. Display form (no parenthetical) is what SEPTA writes; canonical
  // form is what we link to. Same canonical can have one or both forms.
  const aliases = [];
  // Dedupe across the upstream-extracted mentions and any roster-derived
  // additions so the same canonical doesn't appear twice in the alias pool.
  const seenCanonical = new Set();
  for (const canonical of mentions || []) {
    if (seenCanonical.has(canonical)) continue;
    seenCanonical.add(canonical);
    const display = displayStationName(canonical);
    aliases.push({ alias: canonical, canonical });
    if (display && display !== canonical) {
      aliases.push({ alias: display, canonical });
    }
  }
  // Longest-first so substring aliases ("Erie") don't shadow longer ones
  // ("Erie-Torresdale") that share a prefix.
  aliases.sort((a, b) => b.alias.length - a.alias.length);
  // Slash and hyphen handling: SEPTA sometimes writes "15th St/ City Hall" or
  // "Walnut Locust" where the canonical name uses "15th St/City Hall" or
  // "Walnut-Locust". Build a regex per alias that tolerates whitespace
  // around slashes and treats `-`/space as interchangeable.
  function aliasPattern(alias) {
    return (
      alias
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        // SEPTA may write "15th St/ City Hall" with a stray space; the canonical
        // name is "15th St/City Hall". Allow whitespace around any `/`.
        .replace(/\//g, '\\s*/\\s*')
        // Hyphens and runs of whitespace are interchangeable: canonical
        // "Walnut-Locust" matches "Walnut Locust".
        .replace(/[\s-]+/g, '[\\s-]+')
    );
  }
  // Suffix denylist: Philadelphia stations are often named for the street
  // they sit on, so short names like "Erie" or "Allegheny" collide with the
  // streets themselves ("Erie Ave", "Allegheny Avenue") and with neighborhood
  // phrasing ("Logan area"). When the match is immediately followed by one of
  // these tokens it's a place name in the alert text, not a station reference,
  // so we skip the link.
  const NON_STATION_SUFFIX =
    '(?:River|Bridge|Avenue|Ave|Street|St|Boulevard|Blvd|Road|Rd|Drive|Dr|Expressway|Expy|area|neighborhood|Heights)';
  const combined = new RegExp(
    `(?<![A-Za-z0-9])(?:${aliases.map((a) => aliasPattern(a.alias)).join('|')})(?![A-Za-z0-9])(?!\\s+${NON_STATION_SUFFIX}\\b)`,
    'g',
  );
  const parts = [];
  let cursor = 0;
  let m = combined.exec(text);
  while (m !== null) {
    if (m.index > cursor) parts.push(text.slice(cursor, m.index));
    // Re-match the captured chunk against each alias to recover the
    // canonical name — alias order isn't preserved in the alternation match.
    const matched = m[0];
    let canonical = null;
    for (const a of aliases) {
      if (new RegExp(`^${aliasPattern(a.alias)}$`).test(matched)) {
        canonical = a.canonical;
        break;
      }
    }
    parts.push(
      <StationName
        key={`${m.index}-${matched}`}
        name={canonical ?? matched}
        stationIndex={stationIndex}
      />,
    );
    cursor = m.index + matched.length;
    m = combined.exec(text);
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts.length > 0 ? parts : text;
}

export function collectAffectedStations(incident) {
  const official = officialAlert(incident);
  const scope = official?.scope ?? {};
  const { primary, extras } = splitObservations(incident);
  const seen = new Set();
  const out = [];
  function add(name) {
    if (!name) return;
    const key = name.toLowerCase().trim();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(name);
  }
  add(scope.from_station);
  add(scope.to_station);
  add(primary?.from_station);
  add(primary?.to_station);
  // Every merged observation's endpoints, not just the primary's. A
  // tunnel-wide alert merges one detection per affected line; showing only the
  // primary obs's segment (e.g. "19th St ↔ 33rd St") misrepresents a
  // five-line incident as a single stretch on one line.
  for (const e of extras) {
    add(e.from_station);
    add(e.to_station);
  }
  // mentioned_stations carries impact-context matches the upstream extractor
  // pulled from the alert text ("delays at Race-Vine"). Include after the
  // segment endpoints so the canonical "from → to" still renders first when
  // both are present; the dedupe keeps overlap from doubling up.
  for (const name of scope.mentioned_stations || []) add(name);
  // Upstream sometimes carries both a bare name (e.g. "Walnut St" from the
  // headline) and its fully qualified counterpart ("Walnut St (D1)" from
  // the extracted mentions) for the same physical station. Drop the bare
  // entry when a qualified version of the same display name exists — it's
  // the same station, just less disambiguated. Distinct qualified entries
  // ("Walnut St (D1)" + "Walnut St (L1)") stay, since those are two
  // physically different stations.
  const QUALIFIER = /\s*\([^)]*\)\s*$/;
  const qualifiedDisplays = new Set();
  for (const name of out) {
    if (QUALIFIER.test(name)) qualifiedDisplays.add(displayStationName(name).toLowerCase());
  }
  return out.filter((name) => {
    if (QUALIFIER.test(name)) return true;
    return !qualifiedDisplays.has(name.toLowerCase());
  });
}

// Group an incident's affected stretches by line, for the per-line station
// list on multi-line incidents. Mirrors the multi-line map: each merged
// observation contributes a segment on its own line. Returns null when no
// segment owns a line (a official-only alerts applies to all its routes at once,
// so there's nothing to split by — the flat chips are clearer there).
export function groupAffectedStationsByLine(segments) {
  const segs = segments.filter((s) => s.line);
  if (segs.length === 0) return null;
  const byLine = new Map();
  for (const s of segs) {
    let list = byLine.get(s.line);
    if (!list) {
      list = [];
      byLine.set(s.line, list);
    }
    list.push({ from: s.from, to: s.to });
  }
  return [...byLine.entries()]
    .sort((a, b) => METRO_LINE_ORDER.indexOf(a[0]) - METRO_LINE_ORDER.indexOf(b[0]))
    .map(([line, segments]) => ({ line, segments }));
}

// Spread a bot's single-line stretch onto the OTHER affected lines that share
// the same trackage. The bot scopes a detection to one line ('t1'), but on
// shared track (the trolley tunnel under Market St, the B1/B2/B3 trunk, the
// D1/D2 trunk from 69th St) the same stations carry several lines — and the SEPTA alert that scopes the
// incident to `routes` confirms those other lines are down too. So for each
// line-owned segment, we add a copy on every other incident route that the
// roster says serves BOTH endpoints. Returns the augmented segment list plus
// `expanded`: whether any inferred copy was actually added (drives the copy
// that tells the reader these rows are shared-trackage, not separate bot hits).
//
// Line-agnostic segments (alert-level, `line: null`) pass through untouched —
// the map already fans those out to every serving line on its own.
export function expandSharedTrackageSegments(segments, routes) {
  const others = (routes || []).filter(Boolean);
  if (others.length < 2) return { segments: segments || [], expanded: false };
  const out = [];
  const seen = new Set();
  const push = (seg) => {
    const key = `${seg.line ?? ''}|${seg.from ?? ''}|${seg.to ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(seg);
  };
  let expanded = false;
  for (const seg of segments || []) {
    push(seg);
    // Only a line-owned stretch with both endpoints can be projected onto a
    // sibling line — we need both stations to confirm the sibling serves the
    // whole run, not just one end.
    if (!seg.line || !seg.from || !seg.to) continue;
    const fromLines = new Set(linesServingStation(seg.from));
    const toLines = new Set(linesServingStation(seg.to));
    for (const r of others) {
      if (r === seg.line) continue;
      if (fromLines.has(r) && toLines.has(r)) {
        const before = seen.size;
        push({ line: r, from: seg.from, to: seg.to });
        if (seen.size > before) expanded = true;
      }
    }
  }
  return { segments: out, expanded };
}

// Quiet inline row of affected station links. No chunky pills — the line
// pill above already carries the brand color, so loud per-station chips
// just compete with it. These are supplementary navigation: dotted-
// underline links that match the rest of the site's station-name style.
// Caller decides whether to render at all (only useful when the headline
// doesn't already spell the stations out — see EventDetail).
export function StationChips({ stations, direction }) {
  if (!stations || stations.length === 0) return null;
  // For two-station segments, `→` reads as "one direction only". Most alerts
  // affect both directions (direction is null) — render `↔` there so the
  // glyph matches reality. When upstream actually carries a direction
  // ("Northbound only"), keep the one-way arrow.
  const segmentGlyph = direction ? '→' : '↔';
  // Two distinct stations (e.g. Walnut St on D1 vs another line) collapse to
  // the same displayStationName, so show the raw qualifier-bearing name for
  // any station whose stripped label collides with another in this list.
  const displayCounts = new Map();
  for (const name of stations) {
    const d = displayStationName(name);
    displayCounts.set(d, (displayCounts.get(d) || 0) + 1);
  }
  return (
    <p className="text-sm text-slate-600 dark:text-slate-300 mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
      <span className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 mr-1">
        Stations
      </span>
      {stations.map((name, i) => {
        const slug = slugifyStation(name);
        const stripped = displayStationName(name);
        const display = displayCounts.get(stripped) > 1 ? name : stripped;
        const isLast = i === stations.length - 1;
        const link = slug ? (
          <a
            href={`/station/${slug}`}
            className="underline decoration-dotted decoration-slate-400 dark:decoration-slate-500 underline-offset-[3px] hover:decoration-solid hover:decoration-blue-500 hover:text-blue-500"
          >
            {display}
          </a>
        ) : (
          <span>{display}</span>
        );
        return (
          <span key={name} className="inline-flex items-center gap-1.5">
            {link}
            {!isLast && stations.length === 2 && (
              <span className="text-slate-500 dark:text-slate-400">{segmentGlyph}</span>
            )}
            {!isLast && stations.length !== 2 && (
              <span className="text-slate-300 dark:text-slate-600">·</span>
            )}
          </span>
        );
      })}
    </p>
  );
}

// Single station as a dotted-underline link to its page, matching the style
// StationChips uses. Falls back to plain text when the name doesn't slugify.
function StationLink({ name }) {
  if (!name) return null;
  const slug = slugifyStation(name);
  const display = displayStationName(name);
  if (!slug) return <span>{display}</span>;
  return (
    <a
      href={`/station/${slug}`}
      className="underline decoration-dotted decoration-slate-400 dark:decoration-slate-500 underline-offset-[3px] hover:decoration-solid hover:decoration-blue-500 hover:text-blue-500"
    >
      {display}
    </a>
  );
}

// Per-line affected stations for multi-line incidents. Each row pairs the
// line's brand-color pill with its affected stretch(es), so the list reads
// the same way the multi-line map does ("T1: 19th St ↔ 33rd St") instead
// of one flat run of names that hides which station sits on which line.
export function StationsByLine({ groups, direction, sharedTrackage = false }) {
  if (!groups || groups.length === 0) return null;
  // Most alerts hit both directions (direction null) — `↔` matches that;
  // a one-way alert keeps the directional arrow.
  const glyph = direction ? '→' : '↔';
  // When the rows were fanned out across shared trackage, the bot only fired on
  // one of them — the rest are inferred from SEPTA's line scope + the roster.
  // Say "affected" (not "bot observed") and note the shared-track inference so
  // the duplicate stretches don't read as separate detections.
  return (
    <div className="mt-1">
      <span className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
        {sharedTrackage ? 'Affected stations (shared trackage)' : 'Bot observed impacted stations'}
      </span>
      <div className="mt-1 space-y-1">
        {groups.map(({ line, segments }) => (
          // Fixed-width pill column so every line's stations start at the same
          // x — the pills vary in width across lines, which
          // otherwise left the station names ragged. items-center vertically
          // centers the station text against its line pill.
          <div key={line} className="flex items-center gap-2">
            <div className="w-16 flex-shrink-0">
              <RowLabel kind="metro" route={line} />
            </div>
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm text-slate-600 dark:text-slate-300">
              {segments.map((seg, si) => (
                <span
                  key={`${seg.from ?? ''}→${seg.to ?? ''}`}
                  className="inline-flex items-center gap-1.5"
                >
                  {si > 0 && <span className="text-slate-300 dark:text-slate-600">·</span>}
                  <StationLink name={seg.from} />
                  {seg.from && seg.to && (
                    <span className="text-slate-500 dark:text-slate-400">{glyph}</span>
                  )}
                  <StationLink name={seg.to} />
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
