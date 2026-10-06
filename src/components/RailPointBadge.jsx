import { railPointEventLabel } from '../lib/incidents.js';

// Status badge for a Regional Rail point event (delay / cancellation / inferred). The
// label comes from railPointEventLabel; the tone separates the outcomes by
// color — any cancellation (confirmed or inferred "possible cancellation")
// gets purple, its own category clear of red=ongoing and amber=delayed, while
// a late/delayed train stays amber (caution). Renders nothing for an unknown
// kind. Used by the incident list, the event page, and the surrounding-
// incidents context rows so the three stay in sync.
export default function RailPointBadge({ source }) {
  const label = railPointEventLabel(source);
  if (!label) return null;
  const cancelled = source === 'cancellation' || source === 'cancellation-inferred';
  return (
    <span
      className={`text-xs font-semibold ${
        cancelled ? 'text-purple-600 dark:text-purple-400' : 'text-amber-600 dark:text-amber-400'
      }`}
    >
      {label}
    </span>
  );
}
