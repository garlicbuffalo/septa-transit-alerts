// HTML → plain text for SEPTA alert bodies. SEPTA's CMS emits Word-pasted
// markup (nested <span class="TextRun …">), entity-encoded punctuation, and
// non-breaking spaces; the published `description` is plain text so every
// consumer (site, feeds, CSV) can render it without sanitizing HTML.

const NAMED = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  bull: '•',
  middot: '·',
  eacute: 'é',
  copy: '©',
  reg: '®',
  trade: '™',
};

/** Decode HTML character references (named subset + all numeric forms). */
export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref) => {
    if (ref[0] === '#') {
      const code =
        ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : Number(ref.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED[ref.toLowerCase()] ?? whole;
  });
}

/**
 * Flatten an HTML fragment to readable plain text. Block boundaries (</p>,
 * <br>, </li>) become line breaks; list items get a bullet; runs of whitespace
 * collapse. Returns '' for empty input.
 * @param {string | null | undefined} html
 * @returns {string}
 */
export function htmlToText(html) {
  if (!html) return '';
  const text = String(html)
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '\n• ')
    .replace(/<\/\s*(p|div|li|ul|ol|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '');
  return decodeEntities(text)
    .replace(/ /g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/** Lowercase, hyphenated URL slug ("8th-Market" → "8th-market"). */
export function slugify(s) {
  const slug = String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || null;
}
