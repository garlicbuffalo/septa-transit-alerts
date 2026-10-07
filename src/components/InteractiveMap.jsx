import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  activeSource,
  noteTileFailed,
  noteTileLoaded,
  subscribeSource,
  tileUrl,
} from '../lib/basemap.js';
import { SourceCredit } from './Basemap.jsx';

// A street map the reader can pan and zoom, with lines and dots drawn on it:
// the route and speed maps. The tiles come from the same source the static line
// maps use (CARTO's dark map, or OpenStreetMap), so the page keeps one tile
// provider, one credit, and the one fallback when the primary can't serve.
//
// Zooming and panning must not trap someone scrolling the page, so:
//   * the wheel scrolls the page; Ctrl or ⌘ + wheel (and a trackpad pinch,
//     which arrives as one) zooms the map, and a hint says so;
//   * on a touchscreen one finger scrolls the page and two move and zoom the map;
//   * the +/− buttons and the arrow and +/− keys always work.
//
// `lines`: [{ id, points: [[lat, lon], …], color, weight?, opacity?, tip? }],
// drawn in order over their casings (a dark edge that sets them off the tiles).
// `dots`: [{ id, point: [lat, lon] }]. `fit`: the points the first view shows.
// `children` are overlays (a legend) drawn over the map.

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');
const EDGE = '#0b0f14';
const HINT_MS = 1600;
// A wheel's notch is about 100 pixels; a notch zooms by about half a level.
const WHEEL_ZOOM_PER_PX = 1 / 200;

// Leaflet's tile layer, asking the page's tile source for each tile.
const SourceTiles = L.TileLayer.extend({
  getTileUrl(coords) {
    const retina = (globalThis.devicePixelRatio ?? 1) > 1;
    return tileUrl(activeSource(), { x: coords.x, y: coords.y }, coords.z, retina);
  },
});

const wheelPixels = (e) => (e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY);

export default function InteractiveMap({
  label,
  fit,
  lines = [],
  dots = [],
  className = 'h-[360px] sm:h-[480px]',
  children,
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const [hint, setHint] = useState(null);
  const hintTimer = useRef(null);

  const showHint = useCallback((text) => {
    setHint(text);
    clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHint(null), HINT_MS);
  }, []);

  // Fit the view to the points it was given.
  const resetView = useCallback(() => {
    const map = mapRef.current;
    const points = fitRef.current;
    if (!map || !points?.length) return;
    map.fitBounds(L.latLngBounds(points), { padding: [28, 28], animate: false });
  }, []);

  // The map itself, made once.
  useEffect(() => {
    const el = containerRef.current;
    const touchOnly = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    const map = L.map(el, {
      attributionControl: false,
      scrollWheelZoom: false,
      // One finger scrolls the page on a touchscreen; two pinch and move the map.
      dragging: !touchOnly,
      touchZoom: true,
      zoomSnap: 0,
      zoomDelta: 1,
      minZoom: 8,
      maxZoom: 18,
      preferCanvas: false,
    });
    mapRef.current = map;
    layerRef.current = L.layerGroup().addTo(map);

    const tiles = new SourceTiles('', { maxZoom: 18, crossOrigin: true, className: 'map-tiles' });
    tiles.on('tileload', noteTileLoaded);
    tiles.on('tileerror', () => noteTileFailed(activeSource()));
    // OpenStreetMap's light tiles are darkened with a filter; CARTO's need none.
    // The layer has no element until the map has a view, so it's set when added.
    const applySource = () => {
      const container = tiles.getContainer();
      if (container) container.style.filter = activeSource().filter ?? '';
    };
    tiles.on('add', applySource);
    tiles.addTo(map);
    const unsubscribe = subscribeSource(() => {
      applySource();
      tiles.redraw();
    });

    // The wheel zooms only with Ctrl or ⌘ held.
    const onWheel = (e) => {
      if (!(e.ctrlKey || e.metaKey)) {
        showHint(MAC ? 'Use ⌘ + scroll to zoom the map' : 'Use Ctrl + scroll to zoom the map');
        return;
      }
      e.preventDefault();
      const zoom = map.getZoom() - wheelPixels(e) * WHEEL_ZOOM_PER_PX;
      map.setZoomAround(
        map.mouseEventToContainerPoint(e),
        Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), zoom)),
        { animate: false },
      );
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    const onTouchStart = (e) => {
      if (touchOnly && e.touches.length === 1) showHint('Use two fingers to move the map');
    };
    el.addEventListener('touchstart', onTouchStart, { passive: true });

    return () => {
      clearTimeout(hintTimer.current);
      unsubscribe();
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
  }, [showHint]);

  // The lines and dots, redrawn when they change, and the view fitted to them.
  useEffect(() => {
    const map = mapRef.current;
    const group = layerRef.current;
    if (!map || !group) return;
    group.clearLayers();
    const round = { lineCap: 'round', lineJoin: 'round', interactive: false };
    for (const l of lines) {
      L.polyline(l.points, {
        ...round,
        color: EDGE,
        weight: (l.weight ?? 5) + 4,
        opacity: 0.65,
      }).addTo(group);
    }
    for (const l of lines) {
      const line = L.polyline(l.points, {
        ...round,
        interactive: Boolean(l.tip),
        color: l.color,
        weight: l.weight ?? 5,
        opacity: l.opacity ?? 1,
      }).addTo(group);
      if (l.tip) line.bindTooltip(l.tip, { sticky: true });
    }
    for (const d of dots) {
      L.circleMarker(d.point, {
        radius: 6,
        color: EDGE,
        weight: 2,
        fillColor: '#f8fafc',
        fillOpacity: 1,
        interactive: false,
      }).addTo(group);
    }
    resetView();
  }, [lines, dots, resetView]);

  return (
    <div>
      <div className={`relative overflow-hidden rounded-md bg-[#262626] ${className}`}>
        <section
          ref={containerRef}
          aria-label={`${label}. Interactive map: drag to move, plus and minus to zoom.`}
          className="absolute inset-0 !bg-[#262626]"
        />
        <button
          type="button"
          onClick={resetView}
          className="absolute right-2.5 top-2.5 z-[1000] rounded border border-black/30 bg-[#161b22]/90 px-2 py-1 text-xs font-medium text-slate-100 shadow hover:bg-[#21262d] focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400"
        >
          Reset view
        </button>
        {hint && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 z-[1000] flex items-center justify-center bg-black/45 text-sm font-medium text-white"
          >
            {hint}
          </div>
        )}
        {children}
      </div>
      <SourceCredit />
    </div>
  );
}
