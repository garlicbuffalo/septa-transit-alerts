import { useEffect, useMemo, useState } from 'react';
import { useDarkMode } from '../hooks/useDarkMode.js';
import { eventTrail } from '../lib/breadcrumbs.js';
import { getIncidentWithContext } from '../lib/incidentStore.js';
import {
  formatRoutesLabel,
  incidentLifecycle,
  incidentRecords,
  legacyKind,
} from '../lib/incidents.js';
import { SITE_NAME } from '../lib/site.js';
import { buildStationIndex } from '../lib/stations.js';
import Breadcrumb from './Breadcrumb.jsx';
import { EventDetail } from './event/EventDetail.jsx';
import EventNav from './event/EventNav.jsx';
import { describeText, incidentRoutes } from './event/incidentText.jsx';
import { CrossLineContext, RelatedIncidents } from './event/RelatedIncidents.jsx';
import Footer from './Footer.jsx';
import Header from './Header.jsx';
import NotFoundPage from './NotFoundPage.jsx';

export default function EventPage({ eventId }) {
  const [dark, toggleDark] = useDarkMode();
  // `result` is { incident, incidents } from the store: the resolved incident
  // plus a context set spanning its month ± the adjacent months and its lines'
  // all-time files — wide enough that prev/next nav and the ±24h/±1h callouts
  // stay correct across shard boundaries. `notFound` distinguishes "resolved to
  // nothing" from "still loading". Deep links resolve by canonical incident.id
  // or any of the incident's post rkeys (the index carries both).
  const [result, setResult] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState(null);

  // Initial resolve + 5-minute poll. Matches App.jsx's cadence so an event
  // page left open on an active incident updates its duration / "ongoing"
  // chip / resolution status without a reload. Only the initial load surfaces a
  // hard error — silent failures after that keep the existing data visible
  // rather than yanking the page out from under the reader.
  useEffect(() => {
    let cancelled = false;

    function fetchData() {
      getIncidentWithContext(eventId)
        .then((res) => {
          if (cancelled) return;
          setNotFound(!res);
          if (res) setResult(res);
        })
        .catch((err) => {
          if (cancelled) return;
          setResult((prev) => {
            if (!prev) setError(err);
            return prev;
          });
        });
    }

    fetchData();
    const id = setInterval(fetchData, 5 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [eventId]);

  const incident = result?.incident ?? null;
  const incidents = result?.incidents ?? null;

  // Flat { alerts, observations } view of the slice — the station index and
  // BrowseMenu (and, via EventDetail, the cohort stats) still read the flat
  // shape. The view itself renders the nested `incident` directly.
  const flat = useMemo(() => (incidents ? incidentRecords(incidents) : null), [incidents]);

  const stationIndex = useMemo(() => {
    if (!flat) return null;
    return buildStationIndex(flat.officialRecords, flat.detectionRecords, { windowDays: 90 });
  }, [flat]);

  // Set the tab title from the incident so bookmarks and shared links land in
  // browser history with something readable, not the generic site title.
  useEffect(() => {
    const base = SITE_NAME;
    if (!incident) {
      document.title = base;
      return;
    }
    // Prefix the tab title with the route label so a generic SEPTA headline
    // (e.g. "Temporary Reroute") doesn't lose the route context the rest of
    // the page makes obvious.
    const label = formatRoutesLabel(legacyKind(incident), incidentRoutes(incident));
    const desc = describeText(incident);
    document.title = `${label} · ${desc} · ${base}`;
    return () => {
      document.title = base;
    };
  }, [incident]);

  if (notFound) {
    return <NotFoundPage />;
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-gh-canvas flex flex-col">
      <Header
        generatedAt={null}
        dark={dark}
        onToggleDark={toggleDark}
        onResetFilters={() => {
          window.location.href = '/';
        }}
        alerts={flat?.alerts}
        observations={flat?.observations}
      />
      <main id="main" tabIndex={-1} className="max-w-3xl mx-auto px-4 py-6 w-full flex-1">
        <div className="mb-4">
          <Breadcrumb
            items={
              incident
                ? eventTrail(
                    incidentLifecycle(incident).first_seen_ts,
                    formatRoutesLabel(legacyKind(incident), incidentRoutes(incident)),
                  )
                : [{ label: 'Home', href: '/' }, { label: 'Incident' }]
            }
          />
        </div>

        {error && <p className="text-red-600 text-sm">Failed to load alert data.</p>}

        {!error && !result && (
          <div className="h-32 bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border animate-pulse" />
        )}

        {incident && (
          <>
            <EventDetail
              incident={incident}
              incidents={incidents}
              alerts={flat.officialRecords}
              observations={flat.detectionRecords}
              stationIndex={stationIndex}
              dark={dark}
            />
            <RelatedIncidents
              incident={incident}
              incidents={incidents}
              stationIndex={stationIndex}
            />
            <CrossLineContext
              incident={incident}
              incidents={incidents}
              stationIndex={stationIndex}
            />
            <EventNav incident={incident} incidents={incidents} />
          </>
        )}
      </main>
      <Footer />
    </div>
  );
}
