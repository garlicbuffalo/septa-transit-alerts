// Official SEPTA alerts on the alerts account: a post when a significant alert
// appears, and a threaded ✅ reply when SEPTA clears it.
//
// Modeled on cta-insights' alert bins (ISC). What counts as significant is
// SEPTA-specific (see alertGate): real-time alerts always post; planned
// advisories post only for service changes riders must plan around (shuttle
// buses, closed stations, suspensions, delays), never for platform-boarding
// or bus-stop notices; detours post only for unplanned causes (police, fire,
// crashes), not construction.
import { SITE_ORIGIN } from '../../src/lib/site.js';
import { routeEmoji, routeShortLabel, routesLabel } from '../lib/routes.js';
import { firstThatFits, linkFacets, truncateGraphemes, truncateSentence } from '../lib/text.js';

export const ALERTS_ACCOUNT = 'alerts';
// Cleared replies for alerts that resolved longer ago than this are skipped
// (the bot was down); the thread would only confuse.
const CLEARED_MAX_AGE_MS = 12 * 60 * 60 * 1000;

const SITE_HOST = new URL(SITE_ORIGIN).host;

const ADVISORY_MAJOR =
  /\b(suspend\w*|shuttle bus\w*|bus(es)? replaces?|no (\w+ )?service|not (running|operating|stopping)|will not (run|operate|stop)|closed|bypass\w*|single[- ]track\w*|delays?|cancel\w*)\b/i;
const ADVISORY_MINOR =
  /\b(platform boarding|boarding location|board on the|bus stop changes?|stop changes?|stop (closures?|relocat\w*|discontinu\w*)|notice of bus detour|parking|elevators?|escalators?)\b/i;
const UNPLANNED_CAUSES = new Set([
  'ACCIDENT',
  'POLICE_ACTIVITY',
  'MEDICAL_EMERGENCY',
  'WEATHER',
  'TECHNICAL_PROBLEM',
  'STRIKE',
  'DEMONSTRATION',
]);
const UNPLANNED_DETOUR =
  /\b(police|fire|accident|crash|collision|emergency|water main|disabled|downed|flood\w*|wires? down|tree|gas leak|investigation)\b/i;

/**
 * Whether an official incident is worth a post.
 * @returns {{ post: boolean, reason: string }}
 */
export function alertGate(incident) {
  const a = incident.official_alert;
  if (!a) return { post: false, reason: 'not-official' };
  const type = a.septa?.type ?? null;
  const headline = a.headline ?? '';
  if (type === 'ALERT') return { post: true, reason: 'real-time-alert' };
  if (type === 'DETOUR' || incident.id.startsWith('detour-')) {
    const unplanned =
      UNPLANNED_CAUSES.has(a.septa?.cause) ||
      UNPLANNED_DETOUR.test(`${headline} ${a.description ?? ''}`);
    return unplanned
      ? { post: true, reason: 'unplanned-detour' }
      : { post: false, reason: 'planned-detour' };
  }
  if (ADVISORY_MINOR.test(headline)) return { post: false, reason: 'minor-advisory' };
  if (ADVISORY_MAJOR.test(headline)) return { post: true, reason: 'major-advisory' };
  return { post: false, reason: 'advisory' };
}

const BOILERPLATE = [
  /\bFor (more information|details)( and schedules)?,? visit SEPTA\.org\.?/gi,
  /\bVisit SEPTA\.org for (more information|details)\.?/gi,
  /\bSEPTA apologizes for (any|the) inconvenience\.?/gi,
];

/** The alert's description minus the headline it often repeats and boilerplate. */
export function alertBody(alert) {
  let body = String(alert.description ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const headline = String(alert.headline ?? '').trim();
  const norm = (s) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  if (headline && norm(body).startsWith(norm(headline))) body = body.slice(headline.length).trim();
  for (const re of BOILERPLATE) body = body.replace(re, '');
  return body.replace(/\s+/g, ' ').trim();
}

export const eventUrl = (id) => `${SITE_ORIGIN}/event/${encodeURIComponent(id)}`;

function headLine(incident) {
  const a = incident.official_alert;
  const emoji = routeEmoji(incident.mode, incident.routes?.[0]);
  const label = routesLabel(incident.mode, incident.routes);
  const headline = a.headline.trim();
  // Prefix the route unless SEPTA's headline already names it.
  const lower = headline.toLowerCase();
  const named =
    !label ||
    (incident.routes ?? []).some((r) =>
      lower.includes(
        routeShortLabel(incident.mode, r)
          .replace(/ Line$/, '')
          .toLowerCase(),
      ),
    );
  return `${emoji}⚠️ ${named ? headline : `${label}: ${headline}`}`;
}

/** Post text and its link facets. */
export function alertPostText(incident) {
  const a = incident.official_alert;
  const head = headLine(incident);
  const body = alertBody(a);
  const footer = `Per SEPTA · septa.org · ${SITE_HOST}`;
  const text = firstThatFits([
    body ? `${head}\n\n${truncateSentence(body, 200)}\n\n${footer}` : null,
    body ? `${head}\n\n${truncateSentence(body, 120)}\n\n${footer}` : null,
    `${head}\n\n${footer}`,
    `${truncateGraphemes(head, 240)}\n\n${footer}`,
  ]);
  const facets = linkFacets(text, [
    { text: 'septa.org', uri: a.source_url ?? 'https://www.septa.org/' },
    { text: SITE_HOST, uri: eventUrl(incident.id) },
  ]);
  return { text, facets };
}

export function clearedPostText(incident) {
  const a = incident.official_alert;
  const emoji = routeEmoji(incident.mode, incident.routes?.[0]);
  const label = routesLabel(incident.mode, incident.routes);
  const text = firstThatFits([
    `${emoji}✅ SEPTA has cleared this ${label} alert: ${truncateGraphemes(a.headline, 200)}`,
    `${emoji}✅ SEPTA has cleared: ${truncateGraphemes(a.headline, 240)}`,
  ]);
  return { text };
}

export function alertAltText(incident) {
  const a = incident.official_alert;
  const label = routesLabel(incident.mode, incident.routes);
  const scope = a.scope ?? {};
  const stretch =
    scope.from_station && scope.to_station
      ? ` with the stretch between ${scope.from_station} and ${scope.to_station} highlighted`
      : '';
  return `Map of the ${label}${stretch}. SEPTA alert: ${a.headline}`;
}

const subjectOf = (incident) => `septa-alert:${incident.official_alert.id}`;

/**
 * Post new significant alerts and cleared replies. Each SEPTA alert posts once
 * even when it spans several networks (several incidents share its id).
 * @param {{ incidents: Map<string, object>, poster: ReturnType<import('../lib/poster.js').createPoster>,
 *   now: number, maxAgeMs: number, renderMap?: (incident: object) => Promise<Buffer | null>,
 *   log?: (m: string) => void }} opts
 */
export async function postAlerts({ incidents, poster, now, maxAgeMs, renderMap, log = () => {} }) {
  const stats = { posted: 0, cleared: 0, skipped: 0, failed: 0 };
  // No credentials for the account yet: judge nothing, so alerts are still
  // fresh when it's added.
  if (!poster.client.hasAccount(ALERTS_ACCOUNT)) return { ...stats, disabled: true };
  const since = poster.since();
  const handled = new Set();
  const official = [...incidents.values()]
    .filter((inc) => inc.official_alert)
    // Primary part first (the id without a network suffix), oldest first.
    .sort(
      (a, b) => a.id.length - b.id.length || a.lifecycle.first_seen_ts - b.lifecycle.first_seen_ts,
    );

  for (const inc of official) {
    const subject = subjectOf(inc);
    if (handled.has(subject)) continue;
    handled.add(subject);
    const posted = poster.find(subject, 'alert');
    try {
      if (!posted) {
        if (poster.skipped(subject)) continue;
        const firstSeen = inc.lifecycle.first_seen_ts;
        let reason = null;
        if (!inc.lifecycle.active) reason = 'resolved-before-post';
        else if (firstSeen < since) reason = 'before-posting-started';
        else if (now - firstSeen > maxAgeMs) reason = 'stale';
        else {
          const gate = alertGate(inc);
          if (!gate.post) reason = gate.reason;
        }
        if (reason) {
          poster.skip(subject, reason);
          stats.skipped++;
          continue;
        }
        const { text, facets } = alertPostText(inc);
        let image = null;
        if (renderMap) {
          try {
            const data = await renderMap(inc);
            if (data) image = { data, alt: alertAltText(inc) };
          } catch (err) {
            log(`alerts: map for ${inc.id} failed: ${err.message}`);
          }
        }
        await poster.post({
          account: ALERTS_ACCOUNT,
          kind: 'alert',
          subject,
          text,
          facets,
          ...(image
            ? { image }
            : {
                link: {
                  url: eventUrl(inc.id),
                  title: inc.official_alert.headline,
                  description: 'Live status and history on SEPTA Transit Alerts.',
                  fallbackThumbUrl: `${SITE_ORIGIN}/og-image.png`,
                },
              }),
        });
        stats.posted++;
        continue;
      }

      if (inc.lifecycle.active || poster.find(subject, 'cleared')) continue;
      if (poster.skipped(`${subject}:cleared`)) continue;
      if (now - (inc.lifecycle.resolved_ts ?? now) > CLEARED_MAX_AGE_MS) {
        poster.skip(`${subject}:cleared`, 'stale');
        continue;
      }
      const { text } = clearedPostText(inc);
      const url = `${eventUrl(inc.id)}/resolved`;
      await poster.post({
        account: ALERTS_ACCOUNT,
        kind: 'cleared',
        subject,
        reply: posted.uri,
        text,
        link: {
          url,
          title: `SEPTA has cleared: ${truncateGraphemes(inc.official_alert.headline, 120)}`,
          description: 'How long it lasted, on SEPTA Transit Alerts.',
          thumbUrl: `${url}/og.jpg`,
          fallbackThumbUrl: `${SITE_ORIGIN}/og-image.png`,
        },
      });
      stats.cleared++;
    } catch (err) {
      stats.failed++;
      log(`alerts: posting ${inc.id} failed: ${err.message}`);
    }
  }
  return stats;
}

/**
 * Write each official incident's post links into the published record:
 * official_alert.post_url and resolved_reply_url. Dry-run posts never appear.
 */
export function linkAlertPosts(incidents, poster) {
  if (poster.dryRun) return 0;
  let linked = 0;
  for (const inc of incidents.values()) {
    if (!inc.official_alert) continue;
    const subject = subjectOf(inc);
    const post = poster.find(subject, 'alert');
    if (!post) continue;
    const cleared = poster.find(subject, 'cleared');
    const next = {
      ...inc.official_alert,
      post_url: post.url,
      resolved_reply_url: cleared?.url ?? null,
    };
    if (
      next.post_url !== inc.official_alert.post_url ||
      next.resolved_reply_url !== inc.official_alert.resolved_reply_url
    ) {
      incidents.set(inc.id, { ...inc, official_alert: next });
      linked++;
    }
  }
  return linked;
}
