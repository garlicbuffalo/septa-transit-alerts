import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import SignalBreakdown from '../components/SignalBreakdown.jsx';

describe('SignalBreakdown', () => {
  // Regression: the Metra tally only creates keys for lines that had
  // observations, so probing a quiet line handed `lineTotal` undefined and
  // threw while rendering the "Trends & history" section.
  it('renders when only some Metra lines have observations', () => {
    const observations = [
      { kind: 'rail', line: 'UP-N', detection_source: 'cancellation', ts: Date.now() },
    ];
    expect(() => render(<SignalBreakdown observations={observations} />)).not.toThrow();
    expect(screen.getByText('Metra signal mix by line')).toBeInTheDocument();
    // Only the line with data gets a row.
    expect(screen.getByText('UP-N')).toBeInTheDocument();
    expect(screen.queryByText('BNSF')).not.toBeInTheDocument();
  });

  // The reported repro: with the agency filter on "CTA", Metra incidents are
  // filtered out upstream, so the Metra tally is empty while train data is
  // present. Every Metra line probe then missed. ("All" hid the bug because
  // all 11 Metra lines happen to have signal data.)
  it('renders train rows when the agency filter excludes all Metra data', () => {
    const observations = [{ kind: 'metro', line: 'red', detection_source: 'gap', ts: Date.now() }];
    expect(() => render(<SignalBreakdown observations={observations} />)).not.toThrow();
    expect(screen.getByText('Signal mix by train line')).toBeInTheDocument();
    expect(screen.queryByText('Metra signal mix by line')).not.toBeInTheDocument();
  });

  it('renders nothing when no signals fired on either agency', () => {
    const { container } = render(<SignalBreakdown observations={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
