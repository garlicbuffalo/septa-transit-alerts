import { describe, expect, it } from 'vitest';
import {
  firstThatFits,
  graphemeLength,
  linkFacets,
  ordinal,
  truncateGraphemes,
  truncateSentence,
} from '../lib/text.js';

describe('post text', () => {
  it('counts emoji as single graphemes', () => {
    expect(graphemeLength('🚇⚠️ L1')).toBe(5);
    expect(graphemeLength('👨‍👩‍👧')).toBe(1);
  });

  it('truncates to a grapheme budget with an ellipsis', () => {
    expect(truncateGraphemes('abcdef', 4)).toBe('abc…');
    expect(truncateGraphemes('abc', 4)).toBe('abc');
  });

  it('ends on a sentence boundary, not an initial', () => {
    const text =
      'Due to an Amtrak project near William H. Gray III 30th St Station, trains may be delayed up to 10 minutes. Please plan ahead.';
    expect(truncateSentence(text, 110)).toBe(
      'Due to an Amtrak project near William H. Gray III 30th St Station, trains may be delayed up to 10 minutes.',
    );
  });

  it('falls back to a word boundary', () => {
    expect(truncateSentence('one two three four five six seven', 20)).toBe('one two three four…');
  });

  it('picks the first candidate that fits', () => {
    expect(firstThatFits(['x'.repeat(400), 'short'])).toBe('short');
    expect(graphemeLength(firstThatFits(['x'.repeat(400)]))).toBe(300);
  });

  it('builds link facets with UTF-8 byte offsets', () => {
    const text = '🚇⚠️ Delays. Per SEPTA · septa.org';
    const [facet] = linkFacets(text, [{ text: 'septa.org', uri: 'https://www.septa.org/' }]);
    const bytes = Buffer.from(text, 'utf8');
    expect(bytes.subarray(facet.index.byteStart, facet.index.byteEnd).toString('utf8')).toBe(
      'septa.org',
    );
    expect(facet.features[0].uri).toBe('https://www.septa.org/');
  });

  it('formats ordinals', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 103].map(ordinal)).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
      '11th',
      '12th',
      '13th',
      '21st',
      '22nd',
      '103rd',
    ]);
  });
});
