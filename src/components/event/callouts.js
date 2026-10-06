// Pure derivations behind EventDetail's metadata callouts. Split out of the
// JSX so the fiddly time-bucketing math (… min / …h …m / …d …h ahead,
// early/late, the various skip thresholds) is unit-testable in isolation.

import { incidentLifecycle, legacyKind } from '../../lib/incidents.js';

const MIN = 60_000;

// "5 min", "1h 30m", or "2h" from a positive millisecond span. Used for the
// bot-lead callout; agencyPlanned/agencyEstimate have their own suffixes.
export function formatLeadTime(ms) {
  const min = Math.round(ms / MIN);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

// How far the earliest bot observation predates SEPTA's alert post — surfaced so
// the page doesn't read as if SEPTA detected first. Only for merged SEPTA+bot
// incidents; skipped under 2 min (SEPTA effectively kept pace). Returns
// `{ phrase, onsetTs }` or null.
export function computeBotLead({ isMerged, agencyFirstSeenTs, observations }) {
  if (!isMerged || agencyFirstSeenTs == null) return null;
  const earliestOnset = (observations || []).reduce(
    (min, o) => Math.min(min, o.onset_ts ?? o.ts),
    Number.POSITIVE_INFINITY,
  );
  if (!Number.isFinite(earliestOnset)) return null;
  const leadMs = agencyFirstSeenTs - earliestOnset;
  if (leadMs < 2 * MIN) return null;
  return { phrase: formatLeadTime(leadMs), onsetTs: earliestOnset };
}

// SEPTA-planned-ahead callout: an EventStart that predates our first sighting by
// 10 min–14 days marks a planned event rather than a live reactive post.
// Returns the "…ahead" phrase or null (gap too small, too large, or unknown).
export function computeAgencyPlanned({ agencyStartTs, startTs }) {
  if (agencyStartTs == null || startTs == null) return null;
  const aheadMs = startTs - agencyStartTs;
  const TEN_MIN = 10 * MIN;
  const FOURTEEN_DAYS = 14 * 24 * 60 * MIN;
  if (aheadMs < TEN_MIN || aheadMs > FOURTEEN_DAYS) return null;
  const aheadMin = Math.round(aheadMs / MIN);
  if (aheadMin < 60) return `${aheadMin} min ahead`;
  if (aheadMin < 24 * 60) {
    const h = Math.floor(aheadMin / 60);
    const m = aheadMin % 60;
    return m > 0 ? `${h}h ${m}m ahead` : `${h}h ahead`;
  }
  const d = Math.floor(aheadMin / (24 * 60));
  const hours = Math.round((aheadMin - d * 24 * 60) / 60);
  return hours > 0 ? `${d}d ${hours}h ahead` : `${d}d ahead`;
}

// Retrospective comparison of actual resolution vs SEPTA's stated EventEnd.
// Returns `{ sameMinute, phrase }` or null. Skipped for date-only EventEnd (no
// minute precision to compare) and when the two are more than a week apart (a
// stale estimate from a multi-day planned alert isn't a useful comparison).
export function computeAgencyEstimate({ agencyEndTs, resolvedTs, dateOnly }) {
  if (agencyEndTs == null || resolvedTs == null || dateOnly) return null;
  const deltaMs = resolvedTs - agencyEndTs;
  const WEEK_MS = 7 * 24 * 60 * MIN;
  if (Math.abs(deltaMs) > WEEK_MS) return null;
  const absMin = Math.round(Math.abs(deltaMs) / MIN);
  const sameMinute = absMin === 0;
  const earlyLate = deltaMs > 0 ? 'late' : 'early';
  const minPhrase =
    absMin < 60
      ? `${absMin} min`
      : `${Math.floor(absMin / 60)}h${absMin % 60 ? ` ${absMin % 60}m` : ''}`;
  return {
    sameMinute,
    phrase: sameMinute ? 'cleared right on schedule' : `${minPhrase} ${earlyLate}`,
  };
}

// Chronological neighbors of an incident for the prev/next footer nav.
// Sorts by first_seen_ts (ties broken by id so the order is stable), finds
// the subject, and returns the incident immediately before/after it. With
// `sameRouteOnly`, the walk is restricted to incidents of the same kind that
// share at least one route — so "next on the L1" skips unrelated
// lines. Returns `{ prev, next }`, either of which may be null at an end.
export function findIncidentNeighbors(incident, incidents, { sameRouteOnly = false } = {}) {
  if (!incident || !Array.isArray(incidents)) return { prev: null, next: null };
  const routeSet = sameRouteOnly ? new Set(incident.routes || []) : null;
  const incidentKind = legacyKind(incident);
  const pool = incidents.filter((inc) => {
    if (sameRouteOnly) {
      if (legacyKind(inc) !== incidentKind) return false;
      if (!(inc.routes || []).some((r) => routeSet.has(r))) return false;
    }
    return incidentLifecycle(inc).first_seen_ts != null;
  });
  pool.sort(
    (a, b) =>
      incidentLifecycle(a).first_seen_ts - incidentLifecycle(b).first_seen_ts ||
      String(a.id).localeCompare(String(b.id)),
  );
  const idx = pool.findIndex((inc) => inc.id === incident.id);
  if (idx < 0) return { prev: null, next: null };
  return {
    prev: idx > 0 ? pool[idx - 1] : null,
    next: idx < pool.length - 1 ? pool[idx + 1] : null,
  };
}

// Plain-text one-incident summary for the "Copy summary" button — something
// you can paste into a chat or thread without the recipient needing to open
// the page. Takes pre-formatted strings (the component owns date/duration
// formatting) so this stays a pure string assembler. Shape:
//   <Line>: <headline>
//   <date> · ongoing | lasted <duration>
//   <url>
export function buildEventSummaryText({
  description,
  lineLabel,
  dateText,
  durationText,
  active,
  url,
}) {
  const lines = [];
  lines.push(lineLabel ? `${lineLabel}: ${description}` : description);
  const meta = [];
  if (dateText) meta.push(dateText);
  if (active) meta.push('ongoing');
  else if (durationText) meta.push(`lasted ${durationText}`);
  if (meta.length > 0) lines.push(meta.join(' · '));
  if (url) lines.push(url);
  return lines.join('\n');
}
