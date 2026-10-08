import { describe, expect, it } from 'vitest';
import { activeNavKey } from '../lib/nav.js';

describe('activeNavKey', () => {
  it('lights up Routes for the route pages, the directory, and the system map', () => {
    for (const path of ['/routes', '/map', '/map/', '/line/l1', '/route/17', '/rail/line/pao']) {
      expect(activeNavKey(path)).toBe('routes');
    }
  });

  it('does not take other paths that start the same way', () => {
    expect(activeNavKey('/mapping')).toBeNull();
    expect(activeNavKey('/stations')).toBe('stations');
    expect(activeNavKey('/')).toBe('now');
  });
});
