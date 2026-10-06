# Data API Changelog

Breaking and notable changes to the published data under `/data/` —
`alerts-recent.json`, the monthly `alerts/<YYYY-MM>.json` shards,
`incidents/by-line/<key>.json`, `alerts-index.json`, `aggregates.json`,
`daily-counts.json`, `accessibility.json`, and `alerts.csv` — and to the
syndication feeds (`/feed.xml` and the per-line/route feeds under `/feed/`).
Newest first. If you build on this data, watch this file before pinning to the
format.

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
