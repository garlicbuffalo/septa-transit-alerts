// Launch the headless Chromium used for OG-card rendering. Playwright's own
// download is the default (`npx playwright install chromium`); set
// CHROMIUM_PATH to use an existing Chromium binary instead (e.g. a system or
// container-provided one whose version doesn't match the Playwright package).
import { chromium } from 'playwright';

export function launchChromium() {
  const executablePath = process.env.CHROMIUM_PATH || undefined;
  return chromium.launch(executablePath ? { executablePath } : {});
}
