import { dataUrl } from './dataSource.js';
import { normalizeMetroLine } from './metroLines.js';
import { normalizeRailLine } from './railLines.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

// Elevator outages are published per station, on one of the two station
// networks: SEPTA Metro ('metro') or Regional Rail ('rail'). The wire record
// carries the network as `mode` ('metro' | 'regional_rail'); views key on the
// short kind, which also picks the station URL namespace.
export const OUTAGE_KINDS = ['metro', 'rail'];

/** 'metro' | 'rail' for an outage record. */
export function outageKind(outage) {
  return outage?.mode === 'regional_rail' ? 'rail' : 'metro';
}

export async function fetchAccessibilityData() {
  try {
    const res = await fetch(dataUrl('accessibility.json'), { cache: 'no-store' });
    if (res.ok) return res.json();
  } catch {
    // The accessibility feed may not exist on the data origin before the
    // collector's first run. Fall through to the bundled empty payload.
  }

  const fallback = await fetch('/data/accessibility.json', { cache: 'no-store' });
  if (!fallback.ok) throw new Error(`HTTP ${fallback.status}`);
  return fallback.json();
}

export function stationHref(outageOrRow) {
  const kind = outageOrRow?.kind ?? outageKind(outageOrRow);
  const slug = outageOrRow?.station?.slug ?? outageOrRow?.slug;
  if (!slug) return null;
  return kind === 'rail' ? `/rail/station/${slug}` : `/station/${slug}`;
}

export function outageDuration(outage, now = Date.now()) {
  const start = outage?.lifecycle?.first_seen_ts;
  if (start == null) return 0;
  const end = outage.lifecycle.restored_ts ?? (outage.lifecycle.active ? now : null);
  return end == null ? 0 : Math.max(0, end - start);
}

export function stationLabel(outage) {
  return outage?.station?.name || 'Unmatched station';
}

export function kindLabel(kind) {
  return kind === 'rail' ? 'Regional Rail' : 'SEPTA Metro';
}

export function normalizeOutageLine(kind, line) {
  if (kind === 'rail') return normalizeRailLine(line);
  if (kind === 'metro') return normalizeMetroLine(line);
  return line;
}

export function outageHasLine(outage, line) {
  if (!line) return true;
  const kind = outageKind(outage);
  const want = normalizeOutageLine(kind, line);
  return (outage?.station?.lines || []).some((raw) => normalizeOutageLine(kind, raw) === want);
}

export function currentlyOut(outages = [], { now = Date.now(), kind = null, line = null } = {}) {
  return outages
    .filter((o) => o.lifecycle?.active)
    .filter((o) => !kind || outageKind(o) === kind)
    .filter((o) => outageHasLine(o, line))
    .map((o) => ({ ...o, durationMs: outageDuration(o, now) }))
    .sort(
      (a, b) =>
        b.durationMs - a.durationMs ||
        outageKind(a).localeCompare(outageKind(b)) ||
        stationLabel(a).localeCompare(stationLabel(b)),
    );
}

export function summarizeOutages(outages = []) {
  const stations = new Set();
  let metro = 0;
  let rail = 0;
  for (const o of outages) {
    stations.add(`${outageKind(o)}:${o.station?.slug || stationLabel(o)}`);
    if (outageKind(o) === 'rail') rail += 1;
    else metro += 1;
  }
  return { total: outages.length, stations: stations.size, metro, rail };
}

// Collapses active outages into one group per station so a stop with several
// out-of-service units (e.g. two elevators) reads as a single card. Stations
// keep the order of their first outage in the input, so a list pre-sorted by
// duration surfaces the longest-out station first. A station belongs to several
// lines, so we group by station rather than line to avoid an arbitrary
// primary-line pick or duplicating one outage across line sections.
export function groupOutagesByStation(outages = []) {
  const groups = new Map();
  for (const o of outages) {
    const kind = outageKind(o);
    const key = `${kind}:${o.station?.slug || stationLabel(o)}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        kind,
        name: stationLabel(o),
        slug: o.station?.slug ?? null,
        lines: o.station?.lines || [],
        outages: [],
      });
    }
    groups.get(key).outages.push(o);
  }
  return [...groups.values()];
}

export function outagesForStation(outages = [], { kind, slug, now = Date.now(), limit = 8 } = {}) {
  if (!kind || !slug) return [];
  return outages
    .filter((o) => outageKind(o) === kind && o.station?.slug === slug)
    .map((o) => ({ ...o, durationMs: outageDuration(o, now) }))
    .sort((a, b) => {
      if (a.lifecycle?.active !== b.lifecycle?.active) return a.lifecycle?.active ? -1 : 1;
      return (b.lifecycle?.first_seen_ts || 0) - (a.lifecycle?.first_seen_ts || 0);
    })
    .slice(0, limit);
}

export function outagesForLine(outages = [], { kind, line, now = Date.now(), limit = 8 } = {}) {
  if (!kind || !line) return [];
  return outages
    .filter((o) => outageKind(o) === kind)
    .filter((o) => outageHasLine(o, line))
    .map((o) => ({ ...o, durationMs: outageDuration(o, now) }))
    .sort((a, b) => {
      if (a.lifecycle?.active !== b.lifecycle?.active) return a.lifecycle?.active ? -1 : 1;
      return (b.lifecycle?.first_seen_ts || 0) - (a.lifecycle?.first_seen_ts || 0);
    })
    .slice(0, limit);
}

export function stationReliability(
  outages = [],
  { now = Date.now(), windowDays = 90, kind = null, line = null } = {},
) {
  const cutoff = now - windowDays * DAY_MS;
  const byStation = new Map();
  for (const outage of outages) {
    const outKind = outageKind(outage);
    if (kind && outKind !== kind) continue;
    if (!outageHasLine(outage, line)) continue;
    const start = outage.lifecycle?.first_seen_ts;
    if (start == null) continue;
    const restored = outage.lifecycle?.restored_ts ?? (outage.lifecycle?.active ? now : null);
    if (restored != null && restored < cutoff) continue;
    const key = `${outKind}:${outage.station?.slug || stationLabel(outage)}`;
    if (!byStation.has(key)) {
      byStation.set(key, {
        kind: outKind,
        slug: outage.station?.slug ?? null,
        name: stationLabel(outage),
        lines: outage.station?.lines || [],
        outageCount: 0,
        totalDownMs: 0,
        currentlyOut: 0,
        weeklyDownMs: Array.from({ length: Math.ceil(windowDays / 7) }, () => 0),
      });
    }
    const rec = byStation.get(key);
    const boundedStart = Math.max(start, cutoff);
    const boundedEnd = Math.max(boundedStart, restored ?? now);
    rec.outageCount += 1;
    rec.totalDownMs += Math.max(0, boundedEnd - boundedStart);
    if (outage.lifecycle?.active) rec.currentlyOut += 1;
    addWeeklyDurations(rec.weeklyDownMs, boundedStart, boundedEnd, cutoff);
  }
  return [...byStation.values()].sort(
    (a, b) =>
      b.currentlyOut - a.currentlyOut ||
      b.totalDownMs - a.totalDownMs ||
      b.outageCount - a.outageCount ||
      a.kind.localeCompare(b.kind) ||
      a.name.localeCompare(b.name),
  );
}

function addWeeklyDurations(buckets, start, end, cutoff) {
  let cursor = start;
  while (cursor < end) {
    const idx = Math.min(buckets.length - 1, Math.max(0, Math.floor((cursor - cutoff) / WEEK_MS)));
    const next = Math.min(end, cutoff + (idx + 1) * WEEK_MS);
    buckets[idx] += Math.max(0, next - cursor);
    cursor = next;
  }
}

// --- Elevator reliability -------------------------------------------------------
// SEPTA's feed lists only the elevators that are out, so an elevator is known
// here once it has been out at least once. Its uptime is over the part of the
// window the archive covers; an elevator that has never appeared has, as far as
// the archive can tell, been up throughout.

const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/**
 * Each elevator's record over the window: how many times it went out, how long
 * it was down in all, its uptime (the share of the covered window it wasn't
 * down), its longest outage, and how long a repair usually took (the median of
 * its finished outages). Most outages first, then most downtime.
 * @param {object[]} outages
 * @param {{ now?: number, windowDays?: number, dataStartTs?: number | null,
 *   kind?: 'metro' | 'rail' | null, line?: string | null }} [opts]
 */
export function elevatorReliability(
  outages = [],
  { now = Date.now(), windowDays = 90, dataStartTs = null, kind = null, line = null } = {},
) {
  const from = Math.max(now - windowDays * DAY_MS, dataStartTs ?? 0);
  const span = Math.max(1, now - from);
  const byUnit = new Map();
  for (const outage of outages) {
    const outKind = outageKind(outage);
    if (kind && outKind !== kind) continue;
    if (!outageHasLine(outage, line)) continue;
    const start = outage.lifecycle?.first_seen_ts;
    if (start == null) continue;
    const active = !!outage.lifecycle?.active;
    const end = outage.lifecycle?.restored_ts ?? (active ? now : null);
    if (end == null || end < from) continue;
    const key = outage.unit_key ?? `${outKind}:${outage.station?.slug}:${outage.unit_label}`;
    if (!byUnit.has(key)) {
      byUnit.set(key, {
        key,
        kind: outKind,
        slug: outage.station?.slug ?? null,
        name: stationLabel(outage),
        lines: outage.station?.lines || [],
        unit: outage.unit_label || 'Elevator',
        outageCount: 0,
        totalDownMs: 0,
        longestMs: 0,
        currentlyOut: false,
        lastStartTs: 0,
        repairs: [],
      });
    }
    const rec = byUnit.get(key);
    const boundedStart = Math.max(start, from);
    rec.outageCount += 1;
    rec.totalDownMs += Math.max(0, end - boundedStart);
    rec.longestMs = Math.max(rec.longestMs, end - start);
    rec.lastStartTs = Math.max(rec.lastStartTs, start);
    if (active) rec.currentlyOut = true;
    else rec.repairs.push(end - start);
  }
  return [...byUnit.values()]
    .map(({ repairs, ...rec }) => ({
      ...rec,
      uptime: Math.max(0, 1 - rec.totalDownMs / span),
      typicalRepairMs: median(repairs),
      windowMs: span,
    }))
    .sort(
      (a, b) =>
        b.outageCount - a.outageCount ||
        b.totalDownMs - a.totalDownMs ||
        a.name.localeCompare(b.name) ||
        a.unit.localeCompare(b.unit),
    );
}

/**
 * The headline figures over the same rows: how many elevators went out, how
 * many more than once, how long a repair usually took across all of them, and
 * the days the window really covers.
 */
export function reliabilitySummary(
  outages = [],
  { now = Date.now(), windowDays = 90, dataStartTs = null, kind = null, line = null } = {},
) {
  const rows = elevatorReliability(outages, { now, windowDays, dataStartTs, kind, line });
  const from = Math.max(now - windowDays * DAY_MS, dataStartTs ?? 0);
  const repairs = [];
  for (const outage of outages) {
    if (kind && outageKind(outage) !== kind) continue;
    if (!outageHasLine(outage, line)) continue;
    const { first_seen_ts: start, restored_ts: end, active } = outage.lifecycle ?? {};
    if (start == null || end == null || active || end < from) continue;
    repairs.push(end - start);
  }
  const worst = [...rows].sort((a, b) => a.uptime - b.uptime)[0] ?? null;
  return {
    elevators: rows.length,
    repeat: rows.filter((r) => r.outageCount >= 2).length,
    outages: rows.reduce((n, r) => n + r.outageCount, 0),
    typicalRepairMs: median(repairs),
    longestRepairMs: repairs.length ? Math.max(...repairs) : null,
    worst,
    coveredDays: Math.max(1, Math.round((now - from) / DAY_MS)),
  };
}

/** An uptime share as "99.2%"; "99.9%+" for one that rounds to all of it. */
export function formatUptime(share) {
  if (share >= 0.9995) return '99.9%+';
  return `${(share * 100).toFixed(1)}%`;
}
