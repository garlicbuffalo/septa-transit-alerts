import { useEffect, useMemo, useRef, useState } from 'react';
import { hexToRgba } from '../lib/format.js';
import { buildLineMap } from '../lib/lineMap.js';
import { METRO_LINES } from '../lib/metroLines.js';
import { buildRailLineMap } from '../lib/railLineMap.js';
import { RAIL_LINES } from '../lib/railLines.js';
import { displayStationName } from '../lib/stations.js';

// Five intensity stops keyed off the line's max station count so the
// busiest station is fully saturated and the rest scale linearly. Mirrors
// the existing Calendar / Hour-of-Week heatmap conventions for visual
// consistency across the site.
function stationFill(count, maxCount, baseColor) {
  if (count === 0 || maxCount <= 0) return 'var(--timeline-empty)';
  const ratio = count / maxCount;
  if (ratio < 0.2) return hexToRgba(baseColor, 0.35);
  if (ratio < 0.4) return hexToRgba(baseColor, 0.55);
  if (ratio < 0.7) return hexToRgba(baseColor, 0.75);
  if (ratio < 0.9) return hexToRgba(baseColor, 0.9);
  return baseColor;
}

// Compose an SVG `path` `d` attribute for a polyline. Skip lines with
// fewer than 2 points (would render nothing useful anyway).
function pathFor(track) {
  return `M${track.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('L')}`;
}

function StationDot({ station, maxCount, accent, radius = 5, hrefBase = '/station' }) {
  const fill = stationFill(station.count, maxCount, accent);
  const display = displayStationName(station.name);
  const label =
    station.count === 0
      ? `${display}: no incidents (last 90 days)`
      : `${display}: ${station.count} incident${station.count === 1 ? '' : 's'} (last 90 days)`;
  const href = station.slug ? `${hrefBase}/${station.slug}` : null;
  const circle = (
    <circle
      cx={station.x}
      cy={station.y}
      r={radius}
      fill={fill}
      stroke="white"
      strokeWidth={1.5}
      className="dark:[stroke:#0d1117]"
    >
      <title>{label}</title>
    </circle>
  );
  if (!href || station.count === 0) return circle;
  return (
    <a href={href} aria-label={label}>
      {circle}
    </a>
  );
}

// HTML overlay terminal label. SVG `<text>` clips at the viewBox bounds,
// which made centered labels at edge-of-line terminals (Harlem/Lake,
// Cottage Grove) hard to keep both readable and unclipped. HTML labels
// don't share that constraint — they're positioned by percent of the
// container, can overflow into the card's padding, and use CSS
// text-shadow for halo legibility.
//
// Placement strategy:
//   * Vertical: push the label OUT of the line's drawing band, into the
//     SVG's empty top/bottom margin (or the card padding above/below the
//     SVG). Top-half terminals → label above the dot; bottom-half →
//     below. This avoids the trap where a track segment angling away
//     from a corner terminal still passes through a "centerward" label
//     position (Cottage Grove on Green did this — line goes
//     up-and-left, so a label above-and-left of the dot lands on it).
//   * Horizontal: edge-anchored for terminals near the SVG sides so the
//     label never extends past the canvas. Left third → label's left
//     edge sits at the dot (text grows right). Right third → right edge
//     at the dot (text grows left). Middle third → centered on the dot.
function TerminalLabel({ station, mapWidth, mapHeight, radius }) {
  const leftPct = (station.x / mapWidth) * 100;
  const topPct = (station.y / mapHeight) * 100;
  const xRatio = station.x / mapWidth;
  const isTopHalf = station.y < mapHeight / 2;
  const sidePad = radius + 2;
  const verticalOffset = radius + 6;

  // Vertical: push the label OUT into the empty SVG margin / card
  // padding rather than INTO the line's drawing band. Top half pushes
  // up (above the dot, toward the SVG top). Bottom half pushes down.
  // Horizontal: anchor on the side opposite the SVG edge so the label
  // never extends past the canvas.
  let xTransform;
  if (xRatio < 0.25) {
    // Left side: label's left edge sits at the dot, growing right.
    xTransform = `${sidePad}px`;
  } else if (xRatio > 0.75) {
    // Right side: label's right edge sits at the dot, growing left.
    xTransform = `calc(-100% - ${sidePad}px)`;
  } else {
    // Middle: centered horizontally on the dot.
    xTransform = '-50%';
  }
  const yTransform = isTopHalf ? `calc(-100% - ${verticalOffset}px)` : `${verticalOffset}px`;

  return (
    <span
      className="absolute pointer-events-none whitespace-nowrap text-[11px] font-semibold text-slate-700 dark:text-slate-200 [text-shadow:0_0_3px_white,0_0_3px_white,0_0_3px_white] dark:[text-shadow:0_0_3px_#161b22,0_0_3px_#161b22,0_0_3px_#161b22]"
      style={{
        left: `${leftPct}%`,
        top: `${topPct}%`,
        transform: `translate(${xTransform}, ${yTransform})`,
      }}
    >
      {displayStationName(station.name)}
    </span>
  );
}

// SVG geographic heatmap of stations along a single train line, colored by
// their incident count over the rolling window. Hidden when there's no data
// for the line at all (geography missing or wrong line key) — the caller
// shouldn't paper over a blank rendering with a "no data" placeholder.
//
// When ≥4 stations cluster downtown (true for every line except Yellow),
// a zoom inset is rendered in the lower-right corner so the dense Center City
// stations are individually clickable rather than overlapping dots.
export default function LineMap({ lineKey, stationIndex, kind = 'metro' }) {
  const isRail = kind === 'rail';
  const map = useMemo(
    () =>
      (isRail ? buildRailLineMap : buildLineMap)(lineKey, stationIndex, {
        maxWidth: 720,
        maxHeight: 540,
      }),
    [lineKey, stationIndex, isRail],
  );
  // Track whether the map's horizontal scroll has more content to the right.
  // The fade overlay is `position: absolute; right: 0` inside the scroll
  // container, which pins it to the visible right edge — handy as a "scroll
  // right for more" hint, but it stays put as the SVG scrolls underneath,
  // dimming arbitrary parts of the track. Hide it once we've scrolled to the
  // right end (and at mount, when content fits without scrolling).
  const scrollRef = useRef(null);
  const [showRightFade, setShowRightFade] = useState(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      const overflowed = el.scrollWidth - el.clientWidth > 1;
      const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
      setShowRightFade(overflowed && !atEnd);
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, []);
  if (!map) return null;
  const info = isRail ? RAIL_LINES[lineKey] : METRO_LINES[lineKey];
  const accent = info?.color ?? '#475569';
  // SEPTA lines read "L1"; Regional Rail lines are named outright ("Union Pacific
  // North"), so only the train side gets the " Line" suffix.
  const lineName = info?.label ?? lineKey;
  const mapLabel = isRail ? lineName : `${lineName} Line`;
  const hrefBase = isRail ? '/rail/station' : '/station';

  const trackPaths = map.tracks.filter((t) => t.length >= 2).map(pathFor);
  const inset = map.downtown;
  const insetTracks = inset ? inset.tracks.filter((t) => t.length >= 2).map(pathFor) : [];

  return (
    <section>
      <h2 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-3">
        Stations by 90-day incident count
      </h2>
      <div className="bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border p-4">
        {/* Main + inset side-by-side on wide screens, stacked on narrow.
            The main map has its own horizontal scroll affordance so dots
            stay tappable even at phone width. */}
        <div className="flex flex-col lg:flex-row gap-4 lg:items-start">
          {/* py-6 reserves space inside the scroll container's clip box so
              HTML terminal labels can overflow above/below the SVG without
              being chopped. The labels translate up to ~labelHeight + 6 px
              above the top-edge dot; on a landscape line like Yellow whose
              SVG can render only ~190 px tall at narrow widths, that places
              the label at negative y relative to the inner container. The
              padding turns that negative offset into a positive one inside
              the padding-box (where `overflow-x: auto` is coerced to clip
              both axes). */}
          <div ref={scrollRef} className="relative overflow-x-auto flex-1 min-w-0 py-6">
            <div
              aria-hidden="true"
              className={`pointer-events-none absolute top-0 right-0 bottom-0 w-8 bg-gradient-to-l from-white dark:from-gh-surface to-transparent sm:hidden z-20 transition-opacity ${
                showRightFade ? 'opacity-100' : 'opacity-0'
              }`}
            />
            {/* SVG sized container — labels are HTML siblings of the SVG,
                positioned in % of this container so they scale with the
                SVG and aren't clipped by viewBox bounds. */}
            <div className="relative" style={{ minWidth: Math.min(map.width, 560), width: '100%' }}>
              <svg
                viewBox={`0 0 ${map.width} ${map.height}`}
                preserveAspectRatio="xMidYMid meet"
                role="img"
                aria-label={`${mapLabel} stations heatmap`}
                className="block w-full h-auto"
              >
                <title>{`${mapLabel} stations`}</title>
                {trackPaths.map((d) => (
                  <path
                    key={d}
                    d={d}
                    fill="none"
                    stroke={hexToRgba(accent, 0.35)}
                    strokeWidth={4}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ))}
                {map.stations.map((s) => (
                  <StationDot
                    key={s.name}
                    station={s}
                    maxCount={map.maxCount}
                    accent={accent}
                    radius={6}
                    hrefBase={hrefBase}
                  />
                ))}
                {/* Marker rectangle on the main map showing where the
                    downtown inset zooms in. Dashed slate so it reads as a
                    reference frame, not part of the data. */}
                {inset && (
                  <rect
                    x={map.downtown.mainBoxRect.x}
                    y={map.downtown.mainBoxRect.y}
                    width={map.downtown.mainBoxRect.width}
                    height={map.downtown.mainBoxRect.height}
                    fill="none"
                    stroke="#94a3b8"
                    strokeWidth={1.5}
                    strokeDasharray="4 3"
                    rx={3}
                  />
                )}
              </svg>
              {/* Terminal labels — HTML overlays positioned by the same
                  relative container, so they overflow naturally into the
                  card padding without SVG clipping. */}
              {map.stations
                .filter((s) => s.isTerminal)
                .map((s) => (
                  <TerminalLabel
                    key={`label-${s.name}`}
                    station={s}
                    mapWidth={map.width}
                    mapHeight={map.height}
                    radius={6}
                  />
                ))}
            </div>
          </div>

          {inset && (
            <div className="lg:w-[280px] flex-shrink-0">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-2">
                Downtown
              </p>
              <div className="rounded-md border border-slate-200 dark:border-gh-border p-2 bg-slate-50 dark:bg-gh-canvas">
                <svg
                  viewBox={`0 0 ${inset.width} ${inset.height}`}
                  preserveAspectRatio="xMidYMid meet"
                  role="img"
                  aria-label={`${info?.label ?? lineKey} Line downtown stations zoom`}
                  className="block w-full h-auto"
                >
                  <title>{`${info?.label ?? lineKey} Line downtown stations`}</title>
                  {insetTracks.map((d) => (
                    <path
                      key={`inset-${d}`}
                      d={d}
                      fill="none"
                      stroke={hexToRgba(accent, 0.35)}
                      strokeWidth={3.5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  ))}
                  {inset.stations.map((s) => (
                    <StationDot
                      key={`inset-${s.name}`}
                      station={s}
                      maxCount={map.maxCount}
                      accent={accent}
                      radius={6}
                    />
                  ))}
                </svg>
              </div>
            </div>
          )}
        </div>

        {/* Legend mirrors the calendar/hour-grid scale */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 pt-3 border-t border-slate-100 dark:border-gh-border">
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500 dark:text-slate-400">Less</span>
            <div className="flex gap-0.5">
              {[0, 0.1, 0.3, 0.55, 0.8, 1].map((r) => {
                const count = Math.ceil(r * Math.max(map.maxCount, 1));
                return (
                  <div
                    key={r}
                    className="w-3 h-3 rounded-full"
                    style={{
                      backgroundColor:
                        r === 0
                          ? 'var(--timeline-empty)'
                          : stationFill(count, Math.max(map.maxCount, 1), accent),
                    }}
                  />
                );
              })}
            </div>
            <span className="text-xs text-slate-500 dark:text-slate-400">More</span>
          </div>
          <span className="text-xs text-slate-300 dark:text-slate-600">
            · Each dot = one station · Click for the station's incident history
            {inset ? ' · Dashed box marks the downtown zoom panel' : ''}
          </span>
        </div>
      </div>
    </section>
  );
}
