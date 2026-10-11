import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const shell = readFileSync(resolve(__dirname, '../../index.html'), 'utf8');

// The inline <script> in index.html that swaps in the seasonal icons.
const swapScript = [...shell.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1])
  .find((src) => src.includes('SEASONS'));

const ICON_LINKS = `
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
  <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16.png" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
`;

const TOWER = ['/favicon-32.png', '/favicon-16.png', '/favicon.svg', '/apple-touch-icon.png'];
const iconSet = (set) => [
  `/favicon-${set}-32.png`,
  `/favicon-${set}-16.png`,
  `/favicon-${set}.svg`,
  `/apple-touch-icon-${set}.png`,
];

const SETS = ['love', 'mummers', 'pretzel', 'liberty-bell', 'eastern-state', 'boathouse-row'];

function iconsAt(isoInstant) {
  vi.setSystemTime(new Date(isoInstant));
  document.head.innerHTML = ICON_LINKS;
  new Function(swapScript)();
  return [...document.head.querySelectorAll('link')].map((l) => l.getAttribute('href'));
}

describe('seasonal icons', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    document.head.innerHTML = '';
  });

  it('finds the swap script in index.html', () => {
    expect(swapScript).toBeTruthy();
  });

  it.each([
    ['mummers', '2027-12-31T12:00:00-05:00'],
    ['mummers', '2027-01-01T00:30:00-05:00'],
    ['mummers', '2027-01-02T23:30:00-05:00'],
    ['love', '2027-02-01T12:00:00-05:00'],
    ['love', '2027-02-14T23:30:00-05:00'],
    ['pretzel', '2027-04-26T12:00:00-04:00'],
    ['liberty-bell', '2027-06-19T12:00:00-04:00'],
    ['liberty-bell', '2027-07-04T21:00:00-04:00'],
    ['eastern-state', '2027-10-24T12:00:00-04:00'],
    ['eastern-state', '2027-10-31T23:30:00-04:00'],
    ['boathouse-row', '2027-12-01T12:00:00-05:00'],
    ['boathouse-row', '2027-12-30T23:30:00-05:00'],
  ])('shows the %s set at %s', (set, instant) => {
    expect(iconsAt(instant)).toEqual(iconSet(set));
  });

  it.each([
    '2027-01-03T00:30:00-05:00',
    '2027-01-31T23:30:00-05:00',
    '2027-02-15T00:30:00-05:00',
    '2027-04-25T23:30:00-04:00',
    '2027-04-27T00:30:00-04:00',
    '2027-06-18T23:30:00-04:00',
    '2027-07-05T00:30:00-04:00',
    '2027-10-23T23:30:00-04:00',
    '2027-11-01T00:30:00-04:00',
    '2027-11-30T23:30:00-05:00',
  ])('keeps the City Hall icons at %s', (instant) => {
    expect(iconsAt(instant)).toEqual(TOWER);
  });

  it('uses Philadelphia time, not UTC', () => {
    // 03:00 UTC on Feb 15 is still 10pm Feb 14 in Philadelphia.
    expect(iconsAt('2027-02-15T03:00:00Z')).toEqual(iconSet('love'));
    // 02:00 UTC on Feb 1 is still Jan 31 in Philadelphia.
    expect(iconsAt('2027-02-01T02:00:00Z')).toEqual(TOWER);
    // 03:00 UTC on Jan 1 is still New Year's Eve in Philadelphia.
    expect(iconsAt('2028-01-01T03:00:00Z')).toEqual(iconSet('mummers'));
  });

  it.each(SETS)('ships every asset of the %s set', (set) => {
    for (const href of iconSet(set)) {
      expect(() => readFileSync(resolve(__dirname, '../../public', href.slice(1)))).not.toThrow();
    }
  });

  it('names only sets that ship', () => {
    const named = [...swapScript.matchAll(/\[\d+, \d+, \d+, \d+, '([\w-]+)'\]/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(0);
    expect(new Set(named)).toEqual(new Set(SETS));
  });
});
