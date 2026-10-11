import { useEffect, useState } from 'react';
import { fetchPccStatus, PCC_TRACKER_URL } from '../lib/pcc.js';

// Re-checked this often while the page is open (the tracker caches for 60s).
export const PCC_POLL_MS = 60_000;

function carLabel(car) {
  const where = [car.direction, car.destination ? `to ${car.destination}` : null]
    .filter(Boolean)
    .join(' ');
  return where ? `#${car.id} · ${where}` : `#${car.id}`;
}

// A banner on the G1 page while SEPTA's vintage PCC trolleys are running,
// read live from the G Trolley Tracker's public feed (src/lib/pcc.js). It
// shows nothing when no PCC is out, and nothing when the tracker can't be
// reached: a stale "running now" would send riders out for a car that's gone.
export default function PccBanner({ fetchStatus = fetchPccStatus, pollMs = PCC_POLL_MS }) {
  const [status, setStatus] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetchStatus()
        .then((s) => {
          if (!cancelled) setStatus(s);
        })
        .catch(() => {
          if (!cancelled) setStatus(null);
        });
    load();
    const id = setInterval(load, pollMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [fetchStatus, pollMs]);

  const cars = status?.cars ?? [];
  if (cars.length === 0) return null;
  const n = cars.length;
  const buses = status.buses;

  return (
    <section
      aria-label="PCC trolleys running now"
      className="rounded-lg border border-yellow-300 dark:border-yellow-700/70 bg-yellow-50 dark:bg-yellow-950/30 px-4 py-3"
    >
      <div role="status" className="flex items-start gap-3">
        <span aria-hidden="true" className="text-2xl leading-none mt-0.5">
          🚋
        </span>
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-bold text-yellow-900 dark:text-yellow-100">
            {n === 1 ? 'A vintage PCC trolley is' : `${n} vintage PCC trolleys are`} running on the
            G1 now
          </p>
          <ul className="flex flex-wrap gap-x-4 gap-y-0.5 text-sm text-yellow-900 dark:text-yellow-100">
            {cars.map((car) => (
              <li key={car.id} className="font-medium">
                {carLabel(car)}
              </li>
            ))}
          </ul>
          <p className="text-xs text-yellow-800/90 dark:text-yellow-200/80">
            Most G1 trips run with buses
            {buses > 0
              ? ` (${buses === 1 ? '1 bus is' : `${buses} buses are`} out on the line too)`
              : ''}
            .{' '}
            <a
              href={PCC_TRACKER_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold underline underline-offset-2 hover:text-yellow-950 dark:hover:text-white"
            >
              Track {n === 1 ? 'it' : 'them'} live on the G Trolley Tracker ↗
            </a>
          </p>
        </div>
      </div>
    </section>
  );
}
