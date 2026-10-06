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
  mostAffectedId: 'red',
  quietestLineId: 'yellow',
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

  it('renders the most-affected train phrase', () => {
    render(<SummaryStats {...baseProps} />);
    expect(screen.getAllByText(/Red Line/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/most affected \(last 30 days\)/i).length).toBeGreaterThan(0);
  });

  it('links the most-affected and quietest line names to their pages', () => {
    render(
      <SummaryStats
        {...baseProps}
        railMostAffectedId="bnsf"
        railQuietestLineId="up-n"
        railQuietestLineDays={9}
      />,
    );
    expect(screen.getAllByRole('link', { name: /Red Line/ })[0]).toHaveAttribute(
      'href',
      '/line/red',
    );
    expect(screen.getAllByRole('link', { name: /Yellow Line/ })[0]).toHaveAttribute(
      'href',
      '/line/yellow',
    );
    expect(screen.getAllByRole('link', { name: /BNSF/ })[0]).toHaveAttribute(
      'href',
      '/rail/line/bnsf',
    );
    expect(screen.getAllByRole('link', { name: /Union Pacific North/ })[0]).toHaveAttribute(
      'href',
      '/rail/line/up-n',
    );
  });

  it('renders separate CTA and Metra most-affected / quietest lines', () => {
    render(
      <SummaryStats
        {...baseProps}
        railMostAffectedId="bnsf"
        railQuietestLineId="up-n"
        railQuietestLineDays={9}
      />,
    );
    expect(screen.getAllByText(/Red Line/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Yellow Line/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/BNSF/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Union Pacific North/).length).toBeGreaterThan(0);
  });

  it('gates the per-agency lines on the agency filter', () => {
    const props = {
      ...baseProps,
      railMostAffectedId: 'bnsf',
      railQuietestLineId: 'up-n',
      railQuietestLineDays: 9,
    };
    const { rerender } = render(<SummaryStats {...props} agency="cta" />);
    expect(screen.getAllByText(/Red Line/).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/BNSF/)).toHaveLength(0);

    rerender(<SummaryStats {...props} agency="rail" />);
    expect(screen.queryAllByText(/Red Line/)).toHaveLength(0);
    expect(screen.getAllByText(/BNSF/).length).toBeGreaterThan(0);
  });

  it('renders an "all clear" active label when nothing is active', () => {
    render(<SummaryStats {...baseProps} activeCount={0} showActive />);
    expect(screen.getAllByText(/all clear/i).length).toBeGreaterThan(0);
  });

  it('labels CTA train disruption hours explicitly', () => {
    render(<SummaryStats {...baseProps} observations={[railObservation('metro', 'red')]} />);
    expect(screen.getAllByText(/CTA trains disrupted in last 7 days/i).length).toBeGreaterThan(0);
  });

  it('shows only CTA disruption cards when scoped to CTA', () => {
    render(
      <SummaryStats
        {...baseProps}
        agency="cta"
        observations={[railObservation('metro', 'red'), railObservation('rail', 'me')]}
      />,
    );
    expect(screen.getAllByText(/CTA trains disrupted in last 7 days/i).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/Metra trains disrupted in last 7 days/i)).toHaveLength(0);
  });

  it('shows only Metra disruption cards when scoped to Metra', () => {
    render(
      <SummaryStats
        {...baseProps}
        agency="rail"
        observations={[railObservation('metro', 'red'), railObservation('rail', 'me')]}
      />,
    );
    expect(screen.queryAllByText(/CTA trains disrupted in last 7 days/i)).toHaveLength(0);
    expect(screen.getAllByText(/Metra trains disrupted in last 7 days/i).length).toBeGreaterThan(0);
  });
});
