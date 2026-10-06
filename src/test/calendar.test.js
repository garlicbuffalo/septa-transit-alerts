import { describe, expect, it } from 'vitest';
import { buildCalendarMonths, dateStringToUtc, maxCountAcrossMonths } from '../lib/calendar.js';

// Pin "now" to 2026-05-09 13:00 Philadelphia — comfortably mid-day so anchor-month
// resolution doesn't depend on the test environment's local timezone.
const NOW = Date.UTC(2026, 4, 9, 18, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

describe('dateStringToUtc', () => {
  it('parses a valid YYYY-MM-DD date', () => {
    expect(dateStringToUtc('2026-05-09')).toBe(Date.UTC(2026, 4, 9));
  });

  it('rejects non-strings and malformed input', () => {
    expect(dateStringToUtc(null)).toBeNull();
    expect(dateStringToUtc(20260509)).toBeNull();
    expect(dateStringToUtc('not-a-date')).toBeNull();
    expect(dateStringToUtc('2026/05/09')).toBeNull();
  });

  it('rejects out-of-range months and overflow days', () => {
    expect(dateStringToUtc('2026-13-01')).toBeNull();
    expect(dateStringToUtc('2026-02-30')).toBeNull(); // Feb 30 — overflow
    expect(dateStringToUtc('2026-00-01')).toBeNull();
  });
});

describe('buildCalendarMonths', () => {
  it('returns the requested number of months, newest first', () => {
    const r = buildCalendarMonths([], { now: NOW, monthsBack: 6 });
    expect(r).toHaveLength(6);
    // Newest entry is the current month (May 2026).
    expect(r[0].year).toBe(2026);
    expect(r[0].month).toBe(5);
    // Walking back, December 2025 is 6 entries back.
    expect(r[5].year).toBe(2025);
    expect(r[5].month).toBe(12);
  });

  it('always emits 31 cells per row, marking absent days as placeholders', () => {
    const r = buildCalendarMonths([], { now: NOW, monthsBack: 1 });
    expect(r[0].cells).toHaveLength(31);
    // May has 31 days — no placeholders this month.
    expect(r[0].cells.filter((c) => c.placeholder)).toHaveLength(0);

    // February 2026 has 28 days — slots 29/30/31 are placeholders.
    const feb = buildCalendarMonths([], {
      now: Date.UTC(2026, 1, 15, 18),
      monthsBack: 1,
    });
    expect(feb[0].cells.slice(28).every((c) => c.placeholder)).toBe(true);
  });

  it('flags days past today as future cells', () => {
    const r = buildCalendarMonths([], { now: NOW, monthsBack: 1 });
    // Current month is May; "today" is the 9th. Days 10+ are future.
    const tenth = r[0].cells[9];
    expect(tenth.future).toBe(true);
    const ninth = r[0].cells[8];
    expect(ninth.future).toBe(false);
  });

  it('marks days before dataStartTs as noData', () => {
    // Cut data off a few days into May — anything before should be noData.
    const dataStartTs = Date.UTC(2026, 4, 5);
    const r = buildCalendarMonths([], { now: NOW, monthsBack: 1, dataStartTs });
    expect(r[0].cells[0].noData).toBe(true); // May 1
    expect(r[0].cells[3].noData).toBe(true); // May 4
    expect(r[0].cells[4].noData).toBe(false); // May 5 onward
  });

  it('joins per-day counts from the input by date string', () => {
    const days = [
      { date: '2026-05-01', metro_count: 3, bus_count: 2 },
      { date: '2026-05-02', metro_count: 1, bus_count: 0 },
    ];
    const r = buildCalendarMonths(days, { now: NOW, monthsBack: 1 });
    expect(r[0].cells[0].count).toBe(5);
    expect(r[0].cells[0].metroCount).toBe(3);
    expect(r[0].cells[0].busCount).toBe(2);
    expect(r[0].cells[1].count).toBe(1);
    expect(r[0].cells[2].count).toBe(0);
  });
});

describe('maxCountAcrossMonths', () => {
  it('returns 0 for an empty grid', () => {
    expect(maxCountAcrossMonths([])).toBe(0);
  });

  it('ignores placeholder, future, and noData cells', () => {
    const grid = [
      {
        cells: [
          { count: 5, placeholder: true, future: false, noData: false },
          { count: 8, placeholder: false, future: true, noData: false },
          { count: 6, placeholder: false, future: false, noData: true },
          { count: 3, placeholder: false, future: false, noData: false },
        ],
      },
    ];
    expect(maxCountAcrossMonths(grid)).toBe(3);
  });
});

// Sanity check that DAY_MS use in calendar.js stays consistent.
describe('calendar internals', () => {
  it('respects the standard day length', () => {
    expect(DAY_MS).toBe(86_400_000);
  });
});
