# Data API Changelog

Breaking and notable changes to the published data under `/data/` —
`alerts-recent.json`, the monthly `alerts/<YYYY-MM>.json` shards,
`incidents/by-line/<key>.json`, `alerts-index.json`, `aggregates.json`,
`daily-counts.json`, `accessibility.json`, `shapes/<route>.json`,
`system-map.json`, `speeds/<route>.json`, `speeds/rail/<line>.json`, and `alerts.csv` — and to the
syndication feeds (`/feed.xml` and the per-line/route feeds under `/feed/`).
Newest first. If you build on this data, watch this file before pinning to the
format.

## 2026-10-08 — System map shapes

- New **`system-map.json`**: every bus route's lines in one file, for the site's
  system map (`/map`), so it needn't fetch a `shapes/<route>.json` per route:
  `{ schema_version, generated_at, routes: { "<route id>": [[[lat, lon], …], …] } }`.
  A route has one line for each direction that isn't the same street as the
  other (a route that runs the same street both ways has one), simplified to
  about 20 m. Metro routes are left out; the site carries those itself. Written
  by the collector alongside `shapes/<route>.json`, whenever it rebuilds its GTFS
  cache or the file is missing.

## 2026-10-07 — Stops on route shapes

- **`shapes/<route>.json`** now also covers SEPTA Metro routes (trolleys and the
  M1; also L1 and B1–B3), not just buses, and gains an optional **`stops`**
  object keyed by direction id like `directions`:
  `stops: { "<direction id>": [[lat, lon, name], …] }`, in route order, from a
  trip that runs the direction's shape (names without boarding-position
  suffixes). It is absent from a file until the collector next rebuilds its GTFS
  cache (daily), and for a route with no stop data.

## 2026-10-07 — Route shapes and weekly speeds

- New **`shapes/<route>.json`** (bus routes; the route id is URL-encoded):
  `{ schema_version, route, directions: { "<direction id>": [[lat, lon], …] } }`.
  Each direction's shape from SEPTA's GTFS, simplified to about 15 m. Written by
  the collector whenever it rebuilds its GTFS cache.
- New **`speeds/<route>.json`** (bus routes, trolley lines, and the M1; and
  **`speeds/rail/<line>.json`** for Regional Rail lines, with one direction,
  "Both directions", along the line's main alignment in half-mile stretches;
  written by the bot server only, so absent when the GitHub Actions collector is
  running alone, and for routes with too little tracker data):
  `{ schema_version, mode, route, generated_at, window_days, from_day, to_day,
  days_with_data, directions: [{ id, label, avg_mph, coverage, readings, bin_m,
  mph, n, shape }] }`. `mph[i]` is the past week's average speed (total
  distance over total time) along the i-th `bin_m`-meter stretch of `shape`,
  `null` where there were fewer than 3 readings; `n[i]` is the readings behind
  it. Updated hourly.

## 2026-10-06 — Detection posts and silent routes

- New detection source **`thin-gap`** (id prefix `thin-gap-`): a low-frequency
  bus or Metro route with nothing on SEPTA's tracker for at least an hour (two
  scheduled trips), with `lifecycle.onset_ts` backdated to when the route was
  last seen. `evidence.details`: `{ kind, silent_min, headway_min,
  missed_trips, scheduled }`.
- `gap` and `bunching` details carry `direction_id` (the GTFS direction).
- Vehicle detections now link their Bluesky posts: `detections[].post_url` (the
  metro or bus bot's post, or the hourly rollup listing a missing-vehicles
  detection) and `resolved_post_url` (its ✅ reply, for stuck vehicles and
  silent routes).

## 2026-10-06 — Bluesky post links

- `official_alert.post_url` now links to the alerts bot's Bluesky post of the
  SEPTA alert (`https://bsky.app/profile/<did>/post/<rkey>`), and
  `official_alert.resolved_reply_url` to its threaded "✅ SEPTA has cleared"
  reply. Both stay `null` for alerts the bot didn't post (it posts significant
  alerts only) and for anything from before it started.
- Official alerts now resolve only after being missing from SEPTA's feed for two
  polls at least 4 minutes apart, with `resolved_ts` backdated to the first
  miss, so feed blips no longer close and reopen incidents.
- Bus and Metro detections open after persisting at least 6 minutes (and close
  after 6 minutes absent) rather than after two polls.
- Feeds: entries link "View the post on Bluesky" when there is one, and the JSON
  Feed's `external_url` prefers the Bluesky post over the SEPTA.org page.

## 2026-10-06 — Bus and Metro detections

- **New detection sources** on bus and SEPTA Metro incidents: `gap`, `bunching`,
  `ghost` (missing vehicles), and `pulse-held`, inferred from TransitView vehicle
  positions against SEPTA's GTFS schedule; and `trip-cancellations`, one
  incident per route per service day from SEPTA's GTFS-realtime trip feed
  (`trip-cancellations-<YYYY-MM-DD>-<route>`). Shapes are in
  [`/llms-full.txt`](/llms-full.txt).
- Detections can now attach to an official SEPTA incident on the same route,
  making `sources` `["septa", "bot"]`.
- `daily-counts.json` and `aggregates.json` count the new bot incidents like any
  other incident.

## 2026-10-06 — Initial release

First published version of the SEPTA data, produced by the collector in
`collector/`. The incident shape follows the agency-neutral `schema_version: 2`
model of the Chicago Transit Alerts project this site is adapted from, with
SEPTA's values:

- **`agency`** is always `"septa"`; **`mode`** is `"metro"`, `"bus"`, or
  `"regional_rail"`.
- **`routes`** are lowercase SEPTA Metro keys (`l1`, `b1`, `t3`, …), SEPTA bus
  route ids with spaces hyphenated (`17`, `LUCYGO`, `L1-OWL`), or lowercase
  Regional Rail route codes (`pao`, `wtr`, …).
- **`sources`** name the contributors: `"septa"` (official alert) and/or `"bot"`
  (collector detection).
- **`official_alert`** carries SEPTA's alert: `id` is SEPTA's alert id (`D…` for
  detours), `source_url` links the route's SEPTA.org page (alerts have no
  permalinks), and `septa { type, cause, effect, severity }` echoes SEPTA's own
  classification. `scope` stations are matched from the alert text against
  SEPTA's GTFS station list.
- **`detections[]`** currently carry Regional Rail `delay` and `cancellation`
  detections from SEPTA's TrainView feed, with `status` holding the train
  number, lateness, and schedule anchors.
- **Monthly shards** bucket incidents by their first-seen **America/New_York**
  month.
- **`daily-counts.json`** carries `metro_count`, `bus_count`, `rail_count`, and
  per-line breakdowns `by_line` (Metro), `by_route` (bus), and `by_rail_line`.
- **`aggregates.json`** carries `yoy.by_mode` buckets `metro`, `bus`, and `rail`.
- **`accessibility.json`** lists elevator outages with `mode` `"metro"` or
  `"regional_rail"`.
- **`alerts.csv`** adds a trailing `source_url` column.
