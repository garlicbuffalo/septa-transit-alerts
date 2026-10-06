// Reading, labeling, and filtering the published incident feed. Each incident
// already pairs an official SEPTA alert with any bot detections describing the
// same event (the collector does that once, upstream); this module turns the
// nested wire shape into the flat records and labels the views render.

import { BUS_ROUTE_NAMES, busRouteDisplayId, formatBusRoute } from './busRoutes.js';
import { phillyDayUTC } from './format.js';
import { METRO_LINES, metroLineFullName } from './metroLines.js';
import { RAIL_LINES, railLineInfo } from './railLines.js';

export function incidentMode(incident) {
  return incident?.mode ?? null;
}

// Display "kind" used throughout the views: 'metro' (SEPTA Metro rail
// transit), 'bus', or 'rail' (Regional Rail). Identical to the wire `mode`
// except Regional Rail, which publishes as 'regional_rail'.
export function legacyKind(incidentOrMode) {
  const mode = typeof incidentOrMode === 'string' ? incidentOrMode : incidentMode(incidentOrMode);
  if (mode === 'regional_rail') return 'rail';
  return mode;
}

// SEPTA runs two networks the site lets riders scope to separately — the same
// split as SEPTA's two GTFS feeds:
//   'transit' — SEPTA Metro (subway, El, trolleys, NHSL) plus buses
//   'rail'    — Regional Rail
// The All / Metro & Bus / Regional Rail control filters on this.
export const NETWORKS = ['transit', 'rail'];
export const NETWORK_LABELS = { transit: 'Metro & Bus', rail: 'Regional Rail' };

/**
 * @param {Incident | string} incidentOrKind An incident, or a kind ('metro' | 'bus' | 'rail').
 * @returns {'transit' | 'rail'}
 */
export function incidentNetwork(incidentOrKind) {
  const kind =
    typeof incidentOrKind === 'string' ? legacyKind(incidentOrKind) : legacyKind(incidentOrKind);
  return kind === 'rail' ? 'rail' : 'transit';
}

export function incidentLifecycle(incident) {
  return (
    incident?.lifecycle ?? {
      first_seen_ts: null,
      resolved_ts: null,
      active: false,
      duration_ms: null,
    }
  );
}

export function officialAlert(incident) {
  return incident?.official_alert ?? null;
}

export function officialAlerts(incident) {
  if (Array.isArray(incident?.official_alerts) && incident.official_alerts.length > 0) {
    return incident.official_alerts;
  }
  const one = officialAlert(incident);
  return one ? [one] : [];
}

export function incidentDetections(incident) {
  return incident?.detections ?? [];
}

function officialScope(alert) {
  if (!alert) return {};
  return alert.scope ?? {};
}

function officialLifecycle(alert) {
  if (!alert) return {};
  return alert.lifecycle ?? {};
}

function detectionScope(detection) {
  if (!detection) return {};
  return detection.scope ?? {};
}

function detectionLifecycle(detection) {
  if (!detection) return {};
  return detection.lifecycle ?? {};
}

function legacyDetection(incident, detection) {
  const scope = detectionScope(detection);
  const lifecycle = detectionLifecycle(detection);
  const evidence = detection.evidence ?? {};
  return {
    id: detection.id,
    kind: legacyKind(incident),
    line: scope.route ?? incident?.routes?.[0] ?? null,
    direction: scope.direction ?? null,
    direction_label: scope.direction_label ?? null,
    train_number: evidence.train_number ?? detection.train_number ?? null,
    from_station: scope.from_station ?? null,
    to_station: scope.to_station ?? null,
    stations: scope.stations ?? [],
    detection_source: detection.source ?? null,
    signals: evidence.signals ?? null,
    evidence: evidence.details ?? null,
    ts: lifecycle.first_seen_ts,
    onset_ts: lifecycle.onset_ts ?? null,
    resolved_ts: lifecycle.resolved_ts ?? null,
    duration_ms: lifecycle.duration_ms ?? null,
    active: lifecycle.active ?? false,
    post_url: detection.post_url ?? null,
    resolved_post_url: detection.resolved_post_url ?? null,
    bot_description: detection.description ?? null,
    bot_resolved_description: evidence.resolved_description ?? null,
    bot_evidence_bullets: evidence.bullets ?? [],
    onset_description: evidence.onset_description ?? null,
    bot_updates: evidence.updates ?? [],
    _incidentId: incident?.id,
  };
}

// Convert the published `incidents[]` wire shape into incident-derived records
// for the analytics helpers that still need row-level official-alert and
// detection inputs. This is not a v1 wire compatibility layer: records are
// derived from v2 incidents and stamped with `_incidentId`, so regrouping uses
// the producer's server-side pairing decision instead of fuzzy client matching.
/**
 * @param {Incident[]} incidents
 * @returns {{ officialRecords: Alert[], detectionRecords: Observation[] }}
 */
export function incidentRecords(incidents) {
  const officialRecords = [];
  const detectionRecords = [];
  for (const inc of incidents || []) {
    if (officialAlert(inc)) officialRecords.push(officialRecordFromIncident(inc));
    for (const o of incidentDetections(inc)) {
      detectionRecords.push(
        inc.detections ? legacyDetection(inc, o) : { ...o, _incidentId: inc.id },
      );
    }
  }
  return { officialRecords, detectionRecords };
}

// Reconstruct the flat Alert shape from an incident's nested `official_alert`
// block. The incident carries `kind`/`routes` at the top level and SEPTA's own
// lifecycle (first_seen_ts/resolved_ts/active) inside `official_alert`.
export function officialRecordFromIncident(inc) {
  const c = officialAlert(inc);
  const scope = officialScope(c);
  const lifecycle = officialLifecycle(c);
  const agencyWindow = c.agency_event_window ?? {};
  const alert = {
    alert_id: c.id ?? c.alert_id,
    kind: legacyKind(inc),
    routes: inc.routes,
    headline: incidentHeadlineText(inc) ?? c.headline,
    short_description: c.description ?? c.short_description ?? null,
    first_seen_ts: lifecycle.first_seen_ts,
    resolved_ts: lifecycle.resolved_ts ?? null,
    duration_ms: lifecycle.duration_ms ?? null,
    active: lifecycle.active,
    post_url: c.post_url,
    // SEPTA's page for the affected route — alerts have no permalinks of their own.
    source_url: c.source_url ?? null,
    resolved_reply_url: c.resolved_reply_url ?? null,
    affected_from_station: scope.from_station ?? null,
    affected_to_station: scope.to_station ?? null,
    affected_direction: scope.direction ?? null,
    mentioned_stations: scope.mentioned_stations ?? [],
    // Full station fill of the affected segment (endpoints + inner stops),
    // enumerated upstream. Lets buildStationIndex tie the inner stations to
    // the incident, not just the two named endpoints.
    affected_stations: scope.stations ?? [],
    agency_event_start_ts: agencyWindow.start_ts ?? null,
    agency_event_end_ts: agencyWindow.end_ts ?? null,
    agency_event_start_is_date_only: agencyWindow.start_is_date_only ?? false,
    agency_event_end_is_date_only: agencyWindow.end_is_date_only ?? false,
    // Schedule-anchored single-train Regional Rail cancellation (null
    // otherwise). Top-level on the incident, not under `official_alert`.
    cancellation:
      inc.status?.type === 'cancellation'
        ? {
            state: inc.status.state ?? null,
            scheduled_departure_ts: inc.status.scheduled_departure_ts ?? null,
            scheduled_arrival_ts: inc.status.scheduled_arrival_ts ?? null,
            train_number: inc.status.train_number ?? null,
            origin: inc.status.origin ?? null,
          }
        : null,
    _incidentId: inc.id,
  };
  // Build the update timeline across EVERY official alert on the incident.
  // Incidents can carry several official alerts (official_alerts[]) when the
  // producer groups related entities into one event; fold each member's
  // versions into one chronological list so the timeline shows the whole chain,
  // not just the primary. A member without in-place edits contributes a single
  // synthesized entry. Original version fields are preserved (station/direction
  // data the timeline renders); `short_description` is normalized for fallback.
  const versions = [];
  for (const member of officialAlerts(inc)) {
    const memberLifecycle = officialLifecycle(member);
    const memberVersions =
      Array.isArray(member.versions) && member.versions.length > 0
        ? member.versions
        : [
            {
              ts: memberLifecycle.first_seen_ts,
              headline: member.headline ?? null,
              short_description: member.short_description ?? member.description ?? null,
            },
          ];
    for (const v of memberVersions) {
      versions.push({
        ...v,
        ts: v.ts ?? memberLifecycle.first_seen_ts,
        short_description: v.short_description ?? v.description ?? null,
      });
    }
  }
  if (versions.length > 1) alert.versions = versions;
  return alert;
}

/**
 * Top-level payload of the published incident files (`alerts-recent.json`, the
 * monthly shards, and the per-line files), produced by collector/.
 *
 * @typedef {object} AlertsPayload
 * @property {2} schema_version
 * @property {number} generated_at Epoch ms when the snapshot was produced.
 * @property {number} data_start_ts Earliest moment we have coverage for.
 * @property {Incident[]} incidents
 */

/**
 * One real-world disruption as published on the wire.
 *
 * @typedef {object} Incident
 * @property {string} id Stable permalink id ('alert-136615', 'delay-2026-10-05-3556').
 * @property {'septa'} agency
 * @property {'metro' | 'bus' | 'regional_rail'} mode
 * @property {string[]} routes Lowercase Metro keys ('l1'), bus route ids ('17'), or
 *   lowercase Regional Rail keys ('pao').
 * @property {Lifecycle} lifecycle Incident-level lifecycle across all sources.
 * @property {Array<'septa' | 'bot'>} sources Which observers contributed.
 * @property {OfficialAlert | null} official_alert SEPTA alert, or null.
 * @property {Detection[]} detections Bot detections, or [].
 * @property {RailStatus | null} status Regional Rail cancellation/delay status, or null.
 */

/** @typedef {{first_seen_ts:number|null,onset_ts?:number|null,resolved_ts:number|null,active:boolean,duration_ms:number|null}} Lifecycle */

/**
 * @typedef {object} OfficialAlert
 * @property {string} id SEPTA's alert id ('136615', 'D17471').
 * @property {string} headline
 * @property {string | null} description
 * @property {string | null} [post_url] Social post republishing the alert, when one exists.
 * @property {string | null} [source_url] SEPTA's page for the affected route.
 * @property {string | null} [resolved_reply_url]
 * @property {Lifecycle} lifecycle
 * @property {Scope} scope
 * @property {{start_ts:number|null,end_ts:number|null,start_is_date_only:boolean,end_is_date_only:boolean}} agency_event_window
 * @property {{type:string|null,cause:string|null,effect:string|null,severity:string|null}} [septa]
 *   SEPTA's own classification (type ADVISORY/ALERT/DETOUR; GTFS-rt cause/effect/severity).
 * @property {object[]} [versions]
 */

/**
 * @typedef {object} Scope
 * @property {string | null} [route]
 * @property {string | null} from_station
 * @property {string | null} to_station
 * @property {string[]} stations
 * @property {string | null} direction
 * @property {string | null} [direction_label]
 * @property {string[]} [mentioned_stations]
 */

/**
 * @typedef {object} Detection
 * @property {number | string} id
 * @property {string} source
 * @property {Scope} scope
 * @property {Lifecycle} lifecycle
 * @property {string | null} [post_url]
 * @property {string | null} [resolved_post_url]
 * @property {string | null} description
 * @property {{signals:string[]|null,details:object|null,bullets:string[],onset_description:string|null,train_number:string|null,resolved_description:string|null}} evidence
 */

/**
 * @typedef {object} RailStatus
 * @property {string} type
 * @property {string} [state]
 * @property {string | null} [train_number]
 * @property {number | null} [scheduled_departure_ts]
 * @property {number | null} [scheduled_arrival_ts]
 * @property {string | null} [origin]
 * @property {number | null} [delay_min]
 * @property {number | null} [deadline_ts]
 */

// User-visible signal categories for SEPTA Metro and bus detections — the
// chips and stacked-bar segments. Order is the display order. An observation's
// detection_source is one of these (or 'roundup', in which case the precise
// signal kinds live in `signals`). The collector doesn't emit Metro/bus
// detections yet; the vocabulary is kept so those detectors can slot in.
export const SIGNAL_TYPES = ['gap', 'bunching', 'ghost', 'pulse-cold', 'pulse-held', 'thin-gap'];

// Source categories for the filter chip. Each incident falls into exactly
// one bucket after `groupIncidentRecords` runs:
//   'official' — official SEPTA alert with no matching bot detection
//   'bot'      — bot detection with no matching official alert
//   'merged'   — official alert and bot detection that paired up
// Order is the display order in the popover; keep it official → bot → merged
// so the "they agreed" row sits at the end as the strongest signal.
export const SOURCE_TYPES = ['official', 'bot', 'merged'];
export const SOURCE_LABELS = {
  official: 'SEPTA reported',
  bot: 'Bot observation',
  merged: 'Both',
};

// Friendly labels for every signal kind.
export const SIGNAL_LABELS = {
  gap: 'headway gaps',
  bunching: 'bunching',
  ghost: 'missing vehicles',
  'pulse-cold': 'stretch without trains',
  'pulse-held': 'trains held in place',
  // thin-gap fires when a low-frequency bus route has zero observations for a
  // full headway-derived window — the route effectively stopped running. It
  // covers the 47 routes outside the curated gap/ghost lists, which have no
  // other detector coverage.
  'thin-gap': 'low-frequency route silent',
  // Regional Rail detection_source values. Cancellation is the commuter-rail
  // analog of a ghost; delay is the analog of a gap. 'cancellation-inferred' is
  // a scheduled train the bot never saw run, that SEPTA didn't flag (hedged).
  cancellation: 'cancelled trains',
  'cancellation-inferred': 'trains not seen running',
  delay: 'late trains',
};

// Rider-facing impact phrase for each signal kind — the plain-language outcome a
// rider feels, not the detector's name. `vehicles` is 'trains' or 'buses' so the
// phrase reads right for either mode. Used to build scannable incident titles
// (see summarizeSignals); SIGNAL_LABELS stays the detector-noun form for chips.
const SIGNAL_IMPACT = {
  gap: () => 'long gaps',
  bunching: (v) => `bunched ${v}`,
  ghost: (v) => `fewer ${v}`,
  'pulse-cold': (v) => `stretch without ${v}`,
  'pulse-held': (v) => `${v} held in place`,
  'thin-gap': () => 'route not running',
  cancellation: () => 'cancelled trains',
  'cancellation-inferred': (v) => `${v} not seen running`,
  delay: () => 'late trains',
};

// Turn a detection's signal mix into a single plain-language title, e.g.
// "Fewer trains and long gaps". Joined as a natural list ("X and Y", "X, Y, and
// Z") rather than a jargon list ("Multiple signals: missing vehicles, headway
// gaps, …") — and rather than truncating to "+N more", which hid what was
// happening. A roundup carries at most ~3 distinct signals in practice, so the
// full list stays short. Returns null when there are no signals. `kind` is
// 'bus' | 'metro' (defaults to trains).
/**
 * @param {string[]} signals
 * @param {string} [kind]
 * @returns {string | null}
 */
export function summarizeSignals(signals, kind) {
  const uniq = [...new Set(signals || [])];
  if (uniq.length === 0) return null;
  const v = kind === 'bus' ? 'buses' : 'trains';
  const phrases = uniq.map((s) =>
    SIGNAL_IMPACT[s] ? SIGNAL_IMPACT[s](v) : (SIGNAL_LABELS[s] ?? s),
  );
  let text;
  if (phrases.length === 1) text = phrases[0];
  else if (phrases.length === 2) text = `${phrases[0]} and ${phrases[1]}`;
  else text = `${phrases.slice(0, -1).join(', ')}, and ${phrases[phrases.length - 1]}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Compact human-readable summary of the bot's evidence for this observation
// — surfaced as a small chip on incident rows so a reader can see *why* the
// bot fired without opening the full post. Returns null when there's
// nothing material to render (alerts, missing evidence payload, roundups —
// the signal mix is already shown via the description text).
/**
 * @param {object} incident An Alert, Observation, or MergedIncident.
 * @returns {string | null}
 */
export function formatEvidenceChip(incident) {
  if (!incident) return null;
  // Cancellation surge (roundup): give canceled-trips events the same scannable
  // subtitle that cold/ghost detections get. The rider-facing count ("8 of 14
  // scheduled trips canceled this past hour") is pre-rendered into the roundup's
  // bullet list upstream and isn't reconstructable from evidence.details (which
  // only carries the signal mix), so reuse that bullet verbatim. Fires for any
  // roundup whose signal mix includes a cancellation surge.
  if (Array.isArray(incident.signals) && incident.signals.includes('cancellation')) {
    const bullet = (incident.bot_evidence_bullets || []).find(
      (b) => typeof b === 'string' && /scheduled trips? canceled/i.test(b),
    );
    if (bullet) return bullet;
  }
  const ev = incident.evidence;
  if (!ev || typeof ev !== 'object') return null;
  // Train pulse evidence has the canonical fields. The held subtree exists
  // when the candidate was a held-cluster (or inferred-held from cold).
  if (ev.held && typeof ev.held === 'object' && ev.held.trainCount != null) {
    const min = ev.held.stationaryMs ? Math.round(ev.held.stationaryMs / 60000) : null;
    const noun = incident.kind === 'bus' ? 'buses' : 'trains';
    const single = noun === 'buses' ? 'bus' : 'train';
    const countLabel = `${ev.held.trainCount} ${ev.held.trainCount === 1 ? single : noun} held`;
    return min != null ? `${countLabel} · ${min} min stationary` : countLabel;
  }
  // Bus held shape (no nested .held — fields live at the top level).
  if (ev.kind === 'held' && ev.busCount != null) {
    const min = ev.stationaryMs ? Math.round(ev.stationaryMs / 60000) : null;
    const countLabel = `${ev.busCount} ${ev.busCount === 1 ? 'bus' : 'buses'} held`;
    return min != null ? `${countLabel} · ${min} min stationary` : countLabel;
  }
  // Train cold evidence.
  if (ev.coldStations != null || ev.expectedTrains != null) {
    const parts = [];
    if (ev.coldStations) {
      parts.push(
        `${ev.coldStations} ${ev.coldStations === 1 ? 'station' : 'stations'} without trains`,
      );
    }
    if (ev.expectedTrains) {
      parts.push(`${ev.expectedTrains} ${ev.expectedTrains === 1 ? 'train' : 'trains'} missed`);
    } else if (ev.minutesSinceLastTrain) {
      parts.push(`${ev.minutesSinceLastTrain} min since last train`);
    }
    return parts.length > 0 ? parts.join(' · ') : null;
  }
  // Thin-gap evidence: low-frequency route with zero observations across the
  // headway-derived window.
  if (ev.windowMin != null && ev.headwayMin != null && ev.missedTrips != null) {
    const win = Math.round(ev.windowMin);
    const hw = Math.round(ev.headwayMin);
    return `no buses in ${win} min · scheduled every ~${hw} min`;
  }
  // Bus blackout shape.
  if (ev.kind === 'cold' && ev.lookbackMin != null) {
    const parts = [`no buses in ${ev.lookbackMin} min`];
    if (ev.expectedActive && ev.expectedActive >= 1) {
      parts.push(`${Math.round(ev.expectedActive)} expected`);
    }
    return parts.join(' · ');
  }
  return null;
}

// Returns the set of signal kinds this observation represents. Roundup
// observations carry an explicit `signals` array; single-signal observations
// expose their kind via `detection_source`. Alerts have no signals.
/**
 * @param {Observation} obs
 * @returns {string[]}
 */
export function observationSignals(obs) {
  if (!obs) return [];
  if (obs.detection_source === 'roundup') return obs.signals || [];
  return obs.detection_source ? [obs.detection_source] : [];
}

// Plain-text title for a bot incident that has no single affected stretch (the
// station-pair case is handled by the callers, which may render it as links).
// Summarizes the signal mix as rider-facing impact ("Fewer trains and long
// gaps"); falls back to a generic line only when there are no signals at all.
/**
 * @param {Incident} incident
 * @returns {string}
 */
export function botSummaryText(incident) {
  const { primary } = splitObservations(incident);
  const summary = summarizeSignals(observationSignals(primary), legacyKind(incident));
  if (summary) return summary;
  if (primary?.detection_source === 'roundup') return 'Multiple simultaneous disruptions detected';
  return 'Service disruption detected';
}

// Regional Rail bot-detected point events — one scheduled train that ran late,
// was cancelled, or was never seen running. These are recorded
// website-data-first (no per-train social post), so they arrive as bot-only
// incidents with the rider-facing sentence pre-rendered in `bot_description`
// (e.g. "~22 min late — the 6:31 PM Wawa to Doylestown train (#3556)").
// Without intervention the row shows only the station pair, which reads like a
// route; so we lead with the sentence and stamp a short status badge per kind.
const RAIL_POINT_SOURCES = new Set(['delay', 'cancellation', 'cancellation-inferred']);

/**
 * True when `source` is one of the Regional Rail point-event detection kinds.
 * @param {string | null | undefined} source
 */
export function isRailPointSource(source) {
  return source != null && RAIL_POINT_SOURCES.has(source);
}

/**
 * Normalize a Regional Rail point-event incident for display, or null when the
 * incident isn't one. Skips incidents that carry an official alert — those
 * render from the alert headline. `lede` is the pre-rendered sentence to lead
 * the row/title with; null when the bot shipped none (callers fall back to the
 * station pair, with the badge still marking the kind).
 * @param {Incident} incident
 * @returns {{ source: string, lede: string | null, fromStation: string | null, toStation: string | null, directionLabel: string | null } | null}
 */
export function railPointEvent(incident) {
  if (!incident || officialAlert(incident)) return null;
  const { primary } = splitObservations(incident);
  if (!primary || !isRailPointSource(primary.detection_source)) return null;
  return {
    source: primary.detection_source,
    lede: primary.bot_description ?? null,
    fromStation: primary.from_station ?? null,
    toStation: primary.to_station ?? null,
    directionLabel: primary.direction_label ?? null,
  };
}

export function railPointEventTitle(incident) {
  if (!incident || officialAlert(incident) || legacyKind(incident) !== 'rail') return null;
  const { primary } = splitObservations(incident);
  if (!primary || !isRailPointSource(primary.detection_source)) return null;
  const trainNumber = primary.train_number == null ? null : String(primary.train_number).trim();
  if (!trainNumber) return null;
  const routes =
    Array.isArray(incident.routes) && incident.routes.length > 0
      ? incident.routes
      : primary.line
        ? [primary.line]
        : [];
  const line = formatRoutesLabel('rail', routes);
  const status =
    primary.detection_source === 'cancellation-inferred'
      ? 'possibly cancelled'
      : railPointEventLabel(primary.detection_source);
  if (!line || !status) return null;
  return `${line} train #${trainNumber} ${status}`;
}

// SEPTA classifies each alert's cause; scheduled maintenance and construction
// advisories are planned work even when their text doesn't say so ("Potential
// Delays due to Amtrak Infrastructure Project", "Outbound Platform Boarding").
const PLANNED_SEPTA_CAUSES = new Set(['MAINTENANCE', 'CONSTRUCTION']);
function isSeptaPlannedAdvisory(alert) {
  return alert?.septa?.type === 'ADVISORY' && PLANNED_SEPTA_CAUSES.has(alert.septa.cause);
}

function officialRailStatusSource(incident) {
  const alert = officialAlert(incident);
  if (legacyKind(incident) !== 'rail' || !alert) return null;
  // Backward-compatible display fallback for already-published data that predates
  // Keep the text fallback conservative; the backend remains the source of truth
  // for schedule anchors and train numbers.
  const text = [alert.headline, alert.description].filter(Boolean).join(' \n ');
  const isPlannedDelay =
    (isSeptaPlannedAdvisory(alert) ||
      /\b(track\s+construction|construction|planned\s+work|work\s+zone|maintenance)\b/i.test(
        text,
      )) &&
    /\bdelay(?:ed|s)?\b|\b\d{1,3}\s*(?:\+|\s*or\s+more)?\s*minutes?\s+(?:late|behind|delay)/i.test(
      text,
    );

  const exported = incident.status?.type;
  if (exported === 'planned-delay' || (exported === 'delay' && isPlannedDelay)) {
    return 'planned-delay';
  }
  if (isRailPointSource(exported)) return exported;
  if (incident.status?.type === 'cancellation') return 'cancellation';

  if (/\bwill\s+not\s+operate\b|\bcancell?ed\b|\bannull?ed\b|\bnot\s+running\b/i.test(text)) {
    return 'cancellation';
  }
  if (isPlannedDelay) return 'planned-delay';
  if (
    /\bdelay(?:ed|s)?\b|\b\d{1,3}\s*(?:\+|\s*or\s+more)?\s*minutes?\s+(?:late|behind|delay)/i.test(
      text,
    )
  ) {
    return 'delay';
  }
  return null;
}

/**
 * Badge-level Regional Rail incident status. Bot point events use their
 * observation source; official Regional Rail alerts use the exported status
 * classification when present, with a conservative text fallback.
 * @param {Incident} incident
 * @returns {{source:string}|null}
 */
export function railIncidentStatus(incident) {
  const official = officialRailStatusSource(incident);
  if (official) return { source: official };
  const point = railPointEvent(incident);
  return point ? { source: point.source } : null;
}

const PLANNED_TEXT_RE =
  /\b(track\s+construction|construction|planned\s+work|work\s+zone|maintenance|temporary\s+reroute|reroute)\b/i;

/**
 * True when an active incident is planned/scheduled work — a published-ahead
 * notice (track construction, maintenance) or a multi-day scheduled disruption
 * (a temporary reroute with a fixed end date) — rather than something unfolding
 * in real time. These get lifted into the homepage's "Planned & scheduled"
 * section, where the date window, not an elapsed timer, is the headline fact.
 * @param {Incident} incident
 * @param {number} now
 * @returns {boolean}
 */
export function isPlannedIncident(incident, now = Date.now()) {
  if (railIncidentStatus(incident)?.source === 'planned-delay') return true;
  const alert = officialAlert(incident);
  if (!alert) return false;
  if (isSeptaPlannedAdvisory(alert)) return true;
  const w = alert.agency_event_window ?? {};
  // Advance notice: the scheduled work hasn't started yet.
  if (w.start_ts != null && w.start_ts > now) return true;
  // A scheduled multi-day window posted as a date range (date-only end) —
  // reroutes and construction carry these; live point disruptions don't.
  if (w.end_ts != null && w.end_is_date_only === true) return true;
  const text = [alert.headline, alert.description].filter(Boolean).join(' ');
  return PLANNED_TEXT_RE.test(text);
}

/**
 * Three-way bucket for the homepage's active list:
 *   'planned'    — scheduled / advance-notice work (see {@link isPlannedIncident})
 *   'delay'      — a routine in-progress delay (a single Regional Rail train running late)
 *   'disruption' — everything else live (gaps, ghosts, cancellations, and
 *                  reroutes without a fixed window)
 * @param {Incident} incident
 * @param {number} now
 * @returns {'planned'|'delay'|'disruption'}
 */
export function incidentCategory(incident, now = Date.now()) {
  if (isPlannedIncident(incident, now)) return 'planned';
  if (railIncidentStatus(incident)?.source === 'delay') return 'delay';
  return 'disruption';
}

// Short status-badge label for each Regional Rail point-event kind.
// 'cancellation-inferred' reads "possible cancellation" — the train was
// scheduled but never seen and SEPTA didn't flag it, so the outcome is stated while signalling it's
// unconfirmed. Returns null for unknown kinds.
/**
 * @param {string} source
 * @returns {string | null}
 */
export function railPointEventLabel(source) {
  switch (source) {
    case 'delay':
      return 'delayed';
    case 'planned-delay':
      return 'planned work';
    case 'cancellation':
      return 'cancelled';
    case 'cancellation-inferred':
      return 'possible cancellation';
    default:
      return null;
  }
}

function naturalList(items) {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function collectRailTrainNumbers(incident) {
  const alert = officialAlert(incident);
  if (legacyKind(incident) !== 'rail' || !alert) return [];
  const out = [];
  const push = (n) => {
    const s = n == null ? null : String(n).trim();
    if (s && !out.includes(s)) out.push(s);
  };
  const scanText = (text) => {
    if (!text) return;
    for (const m of String(text).matchAll(/\btrain\s+#?(\d{1,4})\b/gi)) push(m[1]);
    for (const m of String(text).matchAll(/\b[A-Z]{2,5}\s*#(\d{1,4})\b/g)) push(m[1]);
  };
  scanText(alert.headline);
  scanText(alert.description);
  for (const v of alert.versions || []) {
    scanText(v.headline);
    scanText(v.short_description);
  }
  for (const o of incidentDetections(incident)) push(o.evidence?.train_number);
  return out.sort((a, b) => Number(a) - Number(b));
}

function railMultiTrainHeadline(incident) {
  const nums = collectRailTrainNumbers(incident);
  if (nums.length === 0) return null;
  const { primary, extras } = splitObservations(incident);
  const sources = new Set([primary, ...extras].filter(Boolean).map((o) => o.detection_source));
  if (isRailPointSource(incident.status?.type)) sources.add(incident.status.type);
  const official = officialRailStatusSource(incident);
  if (isRailPointSource(official)) sources.add(official);
  let status = 'affected';
  if (incident.status?.type === 'cancellation' && incident.status.state === 'cancelled') {
    status = 'cancelled';
  } else if (sources.size > 0 && [...sources].every((s) => s === 'delay')) status = 'delayed';
  else if (sources.size > 0 && [...sources].every((s) => s === 'cancellation'))
    status = 'cancelled';
  else if (sources.size > 0 && [...sources].every((s) => s === 'cancellation-inferred')) {
    status = 'possibly cancelled';
  }
  // Without a delay/cancellation to report, SEPTA's own headline ("Outbound
  // Platform Boarding, Train #207, …") says more than "train #207 affected".
  if (status === 'affected') return null;
  const line = formatRoutesLabel('rail', incident.routes || []);
  const trainWord = nums.length === 1 ? 'train' : 'trains';
  return `${line} ${trainWord} ${naturalList(nums.map((n) => `#${n}`))} ${status}`;
}

function stableOfficialHeadline(incident) {
  const alert = officialAlert(incident);
  const versions = alert?.versions;
  const first = Array.isArray(versions) ? versions.find((v) => v?.headline)?.headline : null;
  return first || alert?.headline || '';
}

export function incidentHeadlineText(incident) {
  if (!incident) return '';
  if (officialAlert(incident)) {
    return railMultiTrainHeadline(incident) ?? stableOfficialHeadline(incident);
  }
  return null;
}

// The per-line affected stretches for an incident, as `{ line, from, to }`
// segments. A multi-line incident (a Center City alert that merged several
// detections) carries one segment per merged observation, each on its OWN line
// — the multi-line event map uses these to highlight each line's real stretch
// instead of drawing one arbitrary line. `line` is null for an alert-level
// segment ("between 30th St and 15th St" with no single owning line); the
// renderer then highlights it on every drawn line serving both endpoints.
/**
 * @param {Incident} incident
 * @returns {Array<{ line: string | null, from: string | null, to: string | null }>}
 */
export function affectedLineSegments(incident) {
  if (!incident) return [];
  const out = [];
  const push = (line, from, to) => {
    if (!from && !to) return;
    out.push({ line: line ?? null, from: from ?? null, to: to ?? null });
  };
  const alert = officialAlert(incident);
  const scope = officialScope(alert);
  const { primary, extras } = splitObservations(incident);
  if (alert && primary) {
    // Merged: the primary observation's stretch, then the extras that rode
    // along, then the alert's own (line-agnostic) segment endpoints.
    push(primary.line ?? null, primary.from_station, primary.to_station);
    for (const e of extras) push(e.line ?? null, e.from_station, e.to_station);
    push(null, scope.from_station, scope.to_station);
  } else if (alert) {
    // Official alert only: the alert-level segment, applied across its routes.
    push(null, scope.from_station, scope.to_station);
  } else if (primary) {
    // Bot-only: the observation's own stretch.
    push(primary.line ?? null, primary.from_station, primary.to_station);
  }
  return out;
}

// Extract the rkey at the end of a Bluesky post URL — the part after `/post/`.
// Used as the canonical event id for shareable links. Returns null for missing
// or malformed URLs so callers can decide whether to render the share control.
/**
 * @param {string | null | undefined} postUrl
 * @returns {string | null}
 */
export function postUrlRkey(postUrl) {
  if (!postUrl) return null;
  const m = /\/post\/([^/?#]+)/.exec(postUrl);
  return m ? m[1] : null;
}

// The official source for an incident's alert block. Every official alert on
// this site is SEPTA's own; `kind` is accepted so callers needn't special-case.
/**
 * @param {'metro'|'bus'|'rail'} [_kind]
 * @returns {string}
 */
export function agencyLabel(_kind) {
  return 'SEPTA';
}

// Network + mode label for grouping the active list — "SEPTA Metro", "Bus",
// or "Regional Rail".
/**
 * @param {'metro'|'bus'|'rail'} kind
 * @returns {string}
 */
export function modeLabel(kind) {
  if (kind === 'rail') return 'Regional Rail';
  if (kind === 'bus') return 'Bus';
  if (kind === 'metro') return 'SEPTA Metro';
  return 'SEPTA';
}

// Format a multi-route/multi-line label for display. A single line reads in
// full ("L1 Market-Frankford Line", "Paoli/Thorndale Line", "Route 17");
// multi-route labels collapse to codes ("B1, B2, and B3", "Routes 17 and 33")
// so they stay short enough for headings and OG cards. 4+ routes wrap as
// `first two + N more` or `N Metro lines`.
/**
 * @param {'metro'|'bus'|'rail'} kind
 * @param {string[]} routes
 * @returns {string}
 */
export function formatRoutesLabel(kind, routes) {
  if (!routes || routes.length === 0) return kind === 'bus' ? 'this route' : 'this line';
  if (kind === 'metro') {
    if (routes.length === 1) return metroLineFullName(routes[0]);
    const labels = routes.map((r) => METRO_LINES[r]?.label ?? r);
    if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
    if (labels.length === 3) return `${labels[0]}, ${labels[1]}, and ${labels[2]}`;
    return `${labels.length} Metro lines`;
  }
  if (kind === 'rail') {
    const labels = routes.map((r) => railLineInfo(r)?.label ?? r);
    if (labels.length === 1) return `${labels[0]} Line`;
    if (labels.length === 2) return `${labels[0]} and ${labels[1]} Lines`;
    if (labels.length === 3) return `${labels[0]}, ${labels[1]}, and ${labels[2]} Lines`;
    return `${labels.length} Regional Rail lines`;
  }
  // bus
  if (routes.length === 1) return formatBusRoute(routes[0]);
  const ids = routes.map((r) => busRouteDisplayId(r));
  if (ids.length === 2) return `Routes ${ids[0]} and ${ids[1]}`;
  if (ids.length === 3) return `Routes ${ids[0]}, ${ids[1]}, and ${ids[2]}`;
  return `Routes ${ids.slice(0, 2).join(', ')} + ${ids.length - 2} more`;
}

// Find an incident by its shareable event id. The id is the top-level
// `incident.id` (collector-assigned, e.g. 'alert-136615'), but should an
// incident ever be republished to a social account, a link copied from any of
// its posts still resolves: we also match the official post rkey and every
// observation's post rkey. Returns the nested incident the view renders.
/**
 * @param {Incident[]} incidents
 * @param {string} id
 * @returns {Incident | null}
 */
export function findIncidentById(incidents, id) {
  if (!id) return null;
  for (const inc of incidents || []) {
    if (inc.id === id) return inc;
    if (officialAlerts(inc).some((alert) => postUrlRkey(alert.post_url) === id)) return inc;
    if (incidentDetections(inc).some((o) => postUrlRkey(o.post_url) === id)) return inc;
  }
  return null;
}

// Find incidents on the same line(s) within ±windowMs of the given incident,
// excluding the incident itself. Used by the event detail page to show
// surrounding context — was this disruption isolated, or part of a cluster of
// problems on the same line?
/**
 * @param {Incident} incident
 * @param {Incident[]} incidents
 * @param {number} [windowMs] Time window before/after; defaults to 24h.
 * @returns {Incident[]} Sorted newest-first, excluding self.
 */
export function findRelatedIncidents(incident, incidents, windowMs = 24 * 60 * 60 * 1000) {
  if (!incident) return [];
  const routes = new Set(incident.routes || []);
  if (routes.size === 0) return [];
  const kind = legacyKind(incident);
  const ts = incidentLifecycle(incident).first_seen_ts;
  if (ts == null) return [];
  const lo = ts - windowMs;
  const hi = ts + windowMs;

  const out = [];
  for (const other of incidents || []) {
    if (other.id === incident.id) continue;
    if (legacyKind(other) !== kind) continue;
    if (!(other.routes || []).some((r) => routes.has(r))) continue;
    const t = incidentLifecycle(other).first_seen_ts;
    if (t == null || t < lo || t > hi) continue;
    out.push(other);
  }

  out.sort((a, b) => incidentLifecycle(b).first_seen_ts - incidentLifecycle(a).first_seen_ts);
  return out;
}

// Find incidents whose start time falls within ±windowMs of the given event
// AND which affect a DIFFERENT line/route. Used by the event detail page to
// answer "was this part of a system-wide problem at the same moment?" — a
// signal-boost when a power outage, weather event, or letout simultaneously
// hits multiple lines. Returns sorted newest-first, deduped on event id.
//
// Bus and train cross-pollinate intentionally: a Red Line meltdown can spawn
// shuttle-bus reroutes on the same hour, and surfacing that pairing helps the
// reader piece the picture together. Each row carries its own `kind` so the
// caller can render an appropriate line/route pill.
/**
 * @param {Incident} incident
 * @param {Incident[]} incidents
 * @param {number} [windowMs] Time window before/after; defaults to 1h.
 * @returns {Incident[]}
 */
export function findContemporaneousOnOtherLines(incident, incidents, windowMs = 60 * 60 * 1000) {
  if (!incident) return [];
  const selfRoutes = new Set(incident.routes || []);
  const selfKind = legacyKind(incident);
  const ts = incidentLifecycle(incident).first_seen_ts;
  if (ts == null) return [];
  const lo = ts - windowMs;
  const hi = ts + windowMs;

  // Same kind + a shared route means it's the same line — RelatedIncidents
  // already covers that, so it's excluded here. Cross-kind (train vs bus) is
  // always "different" because the route key spaces are disjoint.
  const overlapsSelfRoutes = (other) =>
    legacyKind(other) === selfKind && (other.routes || []).some((r) => selfRoutes.has(r));

  const out = [];
  for (const other of incidents || []) {
    if (other.id === incident.id) continue;
    const t = incidentLifecycle(other).first_seen_ts;
    if (t == null || t < lo || t > hi) continue;
    if (overlapsSelfRoutes(other)) continue;
    out.push(other);
  }

  out.sort((a, b) => incidentLifecycle(b).first_seen_ts - incidentLifecycle(a).first_seen_ts);
  return out;
}

// Group incident-derived official/detection records into the merged /
// standalone buckets the analytics layer (aggregate.js) and a couple of
// components still consume. The fuzzy alert↔observation pairing is NOT done
// here — it happens upstream in the collector and is baked into each record's
// `_incidentId` by `incidentRecords`. This just groups by that id, so an
// official alert and the bot detections that share its incident reassemble into
// one merged record. (The view layer reads the nested `incidents[]` directly and
// never calls this.)
//
// Returns:
//   merged           — combined alert+observation records (built shape below)
//   standaloneAlerts — alerts whose incident had no observation (or whose obs
//                      were filtered away upstream)
//   standaloneObs    — observations whose incident's alert was filtered away,
//                      or bot-only incidents
//
// Records lacking `_incidentId` (e.g. hand-built in tests, or any object that
// didn't pass through `incidentRecords`) fall back to a per-record id so
// they never accidentally group together.
/**
 * @param {Alert[]} alerts
 * @param {Observation[]} observations
 * @returns {{ merged: MergedIncident[], standaloneAlerts: Alert[], standaloneObs: Observation[] }}
 */
export function groupIncidentRecords(alerts, observations) {
  const groups = new Map();
  const order = [];
  const groupFor = (id) => {
    let g = groups.get(id);
    if (!g) {
      g = { alert: null, obs: [] };
      groups.set(id, g);
      order.push(id);
    }
    return g;
  };
  // Records that never passed through incidentRecords (e.g. hand-built in
  // tests) have no _incidentId; give each a unique key so they never group.
  for (const a of alerts || []) groupFor(a._incidentId ?? Symbol('alert')).alert = a;
  for (const o of observations || []) groupFor(o._incidentId ?? Symbol('obs')).obs.push(o);

  const merged = [];
  const standaloneAlerts = [];
  const standaloneObs = [];
  for (const id of order) {
    const { alert, obs } = groups.get(id);
    if (alert && obs.length > 0) merged.push(buildMergedRecord(alert, obs));
    else if (alert) standaloneAlerts.push(alert);
    else standaloneObs.push(collapseStandaloneObs(obs));
  }
  return { merged, standaloneAlerts, standaloneObs };
}

// Build the legacy display record that older analytics/components render from
// an official alert and its grouped detections.
function buildMergedRecord(alert, obsList) {
  // Primary obs = closest in time to the alert (most likely the detection that
  // caught the same onset SEPTA published). The single-obs fields (obs_post_url,
  // from_station, …) reflect this primary; the rest ride along on extra_obs.
  const matches = [...obsList].sort(
    (a, b) => Math.abs(a.ts - alert.first_seen_ts) - Math.abs(b.ts - alert.first_seen_ts),
  );
  const primary = matches[0];
  const extras = matches.slice(1);
  // While the incident is active, a paired obs's prior resolution doesn't end
  // the incident — surfacing it would produce a "last seen" before "first seen"
  // and a misleading "Bot resolution" link. Suppress resolution-side fields
  // until the alert resolves.
  const active = alert.active || matches.some((o) => o.active);
  return {
    _type: 'merged',
    _sortTs: alert.first_seen_ts,
    _incidentId: alert._incidentId,
    alert_id: alert.alert_id,
    kind: alert.kind,
    routes: alert.routes,
    headline: alert.headline,
    short_description: alert.short_description ?? null,
    first_seen_ts: alert.first_seen_ts,
    resolved_ts: active ? null : (alert.resolved_ts ?? primary.resolved_ts ?? null),
    active,
    post_url: alert.post_url,
    source_url: alert.source_url ?? null,
    resolved_reply_url: alert.resolved_reply_url,
    affected_from_station: alert.affected_from_station,
    affected_to_station: alert.affected_to_station,
    affected_direction: alert.affected_direction,
    mentioned_stations: alert.mentioned_stations ?? [],
    // Only present when SEPTA edited the alert text (>1 version on the wire).
    versions: alert.versions,
    // SEPTA's claimed event window, so EventPage can compare their stated end to
    // the actual resolve timestamp.
    agency_event_start_ts: alert.agency_event_start_ts ?? null,
    agency_event_end_ts: alert.agency_event_end_ts ?? null,
    agency_event_start_is_date_only: alert.agency_event_start_is_date_only === true,
    agency_event_end_is_date_only: alert.agency_event_end_is_date_only === true,
    from_station: primary.from_station,
    to_station: primary.to_station,
    obs_post_url: primary.post_url,
    obs_resolved_post_url: active ? null : primary.resolved_post_url,
    // The bot's resolved_ts requires sustained recovery before firing; comparing
    // it to the alert's resolved_ts (when both resolved) gives the
    // service-stabilization delta. Null while active to avoid the hazard above.
    obs_resolved_ts: active ? null : (primary.resolved_ts ?? null),
    obs_ts: primary.ts,
    obs_id: primary.id,
    obs_line: primary.line,
    obs_detection_source: primary.detection_source,
    obs_signals: primary.signals,
    extra_obs: extras.map((e) => ({
      id: e.id,
      post_url: e.post_url,
      resolved_post_url: active ? null : e.resolved_post_url,
      ts: e.ts,
      resolved_ts: active ? null : (e.resolved_ts ?? null),
      detection_source: e.detection_source,
      signals: e.signals,
      from_station: e.from_station,
      to_station: e.to_station,
      line: e.line,
    })),
  };
}

// Collapse a bot-only incident's detections (same _incidentId, no official
// alert) into ONE standalone record, so the count/merge surfaces in aggregate.js
// treat the incident as a single event — matching the incidents[] list. Without
// this a roundup carrying e.g. a ghost + a gap would be counted as two incidents.
// Detection-level surfaces (SignalBreakdown) read detectionRecords directly and
// still see every detection; only the grouped/merged path collapses.
//
// The representative is the earliest detection (the incident onset), carrying
// incident-level lifecycle: active if any detection is still active, and the
// latest resolution once they've all cleared.
function collapseStandaloneObs(obsList) {
  if (obsList.length <= 1) return obsList[0];
  const sorted = [...obsList].sort((a, b) => a.ts - b.ts);
  const primary = sorted[0];
  const active = sorted.some((o) => o.active);
  const resolved_ts = active ? null : Math.max(...sorted.map((o) => o.resolved_ts ?? o.ts));
  return { ...primary, active, resolved_ts };
}

// Split a nested incident's observations into a primary and the rest. The
// primary is the detection closest in time to the official alert (so the rendered
// "from → to" / detection link matches what older merged records showed), or
// the sole/first observation for a bot-only incident.
/**
 * @param {Incident} incident
 * @returns {{ primary: Observation | null, extras: Observation[] }}
 */
export function splitObservations(incident) {
  const obs = incidentDetections(incident).map((d) => legacyDetection(incident, d));
  if (obs.length === 0) return { primary: null, extras: [] };
  const alert = officialAlert(incident);
  if (alert) {
    const anchor = alert.lifecycle?.first_seen_ts ?? incidentLifecycle(incident).first_seen_ts;
    const sorted = [...obs].sort((a, b) => Math.abs(a.ts - anchor) - Math.abs(b.ts - anchor));
    return { primary: sorted[0], extras: sorted.slice(1) };
  }
  return { primary: obs[0], extras: obs.slice(1) };
}

// Which source bucket an incident falls in: 'merged' (official alert + bot),
// 'official' (SEPTA alert with no bot detection), or 'bot' (bot-only). Drives
// the source filter.
/**
 * @param {Incident} incident
 * @returns {'official' | 'bot' | 'merged'}
 */
export function incidentSource(incident) {
  if (!officialAlert(incident)) return 'bot';
  return incidentDetections(incident).length > 0 ? 'merged' : 'official';
}

// Build the per-incident text matcher used by both `filterIncidents` and
// `searchFilterIncidents`. Returned as `{ hasSearch, matchesIncident }`; when
// the query is blank `matchesIncident` returns true so direct callers get a
// uniform signature.
//
// Match scope mirrors what users expect from the search box:
//   - SEPTA headline, affected stations/direction
//   - observation segment endpoints, direction
//   - route/line keys *and* their human labels ("L1", "Market-Frankford",
//     pre-rebrand names like "MFL" or "Route 101", "Paoli/Thorndale",
//     "Route 17", bus-route long names, signal-type labels). Without label
//     matching, "Broad Street" wouldn't match key `b1`, and "headway gaps"
//     wouldn't match observations carrying `signals: ['gap']`.
/**
 * @param {string} query
 * @returns {{ hasSearch: boolean, matchesIncident: (incident: Incident) => boolean }}
 */
export function buildSearchMatchers(query) {
  const q = (query || '').trim().toLowerCase();
  const hasSearch = q.length > 0;
  if (!hasSearch) {
    return { hasSearch, matchesIncident: () => true };
  }
  const matchesLine = (key, kind) => {
    if (key == null) return false;
    const haystack = [String(key).toLowerCase()];
    if (kind === 'metro') {
      const info = METRO_LINES[key];
      if (info) {
        haystack.push(info.label.toLowerCase(), info.name.toLowerCase());
        for (const old of info.formerly || []) haystack.push(old.toLowerCase());
      }
    } else if (kind === 'rail') {
      const info = RAIL_LINES[key];
      if (info) haystack.push(info.label.toLowerCase(), `${info.label.toLowerCase()} line`);
    } else if (kind === 'bus') {
      const lowerId = busRouteDisplayId(key).toLowerCase();
      haystack.push(`route ${lowerId}`, `#${lowerId}`);
      const name = BUS_ROUTE_NAMES[key];
      if (name) haystack.push(name.toLowerCase());
    }
    return haystack.some((s) => s.includes(q));
  };
  const matchesIncident = (inc) => {
    // Route/line keys and their labels are carried at the incident top level.
    const kind = legacyKind(inc);
    if ((inc.routes || []).some((r) => matchesLine(r, kind))) return true;
    const c = officialAlert(inc);
    const scope = officialScope(c);
    if (c) {
      const fields = [
        incidentHeadlineText(inc),
        c.headline,
        c.description,
        scope.from_station,
        scope.to_station,
        scope.direction,
      ].filter(Boolean);
      if (fields.some((s) => s.toLowerCase().includes(q))) return true;
    }
    const { primary, extras } = splitObservations(inc);
    for (const o of [primary, ...extras].filter(Boolean)) {
      const fields = [o.from_station, o.to_station, o.direction].filter((v) => v != null);
      if (fields.some((v) => String(v).toLowerCase().includes(q))) return true;
      for (const sig of observationSignals(o)) {
        if (sig.toLowerCase().includes(q)) return true;
        const label = SIGNAL_LABELS[sig];
        if (label?.toLowerCase().includes(q)) return true;
      }
    }
    return false;
  };
  return { hasSearch, matchesIncident };
}

// Search-only filter: subset incidents to those whose searchable fields contain
// `query`. Inputs are expected to already be scoped to the caller's view
// (LinePage, StationPage); this just narrows by free text and uses the same
// matcher as `filterIncidents` so the search box behaves identically everywhere.
/**
 * @param {Incident[]} incidents
 * @param {string} query
 * @returns {Incident[]}
 */
export function searchFilterIncidents(incidents, query) {
  const { hasSearch, matchesIncident } = buildSearchMatchers(query);
  if (!hasSearch) return incidents;
  return incidents.filter(matchesIncident);
}

// Filter incidents by selected Metro lines, bus toggle, Regional Rail lines,
// signal kinds, source bucket, network, free-text search, and a start
// timestamp / pinned day. Active incidents bypass the timestamp filter so they
// always appear. Bus incidents are controlled independently of the Metro line
// filter — selecting L1 doesn't hide bus incidents when showBus=true.
/**
 * @param {Incident[]} incidents
 * @param {object} [options]
 * @param {string[] | null} [options.lines]    null = all Metro lines. Empty array = no Metro lines.
 * @param {number | null} [options.startTs]    Drop incidents older than this (active ones bypass).
 * @param {boolean} [options.showBus]
 * @param {string[] | null} [options.busRoutes] When non-empty, restrict bus incidents to these routes.
 * @param {string[] | null} [options.railLines] When non-empty, restrict Regional Rail incidents to these lines.
 * @param {number | null} [options.selectedDay] Philadelphia-day UTC midnight; when set, only incidents
 *   whose [start, end] span overlaps this day pass. Overrides startTs.
 * @param {string[] | null} [options.signals]  When non-empty, keep only incidents with an
 *   observation carrying one of these signal kinds. Official-only incidents (no observations) drop.
 * @param {string[] | null} [options.sources]  When shorter than SOURCE_TYPES, keep only incidents
 *   whose source bucket (official/bot/merged) is selected.
 * @param {string[] | null} [options.networks] When it names one network ('transit' | 'rail'),
 *   keep only that network's incidents.
 * @param {string} [options.search] Free-text search across alert + observation fields.
 * @param {number} [options.now]               For selectedDay span calc; defaults to Date.now().
 * @returns {Incident[]}
 */
export function filterIncidents(
  incidents,
  {
    lines,
    startTs,
    showBus = true,
    busRoutes = null,
    railLines = null,
    selectedDay = null,
    signals = null,
    sources = null,
    search = '',
    networks = null,
    now = Date.now(),
  } = {},
) {
  const hasLineFilter = lines !== null && lines !== undefined;
  const hasBusRouteFilter = busRoutes && busRoutes.length > 0;
  const hasRailLineFilter = railLines && railLines.length > 0;
  const hasSignalFilter = signals && signals.length > 0;
  const signalSet = hasSignalFilter ? new Set(signals) : null;
  const hasSourceFilter = sources && sources.length < SOURCE_TYPES.length;
  const sourceSet = hasSourceFilter ? new Set(sources) : null;
  // Network = 'rail' for Regional Rail, else 'transit' (Metro + bus).
  const hasNetworkFilter = networks && networks.length > 0 && networks.length < NETWORKS.length;
  const networkSet = hasNetworkFilter ? new Set(networks) : null;
  const { hasSearch, matchesIncident } = buildSearchMatchers(search);

  // When selectedDay is pinned, an incident matches iff its [start, end] span
  // overlaps that calendar day. Active incidents (no resolved_ts) extend to
  // `now`, so a still-open disruption shows up on every day from its start
  // through today.
  const overlapsSelectedDay = (start, end) => {
    if (selectedDay == null) return true;
    const s = phillyDayUTC(start);
    const e = phillyDayUTC(end || now);
    return selectedDay >= s && selectedDay <= e;
  };

  return (incidents || []).filter((inc) => {
    const kind = legacyKind(inc);
    const lifecycle = incidentLifecycle(inc);
    const network = incidentNetwork(kind);
    if (networkSet && !networkSet.has(network)) return false;
    // The Metro line/bus filters apply only to transit incidents — an L1
    // selection shouldn't hide Regional Rail. Regional Rail has its own line
    // filter; the network control governs cross-network visibility.
    if (network === 'transit') {
      if (kind === 'bus') {
        if (!showBus) return false;
        if (hasBusRouteFilter && !(inc.routes || []).some((r) => busRoutes.includes(r))) {
          return false;
        }
      } else if (hasLineFilter && !(inc.routes || []).some((r) => lines.includes(r))) {
        return false;
      }
    } else if (hasRailLineFilter && !(inc.routes || []).some((r) => railLines.includes(r))) {
      // network === 'rail'
      return false;
    }
    // Signal filter keeps an incident when any of its observations carries a
    // matching kind. Official-only incidents have no observations, so they drop —
    // the same "bot-detected only" intent as before, applied atomically (an
    // official+bot incident with a matching detection stays whole rather than being
    // demoted to its bot half).
    if (hasSignalFilter) {
      const { primary, extras } = splitObservations(inc);
      const obs = [primary, ...extras].filter(Boolean);
      if (!obs.some((o) => observationSignals(o).some((s) => signalSet.has(s)))) return false;
    }
    if (hasSourceFilter && !sourceSet.has(incidentSource(inc))) return false;
    if (hasSearch && !matchesIncident(inc)) return false;
    if (selectedDay != null) {
      return overlapsSelectedDay(lifecycle.first_seen_ts, lifecycle.resolved_ts);
    }
    if (startTs && lifecycle.first_seen_ts < startTs && !lifecycle.active) return false;
    return true;
  });
}
