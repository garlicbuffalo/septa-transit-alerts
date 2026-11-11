# Data API Changelog

Breaking and notable changes to the published data under `/data/` —
`alerts-recent.json`, the monthly `alerts/<YYYY-MM>.json` shards,
`incidents/by-line/<key>.json`, `alerts-index.json`, `aggregates.json`,
`daily-counts.json`, `accessibility.json`, `shapes/<route>.json`,
`system-map.json`, `pcc.json`, `speeds/<route>.json`, `speeds/rail/<line>.json`,
`schedule-changes.json`, `scorecards.json`, `rail-trains.json`, `slow-zones.json`, and `alerts.csv` — and to the
syndication feeds (`/feed.xml` and the per-line/route feeds under `/feed/`).
Newest first. If you build on this data, watch this file before pinning to the
format.

## 2026-11-11 — Schedule changes, scorecards, train records, slow zones

Four new files. All carry `schema_version: 1` and `generated_at`; the last
three come from the bot server, so they're absent when only the GitHub Actions
collector is running.

- New **`schedule-changes.json`** (collector, rewritten when the schedule index
  is rebuilt, about daily): what SEPTA's published **bus and Metro** timetable
  holds. `{ covers: ["bus", "metro"], feed_version, feed_start, feed_end,
  periods: [{ start, end, totals: { weekday, saturday, sunday } }], changes:
  [...], special_days: [...] }`. Dates are `YYYY-MM-DD`.
  - `periods` are the stretches between the dates a weekly service starts or
    stops; `totals` are the trips of a typical day of each kind.
  - A `changes` entry compares two periods that follow each other (or a new
    feed with the one it replaces): `{ id, effective, feed_version,
    from_feed_version, detected_ts, totals: { weekday: [before, after], … },
    routes: [{ route, mode, kind: "new" | "ended" | "changed", delta, days: {
    weekday?: { trips: [before, after], first: [before, after], last: [before,
    after] }, saturday?, sunday? } }] }`. `first` and `last` are the first and
    last trip's start in seconds past the service day's midnight (over 86400
    after midnight), null when the route doesn't run. A kind of day is listed
    when its trips differ or a first or last trip moves 10 minutes or more.
    `delta` is the change in trips over a week (a weekday counted five times);
    routes are sorted by its size. Newest `effective` first, kept 180 days.
  - A `special_days` entry is a date in the next 28 days whose service isn't
    its period's typical day of the same kind: `{ date, day_type, holiday,
    trips, typical, like: "sunday" | "saturday" | null, kind: "reduced" |
    "extra" | "routes-off", routes_off: [route, …] }`.
- New **`scorecards.json`**: `{ weights, on_time, modes: { bus?, metro?, rail?:
  { weeks: [{ from, to, ranked }], latest: { from, to, ranked, entries: [{
  route, rank, score, measures, counts }] }, history: { [route]: [score, …] }
  } } }`. `latest` is the last full Sunday–Saturday week; `history` is each
  route's score by week, aligned with `weeks` (newest first, null when it
  wasn't ranked). `measures` holds what was ranked (`onTime` %, `speed` mph;
  for buses and Metro `cancelled`, `bunching`, `gaps` per 1,000 speed readings;
  for Regional Rail `cancelled` % and `delay` minutes) and `counts` what was
  counted. A mode is absent until a week of it has been scored.
- New **`rail-trains.json`**: `{ on_time_max, from, to, days: [date, …],
  trains: [{ no, line, origin, dest, first_seen_min, seen, ran, on_time, late,
  cancelled, avg_late, worst, daily: [...] }] }` over the 28 service days
  before today's. `daily` is aligned with `days`: the train's worst lateness
  that day in minutes, `-1` cancelled, null not seen. `first_seen_min` is when
  the train usually first shows on TrainView, in minutes past midnight
  (TrainView carries no scheduled times).
- New **`slow-zones.json`**: `{ from_day, to_day, zones: [{ mode, route, dir,
  direction, mph, readings, length_m, name, route_mph, points: [[lat, lon], …]
  }] }`: the slowest two stretches in a row of each direction of each bus and
  Metro route over the past 7 days, the 40 slowest for buses and 12 for Metro.
  `name` is from the stops at the zone's ends, or null.

## 2026-10-11 — PCC trolleys on the G1

- New **`pcc.json`**: the vintage PCC trolleys out on the G1 now, told apart
  from its buses by fleet number (four digits starting with 23):
  `{ schema_version: 1, updated_ts, cars: [{ id, direction, destination,
  next_stop, lat, lon, late_min, first_seen_ts }], buses }`. `direction` is
  `Eastbound`, `Westbound`, or null; `first_seen_ts` is when the car's current
  spell on the line began (a car missing from the feed under 15 minutes keeps
  it); `buses` counts the G1's other tracked vehicles. Rewritten by the
  collector every tick that TransitView comes through, so `updated_ts` says
  how current it is. `cars` is empty when no PCC is out.

## 2026-10-08 — System map shapes

- New **`system-map.json`**: every bus route's lines in one file, for the site's
  system map (`/map`), so it needn't fetch a `shapes/<route>.json` per route:
  `{ schema_version, generated_at, routes: { "<route id>": [[[lat, lon], …], …] } }`.
  A route has one line for each direction that isn't the same street as the
  other (a route that runs the same street both ways has one). Lines are
  simplified to about 3 m (about 100 KB compressed), fine enough to follow a
  street's rounded corners at the map's deepest zoom. Metro routes are left out;
  the site carries those itself. Written by the collector alongside
  `shapes/<route>.json`, whenever it rebuilds its GTFS cache (daily, and at once
  after an update to the collector that changes what the cache holds) or the
  file is missing.

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
