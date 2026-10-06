import { describe, expect, it } from 'vitest';
import { breadcrumbJsonLd, dayTrail, eventTrail, topLevelTrail } from '../lib/breadcrumbs.js';
import { phillyDayUTC } from '../lib/format.js';

const SITE = 'https://septa-transit-alerts.example';

// 2026-05-14 21:43 UTC = 16:43 America/New_York (EDT) → Philadelphia day May 14, 2026.
const TS = Date.UTC(2026, 4, 14, 21, 43);

describe('topLevelTrail', () => {
  it('is Home › <page>, current page carries no href', () => {
    expect(topLevelTrail('Stats')).toEqual([{ label: 'Home', href: '/' }, { label: 'Stats' }]);
  });
});

describe('eventTrail', () => {
  it('is Home › <day> › <incident>, with a /day/:date middle crumb', () => {
    const trail = eventTrail(TS, 'Red Line');
    expect(trail).toHaveLength(3);
    expect(trail[0]).toEqual({ label: 'Home', href: '/' });
    expect(trail[1].href).toBe('/day/2026-05-14');
    expect(trail[1].label).toBe('May 14, 2026');
    expect(trail[2]).toEqual({ label: 'Red Line' });
  });

  it('omits the day crumb when the timestamp is missing', () => {
    expect(eventTrail(null, 'Incident')).toEqual([
      { label: 'Home', href: '/' },
      { label: 'Incident' },
    ]);
  });
});

describe('dayTrail', () => {
  it('is Home › Calendar › <day>', () => {
    const trail = dayTrail(phillyDayUTC(TS));
    expect(trail.map((c) => c.label)).toEqual(['Home', 'Calendar', 'May 14, 2026']);
    expect(trail[1].href).toBe('/calendar');
    expect(trail[2].href).toBeUndefined();
  });
});

describe('breadcrumbJsonLd', () => {
  it('emits positioned ListItems with absolute item URLs', () => {
    const ld = breadcrumbJsonLd(topLevelTrail('Stats'), SITE);
    expect(ld['@type']).toBe('BreadcrumbList');
    expect(ld.itemListElement).toEqual([
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE}/` },
      { '@type': 'ListItem', position: 2, name: 'Stats' },
    ]);
  });

  it('resolves nested relative hrefs against the site origin', () => {
    const ld = breadcrumbJsonLd(eventTrail(TS, 'Red Line'), SITE);
    expect(ld.itemListElement[1].item).toBe(`${SITE}/day/2026-05-14`);
    // Current page (last crumb) has no href → no `item`.
    expect(ld.itemListElement[2].item).toBeUndefined();
  });
});
