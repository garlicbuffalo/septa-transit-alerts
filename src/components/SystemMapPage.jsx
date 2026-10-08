import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBrowseData } from '../hooks/useBrowseData.js';
import { useDarkMode } from '../hooks/useDarkMode.js';
import { topLevelTrail } from '../lib/breadcrumbs.js';
import { loadSystemMapShapes } from '../lib/routeMaps.js';
import { SITE_NAME } from '../lib/site.js';
import {
  BUS_COLOR,
  buildBusLayer,
  MAP_MODE_KEYS,
  MAP_MODES,
  METRO_LAYER,
  METRO_LEGEND,
  modesParam,
  parseModes,
  RAIL_COLOR,
  RAIL_LAYER,
  STATION_ZOOM,
  SYSTEM_FIT,
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
  const [selectedId, setSelectedId] = useState(null);
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
  const selected = useMemo(
    () =>
      layers.metro.routes.get(selectedId) ??
      layers.rail.routes.get(selectedId) ??
      layers.bus?.routes.get(selectedId) ??
      null,
    [layers, selectedId],
  );
  const lines = useMemo(
    () => visibleLines(layers, modes, selected?.id ?? null),
    [layers, modes, selected],
  );
  const stops = useMemo(() => visibleStops(modes), [modes]);
  const routeOfLine = useMemo(() => new Map(lines.map((l) => [l.id, l.routeId])), [lines]);

  // A route of a mode that has been switched off is off the map, so it is let go of.
  const pickModes = (next) => {
    setModes(next);
    if (selected && !next.includes(selected.mode)) setSelectedId(null);
  };

  // Picking a route again, or its white outline, lets go of it.
  const onLineClick = useCallback(
    (lineId) => {
      const routeId = routeOfLine.get(lineId);
      if (routeId) setSelectedId((prev) => (prev === routeId ? null : routeId));
    },
    [routeOfLine],
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
            to show, drag to move around, and scroll, pinch, or use + and − to zoom. Select a route
            for its alert history.{' '}
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
                lines={lines}
                stops={stops}
                stopZoom={STATION_ZOOM}
                stopsLabel="stations"
                gestures="free"
                canvas
                onLineClick={onLineClick}
                className={MAP_SIZE}
              />
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
              {selected && (
                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-slate-200 dark:border-gh-border bg-slate-50 dark:bg-gh-subtle px-3 py-2">
                  <span
                    className="inline-flex min-w-[2.5rem] justify-center rounded-full px-2.5 py-0.5 text-xs font-semibold"
                    style={{ backgroundColor: selected.color, color: selected.textColor }}
                  >
                    {selected.label}
                  </span>
                  <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
                    {selected.name}
                  </span>
                  <a
                    href={selected.href}
                    className="text-sm text-blue-500 hover:text-blue-400 hover:underline"
                  >
                    View alerts &amp; history →
                  </a>
                  <button
                    type="button"
                    onClick={() => setSelectedId(null)}
                    aria-label="Clear selected route"
                    className="ml-auto text-lg leading-none text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                  >
                    ×
                  </button>
                </div>
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
              Metro and Regional Rail stations appear as you zoom in. Where routes overlap, the one
              drawn on top is the one you get: Metro over Regional Rail over bus.
            </p>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
