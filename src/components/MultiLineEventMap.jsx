import { useMemo } from 'react';
import { hexToRgba } from '../lib/format.js';
import { buildMultiLineMap, sliceTrackBetween } from '../lib/lineMap.js';
import { METRO_LINES } from '../lib/metroLines.js';
import { displayStationName } from '../lib/stations.js';
import { MapScroller, normalize } from './EventMap.jsx';

// Combined event map for an incident touching more than one train line — a
// tunnel-wide alert that merged several detections, say. Every
// affected line is drawn faint in its brand color, each observation's stretch
// is highlighted bold on its OWN line, and the involved stations render as
// bold dots. Distinct from EventMap (single line) and LineMap (90-day heat).
//
// No text labels: a Center City event can involve ~9 stations spread across the
// system, and floating labels for all of them collide unreadably on a phone.
// The dots carry hover <title>s and the aggregated station chips above the map
// already spell out every name, so the labels would be redundant noise.
//
// Renders nothing when no affected station resolves against the line data —
// falling back to faint tracks with nothing highlighted would be misleading.
//
// `lineKeys`  — full-name keys of the lines to draw ('purple', 'pink', …).
// `segments`  — `{ line, from, to }` per affected stretch (see
//               affectedLineSegments). `line: null` highlights on every drawn
//               line serving both endpoints.
export default function MultiLineEventMap({
  lineKeys,
  segments,
  active = false,
  sharedTrackage = false,
}) {
  // lineKeys and segments are fresh arrays each render; key the memo on their
  // contents so the map only rebuilds when the affected lines or stretches
  // actually change.
  const lineKeysKey = (Array.isArray(lineKeys) ? lineKeys : []).join(',');
  const cropNames = (segments || []).flatMap((s) => [s.from, s.to]).filter(Boolean);
  const cropKey = cropNames.join('|');
  // biome-ignore lint/correctness/useExhaustiveDependencies: lineKeysKey + cropKey capture identity
  const map = useMemo(
    () =>
      buildMultiLineMap(lineKeys, {
        maxWidth: 720,
        maxHeight: 420,
        cropToStationNames: cropNames,
      }),
    [lineKeysKey, cropKey],
  );

  if (!map) return null;

  // Group projected stations by their loose-normalized name so a segment
  // endpoint ("Armitage (Brown/Purple)") resolves to the physical station even
  // when the qualifier differs from the data file's. When several stations
  // share a normalized name (Central Green vs Central Purple), the caller's
  // line picks the right one.
  const byNorm = new Map();
  for (const s of map.stations) {
    const key = normalize(s.name);
    const list = byNorm.get(key);
    if (list) list.push(s);
    else byNorm.set(key, [s]);
  }
  const resolve = (name, line) => {
    if (!name) return null;
    const cands = byNorm.get(normalize(name));
    if (!cands || cands.length === 0) return null;
    if (line) return cands.find((c) => c.lines.includes(line)) ?? cands[0];
    return cands[0];
  };

  const tracksByKey = new Map(map.tracksByLine.map((t) => [t.key, t]));
  const drawnKeys = map.tracksByLine.map((t) => t.key);

  // Resolve each segment to its target line(s), the endpoint dots, and (when
  // both endpoints are present) the highlighted stretch on that line.
  const highlights = [];
  const affectedByName = new Map();
  const markAffected = (s) => {
    if (s) affectedByName.set(s.name, s);
  };
  for (const seg of segments || []) {
    const targets = seg.line ? [seg.line] : drawnKeys;
    for (const lineKey of targets) {
      const entry = tracksByKey.get(lineKey);
      if (!entry) continue;
      const from = resolve(seg.from, lineKey);
      const to = resolve(seg.to, lineKey);
      // For a line-agnostic (alert-level) segment, only highlight on lines that
      // actually serve both endpoints, so "between X and Y" doesn't paint a
      // line that touches neither.
      if (!seg.line && (!from || !to)) continue;
      markAffected(from);
      markAffected(to);
      if (from && to && from !== to) {
        const d = sliceTrackBetween(entry.tracks, from, to);
        if (d) {
          highlights.push({
            d,
            color: entry.color,
            lineKey,
            // Endpoint identity, so two lines covering the same stretch (shared
            // trackage) group together even if their sliced paths differ by a
            // sub-pixel — the projected geometry is the same corridor.
            pairKey: [normalize(from.name), normalize(to.name)].sort().join('::'),
          });
        }
      }
    }
  }

  // Group highlights that cover the same stretch across multiple lines. A shared
  // run (Pink + Green on the Lake St elevated) projects to identical coordinates,
  // so drawing each line's solid stroke just stacks them and only the last color
  // shows. Instead we candy-stripe the group: one path per line, interleaved via
  // staggered dashes so every color reads along the shared track.
  const stretchGroups = new Map();
  for (const h of highlights) {
    let g = stretchGroups.get(h.pairKey);
    if (!g) {
      g = [];
      stretchGroups.set(h.pairKey, g);
    }
    // Dedupe a line that somehow resolved the same stretch twice.
    if (!g.some((x) => x.lineKey === h.lineKey)) g.push(h);
  }
  // On-segment length per stripe, in px along the path. Each line in an N-line
  // group is "on" for DASH px then "off" for DASH*(N-1) px, offset by its index
  // — so the N colors tile the line continuously with no gaps. Longer dashes
  // give each color a continuous run that's easier to read than rapid-fire
  // alternation, which mushes into a single warm-pink blur on Brown/Red/Purple
  // shared trackage.
  const DASH = 16;
  const stretchPaths = [...stretchGroups.values()].flatMap((group) => {
    const d = group[0].d;
    if (group.length === 1) {
      return [{ key: group[0].lineKey, d, color: group[0].color, dasharray: null, dashoffset: 0 }];
    }
    const n = group.length;
    return group.map((h, i) => ({
      key: `${h.lineKey}:${h.pairKey}`,
      d,
      color: h.color,
      dasharray: `${DASH} ${DASH * (n - 1)}`,
      dashoffset: i * DASH,
    }));
  });

  const affected = [...affectedByName.values()];
  if (affected.length === 0) return null;
  const affectedSet = new Set(affected);
  const affectedCenterX = affected.reduce((sum, s) => sum + s.x, 0) / affected.length;

  // When the highlighted stretches come from bot detections (any segment owns a
  // specific line), the bold sections are where the bot saw trains stop — which
  // can spread well beyond SEPTA's reported epicenter as the disruption
  // cascades to the branches. "Where this happened" overstates that, so label it
  // as bot-observed impact. A pure multi-line SEPTA alert (only line-agnostic
  // segments) keeps the plain framing, since that IS the reported location.
  const hasBotSegments = (segments || []).some((s) => s.line);
  // When the stretch was fanned across shared trackage, the bold sections on
  // the sibling line(s) are inferred from SEPTA's line scope + the roster,
  // not a separate bot detection — so don't credit the bot for all of them.
  const heading = sharedTrackage
    ? 'Affected stretches'
    : hasBotSegments
      ? 'Bot observed impact'
      : active
        ? 'Where this is happening'
        : 'Where this happened';
  const note = sharedTrackage
    ? 'The bot saw trains stop on one line; the same stretch runs on the other line(s) over shared track, which the SEPTA alert confirms are affected too.'
    : 'Stretches where the bot saw trains stop, which can spread across the affected lines as the disruption cascades beyond where it started.';

  return (
    <section className="mt-4">
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
          {heading}
        </h2>
        {(hasBotSegments || sharedTrackage) && (
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">{note}</p>
        )}
      </div>
      <div className="bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border p-4">
        {/* Line legend — the colored tracks have no text labels, so this row
            is how a reader maps color → line. */}
        <div className="flex flex-wrap gap-1.5 mb-3">
          {map.tracksByLine.map((t) => {
            const info = METRO_LINES[t.key];
            return (
              <span
                key={t.key}
                className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold whitespace-nowrap"
                style={{ backgroundColor: t.color, color: info?.textColor ?? '#fff' }}
              >
                {t.label}
              </span>
            );
          })}
        </div>
        <MapScroller
          mapWidth={map.width}
          affectedCenterX={affectedCenterX}
          affectedKey={affected.map((s) => s.name).join('|')}
        >
          <div className="relative" style={{ minWidth: Math.min(map.width, 480), width: '100%' }}>
            <svg
              viewBox={`0 0 ${map.width} ${map.height}`}
              preserveAspectRatio="xMidYMid meet"
              role="img"
              aria-label={`Affected stretches across ${map.tracksByLine.length} Metro lines`}
              className="block w-full h-auto overflow-hidden"
            >
              <title>{`Affected stretches across ${map.tracksByLine.length} Metro lines`}</title>
              {/* Faint full tracks, one set per affected line in its color. */}
              {map.tracksByLine.flatMap((t) =>
                t.tracks
                  .filter((track) => track.length >= 2)
                  .map((track) => {
                    const d = `M${track.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('L')}`;
                    return (
                      <path
                        key={`${t.key}:${d}`}
                        d={d}
                        fill="none"
                        stroke={hexToRgba(t.color, 0.25)}
                        strokeWidth={3}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    );
                  }),
              )}
              {/* Bold highlighted stretches. A stretch on one line draws solid;
                  a stretch shared by several affected lines candy-stripes their
                  colors via interleaved dashes (butt caps so the dashes tile
                  cleanly instead of bleeding into each other's gaps). */}
              {stretchPaths.map((h) => (
                <path
                  key={h.key}
                  d={h.d}
                  fill="none"
                  stroke={h.color}
                  strokeWidth={5}
                  strokeLinecap={h.dasharray ? 'butt' : 'round'}
                  strokeLinejoin="round"
                  strokeDasharray={h.dasharray ?? undefined}
                  strokeDashoffset={h.dasharray ? h.dashoffset : undefined}
                  opacity={0.9}
                />
              ))}
              {/* Context dots for every other station on the affected lines. */}
              {map.stations
                .filter((s) => !affectedSet.has(s))
                .map((s) => (
                  <circle
                    key={s.name}
                    cx={s.x}
                    cy={s.y}
                    r={2.5}
                    fill="#cbd5e1"
                    className="dark:[fill:#475569]"
                  >
                    <title>{displayStationName(s.name)}</title>
                  </circle>
                ))}
              {/* Affected stations — bold neutral dots (a station can sit on
                  several affected lines, so a single brand color would be
                  arbitrary; the colored stretches carry the line identity). */}
              {affected.map((s) => {
                const href = s.slug ? `/station/${s.slug}` : null;
                const dot = (
                  <circle
                    cx={s.x}
                    cy={s.y}
                    r={5.5}
                    fill="#334155"
                    stroke="white"
                    strokeWidth={2}
                    className="dark:[fill:#cbd5e1] dark:[stroke:#0d1117]"
                  >
                    <title>{displayStationName(s.name)}</title>
                  </circle>
                );
                if (href) {
                  return (
                    <a
                      key={s.name}
                      href={href}
                      aria-label={`${displayStationName(s.name)} station page`}
                    >
                      {dot}
                    </a>
                  );
                }
                return <g key={s.name}>{dot}</g>;
              })}
            </svg>
          </div>
        </MapScroller>
      </div>
    </section>
  );
}
