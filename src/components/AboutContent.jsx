import { BLUESKY_ACCOUNTS } from '../lib/site.js';

const LINK = 'text-blue-500 hover:text-blue-400 hover:underline';

export default function AboutContent() {
  return (
    <div className="space-y-3 text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
      <p>
        A public archive of SEPTA service disruptions across SEPTA Metro, buses, and Regional Rail —
        one place to check how Philadelphia transit is doing right now, this week, or over the past
        few months.
      </p>
      <p className="text-xs italic text-slate-500 dark:text-slate-400">
        Unofficial. Not affiliated with, endorsed by, or sponsored by the Southeastern Pennsylvania
        Transportation Authority (SEPTA).
      </p>

      <h3 className="font-semibold text-slate-700 dark:text-slate-200 pt-2">
        Where the data comes from
      </h3>
      <p>
        A collector polls SEPTA's public real-time APIs every few minutes and keeps a running record
        of what it sees:
      </p>
      <ul className="list-disc list-outside ml-5 space-y-2">
        <li>
          <strong>Service alerts</strong> — SEPTA's own advisories and alerts for SEPTA Metro, bus,
          and Regional Rail: shuttle busing, station closures, platform changes, delays, and
          short-term bus detours. Each one is tracked from when SEPTA posts it until it comes down.
          Long-running construction detours (weeks or months of moved bus stops) and station-amenity
          notices (parking, ticket offices, waiting rooms) are left out, so the archive stays
          focused on service.
        </li>
        <li>
          <strong>Regional Rail delays</strong> — trains SEPTA's TrainView feed reports running 15+
          minutes late, tracked for as long as they stay late.
        </li>
        <li>
          <strong>Regional Rail cancellations</strong> — trains SEPTA marks as cancelled, anchored
          to the train's scheduled departure.
        </li>
        <li>
          <strong>Cancelled bus and Metro trips</strong> — trips SEPTA marks cancelled in its
          real-time trip feed (often hours ahead, when a run has no operator), grouped into one
          record per route per day with each trip's scheduled time.
        </li>
        <li>
          <strong>Detected disruptions</strong> — the collector compares where SEPTA's buses and
          trolleys are against the timetable and flags <em>long gaps</em> (vehicles twice as far
          apart as scheduled, and at least 20 minutes), <em>bunching</em> (vehicles scheduled well
          apart running together), <em>missing vehicles</em> (far fewer of a route's trips on
          SEPTA's tracker than usual), and <em>vehicles held in place</em> (two or more stopped
          mid-route for 10+ minutes). A condition has to persist for about six minutes before it's
          recorded, and when SEPTA has an alert out for the same route the detection is attached to
          it.
        </li>
        <li>
          <strong>Elevator outages</strong> — out-of-service elevators at SEPTA Metro and Regional
          Rail stations, kept on the{' '}
          <a className={LINK} href="/accessibility">
            accessibility page
          </a>{' '}
          rather than mixed in with service disruptions.
        </li>
      </ul>
      <p>
        Station names in alert text ("Shuttle busing between Olney and Fern Rock") are matched to
        SEPTA's station list, so line maps and station pages can show where disruptions happen.
      </p>

      {BLUESKY_ACCOUNTS.length > 0 && (
        <>
          <h3 className="font-semibold text-slate-700 dark:text-slate-200 pt-2">Bluesky bots</h3>
          <p>
            The same pipeline posts to Bluesky as it goes, one account per stream. Each incident
            here links to its post, and the post links back here.
          </p>
          <ul className="list-disc list-outside ml-5 space-y-1">
            {BLUESKY_ACCOUNTS.map((bot) => (
              <li key={bot.key}>
                <a className={LINK} href={bot.url} target="_blank" rel="noopener noreferrer">
                  @{bot.handle}
                </a>{' '}
                — {bot.description}
              </li>
            ))}
          </ul>
        </>
      )}

      <h3 className="font-semibold text-slate-700 dark:text-slate-200 pt-2">Limits</h3>
      <p>
        The subway lines (L1 and B1–B3) don't report train positions, so gaps and bunching can only
        be detected on buses, trolleys, and the M1. "Missing vehicles" means missing from SEPTA's
        tracker: a bus with a broken locator looks the same as one that never left the depot, so
        it's only flagged when a route that's normally well tracked suddenly isn't.
      </p>
      <p>
        "Disrupted time" figures count unplanned disruptions only. Planned work — scheduled
        closures, construction, and maintenance — is listed but not counted, and a day's cancelled
        trips show up through the gaps and missing vehicles they cause rather than as one long
        disruption.
      </p>

      <h3 className="font-semibold text-slate-700 dark:text-slate-200 pt-2">Updates</h3>
      <p>
        The page checks for new data every 5 minutes while visible. The "Updated" time in the header
        is when the collector last published data.
      </p>

      <h3 className="font-semibold text-slate-700 dark:text-slate-200 pt-2">How far back</h3>
      <p>
        The archive starts on the day the collector first ran; days before that show as "no data" on
        the calendar and timelines. Alerts that were already up on that first day keep the date
        SEPTA originally posted them.
      </p>

      <h3 className="font-semibold text-slate-700 dark:text-slate-200 pt-2">Privacy</h3>
      <p>
        No accounts, no cookies, no analytics, and no advertising — the site doesn't collect
        personal data. Your dark-mode and filter preferences are saved locally in your browser and
        never leave your device. Full details on the{' '}
        <a className={LINK} href="/privacy">
          privacy page
        </a>
        .
      </p>

      <p className="pt-2 text-xs text-slate-500 dark:text-slate-400">
        Source on{' '}
        <a
          className={LINK}
          href="https://github.com/garlicbuffalo/septa-transit-alerts"
          target="_blank"
          rel="noopener noreferrer"
        >
          GitHub
        </a>
        . Adapted from{' '}
        <a
          className={LINK}
          href="https://github.com/cailinpitt/chicago-transit-alerts"
          target="_blank"
          rel="noopener noreferrer"
        >
          Chicago Transit Alerts
        </a>
        .
      </p>
    </div>
  );
}
