import { useEffect, useState } from 'react';
import { BUS_ROUTE_NAMES, compareBusRoutes, formatBusRoute } from '../lib/busRoutes.js';
import { dataUrl } from '../lib/dataSource.js';
import { METRO_LINE_ORDER, metroLineFullName } from '../lib/metroLines.js';
import { RAIL_LINE_ORDER, railLineFullName } from '../lib/railLines.js';
import { BLUESKY_ACCOUNTS, SITE_ORIGIN } from '../lib/site.js';

const LINK = 'text-blue-500 hover:text-blue-400 hover:underline';
const FEED_URL = `${SITE_ORIGIN}/feed.xml`;
// The data origin defaults to the site's own /data path; show absolute URLs
// either way so they can be copied into scripts.
const absoluteDataUrl = (file) => {
  const url = dataUrl(file);
  return /^https?:\/\//.test(url) ? url : `${SITE_ORIGIN}${url}`;
};
const CSV_URL = absoluteDataUrl('alerts.csv');
const RECENT_URL = absoluteDataUrl('alerts-recent.json');
const INDEX_URL = absoluteDataUrl('alerts-index.json');
const ACCESSIBILITY_URL = absoluteDataUrl('accessibility.json');
const CHANGELOG_URL = `${SITE_ORIGIN}/data/CHANGELOG.md`;

const CURL_CMD = `curl -s ${RECENT_URL} | jq '.incidents | length'`;

// Picker options for the per-line/route feed chooser. Values are the feed path
// segment after `/feed/` (e.g. `line/l1`, `route/17`, `rail/line/pao`).
const LINE_FEED_OPTIONS = METRO_LINE_ORDER.map((id) => ({
  value: `line/${id}`,
  label: metroLineFullName(id),
}));
const ROUTE_FEED_OPTIONS = Object.keys(BUS_ROUTE_NAMES)
  .sort(compareBusRoutes)
  .map((r) => ({
    value: `route/${r}`,
    label: `${formatBusRoute(r)} · ${BUS_ROUTE_NAMES[r]}`,
  }));
// Regional Rail feeds live under their own namespace (`rail/line/:line`) so a
// Regional Rail key can never collide with a Metro line key or bus route.
const RAIL_FEED_OPTIONS = RAIL_LINE_ORDER.map((id) => ({
  value: `rail/line/${id}`,
  label: railLineFullName(id),
}));

export default function SubscribeContent() {
  const [copied, setCopied] = useState(null);
  const [pickedTransitFeed, setPickedTransitFeed] = useState('line/l1');
  const [pickedRailFeed, setPickedRailFeed] = useState('rail/line/pao');
  const pickedTransitFeedUrl = `${SITE_ORIGIN}/feed/${pickedTransitFeed}.xml`;
  const pickedRailFeedUrl = `${SITE_ORIGIN}/feed/${pickedRailFeed}.xml`;

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = (key, text) => async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
    } catch {
      // Clipboard API can fail in older Safari / restrictive contexts; the
      // text is visible and selectable either way.
    }
  };

  return (
    <div className="space-y-3 text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
      {BLUESKY_ACCOUNTS.length > 0 && (
        <>
          <h3 className="font-semibold text-slate-700 dark:text-slate-200">Follow on Bluesky</h3>
          <p>
            The bots that feed this archive post to Bluesky in real time. Follow whichever you ride:
          </p>
          <ul className="list-disc list-outside ml-5 space-y-1">
            {BLUESKY_ACCOUNTS.map((bot) => (
              <li key={bot.key}>
                <a className={LINK} href={bot.url} target="_blank" rel="noopener noreferrer">
                  @{bot.handle}
                </a>{' '}
                — {bot.description}
              </li>
            ))}
          </ul>
        </>
      )}

      <h3
        className={`font-semibold text-slate-700 dark:text-slate-200${BLUESKY_ACCOUNTS.length > 0 ? ' pt-3' : ''}`}
      >
        RSS / Atom feed
      </h3>
      <p>
        An Atom feed of the 50 most recent incidents — official SEPTA alerts plus bot-detected
        disruptions, across every line and route. Drop the URL below into any feed reader to follow
        along.
      </p>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        Capped at 50 entries, which typically covers the last 3–7 days depending on how active the
        system has been.
      </p>

      <div className="flex items-center gap-2">
        <input
          type="text"
          readOnly
          value={FEED_URL}
          onFocus={(e) => e.target.select()}
          aria-label="Full feed URL"
          className="flex-1 min-w-0 px-2 py-1.5 text-xs font-mono bg-slate-50 dark:bg-gh-bg border border-slate-200 dark:border-gh-border rounded text-slate-700 dark:text-slate-200"
        />
        <button
          type="button"
          onClick={copy('feed', FEED_URL)}
          className="px-3 py-1.5 text-xs font-medium rounded border border-slate-200 dark:border-gh-border text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-gh-border transition-colors"
        >
          {copied === 'feed' ? 'Copied' : 'Copy'}
        </button>
      </div>

      <h3 className="font-semibold text-slate-700 dark:text-slate-200 pt-3">
        Just one line or route
      </h3>
      <p>
        Only care about your commute? Pick a SEPTA Metro line or bus route, or a Regional Rail line,
        to get its own feed. Every Metro line, every bus route, and every Regional Rail line has one
        at a predictable URL (<code className="text-xs">/feed/line/:line.xml</code>,{' '}
        <code className="text-xs">/feed/route/:route.xml</code>, or{' '}
        <code className="text-xs">/feed/rail/line/:line.xml</code>):
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        <FeedPicker
          id="transit-feed-picker"
          label="Metro line or bus route"
          value={pickedTransitFeed}
          onChange={setPickedTransitFeed}
          url={pickedTransitFeedUrl}
          copied={copied === 'transit-picked'}
          onCopy={copy('transit-picked', pickedTransitFeedUrl)}
        >
          <optgroup label="SEPTA Metro">
            {LINE_FEED_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </optgroup>
          <optgroup label="Bus Routes">
            {ROUTE_FEED_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </optgroup>
        </FeedPicker>
        <FeedPicker
          id="rail-feed-picker"
          label="Regional Rail line"
          value={pickedRailFeed}
          onChange={setPickedRailFeed}
          url={pickedRailFeedUrl}
          copied={copied === 'rail-picked'}
          onCopy={copy('rail-picked', pickedRailFeedUrl)}
        >
          {RAIL_FEED_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </FeedPicker>
      </div>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        Feeds exist for every Metro line, every bus route, and every Regional Rail line up front, so
        you can subscribe to your route today — it just stays quiet until something happens, then
        fills in automatically. Every line and route page also carries a{' '}
        <span className="whitespace-nowrap">“🔔 Subscribe (RSS)”</span> link. A JSON Feed version
        lives at the same path with a <code>.json</code> extension.
      </p>

      <h3 className="font-semibold text-slate-700 dark:text-slate-200 pt-2">
        Popular feed readers
      </h3>
      <ul className="list-disc list-outside ml-5 space-y-1">
        <li>
          <a className={LINK} href="https://feedly.com/" target="_blank" rel="noopener noreferrer">
            Feedly
          </a>{' '}
          — web and mobile.
        </li>
        <li>
          <a
            className={LINK}
            href="https://www.inoreader.com/"
            target="_blank"
            rel="noopener noreferrer"
          >
            Inoreader
          </a>{' '}
          — web and mobile.
        </li>
        <li>
          <a
            className={LINK}
            href="https://netnewswire.com/"
            target="_blank"
            rel="noopener noreferrer"
          >
            NetNewsWire
          </a>{' '}
          — free, native macOS / iOS.
        </li>
      </ul>

      <h3 className="font-semibold text-slate-700 dark:text-slate-200 pt-2">What you'll get</h3>
      <p>
        New entries appear as incidents are detected. Resolved incidents bump their entry so most
        readers will mark them unread again — a quick way to see when something cleared.
      </p>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        The feed regenerates when the underlying data changes and the static site rebuilds.
      </p>

      <h3 className="font-semibold text-slate-700 dark:text-slate-200 pt-3">Bulk data</h3>
      <p>
        Building a dashboard or doing analysis? The incident data is published as bounded JSON files
        — a unified <code className="text-xs">incidents[]</code> array in each — so you never fetch
        the whole archive at once. There's also a flat CSV (one row per alert or observation). No
        auth, no rate-limit beyond reasonable polling.
      </p>
      <ul className="list-disc list-outside ml-5 space-y-1 text-xs">
        <li>
          <a className={LINK} href={RECENT_URL} target="_blank" rel="noopener noreferrer">
            {RECENT_URL}
          </a>{' '}
          — current incidents (active, plus the last 93 days); the same data the live site reads.
          Poll this.
        </li>
        <li>
          <a className={LINK} href={INDEX_URL} target="_blank" rel="noopener noreferrer">
            {INDEX_URL}
          </a>{' '}
          — manifest of the monthly archive shards and per-line files. Union the monthly shards it
          lists for the full all-time history.
        </li>
        <li>
          <a className={LINK} href={CSV_URL} target="_blank" rel="noopener noreferrer">
            {CSV_URL}
          </a>{' '}
          — flat CSV, one row per alert or observation.
        </li>
        <li>
          <a className={LINK} href={ACCESSIBILITY_URL} target="_blank" rel="noopener noreferrer">
            {ACCESSIBILITY_URL}
          </a>{' '}
          — elevator outages, the same data behind the{' '}
          <a className={LINK} href="/accessibility">
            accessibility
          </a>{' '}
          page.
        </li>
      </ul>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        Format changes are tracked in the{' '}
        <a className={LINK} href={CHANGELOG_URL} target="_blank" rel="noopener noreferrer">
          data changelog
        </a>{' '}
        — check it before pinning to the format.
      </p>
      <p className="text-xs text-slate-500 dark:text-slate-400">Quick check from a terminal:</p>
      <div className="flex items-center gap-2">
        <pre className="flex-1 min-w-0 px-2 py-1.5 text-xs font-mono bg-slate-50 dark:bg-gh-bg border border-slate-200 dark:border-gh-border rounded text-slate-700 dark:text-slate-200 whitespace-pre-wrap break-all">
          {CURL_CMD}
        </pre>
        <button
          type="button"
          onClick={copy('curl', CURL_CMD)}
          className="px-3 py-1.5 text-xs font-medium rounded border border-slate-200 dark:border-gh-border text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-gh-border transition-colors"
        >
          {copied === 'curl' ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

function FeedPicker({ id, label, value, onChange, url, copied, onCopy, children }) {
  return (
    <div className="space-y-2">
      <label
        htmlFor={id}
        className="block text-xs font-semibold text-slate-600 dark:text-slate-300"
      >
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-2 py-1.5 text-sm bg-slate-50 dark:bg-gh-bg border border-slate-200 dark:border-gh-border rounded text-slate-700 dark:text-slate-200"
      >
        {children}
      </select>
      <div className="flex items-center gap-2">
        <input
          type="text"
          readOnly
          value={url}
          onFocus={(e) => e.target.select()}
          aria-label={`${label} feed URL`}
          className="flex-1 min-w-0 px-2 py-1.5 text-xs font-mono bg-slate-50 dark:bg-gh-bg border border-slate-200 dark:border-gh-border rounded text-slate-700 dark:text-slate-200"
        />
        <button
          type="button"
          onClick={onCopy}
          className="px-3 py-1.5 text-xs font-medium rounded border border-slate-200 dark:border-gh-border text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-gh-border transition-colors"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}
