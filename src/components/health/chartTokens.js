// Shared color tokens for the homepage health dashboard. Category colors carry
// the same meaning as the dots on the alert lists below (red disruptions,
// amber delays, gray planned work) so a reader learns them once. Red/amber were
// checked for color-vision separation in both themes; planned work is the
// deliberately recessive gray, and every chart pairs color with a legend,
// icon, or label so no reading depends on hue alone.
//
// Written as literal class strings (not built from parts) so Tailwind's
// content scan keeps them in the build.

export const CATEGORY_BAR = {
  disruption: 'bg-red-500',
  delay: 'bg-amber-500',
  planned: 'bg-slate-400 dark:bg-slate-500',
};

// Single-series accent (one color for every bar in a one-measure chart) and
// the de-emphasis gray for context marks.
export const ACCENT_BAR = 'bg-blue-500';
export const MUTED_BAR = 'bg-slate-300 dark:bg-slate-600';

// Mode status → badge styling (tinted pill; the icon and label carry meaning).
export const STATUS_BADGE = {
  good: 'bg-green-50 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-400 dark:border-green-900',
  warning:
    'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900',
  serious:
    'bg-orange-50 text-orange-800 border-orange-200 dark:bg-orange-950/40 dark:text-orange-300 dark:border-orange-900',
  critical:
    'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900',
};

// Thin accent stripe across the top of a mode tile.
export const STATUS_STRIPE = {
  good: 'bg-green-500',
  warning: 'bg-amber-500',
  serious: 'bg-orange-500',
  critical: 'bg-red-500',
};

// Filled disc behind a line's status glyph on the line board.
export const CATEGORY_DISC = {
  disruption: 'bg-red-500 text-white',
  delay: 'bg-amber-500 text-slate-900',
  planned: 'bg-slate-500 text-white dark:bg-slate-400 dark:text-slate-900',
};
