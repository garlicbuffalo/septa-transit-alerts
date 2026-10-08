import { useEffect, useMemo, useRef, useState } from 'react';
import { busRouteDisplayId, compareBusRoutes } from '../lib/busRoutes.js';
import { METRO_LINE_ORDER, METRO_LINES } from '../lib/metroLines.js';
import { RAIL_LINE_ORDER, RAIL_LINES } from '../lib/railLines.js';
import { buildRailStationIndex } from '../lib/railStations.js';
import { BLUESKY_ACCOUNTS } from '../lib/site.js';
import { buildStationIndex } from '../lib/stations.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 90;
const BUS_ROUTE_LIMIT = 15;
// Stations are trimmed to the busiest few so the menu doesn't end in a wall of
// ~30 uniform rows; the long tail lives on /stations. Each shown row carries its
// 90d incident count, so the list reads as "most affected" rather than a flat
// directory.
const STATION_LIMIT = 8;

// Top bus routes by incident count within the rolling window, returned as
// `{ id, count }`. Mirrors what `prerender-pages.js` would emit a per-route OG
// card for, so the menu only links to pages that actually have prerendered
// cards. The slice is sorted alphabetically (numerically for pure-number
// routes) so users can scan it like a directory; the per-pill count badge
// carries the "how active" signal without forcing a most-active-first reorder.
function topBusRoutes(alerts, observations, now) {
  if (!alerts || !observations) return [];
  const cutoff = now - WINDOW_DAYS * DAY_MS;
  const counts = new Map();
  const bump = (route, ts) => {
    if (ts == null || ts < cutoff) return;
    const key = String(route);
    counts.set(key, (counts.get(key) || 0) + 1);
  };
  for (const a of alerts) {
    if (a.kind !== 'bus') continue;
    for (const r of a.routes || []) bump(r, a.first_seen_ts);
  }
  for (const o of observations) {
    if (o.kind !== 'bus') continue;
    bump(o.line, o.ts);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, BUS_ROUTE_LIMIT)
    .sort((a, b) => compareBusRoutes(a[0], b[0]))
    .map(([id, count]) => ({ id, count }));
}

// Busiest SEPTA stations in the window, count-descending. Unlike bus routes (kept
// alphabetical as a directory), this is an explicit "top N" cut, so the most-
// affected order is the point — the count badge and the ranking reinforce each
// other. The full list is on /stations.
function topStations(alerts, observations, now) {
  if (!alerts || !observations) return [];
  const idx = buildStationIndex(alerts, observations, { now, windowDays: WINDOW_DAYS });
  return [...idx.values()]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, STATION_LIMIT);
}

// Busiest Regional Rail stations in the window — the Regional Rail analog of topStations.
function topRailStations(alerts, observations, now) {
  if (!alerts || !observations) return [];
  const idx = buildRailStationIndex(alerts, observations, { now, windowDays: WINDOW_DAYS });
  return [...idx.values()]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, STATION_LIMIT);
}

const ROW_LINK =
  'flex items-center gap-2 px-2 py-1 rounded text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-gh-border transition-colors';
const SUB_LABEL =
  'text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500 mb-1.5';
const NETWORK_LABEL =
  'text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-200';
const PILL =
  'inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold hover:opacity-80 transition-opacity';
const MORE_LINK =
  'block px-2 py-1 mt-1.5 rounded text-xs text-blue-500 hover:text-blue-400 hover:underline';

// Top-N station list (shared by SEPTA and Regional Rail groups). `hrefBase` is
// `/station` or `/rail/station`; `moreHref`/`moreLabel` drive the "All →" link.
function StationList({ stations, hrefBase, moreHref, moreLabel }) {
  if (stations.length === 0) return null;
  return (
    <div className="mt-3">
      <p className={SUB_LABEL}>Top stations (last 90d)</p>
      <ul className="space-y-0.5">
        {stations.map((s) => (
          <li key={s.slug}>
            <a
              href={`${hrefBase}/${s.slug}`}
              role="menuitem"
              title={`${s.count} incident${s.count === 1 ? '' : 's'} in the last 90 days`}
              className="flex items-center justify-between gap-2 px-2 py-1 rounded text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-gh-border transition-colors"
            >
              <span className="truncate">{s.name}</span>
              <span className="shrink-0 tabular-nums text-xs text-slate-400 dark:text-slate-500">
                {s.count}
              </span>
            </a>
          </li>
        ))}
      </ul>
      <a href={moreHref} role="menuitem" className={MORE_LINK}>
        {moreLabel}
      </a>
    </div>
  );
}

// Browse dropdown surfaced in the Header on every page. Organized by network:
// a cross-network Views block, then a Metro & Bus group (Metro lines, bus
// routes, stations) and a Regional Rail group (lines, stations). Lines are the
// stable rosters; bus routes and stations are scoped to the rolling 90-day
// window so the menu reflects what's actually been happening recently.
export default function BrowseMenu({ alerts, observations, align = 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  // Snapshot `now` once at mount so the 90-day window cutoff is stable
  // across re-renders (otherwise useMemo below would invalidate every
  // render via a fresh Date.now()). Browse contents shifting by a few
  // hours of data freshness is fine for a navigation menu.
  const [now] = useState(() => Date.now());

  useEffect(() => {
    if (!open) return;
    function handleOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    function handleKey(e) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  const busRoutes = useMemo(
    () => topBusRoutes(alerts, observations, now),
    [alerts, observations, now],
  );
  const stations = useMemo(
    () => topStations(alerts, observations, now),
    [alerts, observations, now],
  );
  const railStations = useMemo(
    () => topRailStations(alerts, observations, now),
    [alerts, observations, now],
  );

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-slate-100 dark:bg-gh-subtle text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-gh-border transition-colors"
      >
        Browse
        <span aria-hidden="true" className="opacity-60">
          ▾
        </span>
      </button>

      {open && (
        <div
          role="menu"
          className={`absolute ${
            align === 'left'
              ? 'left-0'
              : // The button always sits in the header's right-side control
                // group, so anchor the panel's right edge to it at every width.
                // Anchoring `left-0` on mobile (the old "responsive" behavior)
                // started the 288px panel near the screen's right edge and ran
                // it off-screen, forcing a horizontal page scroll.
                'right-0'
          } top-full mt-1.5 z-40 bg-white dark:bg-gh-surface border border-slate-200 dark:border-gh-border rounded-lg shadow-lg p-3 w-72 max-w-[calc(100vw-1rem)] max-h-[70vh] overflow-y-auto`}
        >
          <div className="divide-y divide-slate-200 dark:divide-gh-border [&>section]:py-4 [&>section:first-child]:pt-0 [&>section:last-child]:pb-0">
            <section>
              <h3 className={SUB_LABEL}>Views</h3>
              {/* Leading glyphs give each row a visual anchor so the block reads
                  as distinct destinations rather than a uniform gray list. The
                  fixed-width icon slot keeps the labels left-aligned. */}
              <a href="/week" role="menuitem" className={ROW_LINK}>
                <span aria-hidden="true" className="w-5 shrink-0 text-center">
                  🗓️
                </span>
                This week
              </a>
              <a href="/calendar" role="menuitem" className={ROW_LINK}>
                <span aria-hidden="true" className="w-5 shrink-0 text-center">
                  📅
                </span>
                Calendar
              </a>
              <a href="/stats" role="menuitem" className={ROW_LINK}>
                <span aria-hidden="true" className="w-5 shrink-0 text-center">
                  📊
                </span>
                Stats
              </a>
              <a href="/map" role="menuitem" className={ROW_LINK}>
                <span aria-hidden="true" className="w-5 shrink-0 text-center">
                  🗺️
                </span>
                System map
              </a>
              <a href="/compare" role="menuitem" className={ROW_LINK}>
                <span aria-hidden="true" className="w-5 shrink-0 text-center">
                  ⚖️
                </span>
                Compare
              </a>
              <a href="/accessibility" role="menuitem" className={ROW_LINK}>
                <span aria-hidden="true" className="w-5 shrink-0 text-center">
                  ♿
                </span>
                Accessibility
              </a>
              {/* One "System health" label with three compact links, instead of
                  three rows that each repeat the noun. */}
              <div className="flex flex-wrap items-center gap-1.5 mt-1 px-2 py-1">
                <span className="text-xs text-slate-500 dark:text-slate-400">System health</span>
                <a
                  href="/system/metro"
                  role="menuitem"
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 dark:bg-gh-subtle text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-gh-border transition-colors"
                >
                  🚇 Metro
                </a>
                <a
                  href="/system/buses"
                  role="menuitem"
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 dark:bg-gh-subtle text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-gh-border transition-colors"
                >
                  🚌 Buses
                </a>
                <a
                  href="/system/rail"
                  role="menuitem"
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 dark:bg-gh-subtle text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-gh-border transition-colors"
                >
                  🚆 Regional Rail
                </a>
              </div>
            </section>

            <section>
              <h3 className={SUB_LABEL}>More</h3>
              <a href="/about" role="menuitem" className={ROW_LINK}>
                <span aria-hidden="true" className="w-5 shrink-0 text-center">
                  ℹ️
                </span>
                About
              </a>
              <a href="/subscribe" role="menuitem" className={ROW_LINK}>
                <span aria-hidden="true" className="w-5 shrink-0 text-center">
                  🔔
                </span>
                Subscribe
              </a>
              <a href="/privacy" role="menuitem" className={ROW_LINK}>
                <span aria-hidden="true" className="w-5 shrink-0 text-center">
                  🔒
                </span>
                Privacy
              </a>

              {/* The Bluesky bots that post these alerts and detections. */}
              {BLUESKY_ACCOUNTS.length > 0 && (
                <div className="mt-3">
                  <p className={SUB_LABEL}>Follow on Bluesky</p>
                  <div className="flex flex-wrap gap-1.5">
                    {BLUESKY_ACCOUNTS.map((bot) => (
                      <a
                        key={bot.key}
                        href={bot.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        role="menuitem"
                        title={bot.description}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-slate-100 dark:bg-gh-subtle text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-gh-border transition-colors"
                      >
                        <span aria-hidden="true">{bot.emoji}</span>
                        {bot.label}
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </section>

            {/* Metro & Bus group — SEPTA Metro lines, bus routes, and Metro stations. */}
            <section>
              <h3 className={NETWORK_LABEL}>Metro &amp; Bus</h3>

              <div className="mt-2.5">
                <p className={SUB_LABEL}>SEPTA Metro lines</p>
                <div className="flex flex-wrap gap-1.5">
                  {METRO_LINE_ORDER.map((line) => {
                    const info = METRO_LINES[line];
                    return (
                      <a
                        key={line}
                        href={`/line/${line}`}
                        role="menuitem"
                        className={PILL}
                        style={{ backgroundColor: info.color, color: info.textColor }}
                        title={info.name}
                      >
                        {info.label}
                      </a>
                    );
                  })}
                </div>
              </div>

              {busRoutes.length > 0 && (
                <div className="mt-3">
                  <p className={SUB_LABEL}>Bus routes (last 90d)</p>
                  <div className="flex flex-wrap gap-1.5">
                    {busRoutes.map((r) => (
                      <a
                        key={r.id}
                        href={`/route/${r.id}`}
                        role="menuitem"
                        title={`${r.count} incident${r.count === 1 ? '' : 's'} in the last 90 days`}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-slate-100 dark:bg-gh-subtle text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-gh-border transition-colors"
                      >
                        {busRouteDisplayId(r.id)}
                        <span className="font-normal tabular-nums opacity-60">{r.count}</span>
                      </a>
                    ))}
                  </div>
                  <a href="/routes" role="menuitem" className={MORE_LINK}>
                    All routes →
                  </a>
                </div>
              )}

              <StationList
                stations={stations}
                hrefBase="/station"
                moreHref="/stations"
                moreLabel="All stations →"
              />
            </section>

            {/* Regional Rail group — lines and stations. */}
            <section>
              <h3 className={NETWORK_LABEL}>Regional Rail</h3>

              <div className="mt-2.5">
                <p className={SUB_LABEL}>Lines</p>
                <div className="flex flex-wrap gap-1.5">
                  {RAIL_LINE_ORDER.map((line) => {
                    const info = RAIL_LINES[line];
                    return (
                      <a
                        key={line}
                        href={`/rail/line/${line}`}
                        role="menuitem"
                        className={PILL}
                        style={{ backgroundColor: info.color, color: info.textColor }}
                      >
                        {info.label}
                      </a>
                    );
                  })}
                </div>
              </div>

              <StationList
                stations={railStations}
                hrefBase="/rail/station"
                moreHref="/stations"
                moreLabel="All Regional Rail stations →"
              />
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
