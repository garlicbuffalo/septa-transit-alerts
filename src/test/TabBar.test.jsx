import '@testing-library/jest-dom';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import TabBar from '../components/TabBar.jsx';
import { PRIMARY_NAV } from '../lib/nav.js';

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

const open = (path) => {
  window.history.replaceState(null, '', path);
  render(<TabBar />);
  return within(screen.getByRole('navigation', { name: 'Primary' }));
};

describe('TabBar', () => {
  it('has a tab for each primary destination, the map among them', () => {
    const bar = open('/');
    const links = bar.getAllByRole('link');
    expect(links.map((a) => a.textContent)).toEqual(PRIMARY_NAV.map((item) => item.label));
    expect(bar.getByRole('link', { name: 'Map' })).toHaveAttribute('href', '/map');
  });

  it('lights up the map’s own tab on the system map, and not Routes', () => {
    const bar = open('/map?modes=bus');
    expect(bar.getByRole('link', { name: 'Map' })).toHaveAttribute('aria-current', 'page');
    expect(bar.getByRole('link', { name: 'Routes' })).not.toHaveAttribute('aria-current');
  });

  it('still lights up Routes on a route page', () => {
    const bar = open('/route/17');
    expect(bar.getByRole('link', { name: 'Routes' })).toHaveAttribute('aria-current', 'page');
    expect(bar.getByRole('link', { name: 'Map' })).not.toHaveAttribute('aria-current');
  });

  it('spreads however many tabs there are across the bar', () => {
    open('/');
    const list = screen.getByRole('list');
    expect(list).toHaveClass('grid-flow-col', 'auto-cols-fr');
  });
});
