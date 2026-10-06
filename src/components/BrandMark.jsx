// The site's tile-grid mark (same drawing as public/favicon.svg): three rows
// of tiles for the L1, B, and T lines, with lit tiles in each line's color.
// Decorative — the site name always sits beside it.
export default function BrandMark({ className = 'h-8 w-8' }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="7" fill="#0d1117" />
      <rect x="5" y="6" width="4" height="4" rx="1" fill="#30363d" />
      <rect x="11" y="6" width="4" height="4" rx="1" fill="#0097D6" />
      <rect x="17" y="6" width="4" height="4" rx="1" fill="#30363d" />
      <rect x="23" y="6" width="4" height="4" rx="1" fill="#0097D6" opacity="0.5" />
      <rect x="5" y="14" width="4" height="4" rx="1" fill="#F26100" />
      <rect x="11" y="14" width="4" height="4" rx="1" fill="#30363d" />
      <rect x="17" y="14" width="4" height="4" rx="1" fill="#F26100" opacity="0.5" />
      <rect x="23" y="14" width="4" height="4" rx="1" fill="#30363d" />
      <rect x="5" y="22" width="4" height="4" rx="1" fill="#30363d" />
      <rect x="11" y="22" width="4" height="4" rx="1" fill="#30363d" />
      <rect x="17" y="22" width="4" height="4" rx="1" fill="#5A960A" />
      <rect x="23" y="22" width="4" height="4" rx="1" fill="#30363d" />
    </svg>
  );
}
