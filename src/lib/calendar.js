// Helpers for the /calendar page. Reads the slim daily-counts.json produced
// by the collector (collector/lib/archive.js) and shapes it into a 12-month
// grid keyed by Philadelphia calendar day.

import { normalizeMetroLine } from './metroLines.js';
import { normalizeRailLine } from './railLines.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Parse "YYYY-MM-DD" → UTC-midnight epoch encoding that Philadelphia Y/M/D
// (same convention as phillyDayUTC). Returns null on malformed input.
export function dateStringToUtc(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const utc = Date.UTC(year, month - 1, day);
  const d = new Date(utc);
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return utc;
}

// Index `days` array by date string for O(1) lookup during grid build.
function indexDays(days) {
  const out = new Map();
  for (const d of days || []) {
    if (d?.date) out.set(d.date, d);
  }
  return out;
}

// Apply the homepage filter set to a daily-counts record. Returns
// `{ metroCount, busCount, railCount }` reflecting only the selected
// lines/routes. Recognizes the same filter keys parseUrlState produces.
//
//   selectedLines      null = all Metro lines; [] = no Metro lines.
//   showBus            false = drop all bus counts.
//   selectedBusRoutes  non-empty = restrict bus counts to these routes.
//   selectedRailLines  non-empty = restrict Regional Rail counts to these lines.
//   network            'transit' / 'rail' scope the day to one network.
//
// Signal filtering is intentionally not supported here — daily-counts.json
// doesn't carry per-signal breakdowns. The calendar page surfaces a small
// note when signals are active so the user understands why the calendar
// isn't responsive to that one filter chip.
function filterCounts(
  day,
  { selectedLines, showBus, selectedBusRoutes, selectedRailLines, network },
) {
  let metroCount = 0;
  if (network !== 'rail') {
    if (selectedLines == null) {
      metroCount = day.metro_count ?? 0;
    } else if (selectedLines.length > 0 && day.by_line && typeof day.by_line === 'object') {
      const wanted = new Set(selectedLines.map(normalizeMetroLine));
      for (const [k, v] of Object.entries(day.by_line)) {
        if (wanted.has(normalizeMetroLine(k))) metroCount += v;
      }
    }
  }

  let busCount = 0;
  if (showBus && network !== 'rail') {
    if (!selectedBusRoutes || selectedBusRoutes.length === 0) {
      busCount = day.bus_count ?? 0;
    } else if (day.by_route && typeof day.by_route === 'object') {
      for (const [k, v] of Object.entries(day.by_route)) {
        if (selectedBusRoutes.includes(k)) busCount += v;
      }
    }
  }

  let railCount = 0;
  if (network !== 'transit') {
    if (!selectedRailLines || selectedRailLines.length === 0) {
      railCount = day.rail_count ?? 0;
    } else if (day.by_rail_line && typeof day.by_rail_line === 'object') {
      const wanted = new Set(selectedRailLines.map(normalizeRailLine));
      for (const [k, v] of Object.entries(day.by_rail_line)) {
        if (wanted.has(normalizeRailLine(k))) railCount += v;
      }
    }
  }

  return { metroCount, busCount, railCount };
}

const ZERO_COUNTS = { metroCount: 0, busCount: 0, railCount: 0 };

// Per-day counts for one cell: the unfiltered totals, or the filtered subset.
// A multi-line incident is counted once in the unfiltered totals but once per
// matching line in a by-line narrowing — an acceptable overcount for a heatmap.
function cellCounts(rec, filters) {
  if (!rec) return ZERO_COUNTS;
  if (filters) return filterCounts(rec, filters);
  return {
    metroCount: rec.metro_count ?? 0,
    busCount: rec.bus_count ?? 0,
    railCount: rec.rail_count ?? 0,
  };
}

// Build a calendar grid covering the most recent `monthsBack` months ending
// in the current month. Returns an array of months, newest first, each with
// a year/month label and a fixed-length 31-cell row. Cells covering days
// that don't exist in that month (e.g. Feb 30) get a `placeholder: true`
// flag so the renderer can skip them. Cells that ended on or before
// `dataStartTs` get `noData: true` so the renderer can hatch them.
//
// `now` defaults to Date.now() — pinned to Philadelphia calendar terms via the
// payload's date strings, so timezone of `now` doesn't matter for cell
// alignment, only for "what's the current month."
//
// `filters` mirrors the homepage filter set; passing it narrows each cell's
// count to only the selected lines/routes (uses each day's by_line/by_route
// breakdowns). Default counts every network.
/**
 * @param {{ date: string, metro_count: number, bus_count: number, rail_count: number, by_line?: object, by_route?: object, by_rail_line?: object }[]} days
 * @param {object} [options]
 * @param {number} [options.now]
 * @param {number} [options.monthsBack]
 * @param {number | null} [options.dataStartTs]
 * @param {{ selectedLines: string[] | null, showBus: boolean, selectedBusRoutes: string[], selectedRailLines?: string[], network?: string } | null} [options.filters]
 * @returns {Array<{
 *   year: number,
 *   month: number,
 *   label: string,
 *   cells: Array<{
 *     dayOfMonth: number,
 *     date: string | null,
 *     count: number,
 *     metroCount: number,
 *     busCount: number,
 *     railCount: number,
 *     placeholder: boolean,
 *     noData: boolean,
 *     future: boolean,
 *   }>,
 * }>}
 */
export function buildCalendarMonths(
  days,
  { now = Date.now(), monthsBack = 12, dataStartTs = null, filters = null } = {},
) {
  const idx = indexDays(days);
  const today = new Date(now);
  // Anchor month uses Philadelphia-local Y/M to avoid edge-of-month drift.
  const anchorParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(today);
  const anchorYear = Number(anchorParts.find((p) => p.type === 'year').value);
  const anchorMonth = Number(anchorParts.find((p) => p.type === 'month').value);
  const anchorDay = Number(anchorParts.find((p) => p.type === 'day').value);
  const todayUtc = Date.UTC(anchorYear, anchorMonth - 1, anchorDay);

  const monthLabelFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric',
  });

  const out = [];
  // Walk backwards from the current month for `monthsBack` rows. Newest first
  // so the page opens with the most recent activity visible.
  for (let i = 0; i < monthsBack; i++) {
    let y = anchorYear;
    let m = anchorMonth - i;
    while (m <= 0) {
      m += 12;
      y -= 1;
    }
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const cells = [];
    for (let d = 1; d <= 31; d++) {
      if (d > daysInMonth) {
        cells.push({
          dayOfMonth: d,
          date: null,
          count: 0,
          ...ZERO_COUNTS,
          placeholder: true,
          noData: false,
          future: false,
        });
        continue;
      }
      const date = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const dayUtc = Date.UTC(y, m - 1, d);
      const future = dayUtc > todayUtc;
      const dayEnd = dayUtc + DAY_MS;
      const noData = !future && dataStartTs != null && dayEnd <= dataStartTs;
      const counts = cellCounts(idx.get(date), filters);
      cells.push({
        dayOfMonth: d,
        date,
        count: counts.metroCount + counts.busCount + counts.railCount,
        ...counts,
        placeholder: false,
        noData,
        future,
      });
    }
    out.push({
      year: y,
      month: m,
      label: monthLabelFmt.format(new Date(Date.UTC(y, m - 1, 1))),
      cells,
    });
  }

  return out;
}

// GitHub-contribution-style year heatmap. Returns a flat array of weeks,
// each week a 7-cell row (Sun..Sat) — so column position is always a single
// weekday across the entire grid. The page lays this out as a 7-row × N-col
// CSS grid: rows become weekdays, columns become weeks moving rightward
// through the year. Reading "are Mondays especially bad in April" reduces
// to scanning the Monday row across the April-tagged columns.
//
// Weeks are emitted oldest-first so the rightmost column is the current
// week. Cells outside the [windowStart, today] interval are flagged
// `inRange: false` so the renderer can hide or dim them; cells before
// `dataStartTs` get `noData: true`.
//
// `windowDays` is the size of the visible heatmap in days (default 364 = 52
// weeks; we pad the leading edge to land on a Sunday boundary). Filters
// behave identically to buildCalendarMonths.
/**
 * @param {Array<{ date: string, metro_count: number, bus_count: number, rail_count: number, by_line?: object, by_route?: object, by_rail_line?: object }>} days
 * @param {object} [options]
 * @param {number} [options.now]
 * @param {number} [options.windowDays]
 * @param {number | null} [options.dataStartTs]
 * @param {{ selectedLines: string[] | null, showBus: boolean, selectedBusRoutes: string[], selectedRailLines?: string[], network?: string } | null} [options.filters]
 * @returns {{
 *   weeks: Array<Array<{
 *     date: string | null,
 *     dayUtc: number | null,
 *     dayOfMonth: number | null,
 *     weekday: number,
 *     count: number,
 *     metroCount: number,
 *     busCount: number,
 *     railCount: number,
 *     inRange: boolean,
 *     noData: boolean,
 *     future: boolean,
 *   }>>,
 *   monthLabels: Array<{ weekIndex: number, label: string }>,
 *   maxCount: number,
 *   firstDayUtc: number,
 *   lastDayUtc: number,
 * }}
 */
export function buildCalendarWeeks(
  days,
  { now = Date.now(), windowDays = 364, dataStartTs = null, filters = null } = {},
) {
  const idx = indexDays(days);

  // Anchor today in Philadelphia Y/M/D so we don't drift around midnight.
  const todayParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(now));
  const todayYear = Number(todayParts.find((p) => p.type === 'year').value);
  const todayMonth = Number(todayParts.find((p) => p.type === 'month').value);
  const todayDay = Number(todayParts.find((p) => p.type === 'day').value);
  const todayUtc = Date.UTC(todayYear, todayMonth - 1, todayDay);

  // We want the rightmost column to contain today, with later weekdays of
  // this week filled in as "future" cells. Find this week's Sunday, then
  // walk back enough weeks to cover windowDays.
  const todayWeekday = new Date(todayUtc).getUTCDay(); // 0 = Sun .. 6 = Sat
  const thisWeekSunday = todayUtc - todayWeekday * DAY_MS;
  // Round up to a whole number of weeks (52 by default = 364 days).
  const numWeeks = Math.max(1, Math.ceil(windowDays / 7));
  const firstWeekSunday = thisWeekSunday - (numWeeks - 1) * DAY_MS * 7;

  const monthLabelFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short' });

  const weeks = [];
  const monthLabels = [];
  let lastLabeledMonth = null;
  let maxCount = 0;

  for (let w = 0; w < numWeeks; w++) {
    const weekSunday = firstWeekSunday + w * DAY_MS * 7;
    const cells = [];
    for (let dow = 0; dow < 7; dow++) {
      const dayUtc = weekSunday + dow * DAY_MS;
      const d = new Date(dayUtc);
      const y = d.getUTCFullYear();
      const mo = d.getUTCMonth() + 1;
      const dom = d.getUTCDate();
      const date = `${y}-${String(mo).padStart(2, '0')}-${String(dom).padStart(2, '0')}`;
      const future = dayUtc > todayUtc;
      const inRange = dayUtc >= firstWeekSunday && !future;
      const dayEnd = dayUtc + DAY_MS;
      const noData = !future && dataStartTs != null && dayEnd <= dataStartTs;
      const counts = cellCounts(idx.get(date), filters);
      const count = counts.metroCount + counts.busCount + counts.railCount;
      if (inRange && !noData && count > maxCount) maxCount = count;
      cells.push({
        date,
        dayUtc,
        dayOfMonth: dom,
        weekday: dow,
        count,
        ...counts,
        inRange,
        noData,
        future,
      });
    }
    weeks.push(cells);

    // Tag a month label on the first week that introduces a new month — by
    // convention, GitHub-style heatmaps label the column where the month
    // starts. Skip the very first column when its label would crowd the
    // weekday row.
    for (const cell of cells) {
      if (cell.dayOfMonth === 1) {
        const label = monthLabelFmt.format(new Date(cell.dayUtc));
        if (label !== lastLabeledMonth) {
          monthLabels.push({ weekIndex: w, label });
          lastLabeledMonth = label;
        }
        break;
      }
    }
  }

  return {
    weeks,
    monthLabels,
    maxCount,
    firstDayUtc: firstWeekSunday,
    lastDayUtc: todayUtc,
  };
}

// Highest count across all real cells in a calendar grid — used to scale
// the cell-coloring intensity stops. Ignores placeholder/noData/future
// cells so an empty future month doesn't compress the visible scale.
export function maxCountAcrossMonths(months) {
  let max = 0;
  for (const month of months) {
    for (const cell of month.cells) {
      if (cell.placeholder || cell.noData || cell.future) continue;
      if (cell.count > max) max = cell.count;
    }
  }
  return max;
}
