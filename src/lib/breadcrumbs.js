// Breadcrumb trails — the single source of truth for both the visible trail
// (rendered by <Breadcrumb> on each detail page) and the BreadcrumbList
// JSON-LD baked into the prerendered stubs. Keeping both on these builders
// means the structured data a crawler reads always matches the trail a visitor
// sees. Each builder returns an ordered array of `{ label, href? }` from root
// to current page; the last item is the current page and carries no href.

import { formatPhillyDay, formatWeekRange, phillyDayIsoUTC, phillyDayUTC } from './format.js';

const HOME = { label: 'Home', href: '/' };

// Day crumb for the Philadelphia calendar day containing `ts` — links to /day/:date.
function dayCrumb(ts) {
  const dayUtc = phillyDayUTC(ts);
  return { label: formatPhillyDay(dayUtc), href: `/day/${phillyDayIsoUTC(dayUtc)}` };
}

// Event detail: Home › <day> › <incident label>.
export function eventTrail(ts, currentLabel) {
  const trail = [HOME];
  if (ts != null) trail.push(dayCrumb(ts));
  trail.push({ label: currentLabel });
  return trail;
}

// Single day: Home › Calendar › <day>. `dayUtc` is a phillyDayUTC value.
export function dayTrail(dayUtc) {
  return [HOME, { label: 'Calendar', href: '/calendar' }, { label: formatPhillyDay(dayUtc) }];
}

// Top-level detail pages (line, route, station, stats, …): Home › <page>.
export function topLevelTrail(currentLabel) {
  return [HOME, { label: currentLabel }];
}

// Single week recap: Home › Week of May 17–23. `weekStartUtc` is the Sunday
// (a phillyDayUTC value).
export function weekTrail(weekStartUtc) {
  return [HOME, { label: `Week of ${formatWeekRange(weekStartUtc)}` }];
}

// Build schema.org BreadcrumbList JSON-LD from a trail. `site` is the absolute
// origin (no trailing slash); relative crumb hrefs are resolved against it. The
// current page (last crumb, no href) is emitted without an `item`, which is the
// recommended shape for the trailing breadcrumb.
export function breadcrumbJsonLd(items, site) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => {
      const node = { '@type': 'ListItem', position: i + 1, name: it.label };
      if (it.href) node.item = it.href.startsWith('http') ? it.href : `${site}${it.href}`;
      return node;
    }),
  };
}
