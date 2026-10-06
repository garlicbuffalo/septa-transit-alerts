import { describe, expect, it } from 'vitest';
import { pickTagline, TAGLINES } from '../lib/taglines.js';

describe('pickTagline', () => {
  it('returns one of the taglines', () => {
    expect(TAGLINES).toContain(pickTagline());
  });

  it('never repeats the current tagline', () => {
    for (const current of TAGLINES) {
      expect(pickTagline(current, () => 0.999)).not.toBe(current);
      expect(pickTagline(current, () => 0)).not.toBe(current);
    }
  });
});
