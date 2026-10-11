import { useId } from 'react';

// The site's mark (same drawing as public/favicon.svg): Philadelphia City
// Hall's tower drawn in transit lines — the L1, B, and T colors rise as the
// shaft and meet at the clock, under the dome and William Penn.
// Decorative — the site name always sits beside it.
export default function BrandMark({ className = 'h-8 w-8' }) {
  // The header and footer both render a mark, so the gradient id must be unique
  // (and a plain name: url(#…) can't take every character useId may emit).
  const bg = `brand-bg${useId().replace(/[^\w-]/g, '')}`;
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={bg} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1c2330" />
          <stop offset="1" stopColor="#0d1117" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="7" fill={`url(#${bg})`} />
      <g strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" fill="none">
        <path d="M9.5 28v-9l4-3" stroke="#5A960A" />
        <path d="M16 28V18" stroke="#F26100" />
        <path d="M22.5 28v-9l-4-3" stroke="#0097D6" />
      </g>
      <circle cx="16" cy="14" r="4" fill="#0d1117" stroke="#FFD700" strokeWidth="2.3" />
      <path d="M16 14v-2M16 14h1.5" stroke="#FFD700" strokeWidth="1.1" strokeLinecap="round" />
      <path
        d="M12.6 9.2C12.6 6.6 14.2 5.6 16 4.6 17.8 5.6 19.4 6.6 19.4 9.2Z"
        fill="#FFD700"
        stroke="#161c26"
        strokeWidth="1"
      />
      <rect x="15.25" y="1.8" width="1.5" height="3.6" rx=".75" fill="#FFD700" />
    </svg>
  );
}
