/**
 * Events → Overview: what is happening right now, across every worldstate source.
 *
 * Events had five tabs and no landing page, so the two most time-critical things in the game —
 * fissures and alerts — were each one click away behind a tab that showed nothing else. This is
 * the page that answers 'what is on' without navigating.
 *
 * **The rule this page is built on: a summary must never be a second implementation.** Anything
 * shown in full here (alerts, active events, fissures) renders the real panel; anything summarised
 * (Baro, Varzia, Nightwave, Teshin) shows the *one fact that changes* and links to the tab holding
 * the rest. A second copy of a panel is how two surfaces start disagreeing — see `opportunityView`
 * in `ELEMENTS.md` §7 for the time that already cost us.
 */
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import { useTranslation } from '../../i18n';
import { formatShortLocalDateTime } from '../../lib/dateTime';
import {
  formatWorldStateCountdown,
  isWorldStateWindowActive,
  parseVaultTraderPayload,
} from '../../lib/worldState';
import { useAppStore } from '../../stores/useAppStore';
import type { EventsSubTab } from '../../types';
import { ActiveEventsPanel } from '../ActiveEventsPanel';
import { FissuresPanel } from '../FissuresPanel';
import { WorldStateAlertsPanel } from '../WorldStateAlertsPanel';

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * A summary card: an eyebrow, the one fact that changes, and the way to the full view.
 *
 * Deliberately NOT an `EventPanel` — a panel header plus a body would be more chrome than the two
 * lines of content inside it. This is the smallest thing that can carry a status and a link.
 */
function SummaryCard({
  eyebrow,
  headline,
  detail,
  tone = 'neutral', actionLabel, onAction, children, }: { eyebrow: string;
  headline: string;
  detail?: string | null;
  tone?: 'neutral' | 'positive' | 'muted';
  actionLabel: string;
  onAction: () => void;
  children?: React.ReactNode;
}) {
  return (
    <Panel className="min-w-0 gap-2 p-3">
      <span className="font-mono text-[9px] font-semibold tracking-[0.1em] text-ink-dim uppercase">
        {eyebrow}
      </span>
      <span
        className={`truncate text-xs font-semibold ${
          tone === 'positive'
            ? 'text-accent-green'
            : tone === 'muted'
              ? 'text-ink-dim'
              : 'text-ink'
        }`}
      >
        {headline}
      </span>
      {detail ? (
        <span className="text-[10px] leading-relaxed text-ink-dim">
          {detail}
        </span>
      ) : null}
      {children}
      <Button
        variant="ghost"
        size="sm"
        static
        className="mt-auto h-6 self-start px-1.5 text-[10px] text-ink-dim hover:text-ink"
        onClick={onAction}
      >
        {actionLabel}
        <i className="ti ti-chevron-right" aria-hidden="true" />
      </Button>
    </Panel>
  );
}

export function EventsOverview({
  onNavigate,
}: {
  onNavigate: (tab: EventsSubTab) => void;
}) {
  const { t } = useTranslation();
  const voidTrader = useAppStore((state) => state.worldStateVoidTrader);
  const vaultEntry = useAppStore( (state) => state.worldStateExtra['vault-trader'], );
  const nightwaveEntry = useAppStore( (state) => state.worldStateExtra.nightwave, );
  const steelPathEntry = useAppStore( (state) => state.worldStateExtra['steel-path'], );

  const [nowMs, setNowMs] = useState(Date.now());
  useEffect(() => {
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, []);

  // ---- Baro ----
  const baroActive = voidTrader
    ? isWorldStateWindowActive(voidTrader.activation, voidTrader.expiry, nowMs)
    : false;
  const baroCountdown = formatWorldStateCountdown( baroActive ? (voidTrader?.expiry ?? null)
      : (voidTrader?.activation ?? null),
    nowMs,
  );

  // ---- Varzia ----
  const varzia = parseVaultTraderPayload(vaultEntry.payload);

  // ---- Nightwave ----
  const nightwavePayload = (nightwaveEntry.payload ?? null) as Record<string, unknown> | null;
  const nightwaveSeason = asNumber(nightwavePayload?.season);
  const nightwaveChallenges = Array.isArray(nightwavePayload?.activeChallenges)
    ? (nightwavePayload.activeChallenges as Record<string, unknown>[])
    : [];
  // Elite first, then weekly: the dailies are worth the least standing and refresh constantly,
  // so a three-line preview that leads with them tells you nothing you need.
  const previewChallenges = [...nightwaveChallenges]
    .sort((left, right) => {
      const rank = (entry: Record<string, unknown>) =>
        entry.isElite === true ? 0 : entry.isDaily === true ? 2 : 1;
      return rank(left) - rank(right);
    })
    .slice(0, 3);

  // ---- Teshin ----
  const steelPayload = (steelPathEntry.payload ?? null) as Record<string, unknown> | null;
  const currentReward = (steelPayload?.currentReward ?? null) as Record<string, unknown> | null;
  const teshinItem = asString(currentReward?.name);
  const teshinCost = asNumber(currentReward?.cost);
  const teshinExpiry = asString(steelPayload?.expiry);

  return (
    /* A main column and a fissure rail, not a stack of full-width rows.
       Two things were fighting before: Alerts and Active Events sat side by side and almost never
       hold the same number of entries, so the shorter one left a hole; and the fissure grid's six
       eras hold anywhere from one to five rows each, so the auto-fill wrap left a second hole
       under the short columns. Both are the same mistake — laying out content of unequal length in
       equal-width cells. Fissures are the tallest thing here and the most-checked, so they take a
       fixed rail down the side and everything else packs vertically beside them
       (`ELEMENTS.md` §6: columns when heights vary, a grid when they do not). */
    <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="flex min-w-0 flex-col gap-3">
        {/* Status first, at a glance: four small cards for the sources whose full view lives behind
          a tab. Each shows the one fact that changes and links onward. */}
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(196px,1fr))]">
          <SummaryCard
            eyebrow={t('ws.voidTrader')}
            headline={baroActive ? t('evt.active') : t('evt.away')}
            detail={
              voidTrader
                ? baroActive
                  ? t('evt.leftCountdown', { time: baroCountdown })
                  : t('evt.untilArrival', { time: baroCountdown })
                : t('evt.voidTraderNoDataDetail')
            }
            tone={baroActive ? 'positive' : 'muted'}
            actionLabel={t('events.tab.vendors')}
            onAction={() => onNavigate('vendors')}
          >
            {baroActive && voidTrader ? (
              <span className="font-mono text-[11px] tabular-nums text-ink">
                {t('evt.itemsCount', { n: voidTrader.inventory.length })}
              </span>
            ) : null}
          </SummaryCard>

          <SummaryCard
            eyebrow={t('evt.primeResurgenceVarziaLabel')}
            headline={
              varzia?.active ? t('evt.vaultedRelicsAvailable') : t('evt.away')
            }
            detail={
              varzia?.active
                ? varzia.expiry
                  ? t('evt.leavesAt', {
                      date: formatShortLocalDateTime(varzia.expiry),
                    })
                  : t('evt.currentlyInBazaar')
                : varzia?.activation
                  ? t('evt.returnsAt', {
                      date: formatShortLocalDateTime(varzia.activation),
                    })
                  : t('evt.rotationBetweenCycles')
            }
            tone={varzia?.active ? 'positive' : 'muted'}
            actionLabel={t('events.tab.vendors')}
            onAction={() => onNavigate('vendors')}
          >
            {varzia?.active && varzia.tradeableItems.length > 0 ? (
              <span className="font-mono text-[11px] tabular-nums text-ink">
                {t('evt.itemsCount', { n: varzia.tradeableItems.length })}
              </span>
            ) : null}
          </SummaryCard>

          {/* Teshin's weekly Limited item is the ONE thing in his shop that rotates — the evergreen
            list has not changed in years. So it is the headline, and the rest is a click away. */}
          <SummaryCard
            eyebrow={t('evt.steelPathTeshinLabel')}
            headline={teshinItem ?? t('evt.steelPathUnavailable')}
            detail={
              teshinExpiry
                ? t('evt.rotates', {
                    date: formatShortLocalDateTime(teshinExpiry),
                  })
                : null
            }
            actionLabel={t('events.tab.progression')}
            onAction={() => onNavigate('progression')}
          >
            {teshinCost !== null ? (
              <span className="font-mono text-[11px] tabular-nums text-ink">
                {t('evt.steelEssenceSuffix', { n: teshinCost })}
              </span>
            ) : null}
          </SummaryCard>

          <SummaryCard
            eyebrow="Nightwave"
            headline={
              nightwaveSeason !== null
                ? t('evt.nightwaveSeason', { n: nightwaveSeason })
                : t('evt.noNightwaveSeason')
            }
            detail={
              nightwaveChallenges.length > 0
                ? t('evt.activeChallengesCount', {
                    n: nightwaveChallenges.length,
                  })
                : null
            }
            actionLabel={t('events.tab.progression')}
            onAction={() => onNavigate('progression')}
          >
            {previewChallenges.length > 0 ? (
              <ul className="flex flex-col gap-1">
                {previewChallenges.map((challenge, index) => (
                  <li
                    key={index}
                    className="flex min-w-0 items-baseline justify-between gap-2"
                  >
                    <span className="truncate text-[10px] text-ink-soft">
                      {asString(challenge.title) ?? t('evt.nightwaveWeekly')}
                    </span>
                    {asNumber(challenge.reputation) !== null ? (
                      <span className="shrink-0 font-mono text-[10px] tabular-nums text-accent-green">
                        {(asNumber(challenge.reputation) ?? 0).toLocaleString()}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </SummaryCard>
        </div>

        {/* Then the live lists, stacked rather than side by side: they are usually nought to three
          entries each and never the same length, so two columns guaranteed a hole under whichever
          was shorter. */}
        <WorldStateAlertsPanel />
        <ActiveEventsPanel />
      </div>

      {/* Fissures are the most-checked thing on this page, so they are here in full rather than
          behind a tab — as a rail, where their unequal era lengths stack instead of wrapping.
          The Fissures tab renders the same component in its `grid` layout. */}
      <FissuresPanel layout="rail" />
    </div>
  );
}
