// Primary site navigation, shared by the desktop header links and the mobile
// bottom tab bar so both always list the same destinations. Pages are full
// reloads (no client router), so the active section is derived from the
// current pathname.

export const PRIMARY_NAV = [
  { key: 'now', label: 'Now', desktopLabel: 'Alerts', href: '/', icon: 'pulse' },
  { key: 'routes', label: 'Routes', href: '/routes', icon: 'routes' },
  { key: 'stations', label: 'Stations', href: '/stations', icon: 'pin' },
  { key: 'history', label: 'History', href: '/calendar', icon: 'calendar' },
  { key: 'follow', label: 'Follow', desktopLabel: 'Subscribe', href: '/subscribe', icon: 'bell' },
];

// Which PRIMARY_NAV entry a path belongs to, or null for pages outside the
// tabs (About, Privacy, a 404). Detail pages light up their parent tab: a line
// or route page and the system map sit under Routes, a station page under Stations, and the
// day/week/stats/compare views under History.
export function activeNavKey(pathname) {
  const path = (pathname || '/').replace(/\/+$/, '') || '/';
  if (path === '/' || path.startsWith('/event/') || path.startsWith('/system/')) return 'now';
  if (/^\/(routes|map|line|route|rail\/line)(\/|$)/.test(path)) return 'routes';
  if (/^\/(stations|station|rail\/station)(\/|$)/.test(path)) return 'stations';
  if (/^\/(calendar|day|week|stats|compare)(\/|$)/.test(path)) return 'history';
  if (/^\/subscribe(\/|$)/.test(path)) return 'follow';
  return null;
}

// SEPTA line colors in the order the header stripe shows them: L1, B, M1, T,
// G, D, then Regional Rail. Same palette as the favicon tile grid and the
// Bluesky profile art.
export const LINE_STRIPE = [
  '#0097D6',
  '#F26100',
  '#5F249F',
  '#5A960A',
  '#FFD700',
  '#DC2E6B',
  '#4F758B',
];
