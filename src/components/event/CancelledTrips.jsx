import { formatTime } from '../../lib/format.js';
import { cleanStopName as stopName } from '../../lib/stops.js';

// The trips behind a route's trip-cancellation roll-up, in schedule order.
// Trips whose scheduled start has passed are dimmed so the runs riders still
// can't count on stand out.
export default function CancelledTrips({ trips, now }) {
  if (!Array.isArray(trips) || trips.length === 0) return null;
  return (
    <section className="mt-3 mb-3">
      <p className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
        Cancelled trips · {trips.length}
      </p>
      <ul className="text-sm divide-y divide-slate-100 dark:divide-gh-border">
        {trips.map((t) => (
          <li
            key={t.trip_id}
            className={`flex gap-3 py-1 ${
              t.start_ts <= now
                ? 'text-slate-400 dark:text-slate-500'
                : 'text-slate-700 dark:text-slate-200'
            }`}
          >
            <span className="w-20 shrink-0 whitespace-nowrap tabular-nums">
              {formatTime(t.start_ts)}
            </span>
            <span className="min-w-0">
              {t.origin && t.destination
                ? `${stopName(t.origin)} → ${stopName(t.destination)}`
                : (stopName(t.destination) ?? '')}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
