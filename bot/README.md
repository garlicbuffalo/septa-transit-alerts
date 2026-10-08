# SEPTA Transit Alerts bots

The always-on half of the project. It runs on a small server and:

- **Collects.** It polls SEPTA's vehicle positions every minute and runs the collector (`../collector/`) every two minutes, a 5× tighter loop than the GitHub Actions schedule.
- **Posts to Bluesky.** It uses four accounts, one per stream:

  | Account | Posts |
  |---|---|
  | `alerts` (titled "insights") | SEPTA's significant alerts, with a map when the alert names a stretch of line, and a threaded ✅ reply when SEPTA clears them; a daily and a weekly system digest; rough-hour callouts; reposts of the other accounts' standout posts |
  | `metro` | SEPTA Metro gaps, bunching, stuck vehicles, and silent routes, each with a map; an hourly roundup of routes with vehicles missing from the tracker; cancelled-trip roundups; timelapse videos; speed maps; weekly and monthly bunching and gap recaps; a weekly Hall of Fame and Wall of Shame |
  | `bus` | The same for buses, plus clusters of several routes' buses stopped together |
  | `rail` | An hourly roundup of Regional Rail cancellations and 15+ min delays; speed maps; weekly and monthly on-time recaps with a chart by line; a weekly Hall of Fame and Wall of Shame |

- **Publishes the site's data.** It pushes the `data` branch and triggers deploys, and links every incident to its Bluesky post. While the server publishes, the [collect workflow](../.github/workflows/collect.yml) stands down. If the server goes quiet for 20 minutes, the workflow's next scheduled run takes over again by itself (GitHub's cron can be slow to fire; *Actions → Collect SEPTA data → Run workflow* takes over at once).

Everything defaults to **dry run**. The service collects and renders every post (text, alt text, map) into `/var/lib/septa-bots/assets`, but posts and publishes nothing until you say so.

## Set up a server

You need:

- an Ubuntu 22.04 or 24.04 server (1 vCPU and 2 GB of RAM is plenty, e.g. Hetzner CX22 or a DigitalOcean $6 droplet);
- the four Bluesky accounts, each with an app password and a verified email address (Bluesky only takes videos from verified accounts);
- a CARTO API key for the maps (free), or the address of the [septa-tracker](https://github.com/garlicbuffalo/septa-tracker) relay's `/api/tiles` — see [Maps](#maps). A Mapbox public token still works as a fallback;
- a fine-grained GitHub token for this repository with **Contents: read and write** and **Actions: read and write**.

1. **Install.** SSH in and run:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/garlicbuffalo/septa-transit-alerts/main/bot/deploy/setup.sh | sudo bash
   ```

   This installs Node.js, ffmpeg (for the timelapses), SQLite and fonts, and clones the repo to `/opt/septa-transit-alerts`. It creates the `septa-bots` user and the systemd service, then starts the service in dry-run mode.

2. **Configure.** Fill in the credentials:

   ```sh
   sudo nano /etc/septa-bots.env
   ```

   Every setting is explained in [`septa-bots.env.example`](deploy/septa-bots.env.example).

3. **Check.** `sudo septa-bots check` logs in to each Bluesky account and tests the map tiles (it fetches one) and the GitHub token.

4. **Apply and watch.**

   ```sh
   sudo systemctl restart septa-bots
   sudo septa-bots logs
   ```

   Each collector tick logs one line, e.g. `collect: 48 active, 0 changed`.

5. **Review dry-run posts.** Would-be posts collect in `/var/lib/septa-bots/assets/<date>/`: a `.json` with the text, plus the image or video. Alerts that were already up when posting started are never posted, so expect only new ones. `sudo septa-bots snapshot 3` records a 3-minute system timelapse right away, to check videos render.

6. **Go live.** Set `BOT_MODE=live` and `PUBLISH=1` in `/etc/septa-bots.env`, then restart.

## Maps

The maps in the posts are the CARTO dark map the site uses. CARTO wants an API key, and the bots can get tiles one of two ways:

- **`CARTO_KEY`**: a CARTO key, to fetch from CARTO directly. It can be the same key as the site's `CARTO_KEY` repository variable, or a key of its own for this server (get one free at [carto.com/basemaps/apikey](https://carto.com/basemaps/apikey/); one limited to the server's IP never has to leave it). A key limited to a domain is sent the Referer a browser on that domain would send: the site's `SITE_URL`, or `CARTO_REFERER` if you set it.
- **`TILES_URL`**: instead of a key, the septa-tracker's tile relay, `https://<the tracker's domain>/api/tiles`, which holds a key as a Cloudflare secret.

Each map's tiles are fetched (@2x), stitched to the map's own projection with sharp, and cropped to the image; a credit is drawn in the corner. If CARTO can't be reached and `MAPBOX_TOKEN` is set, that map comes from Mapbox instead; a map that can't get a basemap at all is posted without its image, as before. With none of the three settings, maps render on a plain background. `sudo septa-bots check` fetches one tile, and the service logs which source it's using when it starts. CARTO answers a key it doesn't accept with an ordinary image stamped "API KEY REQUIRED", which `check` can't tell from a good tile: look at a map (`sudo septa-bots map alert-136615`) after setting a key.

## Operating it

| | |
|---|---|
| Follow the log | `sudo septa-bots logs` |
| Service status | `sudo septa-bots status` |
| Update to the latest `main` | `sudo septa-bots update` |
| One manual tick | `sudo septa-bots once` |
| Re-render an alert's map | `sudo septa-bots map alert-136615` |
| Record and post the system timelapses now | `sudo septa-bots snapshot` (15 minutes; `snapshot 3` for 3) |
| Post a speed map now | `sudo septa-bots speedmap bus` (or `metro`, `rail`) |
| Post a recap now | `sudo septa-bots recap rail week` (`bus`, `metro`, `rail`; `week` or `month`) |
| Post a Hall of Fame thread now | `sudo septa-bots halloffame bus` (`bus`, `metro`, `rail`) |
| Post the insights digest now | `sudo septa-bots digest day` (or `week`) |
| Turn videos off | set `VIDEOS=0`, restart |
| Stop posting at once | set `BOT_MODE=dry-run`, restart |
| Hand collecting back to GitHub Actions | set `PUBLISH=0`, restart, then run *Actions → Collect SEPTA data → Run workflow* (or wait 20+ minutes for its schedule) |

**State** lives in `/var/lib/septa-bots`:

| Path | What it holds |
|---|---|
| `bots.sqlite` | Every post (so restarts never double-post and threads continue), recent vehicle positions, cooldowns, timelapse recordings, a year of Regional Rail train tallies, speed map history, every detection seen (for the recaps) |
| `data/` | The checkout of the `data` branch |
| `cache/` | The daily GTFS schedule index |
| `bluesky-sessions/` | Cached logins, so the accounts stay under Bluesky's login limits |
| `assets/` | Dry-run output, kept 7 days |
| `backups/` | A nightly copy of the database, last 7 kept |

**Rebuilding a server:** run the setup command on a new one and copy `/etc/septa-bots.env` and `/var/lib/septa-bots/bots.sqlite` across. The post history keeps the new server from posting anything twice. Without the database it still won't flood the feed, because it never posts anything first seen before it started.

## How it works

```
main.js            scheduler: observe (1 min), collect (2 min), timelapse sample (15 s) and
                   render (30 s), snapshots, housekeeping, backup
lib/pipeline.js    observe → collect (../collector) → post + link (beforePublish hook) → publish
lib/bluesky.js     Bluesky client: cached sessions, images/video/link cards/quotes, threading, retries
                   + the dry-run client with the same interface
lib/poster.js      posts recorded in SQLite under (subject, kind): never twice, threads continue
lib/publish.js     single-commit push of the data branch ("· server"), debounced deploy dispatch
features/alerts.js which SEPTA alerts post, their text, ✅ cleared replies, links into the data
features/detections.js  gap / bunching / stuck / silent-route posts, caps, follow-ups, quotes
features/ghosts.js      hourly missing-vehicle roundups
features/crossBunching.js  several routes' vehicles stopped together
features/history.js     detection history: daily caps and "📊" callouts
features/rail.js        Regional Rail roundups, the TrainView tally, and on-time recaps
features/timelapse.js   timelapse recordings: start, sample, render, post
features/speedmaps.js   past-hour speeds binned along a route, round-robin
features/speedhistory.js past week's speeds per route, for the site's pages
features/recaps.js      weekly and monthly bunching hotspots and gap charts
features/halloffame.js  weekly Hall of Fame and Wall of Shame: each account's best and worst five routes
features/cancellations.js  twice-daily cancelled-trip roundups
features/insights.js    the insights account: reposts, rough hours, daily and weekly digests
map/               CARTO basemap (tiles stitched in basemap.js) + SVG overlay rendering (projection, drawing, line, route,
                   speed and hotspot maps, bar charts)
video/             timelapses: vehicle tracks, scenes, frame rendering, ffmpeg encoding
lib/shapes.js      route shapes from GTFS (built with the collector's daily schedule)
```

Each feature decides what to post from the collector's incidents. It records what it posted under the incident's id, and writes the post's URL back into the incident (`official_alert.post_url`, `resolved_reply_url`) before the data is published, so the site links each incident to its post. Posts made in dry-run mode are kept separately and never linked.

**Detection posts** (metro and bus accounts) follow the collector's vehicle detections:

| Detection | Post |
|---|---|
| Gap | The last vehicle seen (L) and the next one up (N) on the route map, the empty stretch between them dashed |
| Bunching | The vehicles numbered from the lead one, with how late or early each is running |
| Stuck vehicles | The stopped vehicles, then hourly "still stopped" replies and a ✅ when they move |
| Silent route | How long the route has had nothing on the tracker, then hourly replies and a ✅ |
| Missing vehicles | One roundup per account at 7 past each hour, listing the routes that opened in the last hour |
| Cross-route cluster | 4+ vehicles from 2+ routes stopped together (bot-only, not a site incident) |

**Timelapses.** After a gap, bunching, or cluster post, the bot follows the vehicles in it for 10 minutes, polling their route every 15 seconds, and replies with a 10-second video: the vehicles numbered (or L and N) as on the map, with trails, the route's other vehicles as dots, and a live readout. The reply says what happened: "Still bunched: 3 buses within 520 ft (was 370 ft)", "The buses spread out: 370 ft → 0.42 mi from first to last", "The gap between #3787 (L) and #3314 (N) went from 2.40 mi to 2.10 mi", or "3 of the 4 buses had moved on". At 8 and 11 AM and 2, 5, and 8 PM, each account also posts a 15-minute system timelapse: every tracked bus, or every Metro trolley and M1 car, colored by how late it's running. Bluesky caps video uploads per account per day, so each account gets at most one timelapse reply per kind per hour and 20 videos a day in all (`VIDEO_DAILY_CAP`), 5 of them kept for the snapshots.

Each route gets at most one post per kind per hour, and a few per day: 3 gaps, 3 bunches, 4 stuck-vehicle posts and 3 silent stretches. A detection 25% worse than everything already posted for the route that day posts anyway. Posts carry history callouts ("📊 2nd Route 23 gap reported today · biggest gap vs schedule on this route in 30 days"). When a detection is attached to a SEPTA alert, the alerts account quotes it into that alert's thread, up to 3 per thread.

**Speed maps.** Every two hours from morning to evening, each account maps how fast its vehicles moved along one route or line over the past hour: buses (bus account), trolleys and the M1 (metro), Regional Rail lines (rail). Speeds come from each vehicle's consecutive positions, binned along the route (40 stretches, or half-mile stretches for Regional Rail) and colored like traffic: red is slow, green is moving well, gray had no data. Layovers at the ends of a route don't count. Routes take turns, least recently mapped first, and a map with data for under 30% of its route is skipped. A route's slowest or fastest map in 14 days gets a "📊" callout.

**Speed history for the site.** Every 10 minutes the server folds the new positions into per-day tallies (distance and time per stretch of each bus, trolley, and M1 route shape, and each Regional Rail line's main alignment in half-mile stretches, in the `speed_bins` table), since observations are kept only 3 days. Hourly, with the data snapshot, it writes the past 7 Philadelphia days' averages to `speeds/<route>.json` (`speeds/rail/<line>.json` for Regional Rail) for the site's route and line pages (a stretch needs 3 readings to show; a direction with data for under 20% of its route is left out). The collector publishes bus route shapes to `shapes/<route>.json` for the route maps, and all bus routes together to `system-map.json` for the site's system map.

**Cancelled trips.** SEPTA publishes each day's cancelled bus and trolley trips ahead of time. At 6:45 AM and 2:45 PM, the bus and metro accounts post the day's count by route ("Route 16: 14 of 120 trips"). The 12 worst routes are listed and the rest summed in one line ("…and 33 more routes, 107 trips"), since SEPTA can cancel 250+ bus trips on 45 routes in a day. A day with fewer than 3 cancelled trips gets no post, and each route's incident on the site links to the roundup.

**Recaps.** Sunday mornings (the past week) and on the 1st (the past month), the bus and metro accounts post a map of the places vehicles bunched most often, with bubbles sized by count, and a reply charting the routes with the most long gaps. They count every bunching and gap detection the bot saw, posted or not.

**Hall of Fame and Wall of Shame.** Sundays at noon, after the recaps, each of the bus, metro, and rail accounts posts a thread about the week just ended (Sunday through Saturday): the five best routes or lines with a bar chart, then a reply with the five worst. The rail account ranks Regional Rail lines by on-time share, counted as in its recap (under 15 minutes late and not cancelled, lines with 30+ trains). The bus and metro accounts rank by average speed, each route's distance over its time across the week from the speed tallies behind the site's speed maps, so time at stops counts and layovers at the ends of a route don't; a route needs 300 readings on 3 days of the week to be ranked. Both charts of a thread share one scale. Ten routes or lines are needed to fill both lists; with fewer (Metro has about nine that report positions) the ranking splits evenly, so nothing is in both, and with fewer than six there's no thread. A week the bot saw too little of (speeds on fewer than 5 days, or under 200 trains) gets no thread. The posts aren't highlighted, so the insights account doesn't repost them.

**Regional Rail** (rail account). At 14 past each hour, the bot posts a roundup of the trains SEPTA cancelled and the trains running 15+ minutes late that the collector picked up in the hour before, worst delays first, threaded when it runs long. It's silent when there were none, and each train's incident on the site links to the roundup. Every Sunday (the past week) and on the 1st (the past month), a recap gives the share of trains on time (under 15 minutes late and not cancelled), the three least reliable lines, cancellations, and the worst delay, with a bar chart of every line. The recaps count every train on SEPTA's TrainView as the server polls it, not just the ones that were posted.

**Insights** (alerts account, titled "insights" on Bluesky). Besides SEPTA's alerts, the account posts the system-wide picture:

| Post | When |
|---|---|
| Reposts | The other accounts' standout posts: weekly and monthly recaps, cross-route clusters, detections that are a route's worst in 30 days, a route's slowest speed map in 14 days, and the 5 PM system timelapses. One per tick, at most 3 an hour and 10 a day; a post not reposted within 3 hours is let go. Nothing from before the feature first ran is reposted. |
| Rough hour | 10 past the hour, when the hour that just ended brought at least 12 new disruptions across SEPTA (unplanned alerts, gaps, bunching, stuck or missing vehicles, late or cancelled trains), at least 1.5× the usual for that hour, and more than at that hour on any comparable day (weekday, Saturday, or Sunday) in the past 4 weeks. Needs 8 comparable weekdays (3 Saturdays or Sundays) of history; at most one every 3 hours and 2 a day. |
| Daily digest | 9:30 PM: the day's unplanned SEPTA alerts, cancelled bus and Metro trips, long gaps and bunching, Regional Rail's on-time share, elevators out, and the hardest-hit routes, linking to the site's day page. A 📈 line names what stood out against the past 30 days ("Most cancelled trips in 30 days, 3× a usual weekday"), or 📉 a calmer day than usual. |
| Weekly digest | Sunday at 11 AM: the same for the Sunday–Saturday week just ended, against the 8 weeks before, linking to the site's week page. |

Each feature marks its standout posts (`highlight` in the posts table) and the insights account reposts them. The digests and rough hours count from the site's archive, the same incidents the site shows, so their comparisons work from the archive's first day: an alert counts when the account would post it and it isn't planned work, and an earlier day or week counts only once the source behind a figure was running and the collector recorded something every day of it.

**Which alerts post:**

| Kind | Posts? |
|---|---|
| SEPTA real-time alerts | Always |
| Planned advisories | Only when riders must plan around them (shuttle buses, closed stations, suspensions, delays), never platform-boarding or bus-stop notices |
| Detours | Only for unplanned causes (police activity, fire, crashes), not construction |

An alert must be missing from SEPTA's feed for two polls spanning at least 4 minutes before it counts as cleared, so a feed blip doesn't produce a premature ✅.

## Development

```sh
npm ci --prefix bot
npm run test:bot                                    # from the repo root
STATE_DIR=bot-state node bot/cli.js once            # one dry-run tick against live SEPTA data
FIXTURES_DIR=collector/test/fixtures STATE_DIR=bot-state node bot/cli.js once   # offline
```

A dry run never publishes. Publishing needs both `PUBLISH=1` and `BOT_GITHUB_TOKEN`; a stray `GITHUB_TOKEN` in your shell is ignored.

## Credits

The bots are a port of [cta-insights](https://github.com/cailinpitt/cta-insights) by Cailin Pitt, the Bluesky bots behind [Chicago Transit Alerts](https://chicagotransitalerts.app). Its design and much of its approach are adapted here for SEPTA:

- cached Bluesky sessions;
- linear reply threads;
- posting that's recorded so it never repeats;
- segment maps for alerts;
- cleared replies with a `/resolved` link card;
- timelapse videos (frame interpolation, dropout bridging, comet trails, and the ffmpeg settings).

cta-insights is licensed under the ISC license:

> Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.
>
> THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

Map tiles: © OpenStreetMap contributors © CARTO (each map carries the credit); Mapbox's maps, if used as the fallback, carry theirs.
