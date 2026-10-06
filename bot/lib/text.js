// Post text helpers: Bluesky's 300-grapheme limit, sentence-aware truncation,
// and rich-text link facets (byte offsets into the UTF-8 text).

export const POST_MAX_GRAPHEMES = 300;

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** Length as Bluesky counts it (user-perceived characters). */
export function graphemeLength(text) {
  let n = 0;
  for (const _ of segmenter.segment(text)) n++;
  return n;
}

/** Cut to at most `max` graphemes, ending with "…" when shortened. */
export function truncateGraphemes(text, max) {
  if (graphemeLength(text) <= max) return text;
  const parts = [];
  for (const { segment } of segmenter.segment(text)) {
    if (parts.length >= max - 1) break;
    parts.push(segment);
  }
  return `${parts.join('').trimEnd()}…`;
}

// Words ending in "." that don't end a sentence: initials ("William H.") and
// the abbreviations SEPTA's alerts use.
const ABBREVIATION =
  /(?:^|\s)(?:[A-Z]|St|Ave|Av|Rd|Dr|Blvd|Pk|Pkwy|Mt|Jr|Sr|No|Jan|Feb|Mar|Apr|Aug|Sept?|Oct|Nov|Dec|approx|vs|e\.g|i\.e)\.$/;

/** Index of the last sentence-ending punctuation followed by a space, or -1. */
function lastSentenceEnd(text) {
  for (let i = text.length - 2; i > 0; i--) {
    const ch = text[i];
    if ((ch === '.' || ch === '!' || ch === '?') && text[i + 1] === ' ') {
      if (ch === '.' && ABBREVIATION.test(text.slice(Math.max(0, i - 8), i + 1))) continue;
      return i;
    }
  }
  return -1;
}

/**
 * Shorten prose to at most `max` graphemes, preferring to end on a sentence
 * boundary, then a word boundary, then a hard cut with "…".
 */
export function truncateSentence(text, max) {
  const clean = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (graphemeLength(clean) <= max) return clean;
  const head = truncateGraphemes(clean, max + 1).slice(0, -1);
  const sentenceEnd = lastSentenceEnd(head);
  if (sentenceEnd >= max * 0.4) return head.slice(0, sentenceEnd + 1);
  const space = head.lastIndexOf(' ');
  const cut = space >= max * 0.6 ? head.slice(0, space) : head.slice(0, max - 1);
  return `${cut.replace(/[\s,;:–—-]+$/, '')}…`;
}

/** First text that fits in one post, from most to least detailed. */
export function firstThatFits(candidates, max = POST_MAX_GRAPHEMES) {
  for (const c of candidates) if (c && graphemeLength(c) <= max) return c;
  return truncateGraphemes(candidates.filter(Boolean).at(-1) ?? '', max);
}

const byteLength = (s) => Buffer.byteLength(s, 'utf8');

/**
 * Link facets for each `{ text, uri }` whose text appears in the post (first
 * occurrence), so domains like "septa.org" and site URLs are tappable.
 * @param {string} text
 * @param {Array<{ text: string, uri: string }>} links
 */
export function linkFacets(text, links) {
  const facets = [];
  for (const { text: needle, uri } of links) {
    if (!needle || !uri) continue;
    const idx = text.indexOf(needle);
    if (idx < 0) continue;
    facets.push({
      index: {
        byteStart: byteLength(text.slice(0, idx)),
        byteEnd: byteLength(text.slice(0, idx + needle.length)),
      },
      features: [{ $type: 'app.bsky.richtext.facet#link', uri }],
    });
  }
  return facets.sort((a, b) => a.index.byteStart - b.index.byteStart);
}

/** "1st", "2nd", "3rd", "11th", … */
export function ordinal(n) {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th'}`;
}
