import { useEffect, useState } from 'react';
import { useNow } from '../hooks/useNow.js';
import { dataUrl } from '../lib/dataSource.js';
import { formatRelativeTime, formatTime } from '../lib/format.js';
import { PCC_FILE, PCC_TRACKER_URL, parsePccFile } from '../lib/pcc.js';

// Re-read this often while the page is open (the collector rewrites it every few minutes).
export const PCC_POLL_MS = 60_000;
// Older than this, the file can't say what's out now: no banner. A deployed
// file is rewritten when a car comes out or goes in, and refreshed at least
// every half hour otherwise.
export const PCC_MAX_AGE_MS = 90 * 60 * 1000;
// Older than this, the banner says how old.
const PCC_AGE_NOTE_MS = 10 * 60 * 1000;

/** Fetch the published pcc.json. */
export async function fetchPccFile(fetchFn = fetch) {
  const res = await fetchFn(dataUrl(PCC_FILE), { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parsePccFile(await res.json());
}

function carLabel(car) {
  const where = [car.direction, car.destination ? `to ${car.destination}` : null]
    .filter(Boolean)
    .join(' ');
  return where ? `#${car.id} · ${where}` : `#${car.id}`;
}

// A banner on the G1 page while SEPTA's vintage PCC trolleys are running. The
// collector picks them out of SEPTA's G1 positions by fleet number and
// publishes them as pcc.json (src/lib/pcc.js). No PCC out, a file too old to
// trust, or no file at all means no banner: a stale "running now" would send
// riders out for a car that's gone.
export default function PccBanner({ fetchStatus = fetchPccFile, pollMs = PCC_POLL_MS }) {
  const [status, setStatus] = useState(null);
  const now = useNow(pollMs);

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
  const age = status?.updatedTs != null ? now - status.updatedTs : null;
  if (cars.length === 0 || age == null || age > PCC_MAX_AGE_MS) return null;
  const n = cars.length;
  const buses = status.buses;
  const since = Math.min(...cars.map((c) => c.first_seen_ts).filter(Number.isFinite));

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
            {Number.isFinite(since) && (
              <span className="font-normal text-yellow-800/90 dark:text-yellow-200/80">
                {' '}
                · out since {formatTime(since)}
              </span>
            )}
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
            .{age > PCC_AGE_NOTE_MS ? ` Updated ${formatRelativeTime(status.updatedTs, now)}.` : ''}{' '}
            <a
              href={PCC_TRACKER_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold underline underline-offset-2 hover:text-yellow-950 dark:hover:text-white"
            >
              Follow {n === 1 ? 'it' : 'them'} live on the G Trolley Tracker ↗
            </a>
          </p>
        </div>
      </div>
    </section>
  );
}
