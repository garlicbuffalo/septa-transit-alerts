import { useEffect, useMemo, useState } from 'react';
import { useBrowseData } from '../hooks/useBrowseData.js';
import { useDarkMode } from '../hooks/useDarkMode.js';
import { topLevelTrail } from '../lib/breadcrumbs.js';
import { BUS_ROUTE_NAMES, busRouteDisplayId, compareBusRoutes } from '../lib/busRoutes.js';
import { METRO_LINE_ORDER, METRO_LINES } from '../lib/metroLines.js';
import { RAIL_LINE_ORDER, RAIL_LINES } from '../lib/railLines.js';
import { SITE_NAME } from '../lib/site.js';
import Breadcrumb from './Breadcrumb.jsx';
import Footer from './Footer.jsx';
import Header from './Header.jsx';

// Bus roster, sorted the same way the rest of the site orders routes (numeric
// ascending, lettered/express variants alongside). Static — compute once.
const BUS_ROUTES = Object.keys(BUS_ROUTE_NAMES).sort(compareBusRoutes);

export default function RoutesIndexPage() {
  const [dark, toggleDark] = useDarkMode();
  const { officialRecords, detectionRecords } = useBrowseData();
  // Free-text filter over both train lines (by label) and bus routes (by number
  // or name), seeded from the same `?q=` param the rest of the site uses.
  const [search, setSearch] = useState(
    () => new URLSearchParams(window.location.search).get('q') ?? '',
  );

  useEffect(() => {
    document.title = `All routes · ${SITE_NAME}`;
    return () => {
      document.title = SITE_NAME;
    };
  }, []);

  // Mirror the search into the URL so a filtered view is a shareable link.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const q = search.trim();
    if (q) params.set('q', q);
    else params.delete('q');
    const qs = params.toString();
    const next = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`;
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (next !== current) window.history.replaceState(null, '', next);
  }, [search]);

  const { lines, routes, rail } = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return { lines: METRO_LINE_ORDER, routes: BUS_ROUTES, rail: RAIL_LINE_ORDER };
    return {
      lines: METRO_LINE_ORDER.filter((line) => {
        const info = METRO_LINES[line];
        const names = [info?.label, info?.name, ...(info?.formerly ?? [])];
        return line.includes(q) || names.some((n) => n?.toLowerCase().includes(q));
      }),
      routes: BUS_ROUTES.filter(
        (id) =>
          id.toLowerCase().includes(q) || (BUS_ROUTE_NAMES[id] ?? '').toLowerCase().includes(q),
      ),
      rail: RAIL_LINE_ORDER.filter((line) => {
        const info = RAIL_LINES[line];
        return line.includes(q) || (info?.label.toLowerCase().includes(q) ?? false);
      }),
    };
  }, [search]);

  const searching = search.trim() !== '';
  const nothingMatches = lines.length === 0 && routes.length === 0 && rail.length === 0;

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
          <Breadcrumb items={topLevelTrail('Routes')} className="mb-3" />
          <h1 className="text-xl font-bold text-slate-800 dark:text-slate-100">All routes</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 mb-4">
            Every SEPTA Metro line, bus route, and Regional Rail line. Pick one for its alert and
            disruption history, or{' '}
            <a href="/map" className="text-blue-500 hover:text-blue-400 hover:underline">
              see them all on the system map
            </a>
            .
          </p>

          {/* Search by route number or name — the fast path through 150+ bus
              routes; also narrows the Metro and Regional Rail lines by name. */}
          <div className="relative w-full sm:w-72 mb-4">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search routes by number or name…"
              aria-label="Search routes by number or name"
              className="w-full pl-3 pr-7 py-1.5 text-sm rounded-full bg-slate-100 dark:bg-gh-subtle text-slate-700 dark:text-slate-200 placeholder:text-slate-400 dark:placeholder:text-slate-500 border border-transparent focus:outline-none focus:border-slate-300 dark:focus:border-gh-border focus-visible:ring-2 focus-visible:ring-blue-500 dark:focus-visible:ring-blue-400"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 text-base leading-none"
              >
                ×
              </button>
            )}
          </div>

          <div className="bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border p-4 sm:p-6 space-y-6">
            {nothingMatches ? (
              <p className="text-sm text-slate-500 dark:text-slate-400 text-center py-4">
                No lines or routes match “{search.trim()}”.
              </p>
            ) : (
              <>
                {lines.length > 0 && (
                  <section>
                    <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500 mb-2">
                      SEPTA Metro
                    </h2>
                    <div className="flex flex-wrap gap-1.5">
                      {lines.map((line) => {
                        const info = METRO_LINES[line];
                        return (
                          <a
                            key={line}
                            href={`/line/${line}`}
                            className="inline-flex items-center px-3 py-1 rounded-full text-sm font-semibold hover:opacity-80 transition-opacity"
                            style={{ backgroundColor: info.color, color: info.textColor }}
                            title={info.name}
                          >
                            {info.label} <span className="font-normal">{info.name}</span>
                          </a>
                        );
                      })}
                    </div>
                  </section>
                )}

                {rail.length > 0 && (
                  <section>
                    <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500 mb-2">
                      Regional Rail
                    </h2>
                    <div className="flex flex-wrap gap-1.5">
                      {rail.map((line) => {
                        const info = RAIL_LINES[line];
                        return (
                          <a
                            key={line}
                            href={`/rail/line/${line}`}
                            className="inline-flex items-center px-3 py-1 rounded-full text-sm font-semibold hover:opacity-80 transition-opacity"
                            style={{ backgroundColor: info.color, color: info.textColor }}
                          >
                            {info.label}
                          </a>
                        );
                      })}
                    </div>
                  </section>
                )}

                {routes.length > 0 && (
                  <section>
                    <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500 mb-2">
                      Bus routes (
                      {searching ? `${routes.length} of ${BUS_ROUTES.length}` : routes.length})
                    </h2>
                    <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-0.5">
                      {routes.map((id) => (
                        <li key={id}>
                          <a
                            href={`/route/${id}`}
                            className="flex items-center gap-2 px-2 py-1 rounded hover:bg-slate-100 dark:hover:bg-gh-border transition-colors"
                          >
                            <span className="shrink-0 min-w-[2.75rem] text-center px-1.5 py-0.5 rounded text-xs font-semibold tabular-nums bg-slate-100 dark:bg-gh-subtle text-slate-600 dark:text-slate-300">
                              {busRouteDisplayId(id)}
                            </span>
                            <span className="truncate text-sm text-slate-700 dark:text-slate-200">
                              {BUS_ROUTE_NAMES[id]}
                            </span>
                          </a>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </>
            )}
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
