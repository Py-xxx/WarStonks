import { useEffect, useMemo, useState } from 'react';

import { EmptyState } from '@/components/ui/empty-state';
import { useTranslation } from '../../i18n';
import { HomePanel } from './HomePanel';
import { formatElapsedTime } from '../../lib/dateTime';
import { formatPlatinumDelta } from '../../lib/opportunityView';
import { getCachedWfmProfileTradeLog } from '../../lib/tauriClient';
import type { PortfolioTradeLogEntry } from '../../types';
import { formatWorldStateCountdown, isWorldStateEntryOpen } from '../../lib/worldState';
import { useAppStore } from '../../stores/useAppStore';

/**
 * The rail: only things with a clock on them.
 *
 * Sticky, so it travels with you while the action queue scrolls rather than running dry and
 * leaving dead space beside a long list. Everything here is time-bound — if an item has no
 * deadline it belongs in the main column or on its own page, not here.
 *
 * This is also where the old Alerts sub-tab went. A world-state alert IS a countdown, so it
 * reads better as "closing soon" than as a separate tab you have to remember to open.
 */

/**
 * The one row shape for all three rail panels.
 *
 * An earlier pass defined this and then used it for only the first list, hand-rolling the same
 * box model inline for relics and fills — three versions of one row inside one file, with the
 * gaps and paddings drifting between them. `lead` and `meta` take nodes so the relic chips and
 * the buy/sell glyph fit without a second row component.
 */
function RailRow({
  lead,
  name,
  meta,
  value,
  valueTone,
}: {
  lead?: React.ReactNode;
  name: string;
  meta?: React.ReactNode;
  value: string;
  valueTone?: 'red' | 'amber' | 'green';
}) {
  const toneClass =
    valueTone === 'red'
      ? 'text-accent-red'
      : valueTone === 'amber'
        ? 'text-accent-amber'
        : valueTone === 'green'
          ? 'text-accent-green'
          : 'text-ink';
  return (
    <div className="flex items-center gap-3 border-b border-line-subtle px-3 py-2 last:border-b-0">
      {lead}
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium">{name}</div>
        {meta ? <div className="mt-0.5 truncate text-[10px] text-ink-dim">{meta}</div> : null}
      </div>
      <span className={`shrink-0 font-mono text-xs font-bold tabular-nums ${toneClass}`}>
        {value}
      </span>
    </div>
  );
}

/** Under six hours reads red, under two days amber — a deadline you can still act on. */
function urgencyOf(expiry: string | null): 'red' | 'amber' | undefined {
  if (!expiry) {
    return undefined;
  }
  const msLeft = new Date(expiry).getTime() - Date.now();
  if (Number.isNaN(msLeft) || msLeft < 0) {
    return undefined;
  }
  if (msLeft < 6 * 60 * 60 * 1000) {
    return 'red';
  }
  if (msLeft < 48 * 60 * 60 * 1000) {
    return 'amber';
  }
  return undefined;
}

export function HomeRail() {
  const { t } = useTranslation();
  // Subscribing to the worldstate epoch is what re-renders this panel when a poll lands, so the
  // countdowns re-derive. The clock itself must be Date.now() — an earlier version wrote
  // `epoch && Date.now()`, which yields 0 before the first poll and counted down from 1970.
  useAppStore((s) => s.worldstateEpoch);
  const nowMs = Date.now();
  const events = useAppStore((s) => s.worldStateEvents);
  const fissures = useAppStore((s) => s.worldStateFissures);
  const ownedRelics = useAppStore((s) => s.ownedRelics);
  const voidTrader = useAppStore((s) => s.worldStateVoidTrader);
  const setActivePage = useAppStore((s) => s.setActivePage);
  const tradeAccount = useAppStore((s) => s.tradeAccount);

  // Recent fills come straight off the CACHED profile trade log — the same source Portfolio
  // reads, so this adds no network cost and needs no new backend command. Re-read when a trade
  // is detected (the nonce the Trades page already bumps) rather than on a timer.
  const tradeReloadNonce = useAppStore((s) => s.tradeOverviewReloadNonce);
  const [fills, setFills] = useState<PortfolioTradeLogEntry[]>([]);

  useEffect(() => {
    const username = tradeAccount?.name;
    if (!username) {
      setFills([]);
      return;
    }
    let active = true;
    void getCachedWfmProfileTradeLog(username)
      .then((log) => {
        if (!active) {
          return;
        }
        const newestFirst = [...log.entries].sort((a, b) => b.closedAt.localeCompare(a.closedAt));
        setFills(newestFirst.slice(0, 4));
      })
      .catch(() => {
        // A missing cache is a normal cold-start state, not an error worth surfacing here.
        if (active) {
          setFills([]);
        }
      });
    return () => {
      active = false;
    };
  }, [tradeAccount?.name, tradeReloadNonce]);

  // Soonest deadline first: the rail exists to stop you missing something, so whatever expires
  // next has to be at the top regardless of what kind of thing it is.
  const closing = useMemo(() => {
    const rows = events
      .filter((event) => isWorldStateEntryOpen(event.expiry, event.expired, nowMs))
      .map((event) => ({
        id: event.id,
        name: event.description,
        meta: event.node,
        expiry: event.expiry as string,
      }));
    // The Void Trader is the one exception: `expired` there means he is AWAY, and `expiry` is
    // when he next arrives — a countdown worth showing, not a finished one. Hence no filter.
    if (voidTrader?.expiry) {
      rows.push({
        id: 'void-trader',
        name: voidTrader.expired ? t('home.voidTraderArrives') : t('home.voidTraderLeaves'),
        meta: voidTrader.location ?? null,
        expiry: voidTrader.expiry,
      });
    }
    return rows.sort((a, b) => a.expiry.localeCompare(b.expiry)).slice(0, 5);
  }, [events, voidTrader, t, nowMs]);

  // Fissures worth running: only those whose tier matches a relic you actually hold. An
  // unfiltered fissure list is the Events page's job — the rail's version only earns its space
  // by being about YOUR inventory.
  const relicRuns = useMemo(() => {
    const heldByTier = new Map<string, { code: string; total: number }[]>();
    for (const relic of ownedRelics) {
      if (relic.counts.total <= 0) {
        continue;
      }
      const tier = relic.tier.toLowerCase();
      const bucket = heldByTier.get(tier) ?? [];
      bucket.push({ code: relic.code, total: relic.counts.total });
      heldByTier.set(tier, bucket);
    }

    return fissures
      .filter((fissure) => fissure.tier && isWorldStateEntryOpen(fissure.expiry, fissure.expired, nowMs))
      .map((fissure) => ({
        fissure,
        held: heldByTier.get((fissure.tier ?? '').toLowerCase()) ?? [],
      }))
      .filter((row) => row.held.length > 0)
      .sort((a, b) => (a.fissure.expiry ?? '').localeCompare(b.fissure.expiry ?? ''))
      .slice(0, 4);
  }, [fissures, ownedRelics, nowMs]);

  return (
    <div className="sticky top-4 flex min-w-0 flex-col gap-4">
      <HomePanel
        title={t('home.closingSoon')}
        dotClass="bg-accent-amber"
        linkLabel={t('home.allEvents')}
        onLink={() => setActivePage('events')}
      >
        {closing.length === 0 ? (
          <EmptyState icon="ti-clock" title={t('home.nothingClosing')} className="py-5" />
        ) : (
          closing.map((row) => (
            <RailRow
              key={row.id}
              name={row.name}
              meta={row.meta}
              value={formatWorldStateCountdown(row.expiry, nowMs)}
              valueTone={urgencyOf(row.expiry)}
            />
          ))
        )}
      </HomePanel>

      <HomePanel
        title={t('home.yourRelics')}
        dotClass="bg-accent-purple"
        linkLabel={t('home.openInventory')}
        onLink={() => setActivePage('inventory')}
      >
        {relicRuns.length === 0 ? (
          <EmptyState icon="ti-diamond" title={t('home.noFissures')} className="py-5" />
        ) : (
          relicRuns.map(({ fissure, held }) => (
            <RailRow
              key={fissure.id}
              name={`${fissure.tier} · ${fissure.missionType ?? ''}`}
              meta={
                <span className="flex flex-wrap gap-1">
                  {held.slice(0, 3).map((relic) => (
                    <span
                      key={relic.code}
                      className="rounded border border-line-strong bg-bg-elevated px-1.5 font-mono text-[10px] font-semibold text-ink-soft tabular-nums"
                    >
                      {relic.code} ×{relic.total}
                    </span>
                  ))}
                </span>
              }
              value={formatWorldStateCountdown(fissure.expiry, nowMs)}
              valueTone={urgencyOf(fissure.expiry)}
            />
          ))
        )}
      </HomePanel>

      <HomePanel title={t('home.recentFills')} dotClass="bg-accent-green">
        {fills.length === 0 ? (
          <EmptyState icon="ti-receipt" title={t('home.noFills')} className="py-5" />
        ) : (
          fills.map((fill) => (
            <RailRow
              key={fill.id}
              lead={
                <span
                  className={`grid size-6 shrink-0 place-items-center rounded-sm ${
                    fill.orderType === 'sell'
                      ? 'bg-accent-green/15 text-accent-green'
                      : 'bg-accent-red/15 text-accent-red'
                  }`}
                >
                  <i
                    className={`ti ${fill.orderType === 'sell' ? 'ti-tag' : 'ti-shopping-cart'}`}
                    aria-hidden="true"
                  />
                </span>
              }
              name={fill.itemName}
              meta={formatElapsedTime(fill.closedAt)}
              // A buy is platinum leaving the wallet, so it signs negative — the same convention
              // the Act now value column uses, through the same formatter.
              value={formatPlatinumDelta(
                fill.orderType === 'sell' ? fill.platinum : -fill.platinum,
              )}
              valueTone={fill.orderType === 'sell' ? 'green' : 'red'}
            />
          ))
        )}
      </HomePanel>
    </div>
  );
}
