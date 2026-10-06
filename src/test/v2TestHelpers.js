export const DEFAULT_NOW = 1_000_000_000_000;

export const modeForKind = (kind) => (kind === 'rail' ? 'commuter_rail' : kind);
export const agencyForKind = (kind) => (kind === 'rail' ? 'rail' : 'cta');

export function lifecycle({
  first_seen_ts = null,
  ts = null,
  onset_ts = null,
  resolved_ts = null,
  active = false,
  duration_ms = null,
} = {}) {
  return {
    first_seen_ts: first_seen_ts ?? ts,
    onset_ts,
    resolved_ts,
    active,
    duration_ms,
  };
}

export function detectionFromObs(
  obs = {},
  { kind: _kind = 'metro', routes = ['red'], now = DEFAULT_NOW } = {},
) {
  return {
    id: obs.id ?? 1,
    source: obs.detection_source ?? obs.source ?? 'gap',
    scope: {
      route: obs.line ?? obs.route ?? routes[0] ?? null,
      direction: obs.direction ?? null,
      direction_label: obs.direction_label ?? null,
      from_station: obs.from_station ?? null,
      to_station: obs.to_station ?? null,
      stations: obs.stations ?? [],
    },
    lifecycle: lifecycle({
      first_seen_ts: obs.first_seen_ts ?? obs.ts ?? now,
      onset_ts: obs.onset_ts ?? null,
      resolved_ts: obs.resolved_ts ?? null,
      active: obs.active ?? false,
      duration_ms: obs.duration_ms ?? null,
    }),
    post_url: obs.post_url ?? null,
    resolved_post_url: obs.resolved_post_url ?? null,
    description: obs.bot_description ?? obs.description ?? null,
    evidence: {
      signals: obs.signals ?? null,
      details: obs.evidence ?? null,
      bullets: obs.bot_evidence_bullets ?? [],
      onset_description: obs.onset_description ?? null,
      train_number: obs.train_number ?? null,
      resolved_description: obs.bot_resolved_description ?? null,
    },
  };
}

export function officialAlertFromAgency(
  cta = {},
  {
    id = 'alert1',
    first_seen_ts = DEFAULT_NOW,
    resolved_ts = null,
    active = false,
    duration_ms = null,
  } = {},
) {
  return {
    id: cta.alert_id ?? cta.id ?? id,
    headline: cta.headline ?? 'Red Line Delays',
    description: cta.short_description ?? cta.description ?? null,
    post_url: cta.post_url ?? null,
    resolved_reply_url: cta.resolved_reply_url ?? null,
    lifecycle: lifecycle({
      first_seen_ts: cta.first_seen_ts ?? first_seen_ts,
      resolved_ts: cta.resolved_ts ?? resolved_ts,
      active: cta.active ?? active,
      duration_ms: cta.duration_ms ?? duration_ms,
    }),
    scope: {
      from_station: cta.affected_from_station ?? cta.from_station ?? null,
      to_station: cta.affected_to_station ?? cta.to_station ?? null,
      stations: cta.affected_stations ?? cta.stations ?? [],
      mentioned_stations: cta.mentioned_stations ?? [],
      direction: cta.affected_direction ?? cta.direction ?? null,
    },
    agency_event_window: {
      start_ts: cta.agency_event_start_ts ?? cta.agency_event_window?.start_ts ?? null,
      end_ts: cta.agency_event_end_ts ?? cta.agency_event_window?.end_ts ?? null,
      start_is_date_only:
        cta.agency_event_start_is_date_only ?? cta.agency_event_window?.start_is_date_only ?? false,
      end_is_date_only:
        cta.agency_event_end_is_date_only ?? cta.agency_event_window?.end_is_date_only ?? false,
    },
    versions: cta.versions,
  };
}

export function incident(over = {}) {
  const {
    kind = 'metro',
    agency = agencyForKind(kind),
    mode = modeForKind(kind),
    routes = ['red'],
    first_seen_ts = DEFAULT_NOW,
    resolved_ts = null,
    active = false,
    duration_ms = null,
    cta,
    official_alert,
    official_alerts,
    observations,
    detections,
    rail_status,
    cancellation,
    status,
    sources,
    ...rest
  } = over;
  const hasOfficial = official_alert !== undefined || cta !== null;
  const builtOfficial =
    official_alert ??
    (hasOfficial
      ? officialAlertFromAgency(cta ?? {}, {
          id: over.id ?? 'alert1',
          first_seen_ts,
          resolved_ts,
          active,
          duration_ms,
        })
      : null);
  const builtDetections =
    detections ??
    (observations ?? []).map((o) => detectionFromObs(o, { kind, routes, now: first_seen_ts }));
  const builtStatus =
    status ??
    (cancellation ? { type: 'cancellation', ...cancellation } : null) ??
    (rail_status ? { type: rail_status.source, ...rail_status } : null);
  return {
    id: over.id ?? 'inc1',
    agency,
    mode,
    routes,
    lifecycle: lifecycle({ first_seen_ts, resolved_ts, active, duration_ms }),
    sources:
      sources ??
      [builtOfficial ? agency : null, builtDetections.length > 0 ? 'bot' : null].filter(Boolean),
    official_alert: builtOfficial,
    ...(official_alerts ? { official_alerts } : {}),
    detections: builtDetections,
    status: builtStatus,
    ...rest,
  };
}
