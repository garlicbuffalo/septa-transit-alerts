// How fast is "slow": the color bands the speed maps use, shared by the site's
// route and line pages and the bots' posted maps (whose post text uses the
// emoji as its legend). Road vehicles are buses and trolleys. The M1, formerly
// the Norristown High-Speed Line, runs on its own right of way at up to about
// 50 mph, so it has its own bands: stopping at stations holds its stretch
// averages to 10-40 mph (a week's stretches: none at 45+, a few at 35-45).

export const SPEED_BANDS = {
  road: [
    { below: 5, color: '#ff2a2a', emoji: '🟥', label: 'under 5 mph' },
    { below: 10, color: '#ff8c1a', emoji: '🟧', label: '5–10' },
    { below: 15, color: '#ffd21a', emoji: '🟨', label: '10–15' },
    { below: Infinity, color: '#2ad17f', emoji: '🟩', label: '15+ mph' },
  ],
  rail: [
    { below: 15, color: '#ff2a2a', emoji: '🟥', label: 'under 15 mph' },
    { below: 25, color: '#ff8c1a', emoji: '🟧', label: '15–25' },
    { below: 35, color: '#ffd21a', emoji: '🟨', label: '25–35' },
    { below: 45, color: '#a855f7', emoji: '🟪', label: '35–45' },
    { below: Infinity, color: '#2ad17f', emoji: '🟩', label: '45+ mph' },
  ],
  m1: [
    { below: 10, color: '#ff2a2a', emoji: '🟥', label: 'under 10 mph' },
    { below: 20, color: '#ff8c1a', emoji: '🟧', label: '10–20' },
    { below: 30, color: '#ffd21a', emoji: '🟨', label: '20–30' },
    { below: 40, color: '#a855f7', emoji: '🟪', label: '30–40' },
    { below: Infinity, color: '#2ad17f', emoji: '🟩', label: '40+ mph' },
  ],
};

/** The bands for a route: `kind` is 'rail', 'metro' or 'bus', `route` its id (m1, t1, 17...). */
export const bandsFor = (kind, route) => {
  if (kind === 'rail') return SPEED_BANDS.rail;
  if (kind === 'metro' && route === 'm1') return SPEED_BANDS.m1;
  return SPEED_BANDS.road;
};

export const NO_DATA_COLOR = '#4a4a48';

export const bandFor = (bands, mph) => bands.find((b) => mph < b.below) ?? bands.at(-1);
