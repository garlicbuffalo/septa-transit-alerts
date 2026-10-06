import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import Timeline from '../components/Timeline.jsx';

const noop = () => {};

describe('Timeline', () => {
  it('renders a row for each Metro line', () => {
    render(
      <Timeline
        alerts={[]}
        observations={[]}
        selectedLines={null}
        numDays={30}
        onLineClick={noop}
      />,
    );
    expect(screen.getByText('L1')).toBeInTheDocument();
    expect(screen.getByText('D2')).toBeInTheDocument();
  });

  it('only renders selected lines when a filter is active', () => {
    render(
      <Timeline
        alerts={[]}
        observations={[]}
        selectedLines={['l1']}
        numDays={30}
        onLineClick={noop}
      />,
    );
    expect(screen.getByText('L1')).toBeInTheDocument();
    expect(screen.queryByText('B1')).not.toBeInTheDocument();
  });

  it('renders no Metro rows when selectedLines is empty array', () => {
    render(
      <Timeline alerts={[]} observations={[]} selectedLines={[]} numDays={30} onLineClick={noop} />,
    );
    expect(screen.queryByText('L1')).not.toBeInTheDocument();
    expect(screen.queryByText('D2')).not.toBeInTheDocument();
  });

  it('renders line labels as links to /line/:id', () => {
    render(
      <Timeline
        alerts={[]}
        observations={[]}
        selectedLines={null}
        numDays={30}
        onLineClick={noop}
      />,
    );
    const l1Link = screen.getByText('L1').closest('a');
    expect(l1Link).toBeInTheDocument();
    expect(l1Link).toHaveAttribute('href', '/line/l1');
  });

  it('renders the correct number of day columns', () => {
    render(
      <Timeline
        alerts={[]}
        observations={[]}
        selectedLines={null}
        numDays={7}
        onLineClick={noop}
      />,
    );
    // Each row has numDays cells; check one row (L1)
    const l1Row = screen.getByText('L1').closest('tr');
    // 1 label cell + 7 day cells
    expect(l1Row.querySelectorAll('td')).toHaveLength(8);
  });
});
