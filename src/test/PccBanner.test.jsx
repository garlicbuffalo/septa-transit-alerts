import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PccBanner from '../components/PccBanner.jsx';
import { fetchPccStatus, isPccLabel, parsePccStatus, pccTrackerEndpoint } from '../lib/pcc.js';

afterEach(cleanup);

const STATUS = {
  updatedAt: '2026-10-10T12:00:00.000Z',
  pccCount: 2,
  busCount: 6,
  vehicles: [
    { id: '2337', direction: 'Westbound', destination: '63rd-Girard', lateMinutes: 1 },
    { id: '2324', direction: 'Eastbound', destination: 'Richmond-Westmoreland', lateMinutes: 0 },
  ],
};

describe('PCC tracker feed', () => {
  it("parses the tracker's widget status", () => {
    expect(parsePccStatus(STATUS)).toEqual({
      cars: [
        { id: '2324', direction: 'Eastbound', destination: 'Richmond-Westmoreland' },
        { id: '2337', direction: 'Westbound', destination: '63rd-Girard' },
      ],
      buses: 6,
      updatedAt: Date.parse('2026-10-10T12:00:00.000Z'),
    });
    expect(parsePccStatus({ vehicles: [{ id: '3676', direction: 'Unknown' }] })).toMatchObject({
      cars: [],
      buses: null,
    });
    expect(() => parsePccStatus({ error: 'SEPTA data unavailable' })).toThrow();
  });

  it('knows a PCC fleet number', () => {
    expect(isPccLabel('2328')).toBe(true);
    expect(isPccLabel('8489')).toBe(false);
  });

  it('fetches from the tracker', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, json: async () => STATUS }));
    const status = await fetchPccStatus({ fetchFn });
    expect(fetchFn.mock.calls[0][0]).toBe(pccTrackerEndpoint('widget-status'));
    expect(fetchFn.mock.calls[0][0]).toBe(
      'https://septa-g-trolley-tracker.netlify.app/.netlify/functions/widget-status',
    );
    expect(status.cars).toHaveLength(2);
    await expect(
      fetchPccStatus({ fetchFn: async () => ({ ok: false, status: 502 }) }),
    ).rejects.toThrow('HTTP 502');
  });
});

describe('PccBanner', () => {
  it('shows the PCC cars running now, with a link to the tracker', async () => {
    render(<PccBanner fetchStatus={async () => parsePccStatus(STATUS)} />);
    expect(
      await screen.findByText(/2 vintage PCC trolleys are running on the G1 now/),
    ).toBeInTheDocument();
    expect(screen.getByText('#2324 · Eastbound to Richmond-Westmoreland')).toBeInTheDocument();
    expect(screen.getByText('#2337 · Westbound to 63rd-Girard')).toBeInTheDocument();
    expect(screen.getByText(/6 buses are out on the line too/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /G Trolley Tracker/ })).toHaveAttribute(
      'href',
      'https://septa-g-trolley-tracker.netlify.app/',
    );
  });

  it('shows nothing when no PCC is out, or the tracker is down', async () => {
    const empty = vi.fn(async () => ({ cars: [], buses: 7, updatedAt: null }));
    const { container, unmount } = render(<PccBanner fetchStatus={empty} />);
    await waitFor(() => expect(empty).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    unmount();
    const down = vi.fn(async () => {
      throw new Error('HTTP 502');
    });
    const r = render(<PccBanner fetchStatus={down} />);
    await waitFor(() => expect(down).toHaveBeenCalled());
    expect(r.container).toBeEmptyDOMElement();
  });

  it('comes down when the cars go back to the depot', async () => {
    let status = parsePccStatus(STATUS);
    const fetchStatus = vi.fn(async () => status);
    render(<PccBanner fetchStatus={fetchStatus} pollMs={20} />);
    expect(await screen.findByText(/PCC trolleys are running/)).toBeInTheDocument();
    status = { cars: [], buses: 8, updatedAt: null };
    await waitFor(() => expect(screen.queryByText(/PCC trolley/)).not.toBeInTheDocument());
  });
});
