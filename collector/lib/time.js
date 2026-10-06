// Philadelphia (America/New_York) time helpers. SEPTA's APIs report local
// wall-clock strings with no offset ("2026-10-05 14:40:00"), and every bucket
// the site renders — monthly shards, calendar days, service dates — is an
// Eastern calendar unit, so all conversions route through here.

export const TZ = 'America/New_York';
const MIN_MS = 60 * 1000;

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** Eastern wall-clock parts for an epoch-ms timestamp. */
export function easternParts(ts) {
  const out = {};
  for (const p of partsFmt.formatToParts(new Date(ts))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return out;
}

// Offset (ms) to add to UTC to get Eastern wall-clock time at instant `ts`.
function offsetAt(ts) {
  const p = easternParts(ts);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/**
 * Convert Eastern wall-clock fields to epoch ms. Resolves DST by re-checking
 * the offset at the first guess (the standard two-pass trick); a wall time that
 * falls in the spring-forward gap lands an hour later, which is fine here.
 */
export function easternToEpoch(year, month, day, hour = 0, minute = 0, second = 0) {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  let ts = naive - offsetAt(naive);
  ts = naive - offsetAt(ts);
  return ts;
}

/**
 * Parse a SEPTA local timestamp ("2026-10-05 14:40:00", optional ".000"
 * fraction or "T" separator) as Eastern time. Returns null when unparseable.
 * @param {string | null | undefined} str
 * @returns {number | null}
 */
export function parseEastern(str) {
  if (!str) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(str).trim());
  if (!m) return null;
  return easternToEpoch(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] ?? 0));
}

/** True when a SEPTA local timestamp is at the start-of-day sentinel (00:00/00:01). */
export function isStartOfDayClock(str) {
  return /[ T]00:0[01](?::00)?(?:\.\d+)?$/.test(String(str ?? '').trim());
}

/** True when a SEPTA local timestamp is at the end-of-day sentinel (23:59). */
export function isEndOfDayClock(str) {
  return /[ T]23:59(?::\d{2})?(?:\.\d+)?$/.test(String(str ?? '').trim());
}

const pad = (n) => String(n).padStart(2, '0');

/** Eastern calendar date "YYYY-MM-DD" for an instant. */
export function easternDateKey(ts) {
  const p = easternParts(ts);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Eastern month "YYYY-MM" for an instant — the monthly shard bucket. */
export function easternMonthKey(ts) {
  const p = easternParts(ts);
  return `${p.year}-${pad(p.month)}`;
}

// Transit service days run past midnight: a 1:15 AM trip belongs to the
// previous day's schedule. Clock times before this hour roll to the next date.
export const SERVICE_DAY_START_HOUR = 3;

/**
 * Parse a 12-hour clock string ("6:28 am", "12:05 PM") on an Eastern service
 * date ("YYYY-MM-DD") to epoch ms. Times before SERVICE_DAY_START_HOUR land on
 * the following calendar day. Returns null when unparseable.
 * @param {string} clock
 * @param {string} serviceDateKey
 * @returns {number | null}
 */
export function parseServiceClock(clock, serviceDateKey) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*([ap])\.?m\.?\s*$/i.exec(String(clock ?? ''));
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(serviceDateKey ?? ''));
  if (!m || !d) return null;
  let hour = Number(m[1]) % 12;
  if (m[3].toLowerCase() === 'p') hour += 12;
  const dayOffset = hour < SERVICE_DAY_START_HOUR ? 1 : 0;
  return easternToEpoch(+d[1], +d[2], +d[3] + dayOffset, hour, Number(m[2]));
}

/** Eastern service date "YYYY-MM-DD" an instant belongs to (see SERVICE_DAY_START_HOUR). */
export function serviceDateKey(ts) {
  return easternDateKey(ts - SERVICE_DAY_START_HOUR * 60 * MIN_MS);
}
