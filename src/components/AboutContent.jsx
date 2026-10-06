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
        A collector polls SEPTA's public real-time APIs about every 10 minutes and keeps a running
        record of what it sees:
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

      <h3 className="font-semibold text-slate-700 dark:text-slate-200 pt-2">Not covered yet</h3>
      <p>
        SEPTA Metro and bus disruptions appear here only when SEPTA posts an alert about them. The
        site has room for bot-detected Metro and bus disruptions — long gaps between vehicles,
        bunching, missing trips — but the collector doesn't detect those yet.
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
