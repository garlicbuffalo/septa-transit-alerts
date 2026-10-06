// Local color for the footer: one line rides under the site name, picked at
// random on each page load (tap it for another). Keep them affectionate.
export const TAGLINES = [
  // Transit
  'Still calling it the El.',
  'It’s the Broad Street Line, whatever the signs say.',
  'Still calling it the High Speed Line, which it never was.',
  'Yes, there’s a train station called Wawa.',
  'Leaves on the tracks: a Regional Rail fall tradition.',
  'Your train is delayed. Amtrak is involved.',
  'SEPTA Key: tap, pray, tap again.',
  'Survived another Trolley Tunnel Blitz.',
  'Respect to everyone driving the Owl buses.',
  'Somebody is playing a bucket drum at 15th Street.',
  'The 30th Street ceiling is still gorgeous. Your train is still late.',
  'Delays measured in jawns.',
  'Still faster than the Sure-Kill Expressway.',
  'Down the shore traffic not included.',
  // Local legends
  'BONER 4EVER.',
  'Philly Elmo would’ve danced through this delay.',
  'Chicken Man approved.',
  'Gritty did nothing wrong.',
  'Gritty-tested, Billy Penn-approved.',
  'Rocky ran the Art Museum steps because the bus was late.',
  'Ben Franklin would’ve flown a kite to work.',
  'No Mummers were delayed in the making of this site.',
  // Sports
  'Go Birds. Mind the gap.',
  'Fly Eagles Fly. Ride SEPTA slow.',
  'The city has greased the poles.',
  'Trust the process. Also, check the delays.',
  // Food
  'Wooder ice not included.',
  'Wit’ wiz, wit’out delays.',
  'Pat’s or Geno’s? Neither. John’s Roast Pork.',
  'Hoagiefest is a state of mind.',
  'Tastykake break recommended.',
  'Peanut Chews for the platform.',
];

// A random tagline other than `current`, so a tap always changes it.
export function pickTagline(current = null, random = Math.random) {
  const pool = TAGLINES.filter((t) => t !== current);
  return pool[Math.floor(random() * pool.length)];
}
