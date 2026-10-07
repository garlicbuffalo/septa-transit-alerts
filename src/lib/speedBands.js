// How fast is "slow": the color bands the speed maps use, shared by the site's
// route and line pages and the bots' posted maps (whose post text uses the
// emoji as its legend). Road vehicles are buses, trolleys, and the M1.

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
};

export const NO_DATA_COLOR = '#4a4a48';

export const bandFor = (bands, mph) => bands.find((b) => mph < b.below) ?? bands.at(-1);
