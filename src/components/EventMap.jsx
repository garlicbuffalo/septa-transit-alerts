import { useEffect, useMemo, useRef } from 'react';
import { hexToRgba } from '../lib/format.js';
import { buildLineMap, sliceTrackBetween } from '../lib/lineMap.js';
import { METRO_LINES } from '../lib/metroLines.js';
import { buildRailLineMap } from '../lib/railLineMap.js';
import { RAIL_LINES } from '../lib/railLines.js';
import { displayStationName } from '../lib/stations.js';

// Light-touch event-scoped map: full line track in muted color, with the
// stations involved in this incident highlighted as bold dots with labels.
// Distinct from LineMap (which heat-colors stations by 90-day count) — this
// view is about "where THIS happened," not the line's history.
//
// Renders nothing when:
//   - The incident isn't on a train (no geometry data for buses).
//   - We can't resolve at least one of the affected stations against the
//     line's station list. Falling back to a blank map would be misleading.
//
// `from` / `to` station names come from either an observation (from_station/
// to_station) or an alert (affected_from_station/affected_to_station); the
// caller normalizes which fields to pass.
export default function EventMap({
  lineKey,
  fromStation,
  toStation,
  active = false,
  kind = 'metro',
}) {
  const isRail = kind === 'rail';
  const map = useMemo(
    () =>
      (isRail ? buildRailLineMap : buildLineMap)(lineKey, null, {
        maxWidth: 720,
        maxHeight: 320,
      }),
    [lineKey, isRail],
  );

  if (!map) return null;

  // Lookup affected stations by exact name match — slugify on both sides
  // so case/punctuation differences don't tank the match.
  const wantedNames = new Set();
  if (fromStation) wantedNames.add(normalize(fromStation));
  if (toStation) wantedNames.add(normalize(toStation));
  if (wantedNames.size === 0) return null;

  const affected = map.stations.filter((s) => wantedNames.has(normalize(s.name)));
  if (affected.length === 0) return null;

  // Center of the affected segment in SVG coords. Used by the scroll-on-mount
  // effect below to put the impacted section in view on narrow screens where
  // the map's minWidth (480px) exceeds the viewport.
  const affectedCenterX = affected.reduce((sum, s) => sum + s.x, 0) / affected.length;

  const info = isRail ? RAIL_LINES[lineKey] : METRO_LINES[lineKey];
  const accent = info?.color ?? '#475569';
  // SEPTA reads "L1"; Regional Rail lines are named outright ("Rock Island").
  const mapLabel = isRail ? (info?.label ?? lineKey) : `${info?.label ?? lineKey} Line`;
  const stationHrefBase = isRail ? '/rail/station' : '/station';
  const trackPaths = map.tracks
    .filter((t) => t.length >= 2)
    .map((t) => `M${t.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('L')}`);

  // Highlight the actual segment of track between the two affected stations
  // (when both endpoints are present and distinct). sliceTrackBetween picks
  // the right branch and slices the polyline between them — a straight chord
  // would shortcut bends (Blue Line Clark/Lake → Philadelphia turns 90°
  // underground; the chord version cut across other paths and looked wrong).
  const highlightPath =
    affected.length === 2 ? sliceTrackBetween(map.tracks, affected[0], affected[1]) : null;

  return (
    <section className="mt-4">
      <h2 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-3">
        {active ? 'Where this is happening' : 'Where this happened'}
      </h2>
      <div className="bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border p-4">
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
              aria-label={`Affected stretch on the ${mapLabel}`}
              className="block w-full h-auto"
            >
              <title>{`Affected stretch on the ${mapLabel}`}</title>
              {/* Track — dimmed compared to LinePage's map so the affected
                  segment chord pops as the foreground element. */}
              {trackPaths.map((d) => (
                <path
                  key={d}
                  d={d}
                  fill="none"
                  stroke={hexToRgba(accent, 0.25)}
                  strokeWidth={3}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
              {highlightPath && (
                <path
                  d={highlightPath}
                  fill="none"
                  stroke={accent}
                  strokeWidth={5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity={0.85}
                />
              )}
              {/* Quiet dots for context — every other station on the line
                  renders as a small gray circle. Keeps the map readable
                  but visually subordinate to the highlighted ones. */}
              {map.stations
                .filter((s) => !affected.includes(s))
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
              {/* Affected stations — bold, brand color, larger radius. */}
              {affected.map((s) => {
                const href = s.slug ? `${stationHrefBase}/${s.slug}` : null;
                const dot = (
                  <circle
                    cx={s.x}
                    cy={s.y}
                    r={6}
                    fill={accent}
                    stroke="white"
                    strokeWidth={2}
                    className="dark:[stroke:#0d1117]"
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
            {/* HTML labels for affected stations. Each label is placed on
                the side of its dot pointing AWAY from the other affected
                dot — so the two labels diverge outward from the segment
                rather than landing between the dots (which historically
                made two adjacent stations look swapped).
                Single-station events default to above. */}
            {(() => {
              const midX =
                affected.length > 1
                  ? affected.reduce((sum, s) => sum + s.x, 0) / affected.length
                  : null;
              const midY =
                affected.length > 1
                  ? affected.reduce((sum, s) => sum + s.y, 0) / affected.length
                  : null;
              // Decide whether the segment runs more vertically or
              // horizontally so labels can be placed on the perpendicular
              // axis (vertical segment → labels above/below; horizontal
              // segment → labels left/right). The previous always-left/right
              // placement put labels near neighboring gray dots when the
              // segment was nearly vertical, e.g. Southport → Fullerton on
              // the Brown Line.
              let segmentIsVertical = false;
              if (affected.length === 2) {
                const dx = Math.abs(affected[0].x - affected[1].x);
                const dy = Math.abs(affected[0].y - affected[1].y);
                segmentIsVertical = dy > dx;
              }
              return affected.map((s) => {
                const leftPct = (s.x / map.width) * 100;
                const topPct = (s.y / map.height) * 100;
                // Multi-station: bias each label away from the segment's
                // midpoint so labels live on the outer side of each dot.
                // Tiebreak (when stations sit on a perfectly vertical or
                // horizontal line) defaults to upper/leftward.
                let above;
                let leftOfDot;
                if (midY != null) {
                  above = s.y <= midY;
                  leftOfDot = s.x <= midX;
                } else {
                  above = s.y < map.height / 2;
                  leftOfDot = s.x > map.width / 2;
                }
                const xRatio = s.x / map.width;
                const yRatio = s.y / map.height;
                // Override the bias-based above/below choice when the dot
                // sits near a vertical edge of the canvas — otherwise the
                // label clips out (Green Line "Central" near the top of
                // the map landed above the SVG's top edge and got cut off
                // by the card border).
                if (yRatio < 0.12) above = false;
                else if (yRatio > 0.88) above = true;
                let xTransform;
                let yTransform;
                // Dot has r=6 plus a 2px stroke and the highlight stroke
                // ends with a rounded cap, so the visual dot extends ~8px
                // from center. Add a comfortable margin so the label
                // clearly floats off the dot rather than touching it.
                const LABEL_GAP = 14;
                // Approximate the label's width as a fraction of the
                // canvas so longer names ("Dempster-Skokie") clamp at a
                // larger xRatio than short ones ("Howard"). Without this,
                // a long label on a left-of-midpoint dot can still grow
                // leftward past the canvas edge and clip into card
                // padding. ~0.015 per char tuned for the worst-case 480px
                // mobile minWidth at the current label font size.
                const labelName = displayStationName(s.name);
                const labelWidthRatio = labelName.length * 0.015;
                const leftEdgeMargin = Math.max(0.05, labelWidthRatio);
                const rightEdgeMargin = 1 - leftEdgeMargin;
                if (segmentIsVertical) {
                  // Center the label horizontally over/under the dot,
                  // then clamp at the canvas edges using half the label
                  // width (centered → only half projects past the dot
                  // in each direction).
                  const halfMargin = leftEdgeMargin / 2;
                  if (xRatio < halfMargin) xTransform = '0';
                  else if (xRatio > 1 - halfMargin) xTransform = '-100%';
                  else xTransform = '-50%';
                  yTransform = above ? `calc(-100% - ${LABEL_GAP}px)` : `${LABEL_GAP}px`;
                } else {
                  // Horizontal-ish segment: anchor opposite the bias
                  // direction so the label grows AWAY from the other
                  // dot. When growing outward would clip the canvas,
                  // flip to grow inward instead.
                  if (xRatio < leftEdgeMargin) xTransform = `${LABEL_GAP}px`;
                  else if (xRatio > rightEdgeMargin) xTransform = `calc(-100% - ${LABEL_GAP}px)`;
                  else xTransform = leftOfDot ? `calc(-100% - ${LABEL_GAP}px)` : `${LABEL_GAP}px`;
                  yTransform = above ? `calc(-100% - ${LABEL_GAP}px)` : `${LABEL_GAP}px`;
                }
                return (
                  <span
                    key={`label-${s.name}`}
                    className="absolute pointer-events-none whitespace-nowrap text-[11px] font-semibold text-slate-700 dark:text-slate-200 [text-shadow:0_0_3px_white,0_0_3px_white,0_0_3px_white] dark:[text-shadow:0_0_3px_#161b22,0_0_3px_#161b22,0_0_3px_#161b22]"
                    style={{
                      left: `${leftPct}%`,
                      top: `${topPct}%`,
                      transform: `translate(${xTransform}, ${yTransform})`,
                    }}
                  >
                    {displayStationName(s.name)}
                  </span>
                );
              });
            })()}
          </div>
        </MapScroller>
      </div>
    </section>
  );
}

// Horizontally-scrollable wrapper that, on mount, scrolls the affected
// segment into view. The map's inner content has a 480px minWidth, which
// exceeds many phone viewports — without this, narrow viewports default to
// scrollLeft: 0, hiding incidents that sit on the right side of the line
// (e.g. Blue Line's O'Hare branch). `affectedKey` re-runs the scroll when
// the highlighted stations change, so navigating between events updates
// the framing instead of stuck at the previous segment's position.
export function MapScroller({ mapWidth, affectedCenterX, affectedKey, children }) {
  const ref = useRef(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: affectedKey captures the affected-stations identity
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Inner content is `width: 100%` with `minWidth: min(mapWidth, 480)`, so
    // the rendered width equals max(visible, 480) up to mapWidth. Use the
    // actual scrollWidth so the math is correct regardless.
    const innerWidth = el.scrollWidth;
    const visible = el.clientWidth;
    if (innerWidth <= visible) return; // nothing to scroll
    const targetPx = (affectedCenterX / mapWidth) * innerWidth;
    const desired = targetPx - visible / 2;
    const max = innerWidth - visible;
    el.scrollLeft = Math.max(0, Math.min(max, desired));
  }, [affectedKey, affectedCenterX, mapWidth]);
  return (
    // py-6 reserves vertical room inside the scroll box so a station label that
    // sits at the top or bottom edge of the SVG (e.g. a Regional Rail terminal like
    // Philadelphia OTC near the top of a diagonal line) overflows into the padding
    // instead of being clipped — `overflow-x: auto` coerces the y-axis to clip
    // too, so without this cushion the label's top gets cut off. Same fix the
    // LinePage LineMap uses for its terminal labels.
    <div ref={ref} className="relative overflow-x-auto py-6">
      {children}
    </div>
  );
}

// Loose equality for station name matching — strip whitespace, lowercase,
// drop trailing parenthetical line qualifiers ("Central (Green)"). The
// upstream sources occasionally vary on these details and we'd rather
// surface a match than a blank map.
export function normalize(name) {
  if (!name) return '';
  return String(name)
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim();
}
