import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const shell = readFileSync(resolve(__dirname, '../../index.html'), 'utf8');

// The inline <script> in index.html that swaps in the LOVE icons.
const swapScript = [...shell.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1])
  .find((src) => src.includes('-love'));

const ICON_LINKS = `
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
  <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16.png" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
`;

function iconsAt(isoInstant) {
  vi.setSystemTime(new Date(isoInstant));
  document.head.innerHTML = ICON_LINKS;
  new Function(swapScript)();
  return [...document.head.querySelectorAll('link')].map((l) => l.getAttribute('href'));
}

describe('seasonal LOVE icons', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    document.head.innerHTML = '';
  });

  it('finds the swap script in index.html', () => {
    expect(swapScript).toBeTruthy();
  });

  it('swaps every icon link to the LOVE set from Feb 1 to 14', () => {
    const love = [
      '/favicon-love-32.png',
      '/favicon-love-16.png',
      '/favicon-love.svg',
      '/apple-touch-icon-love.png',
    ];
    expect(iconsAt('2027-02-01T12:00:00-05:00')).toEqual(love);
    expect(iconsAt('2027-02-14T23:30:00-05:00')).toEqual(love);
  });

  it('keeps the City Hall icons the rest of the year', () => {
    const tower = ['/favicon-32.png', '/favicon-16.png', '/favicon.svg', '/apple-touch-icon.png'];
    expect(iconsAt('2027-01-31T23:30:00-05:00')).toEqual(tower);
    expect(iconsAt('2027-02-15T00:30:00-05:00')).toEqual(tower);
    expect(iconsAt('2027-07-04T12:00:00-04:00')).toEqual(tower);
  });

  it('uses Philadelphia time, not UTC', () => {
    // 03:00 UTC on Feb 15 is still 10pm Feb 14 in Philadelphia.
    expect(iconsAt('2027-02-15T03:00:00Z')).toContain('/favicon-love.svg');
    // 02:00 UTC on Feb 1 is still Jan 31 in Philadelphia.
    expect(iconsAt('2027-02-01T02:00:00Z')).toContain('/favicon.svg');
  });

  it('ships every asset the swap points to', () => {
    for (const file of [
      'favicon-love.svg',
      'favicon-love-16.png',
      'favicon-love-32.png',
      'apple-touch-icon-love.png',
    ]) {
      expect(() => readFileSync(resolve(__dirname, '../../public', file))).not.toThrow();
    }
  });
});
