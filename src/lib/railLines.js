// SEPTA Regional Rail line metadata, keyed by the lowercase GTFS route_id
// (`pao`, `wtr`, …). `label` is the line's name as SEPTA writes it, without the
// trailing " Line"; `code` is the three-letter route code SEPTA's own APIs and
// alerts use. SEPTA brands every Regional Rail line with one slate color, so
// `color` is shared — `chartColor` gives each line a distinct hue for charts
// where lines must be told apart.
//
// `trainView` is the line name SEPTA's TrainView API reports for a train on
// that line ("Manayunk/Norristown"), used by the collector to attribute delays
// and cancellations.
export const RAIL_LINES = {
  air: {
    label: 'Airport',
    code: 'AIR',
    color: '#4F758B',
    textColor: '#fff',
    chartColor: '#0E7490',
    trainView: 'Airport',
  },
  che: {
    label: 'Chestnut Hill East',
    code: 'CHE',
    color: '#4F758B',
    textColor: '#fff',
    chartColor: '#15803D',
    trainView: 'Chestnut Hill East',
  },
  chw: {
    label: 'Chestnut Hill West',
    code: 'CHW',
    color: '#4F758B',
    textColor: '#fff',
    chartColor: '#65A30D',
    trainView: 'Chestnut Hill West',
  },
  cyn: {
    label: 'Cynwyd',
    code: 'CYN',
    color: '#4F758B',
    textColor: '#fff',
    chartColor: '#A16207',
    trainView: 'Cynwyd',
  },
  fox: {
    label: 'Fox Chase',
    code: 'FOX',
    color: '#4F758B',
    textColor: '#fff',
    chartColor: '#C2410C',
    trainView: 'Fox Chase',
  },
  lan: {
    label: 'Lansdale/Doylestown',
    code: 'LAN',
    color: '#4F758B',
    textColor: '#fff',
    chartColor: '#B91C1C',
    trainView: 'Lansdale/Doylestown',
  },
  med: {
    label: 'Media/Wawa',
    code: 'MED',
    color: '#4F758B',
    textColor: '#fff',
    chartColor: '#BE185D',
    trainView: 'Media/Wawa',
  },
  nor: {
    label: 'Manayunk/Norristown',
    code: 'NOR',
    color: '#4F758B',
    textColor: '#fff',
    chartColor: '#7E22CE',
    trainView: 'Manayunk/Norristown',
  },
  pao: {
    label: 'Paoli/Thorndale',
    code: 'PAO',
    color: '#4F758B',
    textColor: '#fff',
    chartColor: '#4338CA',
    trainView: 'Paoli/Thorndale',
  },
  tre: {
    label: 'Trenton',
    code: 'TRE',
    color: '#4F758B',
    textColor: '#fff',
    chartColor: '#1D4ED8',
    trainView: 'Trenton',
  },
  war: {
    label: 'Warminster',
    code: 'WAR',
    color: '#4F758B',
    textColor: '#fff',
    chartColor: '#0369A1',
    trainView: 'Warminster',
  },
  wil: {
    label: 'Wilmington/Newark',
    code: 'WIL',
    color: '#4F758B',
    textColor: '#fff',
    chartColor: '#0F766E',
    trainView: 'Wilmington/Newark',
  },
  wtr: {
    label: 'West Trenton',
    code: 'WTR',
    color: '#4F758B',
    textColor: '#fff',
    chartColor: '#475569',
    trainView: 'West Trenton',
  },
};

// Row/display order (alphabetical by route code, matching SEPTA's listings).
export const RAIL_LINE_ORDER = [
  'air',
  'che',
  'chw',
  'cyn',
  'fox',
  'lan',
  'med',
  'nor',
  'pao',
  'tre',
  'war',
  'wil',
  'wtr',
];

/**
 * Lowercase a Regional Rail route code to its web key (`PAO` → `pao`). Safe to
 * call repeatedly; passes null/undefined through.
 * @param {string} key
 * @returns {string}
 */
export function normalizeRailLine(key) {
  return key == null ? key : String(key).toLowerCase();
}

/** Metadata for a Regional Rail line by any-case key, or undefined. */
export function railLineInfo(key) {
  return RAIL_LINES[normalizeRailLine(key)];
}

/** "Paoli/Thorndale Line" — the label plus SEPTA's " Line" suffix. */
export function railLineFullName(key) {
  const info = railLineInfo(key);
  return info ? `${info.label} Line` : String(key ?? '');
}
