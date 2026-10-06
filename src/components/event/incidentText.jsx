import {
  botSummaryText,
  incidentHeadlineText,
  isRailPointSource,
  officialAlert,
  railPointEventTitle,
  splitObservations,
} from '../../lib/incidents.js';
import { displayStationName } from '../../lib/stations.js';
import StationName from '../StationName.jsx';

// Pull the routes/line out of an incident in a uniform shape. Alerts/merged
// records carry plural `routes`; standalone observations carry singular `line`.
export function incidentRoutes(incident) {
  if (Array.isArray(incident?.routes) && incident.routes.length > 0) return incident.routes;
  if (incident?.line) return [incident.line];
  return [];
}

// Plain-string variant of `describe` for places that can't render JSX —
// document.title, plain text logging, etc.
export function describeText(incident) {
  if (officialAlert(incident)) return incidentHeadlineText(incident);
  const { primary } = splitObservations(incident);
  // Regional Rail point event: prefer train-number titles when the exporter supplies the
  // run number; otherwise fall back to the pre-rendered bot sentence.
  const railTitle = railPointEventTitle(incident);
  if (railTitle) return railTitle;
  if (isRailPointSource(primary?.detection_source) && primary?.bot_description) {
    return primary.bot_description;
  }
  if (primary?.from_station && primary?.to_station) {
    const seg = `${displayStationName(primary.from_station)} → ${displayStationName(primary.to_station)}`;
    return primary.direction_label ? `${seg} (${primary.direction_label})` : seg;
  }
  // No stretch to name (bus routes, route-wide signals): the collector's
  // sentence ("~38 min between Route 17 buses …") says more than a summary.
  if (primary?.bot_description) return primary.bot_description;
  return botSummaryText(incident);
}

export function describe(incident, stationIndex) {
  if (officialAlert(incident)) return incidentHeadlineText(incident);
  const { primary } = splitObservations(incident);
  // Regional Rail point event: same title policy as describeText.
  const railTitle = railPointEventTitle(incident);
  if (railTitle) return railTitle;
  if (isRailPointSource(primary?.detection_source) && primary?.bot_description) {
    return primary.bot_description;
  }
  if (primary?.from_station && primary?.to_station) {
    return (
      <>
        <StationName name={primary.from_station} stationIndex={stationIndex} /> →{' '}
        <StationName name={primary.to_station} stationIndex={stationIndex} />
        {primary.direction_label && (
          <span className="ml-2 text-base font-normal text-slate-500 dark:text-slate-400">
            ({primary.direction_label})
          </span>
        )}
      </>
    );
  }
  if (primary?.bot_description) return primary.bot_description;
  return botSummaryText(incident);
}
