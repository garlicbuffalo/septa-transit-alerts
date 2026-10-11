import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PccBanner, { fetchPccFile, PCC_MAX_AGE_MS } from '../components/PccBanner.jsx';
import { isPccLabel, PCC_LOST_MS, parsePccFile, pccSightings } from '../lib/pcc.js';

afterEach(cleanup);

const T = Date.UTC(2026, 9, 10, 11, 0); // 7:00 AM in Philadelphia

const g1 = (label, over = {}) => ({
  id: label,
  label,
  mode: 'metro',
  route: 'g1',
  directionName: 'Eastbound',
  destination: 'Richmond-Westmoreland',
  nextStopName: 'Girard Av & 16th St',
  lat: 39.9719851,
  lon: -75.1635374,
  lateMin: 2,
  ...over,
});

describe('PCC cars', () => {
  it('are told apart from buses by fleet number', () => {
    expect(isPccLabel('2324')).toBe(true);
    expect(isPccLabel(' 2337 ')).toBe(true);
    expect(isPccLabel('3676')).toBe(false);
    expect(isPccLabel('232')).toBe(false);
    expect(isPccLabel('23240')).toBe(false);
    expect(isPccLabel(null)).toBe(false);
  });

  it("are picked out of the G1's vehicles, with how long each has been out", () => {
    const vehicles = [
      g1('2337', { directionName: 'Westbound', destination: '63rd-Girard' }),
      g1('2324'),
      g1('3676'),
      { ...g1('2330'), route: '23' }, // a bus on another route
    ];
    const first = pccSightings(vehicles, null, T);
    expect(first.status).toEqual({
      updated_ts: T,
      cars: [
        {
          id: '2324',
          direction: 'Eastbound',
          destination: 'Richmond-Westmoreland',
          next_stop: 'Girard Av & 16th St',
          lat: 39.971985,
          lon: -75.163537,
          late_min: 2,
          first_seen_ts: T,
        },
        expect.objectContaining({ id: '2337', direction: 'Westbound', first_seen_ts: T }),
      ],
      buses: 1,
    });
    // Missing from one poll, then back: the same spell.
    const gap = pccSightings([g1('2337')], first.state, T + 2 * 60_000);
    const back = pccSightings(vehicles, gap.state, T + 4 * 60_000);
    expect(back.status.cars.map((c) => c.first_seen_ts)).toEqual([T, T]);
    // Gone longer than PCC_LOST_MS: a new spell.
    const later = T + 4 * 60_000 + PCC_LOST_MS + 60_000;
    const again = pccSightings([g1('2324')], back.state, later);
    expect(again.status.cars[0].first_seen_ts).toBe(later);
  });

  it('parse the published file', () => {
    expect(parsePccFile({ updated_ts: T, cars: [{ id: '2324' }, { id: '9' }], buses: 3 })).toEqual({
      updatedTs: T,
      cars: [{ id: '2324' }],
      buses: 3,
    });
    expect(() => parsePccFile({})).toThrow();
  });

  it('are read from the data directory', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, json: async () => ({ cars: [], buses: 0 }) }));
    await fetchPccFile(fetchFn);
    expect(fetchFn.mock.calls[0][0]).toBe('/data/pcc.json');
    await expect(fetchPccFile(async () => ({ ok: false, status: 404 }))).rejects.toThrow('404');
  });
});

describe('PccBanner', () => {
  const status = (over = {}) => ({
    updatedTs: Date.now(),
    buses: 6,
    cars: [
      {
        id: '2324',
        direction: 'Eastbound',
        destination: 'Richmond-Westmoreland',
        first_seen_ts: T,
      },
      { id: '2337', direction: 'Westbound', destination: '63rd-Girard', first_seen_ts: T + 3e6 },
    ],
    ...over,
  });

  it('shows the PCC cars running now, with a link to the tracker', async () => {
    render(<PccBanner fetchStatus={async () => status()} />);
    expect(
      await screen.findByText(/2 vintage PCC trolleys are running on the G1 now/),
    ).toBeInTheDocument();
    expect(screen.getByText(/out since 7:00 AM/)).toBeInTheDocument();
    expect(screen.getByText('#2324 · Eastbound to Richmond-Westmoreland')).toBeInTheDocument();
    expect(screen.getByText('#2337 · Westbound to 63rd-Girard')).toBeInTheDocument();
    expect(screen.getByText(/6 buses are out on the line too/)).toBeInTheDocument();
    expect(screen.queryByText(/Updated/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /G Trolley Tracker/ })).toHaveAttribute(
      'href',
      'https://septa-g-trolley-tracker.netlify.app/',
    );
  });

  it("says how old the file is once it's not fresh", async () => {
    render(
      <PccBanner fetchStatus={async () => status({ updatedTs: Date.now() - 25.5 * 60_000 })} />,
    );
    expect(await screen.findByText(/Updated 25m ago/)).toBeInTheDocument();
  });

  it('shows nothing when no PCC is out, the file is too old, or it is missing', async () => {
    for (const fetchStatus of [
      vi.fn(async () => status({ cars: [] })),
      vi.fn(async () => status({ updatedTs: Date.now() - PCC_MAX_AGE_MS - 60_000 })),
      vi.fn(async () => {
        throw new Error('HTTP 404');
      }),
    ]) {
      const { container, unmount } = render(<PccBanner fetchStatus={fetchStatus} />);
      await waitFor(() => expect(fetchStatus).toHaveBeenCalled());
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it('comes down when the cars go back to the depot', async () => {
    let current = status();
    render(<PccBanner fetchStatus={vi.fn(async () => current)} pollMs={20} />);
    expect(await screen.findByText(/PCC trolleys are running/)).toBeInTheDocument();
    current = status({ cars: [] });
    await waitFor(() => expect(screen.queryByText(/PCC trolley/)).not.toBeInTheDocument());
  });
});
