import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import SubscribeContent from '../components/SubscribeContent.jsx';
import { SITE_ORIGIN } from '../lib/site.js';

describe('SubscribeContent feed picker', () => {
  it('defaults to the L1 feed URL', () => {
    render(<SubscribeContent />);
    expect(screen.getByDisplayValue(`${SITE_ORIGIN}/feed/line/l1.xml`)).toBeInTheDocument();
  });

  it('updates the feed URL when a bus route is picked', async () => {
    render(<SubscribeContent />);
    await userEvent.selectOptions(screen.getByLabelText('Metro line or bus route'), 'route/17');
    expect(screen.getByDisplayValue(`${SITE_ORIGIN}/feed/route/17.xml`)).toBeInTheDocument();
  });

  it('updates the feed URL when a Regional Rail line is picked', async () => {
    render(<SubscribeContent />);
    await userEvent.selectOptions(screen.getByLabelText('Regional Rail line'), 'rail/line/wtr');
    expect(screen.getByDisplayValue(`${SITE_ORIGIN}/feed/rail/line/wtr.xml`)).toBeInTheDocument();
  });
});
