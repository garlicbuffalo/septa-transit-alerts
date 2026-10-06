// Formatting helpers — date/time/duration strings and color conversions.
// Time formatting is pinned to America/New_York so the displayed values match
// what a Philadelphia rider sees, regardless of where the browser is.

const phillyDayParts = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// Returns a stable epoch (UTC midnight) representing the Philadelphia calendar day
// that contains `ts`. Used to bucket incidents by calendar day rather than by
// sliding 24-hour windows from `now`, which would otherwise smear an evening
// incident across two columns depending on the current wall time.
export function phillyDayUTC(ts) {
  let y, m, d;
  for (const p of phillyDayParts.formatToParts(new Date(ts))) {
    if (p.type === 'year') y = +p.value;
    else if (p.type === 'month') m = +p.value;
    else if (p.type === 'day') d = +p.value;
  }
  return Date.UTC(y, m - 1, d);
}

export function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function formatDuration(ms) {
  if (!ms || ms < 0) return null;
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 60) return `~${totalMin}m`;
  const totalH = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (totalH < 24) return m > 0 ? `~${totalH}h ${m}m` : `~${totalH}h`;
  const d = Math.floor(totalH / 24);
  const h = totalH % 24;
  const parts = [`${d}d`];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  return `~${parts.join(' ')}`;
}

// Compact "X min" / "X hr" form for stabilization-time deltas. Differs from
// formatDuration: no `~`, rounds to whole minutes under an hour, and drops
// stray seconds entirely. Returns null for non-positive deltas — a SEPTA alert
// that cleared *after* the bot saw service return shouldn't render a
// negative "stabilized -3 min after".
export function formatStabilizationDelta(ms) {
  if (ms == null || ms <= 0) return null;
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

// Format a duration given in *hours* for the per-line "median gap between
// incidents" stat: minutes for sub-hour gaps, whole hours for sub-day, and
// "Xd Yh" beyond. Differs from formatDuration: input is hours, no `~` prefix,
// and we round to whole hours past 1h since median-gap stats don't need
// minute precision.
export function formatGap(hours) {
  if (hours == null) return '';
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 24) return `${Math.round(hours)}h`;
  const d = Math.floor(hours / 24);
  const h = Math.round(hours - d * 24);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

// Format an integer count of minutes as a compact "Xh Ym" / "Xh" / "Ym"
// string. Used for disruption-hours summaries where totals can run from a few
// minutes (light week on one line) to several hundred hours (busy month
// system-wide). No `~` prefix — disruption totals are sums, not estimates.
// `maxUnit: 'hours'` keeps the figure in flat whole hours past the 24h mark
// (e.g. "54h" not "2d 6h"). Used where a day-rollover would misread as
// wall-clock elapsed time — notably the homepage's summed line-hours stat,
// which is a pooled total across lines, not a contiguous span.
export function formatMinutesAsHours(minutes, { maxUnit } = {}) {
  if (minutes == null || minutes <= 0) return '0m';
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (maxUnit === 'hours') return `${h}h`;
  if (h < 24) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rem = h - d * 24;
  return rem > 0 ? `${d}d ${rem}h` : `${d}d`;
}

export function formatDate(ts) {
  return new Date(ts).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'America/New_York',
  });
}

// Format a value produced by `phillyDayUTC` (a UTC midnight that *encodes*
// the Philadelphia calendar Y/M/D in its components, not a true Philadelphia
// wall-clock instant). Formatting one of those with `formatDate` re-applies the
// Eastern offset and shifts the result back a calendar day; format as UTC instead so
// the date components round-trip.
export function formatPhillyDay(dayUtc) {
  return new Date(dayUtc).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

// `YYYY-MM-DD` slug for a value produced by `phillyDayUTC` — matches the
// `/day/:date` route. The components are read back in UTC for the same reason
// `formatPhillyDay` formats in UTC: `phillyDayUTC` encodes the Philadelphia Y/M/D
// at UTC midnight, so re-applying an offset would shift the date.
export function phillyDayIsoUTC(dayUtc) {
  const d = new Date(dayUtc);
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}-${m}-${day}`;
}

const MONTHS_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

// Human label for a Sun–Sat week given its Sunday `weekStartUtc` (a
// phillyDayUTC value). Collapses the month when start and end share one
// ("May 17–23") and spells both out when they straddle a boundary
// ("Apr 26 – May 2"). Read in UTC for the same reason as formatPhillyDay:
// the value encodes the Philadelphia Y/M/D at UTC midnight.
export function formatWeekRange(weekStartUtc, { year = false } = {}) {
  const s = new Date(weekStartUtc);
  const e = new Date(weekStartUtc + 6 * 24 * 60 * 60 * 1000);
  const sM = MONTHS_SHORT[s.getUTCMonth()];
  const eM = MONTHS_SHORT[e.getUTCMonth()];
  const core =
    s.getUTCMonth() === e.getUTCMonth()
      ? `${sM} ${s.getUTCDate()}–${e.getUTCDate()}`
      : `${sM} ${s.getUTCDate()} – ${eM} ${e.getUTCDate()}`;
  return year ? `${core}, ${e.getUTCFullYear()}` : core;
}

export function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/New_York',
  });
}

// Compact "how long ago" label for a past timestamp, relative to `now`.
// Coarse buckets — "just now" (<60s), "Nm ago", "Nh ago", "Nd ago" — since
// this is for at-a-glance freshness, not precise durations. Clamps a slightly
// future ts (clock skew between the data server and the visitor) to "just now"
// rather than rendering a negative age. Returns null for a missing ts.
export function formatRelativeTime(ts, now = Date.now()) {
  if (ts == null) return null;
  const deltaMs = now - ts;
  if (deltaMs < 60_000) return 'just now';
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// Render SEPTA's posted alert end ("estimated end") relative to `now`.
// Returns null when the estimate is already past or within 2 minutes of now —
// at that point a "SEPTA expects to end at …" label is misleading rather than
// useful, and the alert will either resolve or extend on its own shortly.
//
// SEPTA often posts an alert end as a whole day ("through December 19",
// sent as 23:59).
// Pass `dateOnly: true` so the helper renders weekday + month/day ("Sun May 25")
// instead of the time-of-day form — "11:59 PM" would read as a precision
// SEPTA didn't actually intend.
//
// Otherwise: within 2 hours, render as compact relative ("in ~45m" / "in ~1h
// 20m"); beyond that, render Philadelphia weekday + time, with the weekday
// dropped when the estimate falls on the same Philadelphia calendar day as `now`.
export function formatEstimatedEnd(endTs, nowTs = Date.now(), { dateOnly = false } = {}) {
  if (endTs == null) return null;
  if (dateOnly) {
    // Compare on the Philadelphia calendar day to avoid a noon-UTC ts that's
    // the "next day" in UTC but the current day in ET registering as future.
    if (phillyDayUTC(endTs) < phillyDayUTC(nowTs)) return null;
    if (phillyDayUTC(endTs) === phillyDayUTC(nowTs)) return 'later today';
    return new Date(endTs).toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      timeZone: 'America/New_York',
    });
  }
  const deltaMs = endTs - nowTs;
  const TWO_MIN = 2 * 60 * 1000;
  if (deltaMs < TWO_MIN) return null;
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  if (deltaMs <= TWO_HOURS) {
    const min = Math.round(deltaMs / 60_000);
    if (min < 60) return `in ~${min}m`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m > 0 ? `in ~${h}h ${m}m` : `in ~${h}h`;
  }
  const time = formatTime(endTs);
  if (phillyDayUTC(endTs) === phillyDayUTC(nowTs)) return time;
  const weekday = new Date(endTs).toLocaleDateString('en-US', {
    weekday: 'short',
    timeZone: 'America/New_York',
  });
  return `${weekday} ${time}`;
}
