import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBrowseData } from '../hooks/useBrowseData.js';
import { useDarkMode } from '../hooks/useDarkMode.js';
import { topLevelTrail } from '../lib/breadcrumbs.js';
import { loadSystemMapShapes } from '../lib/routeMaps.js';
import { SITE_NAME } from '../lib/site.js';
import {
  BUS_COLOR,
  buildBusLayer,
  highlightLines,
  MAP_MODE_KEYS,
  MAP_MODES,
  METRO_LAYER,
  METRO_LEGEND,
  modesParam,
  parseModes,
  placeCard,
  RAIL_COLOR,
  RAIL_LAYER,
  routesNear,
  STATION_ZOOM,
  SYSTEM_FIT,
  sortRoutes,
  toggleMode,
  visibleLines,
  visibleStops,
} from '../lib/systemMap.js';
import Breadcrumb from './Breadcrumb.jsx';
import Footer from './Footer.jsx';
import Header from './Header.jsx';
import MapPlaceholder from './MapPlaceholder.jsx';

// Leaflet is heavy; it loads only for a page that has a map to show.
const InteractiveMap = lazy(() => import('./InteractiveMap.jsx'));

// The map is the page, so it's tall: most of a screen, but never so much that a
// phone has nothing left to scroll by.
const MAP_SIZE = 'h-[62vh] min-h-[400px] sm:h-[70vh] sm:min-h-[480px] max-h-[860px]';

const CHIP =
  'inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500';
const CHIP_ON = 'bg-slate-800 dark:bg-slate-200 text-white dark:text-slate-800';
const CHIP_OFF =
  'bg-slate-100 dark:bg-gh-subtle text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-gh-border';

// How near the pointer, in screen pixels, a route's line must pass to be listed there:
// a mouse is precise, a fingertip is not.
const HOVER_PX = 8;
const PICK_PX = 10;
const PICK_TOUCH_PX = 18;
// The cards over the map, sized so they can be kept on screen (see placeCard): the hover
// card lists up to HOVER_ROWS routes and counts the rest; the list a click or tap opens
// shows up to POPUP_ROWS routes in full and, for more, cuts off the last row it has room
// for, which says there is more to scroll to (a scrollbar can't be counted on).
const HOVER_W = 256;
const HOVER_ROWS = 6;
const HOVER_ROW_H = 22;
const POPUP_W = 288;
const POPUP_ROWS = 6;
const POPUP_ROW_H = 40;
const POPUP_HEADER_H = 36;
const NO_DOTS = [];

// How much of the bottom of the map is out of sight, under a phone's tab bar or below the
// fold, so a card is not put there.
function hiddenBelowOf(bottom) {
  const bar = document.querySelector('.tab-bar');
  const tabBar = bar && getComputedStyle(bar).display !== 'none' ? bar.offsetHeight : 0;
  return Math.max(0, bottom - (window.innerHeight - tabBar));
}

function RoutePill({ route }) {
  return (
    <span
      className="inline-flex min-w-[2.25rem] shrink-0 justify-center rounded-full px-2 py-0.5 text-[11px] font-semibold leading-4"
      style={{ backgroundColor: route.color, color: route.textColor }}
    >
      {route.label}
    </span>
  );
}

// What the mouse is over: the routes there, beside the pointer.
function RoutesTip({ at }) {
  const shown = at.routes.slice(0, HOVER_ROWS);
  const more = at.routes.length - shown.length;
  const h = 12 + shown.length * HOVER_ROW_H + (more > 0 ? 18 : 0);
  const { left, top } = placeCard(at, { w: HOVER_W, h, hiddenBelow: at.hiddenBelow });
  return (
    <div
      className="pointer-events-none absolute z-[1000] space-y-0.5 rounded-md border border-black/30 bg-[#0b0f14]/90 px-2 py-1.5 text-xs text-slate-100 shadow-lg"
      style={{ left, top, width: HOVER_W }}
    >
      {shown.map((r) => (
        <div key={r.id} className="flex items-center gap-1.5" style={{ height: HOVER_ROW_H - 2 }}>
          <RoutePill route={r} />
          <span className="truncate">{r.name}</span>
        </div>
      ))}
      {more > 0 && (
        <div className="text-[11px] text-slate-400">+{more} more · click to list them all</div>
      )}
    </div>
  );
}

// What a click or tap found: every route there, each a link to its page.
function RoutesPopup({ at, onClose }) {
  const w = Math.min(POPUP_W, at.width - 12);
  const n = at.routes.length;
  const rows = n <= POPUP_ROWS ? n : POPUP_ROWS - 0.5;
  const h = POPUP_HEADER_H + rows * POPUP_ROW_H + 8;
  const { left, top } = placeCard(at, { w, h, gap: 16, hiddenBelow: at.hiddenBelow });
  return (
    <section
      aria-label="Routes at this spot"
      className="absolute z-[1000] rounded-lg border border-black/30 bg-[#161b22] text-slate-100 shadow-xl"
      style={{ left, top, width: w }}
    >
      <div
        className="flex items-center justify-between pl-3 pr-1 text-xs text-slate-300"
        style={{ height: POPUP_HEADER_H }}
      >
        <span>
          {n} route{n === 1 ? '' : 's'} here
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close route list"
          className="flex h-8 w-8 items-center justify-center rounded text-lg leading-none text-slate-400 hover:bg-white/10 hover:text-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400"
        >
          ×
        </button>
      </div>
      <ul className="overflow-y-auto px-1 pb-1" style={{ maxHeight: rows * POPUP_ROW_H + 4 }}>
        {at.routes.map((r) => (
          <li key={r.id}>
            <a
              href={r.href}
              className="flex items-center gap-2 rounded px-2 text-sm hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400"
              style={{ minHeight: POPUP_ROW_H }}
            >
              <RoutePill route={r} />
              <span className="min-w-0 flex-1 truncate">{r.name}</span>
              <span aria-hidden="true" className="text-slate-400">
                →
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

// A short stretch of line in a mode's look, on a chip or in the legend.
function Swatch({ color, height, opacity = 1 }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block w-5 shrink-0 rounded-full"
      style={{ height, backgroundColor: color, opacity }}
    />
  );
}

// What a mode's chip shows beside its name.
function ModeSwatch({ mode }) {
  if (mode === 'metro') {
    return (
      <span aria-hidden="true" className="flex w-5 shrink-0 flex-col gap-[2px]">
        {METRO_LEGEND.slice(0, 3).map((e) => (
          <span
            key={e.line}
            className="h-[3px] rounded-full"
            style={{ backgroundColor: e.color }}
          />
        ))}
      </span>
    );
  }
  if (mode === 'rail') return <Swatch color={RAIL_COLOR} height={4} />;
  return <Swatch color={BUS_COLOR} height={2} opacity={0.8} />;
}

export default function SystemMapPage() {
  const [dark, toggleDark] = useDarkMode();
  const { officialRecords, detectionRecords } = useBrowseData();
  const [modes, setModes] = useState(() => parseModes(window.location.search));
  // What the mouse is over (`hover`) and what was last clicked or tapped (`pin`): the routes
  // there, and where on the map that is.
  const [hover, setHover] = useState(null);
  const [pin, setPin] = useState(null);
  // The bus routes come from a file the collector publishes; Metro and Regional
  // Rail are bundled with the site and are there from the start.
  const [bus, setBus] = useState({ status: 'idle', layer: null });
  const busRequested = useRef(false);

  useEffect(() => {
    document.title = `System map · ${SITE_NAME}`;
    return () => {
      document.title = SITE_NAME;
    };
  }, []);

  // Mirror the modes into the URL so a view is a shareable link.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const value = modesParam(modes);
    if (value == null) params.delete('modes');
    else params.set('modes', value);
    const qs = params.toString().replace(/%2C/g, ',');
    const next = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`;
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (next !== current) window.history.replaceState(null, '', next);
  }, [modes]);

  // Fetch the bus routes the first time they're wanted, once.
  const wantBus = modes.includes('bus');
  useEffect(() => {
    if (!wantBus || busRequested.current) return;
    busRequested.current = true;
    setBus({ status: 'loading', layer: null });
    loadSystemMapShapes().then((file) => {
      setBus(
        file
          ? { status: 'ready', layer: buildBusLayer(file.routes) }
          : { status: 'unavailable', layer: null },
      );
    });
  }, [wantBus]);

  const layers = useMemo(
    () => ({ metro: METRO_LAYER, rail: RAIL_LAYER, bus: bus.layer }),
    [bus.layer],
  );
  const baseLines = useMemo(() => visibleLines(layers, modes), [layers, modes]);
  const pinnedIds = useMemo(() => (pin ? pin.routes.map((r) => r.id) : []), [pin]);
  // The pinned routes are outlined in a layer of their own, so pinning (and letting go of
  // the pin as the map moves) doesn't redraw every line on the map.
  const outlined = useMemo(() => highlightLines(baseLines, pinnedIds), [baseLines, pinnedIds]);
  const stops = useMemo(() => visibleStops(modes), [modes]);
  const dots = useMemo(() => (pin ? [{ id: 'pin', point: [pin.lat, pin.lon] }] : NO_DOTS), [pin]);

  // Switching modes changes what is on the map, so what was found on it is let go of.
  const pickModes = (next) => {
    setModes(next);
    setHover(null);
    setPin(null);
  };

  // Every route, in any mode on show, with a line within a few pixels of the pointer.
  const routesAt = useCallback(
    (e, px) =>
      sortRoutes(
        routesNear(baseLines, e.lat, e.lon, px * e.metersPerPx)
          .map(
            (id) =>
              layers.metro.routes.get(id) ??
              layers.rail.routes.get(id) ??
              layers.bus?.routes.get(id),
          )
          .filter(Boolean),
      ),
    [baseLines, layers],
  );

  const onPointer = useCallback(
    (e) => {
      if (e.type === 'leave') {
        setHover(null);
      } else if (e.type === 'move') {
        // A point on the map doesn't stay where it was once the map moves.
        setHover(null);
        setPin(null);
      } else if (e.type === 'hover') {
        if (e.touch) return;
        const routes = routesAt(e, HOVER_PX);
        setHover(routes.length > 0 ? { ...e, routes, hiddenBelow: hiddenBelowOf(e.bottom) } : null);
      } else if (e.type === 'pick') {
        const routes = routesAt(e, e.touch ? PICK_TOUCH_PX : PICK_PX);
        setHover(null);
        setPin(routes.length > 0 ? { ...e, routes, hiddenBelow: hiddenBelowOf(e.bottom) } : null);
      }
    },
    [routesAt],
  );

  const all = modes.length === MAP_MODE_KEYS.length;
  const counts = {
    metro: `${METRO_LAYER.routes.size} lines`,
    rail: `${RAIL_LAYER.routes.size} lines`,
    bus: bus.layer ? `${bus.layer.routes.size} routes` : null,
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-gh-canvas flex flex-col">
      <Header
        generatedAt={null}
        dark={dark}
        onToggleDark={toggleDark}
        onResetFilters={() => {
          window.location.href = '/';
        }}
        alerts={officialRecords}
        observations={detectionRecords}
      />
      <main id="main" tabIndex={-1} className="max-w-5xl mx-auto px-4 py-6 space-y-4 w-full flex-1">
        <div>
          <Breadcrumb items={topLevelTrail('System map')} className="mb-3" />
          <h1 className="text-xl font-bold text-slate-800 dark:text-slate-100">System map</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 mb-4">
            Every SEPTA Metro line, Regional Rail line, and bus route on one map. Choose which modes
            to show, drag to move around, and scroll, pinch, or use + and − to zoom. Hover or tap
            the map to see which routes run there.{' '}
            <a href="/routes" className="text-blue-500 hover:text-blue-400 hover:underline">
              Prefer a list?
            </a>
          </p>

          {/* Mode filter — as on the Stations page: with everything showing, picking a mode
              narrows the map to it, picking more adds them, and clearing the last one goes
              back to All. */}
          <fieldset className="flex flex-wrap items-center gap-1.5 mb-3">
            <legend className="sr-only">Modes to show</legend>
            <button
              type="button"
              onClick={() => pickModes([...MAP_MODE_KEYS])}
              aria-pressed={all}
              className={`${CHIP} ${all ? CHIP_ON : CHIP_OFF}`}
            >
              All
            </button>
            {MAP_MODES.map(({ key, label }) => {
              const pressed = !all && modes.includes(key);
              return (
                <button
                  type="button"
                  key={key}
                  onClick={() => pickModes(toggleMode(modes, key))}
                  aria-pressed={pressed}
                  className={`${CHIP} ${pressed ? CHIP_ON : CHIP_OFF}`}
                >
                  <ModeSwatch mode={key} />
                  {label}
                  {counts[key] && (
                    <span className="text-xs font-normal opacity-70">{counts[key]}</span>
                  )}
                </button>
              );
            })}
          </fieldset>

          <div className="bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border p-3 sm:p-4">
            <Suspense fallback={<MapPlaceholder className={MAP_SIZE} />}>
              <InteractiveMap
                label="Map of the SEPTA system"
                fit={SYSTEM_FIT}
                lines={baseLines}
                highlight={outlined}
                dots={dots}
                stops={stops}
                stopZoom={STATION_ZOOM}
                stopsLabel="stations"
                gestures="free"
                canvas
                onPointer={onPointer}
                className={MAP_SIZE}
              >
                {hover && <RoutesTip at={hover} />}
                <div aria-live="polite">
                  {pin && <RoutesPopup at={pin} onClose={() => setPin(null)} />}
                </div>
              </InteractiveMap>
            </Suspense>

            <div aria-live="polite">
              {wantBus && bus.status === 'loading' && (
                <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
                  Loading bus routes…
                </p>
              )}
              {wantBus && bus.status === 'unavailable' && (
                <p className="mt-3 text-xs text-amber-700 dark:text-amber-400">
                  Bus route lines aren’t available right now, so only the other modes are drawn.
                </p>
              )}
            </div>

            <ul
              aria-label="Map key"
              className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-slate-600 dark:text-slate-300"
            >
              {modes.includes('metro') &&
                METRO_LEGEND.map((e) => (
                  <li key={e.line} className="inline-flex items-center gap-1.5">
                    <Swatch color={e.color} height={5} />
                    <span>
                      <span className="font-semibold">{e.label}</span> {e.name}
                    </span>
                  </li>
                ))}
              {modes.includes('rail') && (
                <li className="inline-flex items-center gap-1.5">
                  <Swatch color={RAIL_COLOR} height={4} />
                  Regional Rail
                </li>
              )}
              {modes.includes('bus') && (
                <li className="inline-flex items-center gap-1.5">
                  <Swatch color={BUS_COLOR} height={2} opacity={0.8} />
                  Bus routes
                </li>
              )}
            </ul>
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              Metro and Regional Rail stations appear as you zoom in. Bus stops aren’t shown, but
              hovering or tapping anywhere lists the bus routes that run there, whichever mode is on
              top.
            </p>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
