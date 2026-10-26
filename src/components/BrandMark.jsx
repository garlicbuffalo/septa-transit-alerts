// The site's mark: the same drawing as the page's favicon. index.html swaps the
// favicon links to a seasonal set on its dates (public/favicon-<set>.svg), so
// reading the SVG link as it stands keeps the header and footer marks matching
// the tab and home-screen icons; with no link (tests, SSR) it is City Hall.
// Decorative — the site name always sits beside it.
const DEFAULT_MARK = '/favicon.svg';

function currentMark() {
  if (typeof document === 'undefined') return DEFAULT_MARK;
  const link = document.querySelector('link[rel="icon"][type="image/svg+xml"]');
  return link?.getAttribute('href') || DEFAULT_MARK;
}

export default function BrandMark({ className = 'h-8 w-8' }) {
  return <img src={currentMark()} alt="" aria-hidden="true" className={className} />;
}
