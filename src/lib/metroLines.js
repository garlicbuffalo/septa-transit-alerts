// SEPTA Metro line metadata, keyed by the lowercase GTFS route_id. SEPTA Metro
// is the rail-transit network rebranded in 2024–25: the L (Market-Frankford),
// the B (Broad Street Line and its Broad-Ridge Spur), the M (Norristown High
// Speed Line), and the T, G, and D trolleys. `color` is SEPTA's brand hex from
// GTFS `routes.txt`; `textColor` is chosen for contrast on that background.
//
// `label` is the short route code riders see on signs (and on our pills);
// `name` is the descriptive name used in prose and headings. `formerly` lists
// pre-rebrand names so search ("Route 101", "MFL", "NHSL") still finds a line.
//
// The collector writes these keys verbatim into the published data
// (`routes: ['l1']`); `normalizeMetroLine` lowercases anything that arrives in
// SEPTA's own casing ('L1') so URLs and component keys stay consistent.
export const METRO_LINES = {
  l1: {
    label: 'L1',
    name: 'Market-Frankford Line',
    color: '#0097D6',
    textColor: '#fff',
    formerly: ['MFL', 'Market-Frankford', 'El'],
  },
  b1: {
    label: 'B1',
    name: 'Broad Street Line',
    color: '#F26100',
    textColor: '#fff',
    formerly: ['BSL', 'Broad Street Local'],
  },
  b2: {
    label: 'B2',
    name: 'Broad Street Line Express',
    color: '#F26100',
    textColor: '#fff',
    formerly: ['BSL Express'],
  },
  b3: {
    label: 'B3',
    name: 'Broad-Ridge Spur',
    color: '#F26100',
    textColor: '#fff',
    formerly: ['Broad-Ridge Spur', 'BRS'],
  },
  m1: {
    label: 'M1',
    name: 'Norristown High Speed Line',
    color: '#5F249F',
    textColor: '#fff',
    formerly: ['NHSL', 'Route 100'],
  },
  t1: {
    label: 'T1',
    name: 'Trolley to 63rd-Malvern',
    color: '#5A960A',
    textColor: '#fff',
    formerly: ['Route 10'],
  },
  t2: {
    label: 'T2',
    name: 'Trolley to 61st-Baltimore',
    color: '#5A960A',
    textColor: '#fff',
    formerly: ['Route 34'],
  },
  t3: {
    label: 'T3',
    name: 'Trolley to Yeadon/Darby',
    color: '#5A960A',
    textColor: '#fff',
    formerly: ['Route 13'],
  },
  t4: {
    label: 'T4',
    name: 'Trolley to Darby',
    color: '#5A960A',
    textColor: '#fff',
    formerly: ['Route 11'],
  },
  t5: {
    label: 'T5',
    name: 'Trolley to Eastwick',
    color: '#5A960A',
    textColor: '#fff',
    formerly: ['Route 36'],
  },
  g1: {
    label: 'G1',
    name: 'Girard Ave Trolley',
    color: '#FFD700',
    textColor: '#1A1818',
    formerly: ['Route 15'],
  },
  d1: {
    label: 'D1',
    name: 'Media Trolley',
    color: '#DC2E6B',
    textColor: '#fff',
    formerly: ['Route 101'],
  },
  d2: {
    label: 'D2',
    name: 'Sharon Hill Trolley',
    color: '#DC2E6B',
    textColor: '#fff',
    formerly: ['Route 102'],
  },
};

// Order determines row order in the timeline grid and every line list.
export const METRO_LINE_ORDER = [
  'l1',
  'b1',
  'b2',
  'b3',
  'm1',
  't1',
  't2',
  't3',
  't4',
  't5',
  'g1',
  'd1',
  'd2',
];

/**
 * Normalize a Metro line key to its lowercase web form (`'L1'` → `'l1'`).
 * Safe to call repeatedly; passes null/undefined through and leaves unknown
 * keys otherwise unchanged.
 *
 * @param {string} key
 * @returns {string}
 */
export function normalizeMetroLine(key) {
  if (key == null) return key;
  return String(key).toLowerCase();
}

/** Metadata for a Metro line by any-case key, or undefined. */
export function metroLineInfo(key) {
  return METRO_LINES[normalizeMetroLine(key)];
}

/** "L1 Market-Frankford Line" — the code plus its descriptive name. */
export function metroLineFullName(key) {
  const info = metroLineInfo(key);
  return info ? `${info.label} ${info.name}` : String(key ?? '');
}
