import { useEffect, useMemo, useState } from 'react';
import { useDarkMode } from '../hooks/useDarkMode.js';
import { useNow } from '../hooks/useNow.js';
import { fetchAccessibilityData, outageDuration, outagesForStation } from '../lib/accessibility.js';
import { computeTypicalDurations } from '../lib/aggregate.js';
import { topLevelTrail } from '../lib/breadcrumbs.js';
import { formatDate, formatDuration } from '../lib/format.js';
import { loadIndex, loadLine } from '../lib/incidentStore.js';
import {
  incidentDetections,
  incidentLifecycle,
  incidentRecords,
  legacyKind,
  searchFilterIncidents,
} from '../lib/incidents.js';
import { METRO_LINES } from '../lib/metroLines.js';
import { RAIL_LINES } from '../lib/railLines.js';
import { railStationBySlug } from '../lib/railStations.js';
import { SITE_NAME } from '../lib/site.js';
import {
  buildStationIndex,
  displayStationName,
  rosterStationBySlug,
  slugifyStation,
} from '../lib/stations.js';
import ActiveAlerts from './ActiveAlerts.jsx';
import Breadcrumb from './Breadcrumb.jsx';
import CollapsibleSection from './CollapsibleSection.jsx';
import Footer from './Footer.jsx';
import Header from './Header.jsx';
import HourOfWeekHeatmap from './HourOfWeekHeatmap.jsx';
import IncidentList from './IncidentList.jsx';
import NotFoundPage from './NotFoundPage.jsx';

// `/station/:slug` — surfaces every train alert and observation that
// touched a given station within the rolling window. Stations are sparse:
// only train pulse-cold/pulse-held observations and the rare station-scoped
// alert carry endpoint info, so most line incidents won't show up here.
// The page is intentionally narrower than LinePage: no Timeline (a single
// station doesn't make sense as a per-day grid) and no per-line summary
// card.
export default function StationPage({ slug, kind = 'metro' }) {
  const isRail = kind === 'rail';
  const [dark, toggleDark] = useDarkMode();
  const now = useNow();
  const [data, setData] = useState(null);
  const [accessibilityData, setAccessibilityData] = useState(null);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');

  // A station's incidents all live in its serving lines' files: an incident only
  // touches a station if that station sits on the incident's route's segment, so
  // the station is served by that route. Resolve the serving lines from the
  // static roster (no data needed), then load just those bounded per-line files.
  const stationLineKeys = useMemo(() => {
    const roster = isRail ? railStationBySlug(slug) : rosterStationBySlug(slug);
    return roster?.lines ?? [];
  }, [isRail, slug]);

  useEffect(() => {
    // Load the index first (for generated_at / data_start_ts, which the per-line
    // files don't carry, and for the list of which line files exist), then union
    // only the station's serving lines that actually have a file — a line with no
    // incidents yet has no file, so skipping it avoids a needless 404.
    loadIndex()
      .then((index) => {
        const existing = new Set((index.lines ?? []).map((l) => l.key));
        const keys = stationLineKeys.filter((k) => existing.has(k));
        return Promise.all(keys.map((key) => loadLine(key))).then((perLine) => {
          const byId = new Map();
          for (const arr of perLine) {
            for (const inc of arr) byId.set(inc.id, inc);
          }
          setData({
            incidents: [...byId.values()],
            generated_at: index.generated_at,
            data_start_ts: index.data_start_ts,
          });
        });
      })
      .catch(setError);
  }, [stationLineKeys]);

  useEffect(() => {
    fetchAccessibilityData()
      .then(setAccessibilityData)
      .catch(() => setAccessibilityData(null));
  }, []);

  // Flat view feeds the station index (and Header); the list reads nested
  // incidents reconstructed from the station's records below.
  const flat = useMemo(() => (data ? incidentRecords(data.incidents) : null), [data]);

  // SEPTA path uses the activity index (which keys off the train roster). Regional Rail
  // resolves against the Regional Rail roster instead — skip SEPTA index entirely.
  const stationIndex = useMemo(() => {
    if (isRail || !flat) return null;
    return buildStationIndex(flat.officialRecords, flat.detectionRecords, { now, windowDays: 90 });
  }, [isRail, flat, now]);

  // Regional Rail incidents touching this station: any Regional Rail incident whose origin or
  // destination slugifies to this slug. (Regional Rail cancellation/delay incidents carry
  // from_station/to_station = origin/headsign.)
  const railStationIncidents = useMemo(() => {
    if (!isRail || !data) return [];
    return data.incidents.filter((inc) => {
      if (legacyKind(inc) !== 'rail') return false;
      return incidentDetections(inc).some(
        (o) =>
          slugifyStation(o.scope?.from_station) === slug ||
          slugifyStation(o.scope?.to_station) === slug,
      );
    });
  }, [isRail, data, slug]);

  // Unified `station` object: SEPTA path reads the activity index (with a
  // roster fallback for quiet stations); the Regional Rail path builds it from the Regional Rail
  // roster + the matched incidents' flattened records (so the heatmap/durations
  // work the same downstream).
  const station = useMemo(() => {
    if (isRail) {
      const roster = railStationBySlug(slug);
      if (!roster) return null;
      const f = incidentRecords(railStationIncidents);
      return {
        ...roster,
        count: railStationIncidents.length,
        alerts: f.officialRecords,
        observations: f.detectionRecords,
      };
    }
    return stationIndex?.get(slug) ?? rosterStationBySlug(slug);
  }, [isRail, slug, stationIndex, railStationIncidents]);

  // Nested incidents touching this station — for Regional Rail it's the matched set
  // above; for SEPTA, reconstructed via the station's flat records' `_incidentId`.
  const stationIncidents = useMemo(() => {
    if (!station || !data) return [];
    if (isRail) return railStationIncidents;
    const ids = new Set();
    for (const a of station.alerts) if (a._incidentId) ids.add(a._incidentId);
    for (const o of station.observations) if (o._incidentId) ids.add(o._incidentId);
    return data.incidents.filter((inc) => ids.has(inc.id));
  }, [station, data, isRail, railStationIncidents]);

  const activeIncidents = useMemo(
    () =>
      stationIncidents
        .filter((inc) => incidentLifecycle(inc).active)
        .sort((a, b) => incidentLifecycle(b).first_seen_ts - incidentLifecycle(a).first_seen_ts),
    [stationIncidents],
  );

  const typicalDurations = useMemo(() => {
    if (!station) return null;
    return computeTypicalDurations(station.alerts, station.observations, {
      now,
      windowDays: 90,
    });
  }, [station, now]);

  const listFiltered = useMemo(
    () => searchFilterIncidents(stationIncidents, search),
    [stationIncidents, search],
  );

  const stationOutages = useMemo(
    () =>
      outagesForStation(accessibilityData?.outages || [], {
        kind: isRail ? 'rail' : 'metro',
        slug,
        now,
        limit: 8,
      }),
    [accessibilityData, isRail, slug, now],
  );
  const activeStationOutages = stationOutages.filter((o) => o.lifecycle?.active);

  useEffect(() => {
    const base = SITE_NAME;
    if (!station) {
      document.title = base;
      return;
    }
    const prefix = activeIncidents.length > 0 ? `(${activeIncidents.length}) ` : '';
    document.title = `${prefix}${displayStationName(station.name)} · ${base}`;
    return () => {
      document.title = base;
    };
  }, [station, activeIncidents.length]);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-gh-canvas">
        <p className="text-red-600 text-sm">Failed to load alert data.</p>
      </div>
    );
  }

  if (data && !station) {
    return <NotFoundPage />;
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-gh-canvas flex flex-col">
      <Header
        generatedAt={data?.generated_at}
        dark={dark}
        onToggleDark={toggleDark}
        onResetFilters={() => {
          window.location.href = '/';
        }}
        alerts={flat?.alerts}
        observations={flat?.observations}
      />
      <main id="main" tabIndex={-1} className="max-w-5xl mx-auto px-4 py-6 space-y-6 w-full">
        <div>
          <Breadcrumb
            items={topLevelTrail(station ? displayStationName(station.name) : 'Station')}
            className="mb-3"
          />
          {station && (
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-xl font-bold text-slate-800 dark:text-slate-100">
                {displayStationName(station.name)}
              </h1>
              <div className="flex flex-wrap gap-1.5">
                {station.lines.map((line) => {
                  const info = isRail ? RAIL_LINES[line] : METRO_LINES[line];
                  if (!info) return null;
                  return (
                    <a
                      key={line}
                      href={isRail ? `/rail/line/${line}` : `/line/${line}`}
                      className="inline-flex items-center min-h-[24px] px-2 py-0.5 rounded-full text-xs font-bold hover:opacity-80 transition-opacity"
                      style={{ backgroundColor: info.color, color: info.textColor }}
                    >
                      {info.label}
                    </a>
                  );
                })}
              </div>
              {activeStationOutages.length > 0 && (
                <a
                  href="/accessibility"
                  className="inline-flex items-center rounded-full bg-red-50 dark:bg-red-950/40 px-2.5 py-1 text-xs font-semibold text-red-700 dark:text-red-300 hover:underline"
                >
                  {activeStationOutages.length} accessibility outage
                  {activeStationOutages.length === 1 ? '' : 's'}
                </a>
              )}
            </div>
          )}
        </div>

        {!data && (
          <div className="space-y-4 animate-pulse">
            <div className="h-16 bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border" />
            <div className="h-48 bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border" />
          </div>
        )}

        {station && (
          <>
            {activeIncidents.length > 0 && (
              <ActiveAlerts
                incidents={activeIncidents}
                now={now}
                typicalDurations={typicalDurations}
                stationIndex={stationIndex}
              />
            )}

            <p className="text-sm text-slate-600 dark:text-slate-300 px-1">
              <strong className="text-slate-800 dark:text-slate-100">{station.count}</strong>{' '}
              incident{station.count === 1 ? '' : 's'} on record (last 90 days)
            </p>

            {stationOutages.length > 0 && (
              <CollapsibleSection
                title="Accessibility"
                subtitle={`${activeStationOutages.length} active · ${stationOutages.length} recent`}
                defaultOpen={activeStationOutages.length > 0}
              >
                <ul className="space-y-2">
                  {stationOutages.map((outage) => {
                    const active = !!outage.lifecycle?.active;
                    const duration = formatDuration(outageDuration(outage, now)) || 'just now';
                    return (
                      <li
                        key={outage.id}
                        className="rounded-lg border border-slate-200 dark:border-gh-border bg-white dark:bg-gh-surface p-3"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div>
                            <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                              {outage.unit_label || outage.unit_type || 'Accessibility unit'}
                            </p>
                            {outage.headline && (
                              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                                {outage.headline}
                              </p>
                            )}
                          </div>
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                              active
                                ? 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300'
                                : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                            }`}
                          >
                            {active ? 'Active' : 'Restored'}
                          </span>
                        </div>
                        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                          {active ? `${duration} so far` : `Lasted ${duration}`}
                          {outage.lifecycle?.first_seen_ts
                            ? ` · Seen ${formatDate(outage.lifecycle.first_seen_ts)}`
                            : ''}
                        </p>
                      </li>
                    );
                  })}
                </ul>
              </CollapsibleSection>
            )}

            <HourOfWeekHeatmap alerts={station.alerts} observations={station.observations} />

            <IncidentList
              incidents={listFiltered}
              search={search}
              onSearchChange={setSearch}
              stationIndex={stationIndex}
              isFiltered
            />
          </>
        )}
      </main>
      <Footer />
    </div>
  );
}
