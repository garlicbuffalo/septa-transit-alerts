import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import {
  buildSpeedMap,
  loadRouteShapes,
  loadRouteSpeeds,
  railStopsOf,
  speedWindowLabel,
  stopsOf,
  summarizeSpeeds,
} from '../lib/routeMaps.js';
import { NO_DATA_COLOR, SPEED_BANDS } from '../lib/speedBands.js';
import MapPlaceholder from './MapPlaceholder.jsx';

// Leaflet is heavy; it loads only for a page that has a map to show.
const InteractiveMap = lazy(() => import('./InteractiveMap.jsx'));

const plural = (n, word) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

// A route's or line's path colored by how fast its vehicles moved along each
// stretch, averaged over the past 7 days (the bot server's speed history).
// One map per direction. Left out when there are no speeds for it: the Broad
// Street Line doesn't report positions, the L1's are placed by the schedule in
// the tunnel, and some routes are too thinly tracked.
export default function SpeedMap({ route, label, mode = 'bus' }) {
  const rail = mode === 'rail';
  const bands = rail ? SPEED_BANDS.rail : SPEED_BANDS.road;
  const noun = rail ? 'trains' : mode === 'metro' ? 'vehicles' : 'buses';
  const [file, setFile] = useState(null);
  const [directionId, setDirectionId] = useState(null);
  // The route's shapes file, for its stops (Regional Rail's come with the site).
  const [shapes, setShapes] = useState(null);
  useEffect(() => {
    let cancelled = false;
    setShapes(null);
    if (!rail) {
      loadRouteShapes(route).then((f) => {
        if (!cancelled) setShapes(f);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [route, rail]);
  useEffect(() => {
    let cancelled = false;
    setFile(null);
    setDirectionId(null);
    loadRouteSpeeds(route, { rail }).then((f) => {
      if (cancelled) return;
      setFile(f);
      // The direction with the most readings first.
      const busiest = [...(f?.directions ?? [])].sort((a, b) => b.readings - a.readings)[0];
      setDirectionId(busiest?.id ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [route, rail]);

  const direction = file?.directions.find((d) => d.id === directionId) ?? null;
  const map = useMemo(
    () => (direction ? buildSpeedMap(direction, bands) : null),
    [direction, bands],
  );
  // The stops of the direction on show; zoomed in to, they sit over the colors.
  const directionKey = direction?.id;
  const stops = useMemo(
    () => (rail ? railStopsOf(route) : stopsOf(shapes, directionKey)),
    [rail, route, shapes, directionKey],
  );
  // Gray under everything; each stretch with data over it in its band's color.
  const lines = useMemo(
    () =>
      map && [
        { id: 'base', points: map.base, color: NO_DATA_COLOR },
        ...map.stretches.map((st) => ({
          id: st.index,
          points: st.points,
          color: st.color,
          tip: `${st.mph.toFixed(1)} mph (${plural(st.readings, 'reading')})`,
        })),
      ],
    [map],
  );
  const summary = useMemo(
    () => (direction ? summarizeSpeeds(direction, bands) : null),
    [direction, bands],
  );
  if (!file || !direction || !map || !summary) return null;

  const window = speedWindowLabel(file);
  const dirLabel = file.directions.length > 1 ? ` ${direction.label.toLowerCase()}` : '';
  const alt =
    `Map of ${label}${dirLabel} colored by how fast ${noun} moved along it, ${window}, ` +
    `averaging ${summary.avgMph.toFixed(1)} mph` +
    (summary.slowCount
      ? `, with ${summary.slowCount} of ${summary.shownCount} stretches under ${bands[0].below} mph.`
      : '.') +
    ' Gray stretches had too little data.';

  return (
    <section>
      <h2 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-3">
        Average speeds, past 7 days
      </h2>
      <div className="bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border p-4">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 mb-3">
          {file.directions.length > 1 ? (
            <fieldset className="inline-flex min-w-0 rounded-md border border-slate-200 dark:border-gh-border overflow-hidden">
              <legend className="sr-only">Direction</legend>
              {file.directions.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  aria-pressed={d.id === direction.id}
                  onClick={() => setDirectionId(d.id)}
                  className={`px-3 py-1 text-xs font-medium ${
                    d.id === direction.id
                      ? 'bg-slate-700 text-white dark:bg-slate-200 dark:text-slate-900'
                      : 'bg-white dark:bg-gh-surface text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-gh-subtle'
                  }`}
                >
                  {d.label}
                </button>
              ))}
            </fieldset>
          ) : (
            <span className="text-xs font-medium text-slate-600 dark:text-slate-300">
              {direction.label}
            </span>
          )}
          <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">{window}</span>
        </div>

        <div className="grid grid-cols-3 gap-2 mb-3">
          {[
            { v: `${summary.avgMph.toFixed(1)} mph`, l: 'average' },
            { v: `${summary.slowestMph.toFixed(1)} mph`, l: 'slowest stretch' },
            { v: `${summary.fastestMph.toFixed(1)} mph`, l: 'fastest stretch' },
          ].map((c) => (
            <div
              key={c.l}
              className="rounded-lg border border-slate-200 dark:border-gh-border px-3 py-2"
            >
              <div className="text-base font-semibold text-slate-800 dark:text-slate-100 tabular-nums leading-tight">
                {c.v}
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-snug">
                {c.l}
              </div>
            </div>
          ))}
        </div>

        <p className="sr-only">{alt}</p>
        <Suspense fallback={<MapPlaceholder />}>
          <InteractiveMap
            label={`${label}${dirLabel} average speeds`}
            fit={map.fit}
            lines={lines}
            stops={stops}
            stopZoom={rail ? 0 : undefined}
          >
            <ul className="absolute left-2 bottom-2 z-[1000] rounded-md bg-black/70 px-2 py-1.5 text-[11px] leading-tight text-slate-100 space-y-0.5">
              {[...bands].reverse().map((b) => (
                <li key={b.label} className="flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className="inline-block h-1.5 w-4 rounded-full"
                    style={{ backgroundColor: b.color }}
                  />
                  {b.label}
                </li>
              ))}
              <li className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="inline-block h-1.5 w-4 rounded-full"
                  style={{ backgroundColor: NO_DATA_COLOR }}
                />
                no data
              </li>
            </ul>
          </InteractiveMap>
        </Suspense>

        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          Each stretch is the total distance {noun} covered there over the total time, from{' '}
          {plural(summary.readings, 'position pair')} on SEPTA's{' '}
          {rail ? 'TrainView' : 'vehicle tracker'} over {plural(file.days_with_data, 'day')}. Stops,
          traffic, and signals all count — this is trip speed, not top speed.{' '}
          {rail
            ? 'Trains in both directions are combined.'
            : `The ends of the route are left out, where ${noun} layover.`}{' '}
          Gray stretches had too little data.
        </p>
      </div>
    </section>
  );
}
