import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { buildRouteMap, loadRouteShapes, stopsOf } from '../lib/routeMaps.js';
import MapPlaceholder from './MapPlaceholder.jsx';

// Leaflet is heavy; it loads only for a page that has a map to show.
const InteractiveMap = lazy(() => import('./InteractiveMap.jsx'));

// A bus route drawn on a street map, both directions. Left out when the
// collector hasn't published the route's shape (a route with no scheduled
// trips, or a collector that hasn't rebuilt its GTFS cache yet).
export default function RouteMap({ route, label, accent = '#60a5fa' }) {
  const [shapes, setShapes] = useState(null);
  useEffect(() => {
    let cancelled = false;
    setShapes(null);
    loadRouteShapes(route).then((s) => {
      if (!cancelled) setShapes(s);
    });
    return () => {
      cancelled = true;
    };
  }, [route]);
  const map = useMemo(() => (shapes ? buildRouteMap(shapes.directions) : null), [shapes]);
  const lines = useMemo(
    () => map?.lines.map((l) => ({ id: l.id, points: l.points, color: accent, weight: 4.5 })),
    [map, accent],
  );
  const stops = useMemo(() => stopsOf(shapes), [shapes]);
  const dots = useMemo(() => map?.ends.map((point) => ({ id: point.join(), point })), [map]);
  if (!map) return null;
  return (
    <section>
      <h2 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-3">
        Route map
      </h2>
      <div className="bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border p-4">
        <Suspense fallback={<MapPlaceholder />}>
          <InteractiveMap
            label={`Map of ${label}`}
            fit={map.fit}
            lines={lines}
            dots={dots}
            stops={stops}
          />
        </Suspense>
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          Both directions of the route · large dots mark where it starts and ends · zoom in to see
          its stops
        </p>
      </div>
    </section>
  );
}
