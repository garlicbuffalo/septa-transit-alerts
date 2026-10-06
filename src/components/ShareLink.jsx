import { useEffect, useRef, useState } from 'react';
import { SITE_NAME } from '../lib/site.js';

export default function ShareLink({ eventId, title }) {
  const [copied, setCopied] = useState(false);
  // Pick the label after mount so SSR/initial-render is consistent and we
  // don't hydrate with the wrong text. `null` means "haven't checked yet" —
  // render the desktop label as a safe default until then.
  const [canShare, setCanShare] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => {
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      setCanShare(true);
    }
    return () => clearTimeout(timerRef.current);
  }, []);

  if (!eventId) return null;

  const url = `${window.location.origin}/event/${eventId}`;

  async function handleClick(e) {
    e.preventDefault();
    // Prefer the OS share sheet on devices that have one (mobile, iPadOS).
    // Falls through to clipboard on desktop browsers without navigator.share.
    if (canShare) {
      try {
        await navigator.share({ url, title: title || SITE_NAME });
        return;
      } catch (err) {
        // User canceled the share sheet — don't fall through to clipboard.
        if (err && err.name === 'AbortError') return;
        // Any other error: fall through to clipboard so the user still gets
        // the link.
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt('Copy this link', url);
    }
  }

  const label = copied ? 'Copied!' : canShare ? 'Share 🔗' : 'Copy link 🔗';

  return (
    <a
      href={`/event/${eventId}`}
      onClick={handleClick}
      className="text-xs text-blue-500 hover:text-blue-400 hover:underline"
    >
      {label}
    </a>
  );
}
