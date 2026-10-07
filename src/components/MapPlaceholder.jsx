// The map's box, held open while its code loads so the page doesn't jump.
export default function MapPlaceholder({ className = 'h-[360px] sm:h-[480px]' }) {
  return (
    <div aria-hidden="true" className={`rounded-md bg-[#262626] animate-pulse ${className}`} />
  );
}
