import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import SummaryStats from '../components/SummaryStats.jsx';

// SummaryStats renders two strips (a mobile card grid + a desktop strip), so
// the same label legitimately appears more than once — assertions use
// getAllByText / queryAllByText accordingly.
const baseProps = {
  activeCount: 2,
  weeklyCount: 5,
  mostAffectedKind: 'metro',
  mostAffectedId: 'l1',
  quietestLineId: 'd2',
  quietestLineDays: 10,
  alerts: [],
  observations: [],
};
const HOUR = 60 * 60 * 1000;

function railObservation(kind, line) {
  const now = Date.now();
  return {
    id: `${kind}-${line}`,
    kind,
    line,
    ts: now - HOUR,
    resolved_ts: now,
  };
}

describe('SummaryStats', () => {
  it('renders the 7-day volume figure', () => {
    render(<SummaryStats {...baseProps} />);
    expect(screen.getAllByText('5').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/in last 7 days/i).length).toBeGreaterThan(0);
  });

  it('shows the active-now figure when showActive is set, and hides it otherwise', () => {
    const { rerender } = render(<SummaryStats {...baseProps} showActive />);
    expect(screen.getAllByText(/active now/i).length).toBeGreaterThan(0);

    rerender(<SummaryStats {...baseProps} showActive={false} />);
    expect(screen.queryAllByText(/active now/i)).toHaveLength(0);
    expect(screen.queryAllByText(/all clear/i)).toHaveLength(0);
  });

  it('renders the most-affected Metro line phrase', () => {
    render(<SummaryStats {...baseProps} />);
    expect(screen.getAllByText(/L1 Market-Frankford Line/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/most affected \(last 30 days\)/i).length).toBeGreaterThan(0);
  });

  it('links the most-affected and quietest line names to their pages', () => {
    render(
      <SummaryStats
        {...baseProps}
        railMostAffectedId="pao"
        railQuietestLineId="nor"
        railQuietestLineDays={9}
      />,
    );
    expect(screen.getAllByRole('link', { name: /L1 Market-Frankford Line/ })[0]).toHaveAttribute(
      'href',
      '/line/l1',
    );
    expect(screen.getAllByRole('link', { name: /D2 Sharon Hill Trolley/ })[0]).toHaveAttribute(
      'href',
      '/line/d2',
    );
    expect(screen.getAllByRole('link', { name: /Paoli\/Thorndale Line/ })[0]).toHaveAttribute(
      'href',
      '/rail/line/pao',
    );
    expect(screen.getAllByRole('link', { name: /Manayunk\/Norristown Line/ })[0]).toHaveAttribute(
      'href',
      '/rail/line/nor',
    );
  });

  it('renders separate Metro and Regional Rail most-affected / quietest lines', () => {
    render(
      <SummaryStats
        {...baseProps}
        railMostAffectedId="pao"
        railQuietestLineId="nor"
        railQuietestLineDays={9}
      />,
    );
    expect(screen.getAllByText(/L1 Market-Frankford Line/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/D2 Sharon Hill Trolley/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Paoli\/Thorndale Line/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Manayunk\/Norristown Line/).length).toBeGreaterThan(0);
  });

  it('gates the per-network lines on the network filter', () => {
    const props = {
      ...baseProps,
      railMostAffectedId: 'pao',
      railQuietestLineId: 'nor',
      railQuietestLineDays: 9,
    };
    const { rerender } = render(<SummaryStats {...props} network="transit" />);
    expect(screen.getAllByText(/L1 Market-Frankford Line/).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/Paoli\/Thorndale/)).toHaveLength(0);

    rerender(<SummaryStats {...props} network="rail" />);
    expect(screen.queryAllByText(/L1 Market-Frankford Line/)).toHaveLength(0);
    expect(screen.getAllByText(/Paoli\/Thorndale/).length).toBeGreaterThan(0);
  });

  it('renders an "all clear" active label when nothing is active', () => {
    render(<SummaryStats {...baseProps} activeCount={0} showActive />);
    expect(screen.getAllByText(/all clear/i).length).toBeGreaterThan(0);
  });

  it('labels Metro disruption hours explicitly', () => {
    render(<SummaryStats {...baseProps} observations={[railObservation('metro', 'l1')]} />);
    expect(screen.getAllByText(/Metro trains disrupted in last 7 days/i).length).toBeGreaterThan(0);
  });

  it('shows only Metro disruption cards when scoped to Metro & Bus', () => {
    render(
      <SummaryStats
        {...baseProps}
        network="transit"
        observations={[railObservation('metro', 'l1'), railObservation('rail', 'wtr')]}
      />,
    );
    expect(screen.getAllByText(/^Metro trains disrupted in last 7 days/i).length).toBeGreaterThan(
      0,
    );
    expect(screen.queryAllByText(/Regional Rail trains disrupted in last 7 days/i)).toHaveLength(0);
  });

  it('shows only Regional Rail disruption cards when scoped to Regional Rail', () => {
    render(
      <SummaryStats
        {...baseProps}
        network="rail"
        observations={[railObservation('metro', 'l1'), railObservation('rail', 'wtr')]}
      />,
    );
    expect(screen.queryAllByText(/^Metro trains disrupted in last 7 days/i)).toHaveLength(0);
    expect(
      screen.getAllByText(/Regional Rail trains disrupted in last 7 days/i).length,
    ).toBeGreaterThan(0);
  });
});
