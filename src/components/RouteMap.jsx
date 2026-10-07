import { useEffect, useMemo, useState } from 'react';
import { buildRouteMap, loadRouteShapes } from '../lib/routeMaps.js';
import { BasemapCredit, BasemapTiles } from './Basemap.jsx';

const pathProps = { fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round' };

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
  if (!map) return null;
  return (
    <section>
      <h2 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-3">
        Route map
      </h2>
      <div className="bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border p-4">
        <div className="relative rounded-md overflow-hidden">
          <BasemapTiles basemap={map.basemap} />
          <svg
            viewBox={`0 0 ${map.width} ${map.height}`}
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label={`Map of ${label}`}
            className="relative block w-full h-auto"
          >
            <title>{`${label} route map`}</title>
            {map.paths.map((d) => (
              <path
                key={`edge:${d}`}
                d={d}
                stroke="#0b0f14"
                strokeWidth={8}
                opacity={0.6}
                {...pathProps}
              />
            ))}
            {map.paths.map((d) => (
              <path key={d} d={d} stroke={accent} strokeWidth={4.5} opacity={0.95} {...pathProps} />
            ))}
            {map.ends.map((p) => (
              <circle
                key={`${p.x}:${p.y}`}
                cx={p.x}
                cy={p.y}
                r={6}
                fill="#f8fafc"
                stroke="#0b0f14"
                strokeWidth={2}
              />
            ))}
          </svg>
        </div>
        <BasemapCredit basemap={map.basemap} />
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          Both directions of the route · dots mark where it starts and ends
        </p>
      </div>
    </section>
  );
}
