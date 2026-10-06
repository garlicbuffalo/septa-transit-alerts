// Verified-style badge that marks content as coming straight from the transit
// agency (an official SEPTA alert), as opposed to a bot detection. The blue
// circle + white check is the universally recognized "verified/official" mark.
// `size` is a Tailwind width/height pair so callers can scale it to their
// context (the event page uses the default; the dense home list uses smaller).
export default function OfficialBadge({ agency, className = '', size = 'w-3.5 h-3.5' }) {
  const label = `Official ${agency} alert`;
  return (
    <span className={`inline-flex items-center text-blue-500 ${className}`} title={label}>
      <svg viewBox="0 0 24 24" className={size} fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="10" fill="currentColor" />
        <path
          d="M7.5 12.5l3 3 6-6.5"
          stroke="#fff"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span className="sr-only">{label}</span>
    </span>
  );
}
