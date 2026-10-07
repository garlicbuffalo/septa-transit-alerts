// Small glyphs that pair with status colors so a state never reads by color
// alone: a check for good service, a clock for delays, an exclamation for
// disruptions, a warning triangle for major disruptions, a calendar for
// planned work. `name` is a mode status ('good' | 'warning' | 'serious' |
// 'critical') or a line category ('delay' | 'disruption' | 'planned').
// Decorative — the adjacent label carries the meaning. Inherits `currentColor`.
function glyph(name) {
  switch (name) {
    case 'good':
      return (
        <>
          <circle cx="8" cy="8" r="6.25" />
          <path d="M5.25 8.25 7.1 10 10.75 6.25" />
        </>
      );
    case 'warning':
    case 'delay':
      return (
        <>
          <circle cx="8" cy="8" r="6.25" />
          <path d="M8 4.75V8l2.25 1.5" />
        </>
      );
    case 'planned':
      return (
        <>
          <rect x="2.25" y="3.25" width="11.5" height="10.5" rx="1.5" />
          <path d="M2.25 6.5h11.5M5.5 1.75v3M10.5 1.75v3" />
        </>
      );
    case 'critical':
      return (
        <>
          <path d="M8 1.75 14.5 13.5h-13z" />
          <path d="M8 6.25v3.25M8 11.6v.01" strokeWidth="2" />
        </>
      );
    default:
      // 'serious' and 'disruption'
      return (
        <>
          <circle cx="8" cy="8" r="6.25" />
          <path d="M8 4.75v3.75M8 11.1v.01" strokeWidth="2" />
        </>
      );
  }
}

export default function StatusIcon({ name, className = 'h-3.5 w-3.5' }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {glyph(name)}
    </svg>
  );
}
