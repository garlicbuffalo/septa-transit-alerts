// Elevator outages → the accessibility archive (accessibility.json).
//
// SEPTA's elevator endpoint lists only what is out right now. Each listed unit
// becomes an outage record with a lifecycle; a unit that leaves the list is
// marked restored. A unit that fails again after being restored opens a new
// record (ids carry the date the outage began), so history shows each episode.
import { findMetroStation, findRailStation } from './stations.js';
import { htmlToText, slugify } from './text.js';
import { easternDateKey } from './time.js';

const DAY_MS = 24 * 60 * 60 * 1000;
// Restored outages older than this drop out of the published archive.
export const OUTAGE_RETENTION_DAYS = 365;

// Line names as the elevator API spells them → Metro line keys, used when a
// station name doesn't resolve against the roster.
const LINE_HINTS = [
  [/market[\s-]*frankford/i, ['l1']],
  [/broad[\s-]*ridge/i, ['b3']],
  [/broad street/i, ['b1']],
  [/norristown high speed/i, ['m1']],
  [/media|sharon hill/i, ['d1', 'd2']],
  [/trolley/i, ['t1', 't2', 't3', 't4', 't5']],
];

function linesFromLineText(text) {
  const out = [];
  for (const [re, keys] of LINE_HINTS) {
    if (re.test(String(text ?? ''))) for (const k of keys) if (!out.includes(k)) out.push(k);
  }
  return out;
}

function resolveStation(row) {
  const isRail = /regional rail/i.test(String(row.line ?? ''));
  const rec = isRail ? findRailStation(row.station) : findMetroStation(row.station);
  const name = rec?.name ?? String(row.station ?? '').trim();
  return {
    mode: isRail ? 'regional_rail' : 'metro',
    station: {
      slug: slugify(name),
      name: name || null,
      lines: rec?.lines ?? (isRail ? [] : linesFromLineText(row.line)),
    },
  };
}

/**
 * Apply one successful elevator fetch to the outage map (mutates it).
 * @param {Map<string, object>} outages id → outage
 * @param {{ results?: object[] }} payload
 * @param {number} now
 * @returns {{ changed: boolean, stats: object }}
 */
export function applyElevators(outages, payload, now) {
  const rows = Array.isArray(payload?.results) ? payload.results : null;
  if (!rows) throw new Error('elevator payload missing results[]');
  const stats = { listed: rows.length, opened: 0, restored: 0 };
  let changed = false;

  const activeByUnit = new Map();
  for (const o of outages.values()) if (o.lifecycle?.active) activeByUnit.set(o.unit_key, o);

  const seenUnits = new Set();
  for (const row of rows) {
    const { mode, station } = resolveStation(row);
    const unitLabel =
      String(row.elevator ?? '')
        .replace(/\s+/g, ' ')
        .trim() || 'Elevator';
    const unitKey = `elevator:${station.slug}:${slugify(unitLabel)}`;
    if (seenUnits.has(unitKey)) continue;
    seenUnits.add(unitKey);
    // The plain `message` is the same text as `message_html` minus a one-item
    // <ul> wrapper; prefer it so descriptions don't open with a stray bullet.
    const description = String(row.message ?? '').trim() || htmlToText(row.message_html) || null;
    const existing = activeByUnit.get(unitKey);
    const base = existing ?? {
      id: `${unitKey.replace(/:/g, '-')}-${easternDateKey(now)}`,
      unit_key: unitKey,
      lifecycle: { first_seen_ts: now, last_seen_ts: now, restored_ts: null, active: true },
    };
    const next = {
      id: base.id,
      unit_key: unitKey,
      agency: 'septa',
      mode,
      station,
      unit_type: 'elevator',
      unit_label: unitLabel,
      headline: `${station.name ?? 'Station'} elevator out of service (${unitLabel})`,
      description,
      lifecycle: { ...base.lifecycle, last_seen_ts: now, restored_ts: null, active: true },
      source_url: row.alternate_url || 'https://www.septa.org/accessibility/',
    };
    if (!existing) stats.opened += 1;
    outages.set(next.id, next);
    changed = true;
  }

  for (const [unitKey, o] of activeByUnit) {
    if (seenUnits.has(unitKey)) continue;
    outages.set(o.id, {
      ...o,
      lifecycle: { ...o.lifecycle, restored_ts: now, active: false },
    });
    stats.restored += 1;
    changed = true;
  }

  const cutoff = now - OUTAGE_RETENTION_DAYS * DAY_MS;
  for (const [id, o] of outages) {
    if (!o.lifecycle?.active && (o.lifecycle?.restored_ts ?? 0) < cutoff) {
      outages.delete(id);
      changed = true;
    }
  }
  return { changed, stats };
}
