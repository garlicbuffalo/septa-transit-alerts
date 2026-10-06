import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import SignalBreakdown from '../components/SignalBreakdown.jsx';

describe('SignalBreakdown', () => {
  // Regression: the Regional Rail tally only creates keys for lines that had
  // observations, so probing a quiet line handed `lineTotal` undefined and
  // threw while rendering the "Trends & history" section.
  it('renders when only some Regional Rail lines have observations', () => {
    const observations = [
      { kind: 'rail', line: 'NOR', detection_source: 'cancellation', ts: Date.now() },
    ];
    expect(() => render(<SignalBreakdown observations={observations} />)).not.toThrow();
    expect(screen.getByText('Regional Rail signal mix by line')).toBeInTheDocument();
    // Only the line with data gets a row.
    expect(screen.getByText('NOR')).toBeInTheDocument();
    expect(screen.queryByText('PAO')).not.toBeInTheDocument();
  });

  // With the network filter on "Metro & Bus", Regional Rail incidents are
  // filtered out upstream, so the rail tally is empty while Metro data is
  // present. Every rail line probe must cope with that.
  it('renders Metro rows when the network filter excludes all Regional Rail data', () => {
    const observations = [{ kind: 'metro', line: 'l1', detection_source: 'gap', ts: Date.now() }];
    expect(() => render(<SignalBreakdown observations={observations} />)).not.toThrow();
    expect(screen.getByText('Signal mix by Metro line')).toBeInTheDocument();
    expect(screen.queryByText('Regional Rail signal mix by line')).not.toBeInTheDocument();
  });

  it('renders nothing when no signals fired on either network', () => {
    const { container } = render(<SignalBreakdown observations={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
