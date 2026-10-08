import { describe, expect, it } from 'vitest';
import { activeNavKey, PRIMARY_NAV } from '../lib/nav.js';

describe('PRIMARY_NAV', () => {
  it('has a tab of its own for the system map, next to Routes', () => {
    const keys = PRIMARY_NAV.map((item) => item.key);
    expect(keys).toEqual(['now', 'routes', 'map', 'stations', 'history', 'follow']);
    expect(PRIMARY_NAV.find((item) => item.key === 'map')).toMatchObject({
      label: 'Map',
      href: '/map',
      icon: 'map',
    });
  });
});

describe('activeNavKey', () => {
  it('lights up Map on the system map, with or without a slash or a query', () => {
    for (const path of ['/map', '/map/']) expect(activeNavKey(path)).toBe('map');
  });

  it('lights up Routes for the route pages and the directory, not for the map', () => {
    for (const path of ['/routes', '/line/l1', '/route/17', '/rail/line/pao']) {
      expect(activeNavKey(path)).toBe('routes');
    }
  });

  it('does not take other paths that start the same way', () => {
    expect(activeNavKey('/mapping')).toBeNull();
    expect(activeNavKey('/stations')).toBe('stations');
    expect(activeNavKey('/')).toBe('now');
  });

  it('gives every tab a destination that lights it up', () => {
    for (const item of PRIMARY_NAV) expect(activeNavKey(item.href)).toBe(item.key);
  });
});
