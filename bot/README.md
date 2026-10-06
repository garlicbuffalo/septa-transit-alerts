# SEPTA Transit Alerts bots

The always-on half of the project. It runs on a small server and:

- **Collects.** It polls SEPTA's vehicle positions every minute and runs the collector (`../collector/`) every two minutes, a 5× tighter loop than the GitHub Actions schedule.
- **Posts to Bluesky.** It uses four accounts, one per stream:

  | Account | Posts |
  |---|---|
  | `alerts` | SEPTA's significant alerts, with a map when the alert names a stretch of line, and a threaded ✅ reply when SEPTA clears them |
  | `metro` | SEPTA Metro gaps, bunching, stuck vehicles, and silent routes, each with a map; an hourly roundup of routes with vehicles missing from the tracker |
  | `bus` | The same for buses, plus clusters of several routes' buses stopped together |
  | `rail` | Regional Rail delays, cancellations, speed maps, and recaps *(phase 4)* |

- **Publishes the site's data.** It pushes the `data` branch and triggers deploys, and links every incident to its Bluesky post. While the server publishes, the [collect workflow](../.github/workflows/collect.yml) stands down. If the server goes quiet for 20 minutes, the workflow takes over again by itself.

Everything defaults to **dry run**. The service collects and renders every post (text, alt text, map) into `/var/lib/septa-bots/assets`, but posts and publishes nothing until you say so.

## Set up a server

You need:

- an Ubuntu 22.04 or 24.04 server (1 vCPU and 2 GB of RAM is plenty, e.g. Hetzner CX22 or a DigitalOcean $6 droplet);
- the four Bluesky accounts, each with an app password;
- a Mapbox public token;
- a fine-grained GitHub token for this repository with **Contents: read and write** and **Actions: read and write**.

1. **Install.** SSH in and run:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/garlicbuffalo/septa-transit-alerts/main/bot/deploy/setup.sh | sudo bash
   ```

   This installs Node.js, ffmpeg, SQLite and fonts, and clones the repo to `/opt/septa-transit-alerts`. It creates the `septa-bots` user and the systemd service, then starts the service in dry-run mode.

2. **Configure.** Fill in the credentials:

   ```sh
   sudo nano /etc/septa-bots.env
   ```

   Every setting is explained in [`septa-bots.env.example`](deploy/septa-bots.env.example).

3. **Check.** `sudo septa-bots check` logs in to each Bluesky account and tests the Mapbox and GitHub tokens.

4. **Apply and watch.**

   ```sh
   sudo systemctl restart septa-bots
   sudo septa-bots logs
   ```

   Each collector tick logs one line, e.g. `collect: 48 active, 0 changed`.

5. **Review dry-run posts.** Would-be posts collect in `/var/lib/septa-bots/assets/<date>/`: a `.json` with the text, plus the image. Alerts that were already up when posting started are never posted, so expect only new ones.

6. **Go live.** Set `BOT_MODE=live` and `PUBLISH=1` in `/etc/septa-bots.env`, then restart.

## Operating it

| | |
|---|---|
| Follow the log | `sudo septa-bots logs` |
| Service status | `sudo septa-bots status` |
| Update to the latest `main` | `sudo septa-bots update` |
| One manual tick | `sudo septa-bots once` |
| Re-render an alert's map | `sudo septa-bots map alert-136615` |
| Stop posting at once | set `BOT_MODE=dry-run`, restart |
| Hand collecting back to GitHub Actions | set `PUBLISH=0`, restart; the workflow resumes within 20 minutes |

**State** lives in `/var/lib/septa-bots`:

| Path | What it holds |
|---|---|
| `bots.sqlite` | Every post (so restarts never double-post and threads continue), recent vehicle positions, cooldowns |
| `data/` | The checkout of the `data` branch |
| `cache/` | The daily GTFS schedule index |
| `bluesky-sessions/` | Cached logins, so the accounts stay under Bluesky's login limits |
| `assets/` | Dry-run output, kept 7 days |
| `backups/` | A nightly copy of the database, last 7 kept |

**Rebuilding a server:** run the setup command on a new one and copy `/etc/septa-bots.env` and `/var/lib/septa-bots/bots.sqlite` across. The post history keeps the new server from posting anything twice. Without the database it still won't flood the feed, because it never posts anything first seen before it started.

## How it works

```
main.js            scheduler: observe (1 min), collect (2 min), housekeeping, backup
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
map/               Mapbox basemap + SVG overlay rendering (projection, drawing, line and route maps)
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

Each route gets at most one post per kind per hour, and a few per day: 3 gaps, 3 bunches, 4 stuck-vehicle posts and 3 silent stretches. A detection 25% worse than everything already posted for the route that day posts anyway. Posts carry history callouts ("📊 2nd Route 23 gap reported today · biggest gap vs schedule on this route in 30 days"). When a detection is attached to a SEPTA alert, the alerts account quotes it into that alert's thread, up to 3 per thread.

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
- cleared replies with a `/resolved` link card.

cta-insights is licensed under the ISC license:

> Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.
>
> THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

Map tiles: © Mapbox © OpenStreetMap contributors.
