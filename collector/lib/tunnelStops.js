// The subway-surface trolley tunnel, from either portal to 13th St, as its GTFS stops are named.
// Its own file so the schedule index (schedule.js) can keep these stops' times without loading
// the placement code (trolleyTunnel.js).

/** The trolley lines that run through the tunnel. */
export const TUNNEL_ROUTES = ['t1', 't2', 't3', 't4', 't5'];

/** Where each line goes underground: the T1 at 36th St, the others at 40th St. */
export const TUNNEL_PORTALS = {
  t1: { name: '36th St Portal', lat: 39.95534, lon: -75.19416 },
  t2: { name: '40th St Portal', lat: 39.94953, lon: -75.20333 },
  t3: { name: '40th St Portal', lat: 39.94953, lon: -75.20333 },
  t4: { name: '40th St Portal', lat: 39.94953, lon: -75.20333 },
  t5: { name: '40th St Portal', lat: 39.94953, lon: -75.20333 },
};

/** The tunnel's stops, the portals included. */
export const TUNNEL_STOP_NAMES = new Set([
  '36th St Portal',
  '40th St Portal',
  '37th-Spruce',
  '36th-Sansom',
  '33rd St',
  'Drexel Station at 30th St',
  '22nd St',
  '19th St',
  '15th St/City Hall',
  '13th St',
]);
