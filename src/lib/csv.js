// CSV row construction shared by the postbuild full-dataset export
// (`scripts/generate-csv.js`) and the in-browser "Download filtered CSV"
// button (`IncidentList`). Mirrors the published incident-file concepts.

import { incidentDetections, incidentLifecycle, incidentMode, officialAlert } from './incidents.js';

export const CSV_COLUMNS = [
  'record_type',
  'incident_id',
  'agency',
  'mode',
  'routes',
  'source',
  'status_type',
  'headline',
  'description',
  'from_station',
  'to_station',
  'stations',
  'direction',
  'direction_label',
  'first_seen_ts',
  'onset_ts',
  'resolved_ts',
  'duration_minutes',
  'active',
  'post_url',
  'resolved_post_url',
  'source_url',
];

export function csvEscape(value) {
  if (value == null) return '';
  const s = String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}

function isoOrEmpty(ms) {
  if (ms == null) return '';
  return new Date(ms).toISOString();
}

function durationMinutes(lifecycle) {
  if (!lifecycle) return '';
  if (lifecycle.duration_ms != null) return Math.round(lifecycle.duration_ms / 60_000);
  if (lifecycle.resolved_ts != null && lifecycle.first_seen_ts != null) {
    return Math.round(
      (lifecycle.resolved_ts - (lifecycle.onset_ts ?? lifecycle.first_seen_ts)) / 60_000,
    );
  }
  return '';
}

function officialRow(incident, alert) {
  const scope = alert.scope ?? {};
  const lifecycle = alert.lifecycle ?? incidentLifecycle(null);
  return {
    record_type: 'official_alert',
    incident_id: incident.id,
    agency: incident.agency ?? 'septa',
    mode: incidentMode(incident),
    routes: (incident.routes ?? []).join(';'),
    source: 'official',
    status_type: incident.status?.type ?? '',
    headline: alert.headline ?? '',
    description: alert.description ?? alert.short_description ?? '',
    from_station: scope.from_station ?? '',
    to_station: scope.to_station ?? '',
    stations: (scope.stations?.length ? scope.stations : (scope.mentioned_stations ?? [])).join(
      ';',
    ),
    direction: scope.direction ?? '',
    direction_label: '',
    first_seen_ts: isoOrEmpty(lifecycle.first_seen_ts),
    onset_ts: '',
    resolved_ts: isoOrEmpty(lifecycle.resolved_ts),
    duration_minutes: durationMinutes(lifecycle),
    active: lifecycle.active ? 'true' : 'false',
    post_url: alert.post_url ?? '',
    resolved_post_url: alert.resolved_reply_url ?? '',
    source_url: alert.source_url ?? '',
  };
}

function detectionRow(incident, detection) {
  const scope = detection.scope ?? {};
  const lifecycle = detection.lifecycle ?? {};
  return {
    record_type: 'detection',
    incident_id: incident.id,
    agency: incident.agency ?? 'septa',
    mode: incidentMode(incident),
    routes: (incident.routes ?? []).join(';'),
    source: detection.source ?? '',
    status_type: incident.status?.type ?? '',
    headline: '',
    description: detection.description ?? '',
    from_station: scope.from_station ?? '',
    to_station: scope.to_station ?? '',
    stations: (scope.stations ?? []).join(';'),
    direction: scope.direction ?? '',
    direction_label: scope.direction_label ?? '',
    first_seen_ts: isoOrEmpty(lifecycle.first_seen_ts),
    onset_ts: isoOrEmpty(lifecycle.onset_ts),
    resolved_ts: isoOrEmpty(lifecycle.resolved_ts),
    duration_minutes: durationMinutes(lifecycle),
    active: lifecycle.active ? 'true' : 'false',
    post_url: detection.post_url ?? '',
    resolved_post_url: detection.resolved_post_url ?? '',
    source_url: '',
  };
}

function rowToCsv(row) {
  return CSV_COLUMNS.map((c) => csvEscape(row[c])).join(',');
}

export function buildCsv(incidents) {
  const rows = [];
  for (const incident of incidents ?? []) {
    const alert = officialAlert(incident);
    if (alert) rows.push(officialRow(incident, alert));
    for (const detection of incidentDetections(incident))
      rows.push(detectionRow(incident, detection));
  }
  rows.sort((a, b) =>
    b.first_seen_ts < a.first_seen_ts ? -1 : b.first_seen_ts > a.first_seen_ts ? 1 : 0,
  );
  return `${[CSV_COLUMNS.join(','), ...rows.map(rowToCsv)].join('\n')}\n`;
}
