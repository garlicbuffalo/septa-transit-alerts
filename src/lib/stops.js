// GTFS stop names carry boarding-position suffixes riders don't need:
// "Wissahickon Transit Center Boarding Area 5", "… Drop Off", "11th St &
// Market St - FS" (far side), "- NS" (near side), "- MBFS"/"- MBNS"
// (mid-block). Shared by the site and the bots.
export function cleanStopName(name) {
  if (name == null) return null;
  return String(name)
    .replace(/\s+(?:-\s+(?:FS|NS|MBFS|MBNS)|Boarding Area \w+|Drop Off)$/i, '')
    .trim();
}
