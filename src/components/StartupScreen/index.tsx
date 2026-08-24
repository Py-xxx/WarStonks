/**
 * The boot screen — a **design pass** (`ELEMENTS.md` §1).
 *
 * You look at this for two seconds on a warm start and for several minutes on a first install, and
 * it is the very first thing anyone sees of the product. What it was: a bordered panel with a
 * heading, a subtitle, a percentage chip, a stage card, and **a four-cell grid whose fourth cell
 * read "Ready For — Analysis, scanners, watchlists, and events"**. That is marketing copy on a
 * loading screen, and two of the other three cells restated the status line directly underneath
 * them. All four are gone under `ui-copy`'s delete test.
 *
 * What replaced them is the one thing the old screen could not tell you: **where you are in the
 * sequence.** The boot has four real phases and the backend already names them in `stageKey`, so
 * they render as a checklist — done, running, pending. A long wait you can see the shape of is a
 * different experience from a long wait behind a single bar, and this is the screen where that
 * matters most, because the first-install path genuinely takes minutes.
 *
 * The other change is that it now looks like the product: the app mark (which was in the repo,
 * unused) and one soft accent bloom — the single Expressive moment the view is allowed, and it can
 * afford it because there is nothing else on screen competing.
 */
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import appLogo from '../../assets/branding/app-logo.png';
import { useTranslation } from '../../i18n';
import type { TranslationKey } from '../../i18n/en';
import type { StartupProgress, StartupSummary } from '../../lib/tauriClient';

interface StartupScreenProps {
  progress: StartupProgress;
  summary: StartupSummary | null;
  errorMessage: string | null;
  onRetry: () => void;
}

/**
 * The four phases of a boot, in order, matched on the `stageKey` the backend and
 * `useStartupInitialization` already emit. Matching on the key rather than on a progress threshold
 * keeps this honest: if a phase is skipped or reordered the checklist follows it, instead of
 * claiming a step finished because the bar happened to pass a number.
 */
const PHASES: Array<{ id: string; labelKey: TranslationKey; match: (key: string) => boolean }> = [
  {
    id: 'catalog',
    labelKey: 'su.phase.catalog',
    match: (key) =>
      key === 'startup' || key === 'startup-command' || key.startsWith('catalog-v2'),
  },
  { id: 'planning', labelKey: 'su.phase.planning', match: (key) => key === 'trade-set-map' },
  { id: 'session', labelKey: 'su.phase.session', match: (key) => key === 'trade-session' },
  {
    id: 'live',
    labelKey: 'su.phase.live',
    match: (key) => key.startsWith('worldstate') || key === 'startup-complete',
  },
];

function activePhaseIndex(stageKey: string): number {
  const index = PHASES.findIndex((phase) => phase.match(stageKey));
  return index === -1 ? 0 : index;
}

function formatPercent(progressValue: number): string {
  return `${Math.round(Math.max(0, Math.min(progressValue, 1)) * 100)}%`;
}

/**
 * The backend's status text is written for a log, not a boot screen. These rewrites strip the
 * implementation detail out of the handful of lines a user actually sees.
 */
function formatStartupStatusText(progress: StartupProgress, fallback: string): string {
  const trimmed = progress.statusText.trim();
  if (!trimmed) {
    return fallback;
  }

  return (
    trimmed
      .replace(/catalog initialization is complete\./i, '')
      .replace(
        /loading \d+ worldstate feeds before entering the app\./i,
        'Refreshing live event data before launch.',
      )
      .replace(
        /checking saved warframe market session and credentials\./i,
        'Checking your trading session.',
      )
      .replace(
        /building the cached set component map for trade reconciliation\./i,
        'Preparing planning data.',
      )
      .replace(
        /connecting startup progress and invoking the desktop initializer\./i,
        'Starting the app.',
      )
      .trim() || fallback
  );
}

// These stage keys only ever fire on a genuine first-install catalog build (see
// `item_catalog_v2::initialize_catalog_v2_on_startup` — a stale-but-already-present catalog now
// refreshes off the boot path entirely, so reaching this blocking build path at all means there
// was no catalog file to serve yet).
const FIRST_BOOT_BUILD_STAGE_KEYS = new Set([
  'catalog-v2-fetch',
  'catalog-v2-sets',
  'catalog-v2-wfstat',
  'catalog-v2-writing',
]);

/**
 * Startup failures arrive as backend strings. Each branch answers the only question that matters
 * on this screen — *is this mine to fix, and will retrying help?* Source-outage codes are matched
 * first because their underlying messages also contain words like "download" and "unreachable"
 * that would otherwise fall into the generic network branch.
 */
function startupErrorKey(errorMessage: string): TranslationKey {
  const normalized = errorMessage.trim();
  if (!normalized) {
    return 'su.err.generic';
  }
  if (/WFM_OFFLINE/.test(normalized)) {
    return 'su.err.wfmOffline';
  }
  if (/WFSTAT_FIRST_RUN_OFFLINE/.test(normalized)) {
    return 'su.err.wfstatFirstRun';
  }
  if (/session expired/i.test(normalized)) {
    return 'su.err.session';
  }
  if (/network|timed out|timeout|fetch/i.test(normalized)) {
    return 'su.err.network';
  }
  if (/database|sqlite|catalog/i.test(normalized)) {
    return 'su.err.database';
  }
  return 'su.err.generic';
}

export function StartupScreen({ progress, summary, errorMessage, onRetry }: StartupScreenProps) {
  const { t } = useTranslation();
  const progressPercent = Math.max(0, Math.min(progress.progressValue, 1)) * 100;
  const failed = Boolean(errorMessage);
  const activeIndex = activePhaseIndex(progress.stageKey);
  const isFirstBootBuild = !failed && FIRST_BOOT_BUILD_STAGE_KEYS.has(progress.stageKey);
  const statusText = formatStartupStatusText(progress, t('su.preparingWorkspace'));

  const indexedItems = summary?.stats
    ? (summary.stats.totalWfmItems + summary.stats.totalWfstatItems).toLocaleString()
    : null;

  return (
    <div className="relative grid min-h-screen place-items-center overflow-hidden bg-bg-base p-6">
      {/* The one Expressive moment this view is allowed — and it can afford it, because nothing
          else is on screen to compete with it. Decorative, so it is hidden and inert. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -top-40 left-1/2 h-96 w-[640px] -translate-x-1/2 rounded-full bg-accent-blue/10 blur-3xl"
      />

      <div className="relative flex w-full max-w-md flex-col gap-6">
        <header className="flex flex-col items-center gap-3 text-center">
          <img
            src={appLogo}
            alt=""
            className="size-14 rounded-xl border border-line-strong object-cover shadow-float"
          />
          <div className="flex flex-col gap-1">
            <h1 className="text-base font-semibold text-ink">WarStonks</h1>
            <p className="text-[11px] text-ink-dim">
              {failed ? t('su.needsRetry') : t('su.gettingReady')}
            </p>
          </div>
        </header>

        <Panel className="gap-4 p-4">
          {/* Status, then the bar. The line above the bar says what is happening; the bar says how
              far in. The old screen put a percentage chip up in the header, a stage label in one
              place and the status in another — three readings of one fact, none of them adjacent. */}
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate text-xs font-medium text-ink">
                {failed ? t('su.error') : progress.stageLabel}
              </span>
              <span
                className={`shrink-0 font-mono text-xs font-semibold tabular-nums ${
                  failed ? 'text-accent-red' : 'text-ink-soft'
                }`}
              >
                {formatPercent(progress.progressValue)}
              </span>
            </div>

            <div
              className="h-1 overflow-hidden rounded-full bg-bg-base"
              role="progressbar"
              aria-label={t('a11y.startupProgress')}
              aria-valuenow={Math.round(progressPercent)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className={`h-full rounded-full transition-[width] duration-300 ease-out ${
                  failed ? 'bg-accent-red' : 'bg-accent-blue'
                }`}
                style={{ width: `${progressPercent}%` }}
              />
            </div>

            <p className="text-[11px] leading-relaxed text-ink-dim">
              {failed ? t(startupErrorKey(errorMessage ?? '')) : statusText}
            </p>
          </div>

          {/* The checklist. This is what the old screen could not tell you: which of the four
              phases are done, which is running, and what is still to come. */}
          {!failed ? (
            <ul className="flex flex-col gap-1.5">
              {PHASES.map((phase, index) => {
                const done = index < activeIndex;
                const running = index === activeIndex;
                return (
                  <li key={phase.id} className="flex items-center gap-2">
                    <span
                      className={`grid size-4 shrink-0 place-items-center rounded-full text-[10px] ${
                        done
                          ? 'bg-accent-green/15 text-accent-green'
                          : running
                            ? 'bg-accent-blue/15 text-accent-blue'
                            : 'bg-bg-elevated text-ink-faint'
                      }`}
                      aria-hidden="true"
                    >
                      {/* No pulse here. `animate-pulse` belongs to `Skeleton` and guard 3 rejects
                          it elsewhere — correctly: the progress bar is already the motion on this
                          screen, and the running phase is legible from its accent and its weight
                          without a second thing throbbing next to it. */}
                      {done ? (
                        <i className="ti ti-check" />
                      ) : (
                        <span
                          className={`rounded-full bg-current ${running ? 'size-2' : 'size-1.5'}`}
                        />
                      )}
                    </span>
                    <span
                      className={`text-[11px] ${
                        done ? 'text-ink-dim' : running ? 'font-medium text-ink' : 'text-ink-faint'
                      }`}
                    >
                      {t(phase.labelKey)}
                    </span>
                    {running && indexedItems && phase.id === 'catalog' ? (
                      <span className="ml-auto font-mono text-[10px] tabular-nums text-ink-dim">
                        {t('su.itemsCounted', { n: indexedItems })}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}

          {/* The single most useful thing this screen can say, and only on the path where it is
              true: this one takes minutes, and it never happens again. */}
          {isFirstBootBuild ? (
            <p className="flex items-start gap-2 rounded-md border border-accent-blue/25 bg-accent-blue/8 px-2.5 py-2 text-[11px] leading-relaxed text-accent-blue">
              <i className="ti ti-info-circle mt-px shrink-0 text-sm" aria-hidden="true" />
              {t('su.firstBootNote')}
            </p>
          ) : null}

          {failed ? (
            <div className="flex flex-col gap-2" role="alert">
              {/* The raw backend message, kept under the friendly one: the mapped copy tells you
                  what to do, this tells you what actually broke, and support needs both. */}
              <p className="rounded-md bg-bg-base px-2.5 py-2 font-mono text-[10px] leading-relaxed break-words text-ink-dim">
                {errorMessage}
              </p>
              <Button className="w-full" onClick={onRetry}>
                <i className="ti ti-refresh" aria-hidden="true" />
                {t('su.retry')}
              </Button>
            </div>
          ) : null}
        </Panel>
      </div>
    </div>
  );
}
