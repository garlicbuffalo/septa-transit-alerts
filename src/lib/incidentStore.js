// The single read boundary for published incident data. Every page loads its
// incidents through here instead of fetching the (unbounded) full-history
// alerts.json directly, so the size/parse cost of a page load is bounded by the
// slice it actually needs:
//
//   loadRecent()        93-day window ∪ active — home, browse, all ≤90d analytics
//   loadMonth(key)      one immutable monthly archive shard (closed months only)
//   loadLine(lineKey)   one line/route's all-time history
//   loadIndex()         the manifest: which months/lines exist + id→month
//   loadAggregates()    precomputed YoY (the one >90d computation)
//   getIncidentById(id) recent first, else resolve the id's shard via the index
//   loadRange(a, b)     union of the monthly shards overlapping [a, b]
//
// Caching: data hosts (GitHub Pages, raw.githubusercontent.com, CDNs) hand out
// browser-facing max-ages of minutes to hours, longer than the collector's
// cadence. We therefore fetch the changing files (recent/index/per-line/
// current-month) with `cache: 'no-cache'` — always revalidate, but send the
// ETag so an unchanged file comes back 304 with no body. Closed-month archive
// shards are nearly immutable, so those use `cache: 'default'` and are
// memoized for the session.

import { dataUrl } from './dataSource.js';
import { findIncidentById } from './incidents.js';

// Philadelphia month key "YYYY-MM" for a timestamp, matching the collector's
// shard bucketing (collector/lib/time.js easternMonthKey) so loadMonth and
// getIncidentById agree on which shard an incident lives in. formatToParts so DST never shifts
// the boundary.
const monthKeyFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
});
export function phillyMonthKey(ts) {
  let year = null;
  let month = null;
  for (const p of monthKeyFmt.formatToParts(new Date(ts))) {
    if (p.type === 'year') year = p.value;
    else if (p.type === 'month') month = p.value;
  }
  return `${year}-${month}`;
}

async function fetchJson(file, cache) {
  const res = await fetch(dataUrl(file), { cache });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${file}`);
  return res.json();
}

// Copy at the load boundary so a caller mutating its result never touches
// another caller's cached shard.
function gate(incidents) {
  return [...(incidents || [])];
}

// --- Recent slice (home, browse, ≤90d analytics) ----------------------------
// Not memoized: App.jsx polls this every 5 minutes, and callers want the live
// generated_at. The fetch is cheap on quiet ticks (304, no body).
export async function loadRecent() {
  const payload = await fetchJson('alerts-recent.json', 'no-cache');
  return { ...payload, incidents: gate(payload.incidents) };
}

// --- Index / manifest --------------------------------------------------------
// Memoized for the session: the id→month map only grows, and any id missing
// from a stale cached index would also be in the recent slice (which
// getIncidentById checks first). A failed load clears the cache so a later call
// can retry.
let indexPromise = null;
export function loadIndex() {
  if (!indexPromise) {
    indexPromise = fetchJson('alerts-index.json', 'no-cache').catch((err) => {
      indexPromise = null;
      throw err;
    });
  }
  return indexPromise;
}

// --- Monthly archive shards --------------------------------------------------
// A closed month is *almost* immutable: a long-running incident first seen that
// month but resolving after it ends rewrites that shard's bytes, so `default`
// caching is correct here — served from cache while the host's max-age holds,
// then revalidated, so a late-resolution rewrite is picked up. (Not
// `force-cache`, which would pin the stale copy indefinitely.) The current
// Philadelphia month still grows each tick → `no-cache` (always revalidate).
// Closed months are memoized for the session; the current month never is.
const monthCache = new Map(); // closed-month key → Promise<Incident[]>
export function loadMonth(key) {
  const closed = key < phillyMonthKey(Date.now());
  if (closed && monthCache.has(key)) return monthCache.get(key);
  const promise = fetchJson(`alerts/${key}.json`, closed ? 'default' : 'no-cache')
    .then((payload) => gate(payload.incidents))
    .catch((err) => {
      if (closed) monthCache.delete(key);
      throw err;
    });
  if (closed) monthCache.set(key, promise);
  return promise;
}

// --- Per-line all-time files -------------------------------------------------
// Memoized for the session. A line file changes only when that line gets a new
// incident; a viewing session missing one new incident on the line it's already
// looking at is acceptable, and avoids refetching the whole all-time file on
// every interaction. encodeURIComponent matches how the collector names the file.
const lineCache = new Map(); // lineKey → Promise<Incident[]>
export function loadLine(lineKey) {
  if (lineCache.has(lineKey)) return lineCache.get(lineKey);
  const promise = fetchJson(`incidents/by-line/${encodeURIComponent(lineKey)}.json`, 'no-cache')
    .then((payload) => gate(payload.incidents))
    .catch((err) => {
      lineCache.delete(lineKey);
      throw err;
    });
  lineCache.set(lineKey, promise);
  return promise;
}

// --- Precomputed aggregates (YoY) -------------------------------------------
export function loadAggregates() {
  return fetchJson('aggregates.json', 'no-cache');
}

// --- Id resolution -----------------------------------------------------------
// Resolve a shareable event id to its incident plus the slice it was found in
// (recent or its month shard), so the caller can compute time-neighbors
// (related / contemporaneous incidents) without a second fetch. Recent is
// checked first (covers active + the last 93 days, and matches bot-post-rkey
// links via findIncidentById); older ids resolve through the index's id→month.
// Returns null when the id resolves nowhere.
/**
 * @param {string} id
 * @returns {Promise<{ incident: import('./incidents.js').Incident, incidents: import('./incidents.js').Incident[] } | null>}
 */
export async function getIncidentById(id) {
  if (!id) return null;
  const recent = await loadRecent();
  const inRecent = findIncidentById(recent.incidents, id);
  if (inRecent) return { incident: inRecent, incidents: recent.incidents };

  // Canonical incident.id is in id_month; a non-canonical post rkey (a secondary
  // bot post of the incident) resolves via rkey_month.
  const index = await loadIndex();
  const monthKey = index.id_month?.[id] ?? index.rkey_month?.[id];
  if (!monthKey) return null;
  const monthIncidents = await loadMonth(monthKey);
  const incident = findIncidentById(monthIncidents, id);
  return incident ? { incident, incidents: monthIncidents } : null;
}

// The keys of the months immediately newer/older than `monthKey` that actually
// have a shard, read from the index's `months[]` (newest-first). Returns only
// existing neighbors, so we never request a month with no shard — e.g. next
// month before it exists, or a gap month with no incidents.
function adjacentMonthKeys(index, monthKey) {
  const months = index?.months ?? [];
  const i = months.findIndex((m) => m.key === monthKey);
  if (i === -1) return [];
  const keys = [];
  if (i - 1 >= 0) keys.push(months[i - 1].key); // newer neighbor
  if (i + 1 < months.length) keys.push(months[i + 1].key); // older neighbor
  return keys;
}

// Resolve an event id to its incident plus a context set wide enough for the
// event page's prev/next nav and ±24h/±1h callouts to be correct across shard
// boundaries: the incident's own slice (from getIncidentById), the months on
// either side (so a chronological neighbor that fell into an adjacent month
// shard is present), and each of the incident's lines' all-time files (so
// same-line prev/next is complete even when the neighbor is many months back on
// a quiet line). De-duped by id, preferring the slice's (freshest) copy.
export async function getIncidentWithContext(id) {
  const found = await getIncidentById(id);
  if (!found) return null;
  const { incident, incidents: slice } = found;

  const index = await loadIndex();
  const ts = incident?.lifecycle?.first_seen_ts;
  const monthKey = typeof ts === 'number' && Number.isFinite(ts) ? phillyMonthKey(ts) : null;
  const adjacentMonths = monthKey ? adjacentMonthKeys(index, monthKey) : [];

  const [monthArrays, lineArrays] = await Promise.all([
    Promise.all(adjacentMonths.map((k) => loadMonth(k).catch(() => []))),
    Promise.all((incident.routes || []).map((r) => loadLine(r).catch(() => []))),
  ]);

  const byId = new Map();
  for (const inc of slice) byId.set(inc.id, inc);
  for (const arr of [...monthArrays, ...lineArrays]) {
    for (const inc of arr) if (!byId.has(inc.id)) byId.set(inc.id, inc);
  }
  return { incident, incidents: [...byId.values()] };
}

// --- Time-range union --------------------------------------------------------
// Every incident lands in exactly one monthly shard (its first_seen month), so a
// date range is served by the union of the months whose [min_ts, max_ts] overlap
// the range. De-duped by id (belt-and-suspenders against any future overlap).
// Powers WeekPage / DayPage for dates outside the recent window.
export async function loadRange(fromTs, toTs) {
  const index = await loadIndex();
  const months = (index.months || []).filter((m) => m.min_ts <= toTs && m.max_ts >= fromTs);
  const arrays = await Promise.all(months.map((m) => loadMonth(m.key)));
  const byId = new Map();
  for (const arr of arrays) {
    for (const inc of arr) byId.set(inc.id, inc);
  }
  return [...byId.values()];
}

// Test seam: drop the session caches so a test can exercise a fresh load path.
export function __resetStoreCaches() {
  indexPromise = null;
  monthCache.clear();
  lineCache.clear();
}
