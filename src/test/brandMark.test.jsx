import { render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import BrandMark from '../components/BrandMark.jsx';

afterEach(() => {
  document.head.innerHTML = '';
});

describe('BrandMark', () => {
  it('shows City Hall when the page has no favicon link', () => {
    const { container } = render(<BrandMark />);
    expect(container.querySelector('img').getAttribute('src')).toBe('/favicon.svg');
  });

  it("follows the page's favicon, so a seasonal set reaches the header too", () => {
    document.head.innerHTML = `
      <link rel="icon" type="image/png" sizes="32x32" href="/favicon-eastern-state-32.png" />
      <link rel="icon" type="image/svg+xml" href="/favicon-eastern-state.svg" />`;
    const { container } = render(<BrandMark />);
    expect(container.querySelector('img').getAttribute('src')).toBe('/favicon-eastern-state.svg');
  });
});
