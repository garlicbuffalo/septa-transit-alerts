// Philadelphia clock times and date ranges for post text and images.
import { easternParts, easternToEpoch, serviceDateKey } from '../../collector/lib/time.js';

const CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: 'numeric',
  minute: '2-digit',
});

/** Philadelphia clock time: "4:12 PM". */
export function clockLabel(ts) {
  return CLOCK.format(new Date(ts)).replace(/ /g, ' ');
}

/** "4:00–4:15 PM", or "11:50 AM–12:05 PM" across noon. */
export function clockRange(start, end) {
  const a = clockLabel(start);
  const b = clockLabel(end);
  const [aTime, aHalf] = a.split(' ');
  const [, bHalf] = b.split(' ');
  return aHalf === bHalf ? `${aTime}–${b}` : `${a}–${b}`;
}

const DAY = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
const MONTH = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' });

const keyDate = (key) => new Date(`${key}T12:00:00Z`);

/** A YYYY-MM-DD date key moved by whole days. */
export function addDays(key, days) {
  const d = keyDate(key);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** "Oct 2" for a date key. */
export function dayLabel(key) {
  return DAY.format(keyDate(key));
}

/** "Sep 28 – Oct 4" for two date keys. */
export function dateRangeLabel(fromKey, toKey) {
  return `${dayLabel(fromKey)} – ${dayLabel(toKey)}`;
}

/** "September 2026" for a date key in that month. */
export function monthLabel(key) {
  return MONTH.format(keyDate(key));
}

/**
 * The days a weekly or monthly recap covers, as date keys: the 7 days before
 * `now`'s service day, or the previous calendar month.
 */
export function recapWindow(period, now) {
  const today = serviceDateKey(now);
  if (period === 'month') {
    const p = easternParts(now);
    const firstThis = `${p.year}-${String(p.month).padStart(2, '0')}-01`;
    const toKey = addDays(firstThis, -1);
    return { fromKey: `${toKey.slice(0, 7)}-01`, toKey, label: monthLabel(toKey) };
  }
  const toKey = addDays(today, -1);
  const fromKey = addDays(today, -7);
  return { fromKey, toKey, label: dateRangeLabel(fromKey, toKey) };
}

/** Midnight in Philadelphia at the start of a date key. */
export function keyStart(key) {
  const [y, m, d] = key.split('-').map(Number);
  return easternToEpoch(y, m, d);
}
