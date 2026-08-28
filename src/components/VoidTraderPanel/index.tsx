import { useEffect, useMemo, useState } from 'react';
import { tActive, useTranslation } from '../../i18n';
import {
  formatWorldStateCountdown,
  isWorldStateWindowActive,
} from '../../lib/worldState';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ItemThumb } from '../ListRow';
import { EventEmpty, EventError, EventPanel, EventRow, RowFigure } from '../Events/parts';
import { resolveWfmAssetUrl } from '../../lib/wfmAssets';
import { buildWatchedNameSet, normalizeRewardName } from '../../lib/worldStatePricing';
import { useAppStore } from '../../stores/useAppStore';
import { walletIcons } from '../../assets/wallet';
import type { VoidTraderInventoryItem } from '../../types';

function formatCategoryLabel(category: string): string {
  return category
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function buildInventoryGroups(items: VoidTraderInventoryItem[]) {
  const grouped = new Map<string, VoidTraderInventoryItem[]>();

  for (const item of items) {
    const category = item.category.trim().length > 0 ? item.category : tActive('evt.otherCategory');
    const bucket = grouped.get(category) ?? [];
    bucket.push(item);
    grouped.set(category, bucket);
  }

  return [...grouped.entries()]
    .map(([category, entries]) => ({
      category,
      label: formatCategoryLabel(category),
      items: [...entries].sort((left, right) => left.item.localeCompare(right.item)),
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

export function VoidTraderPanel() {
  const { t } = useTranslation();
  const voidTrader = useAppStore((state) => state.worldStateVoidTrader);
  const loading = useAppStore((state) => state.worldStateVoidTraderLoading);
  const error = useAppStore((state) => state.worldStateVoidTraderError);
  const refreshWorldStateVoidTrader = useAppStore((state) => state.refreshWorldStateVoidTrader);
  const voidTraderPrices = useAppStore((state) => state.voidTraderPrices);
  const voidTraderPricesLoading = useAppStore((state) => state.voidTraderPricesLoading);
  const watchlist = useAppStore((state) => state.watchlist);
  /* Baro's stock is ~40 items and the panel re-renders on a 1s clock tick, so the lookup is a
     Set built once per watchlist change rather than a scan per row per second. */
  const watchedNames = useMemo(() => buildWatchedNameSet(watchlist), [watchlist]);

  const [nowMs, setNowMs] = useState(Date.now());
  const [selectedCategory, setSelectedCategory] = useState<string>('All');

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, []);

  const inventoryGroups = useMemo(
    () => buildInventoryGroups(voidTrader?.inventory ?? []),
    [voidTrader?.inventory],
  );
  const inventoryCategories = useMemo(
    () => ['All', ...inventoryGroups.map((group) => group.category)],
    [inventoryGroups],
  );

  useEffect(() => {
    if (!inventoryCategories.includes(selectedCategory)) {
      setSelectedCategory('All');
    }
  }, [inventoryCategories, selectedCategory]);

  const isActive = voidTrader
    ? isWorldStateWindowActive(voidTrader.activation, voidTrader.expiry, nowMs)
    : false;
  const nextCountdown = formatWorldStateCountdown(
    isActive ? (voidTrader?.expiry ?? null) : (voidTrader?.activation ?? null),
    nowMs,
  );
  const hasUsableVoidTrader = Boolean(voidTrader);
  const ducats = useAppStore((state) => state.walletSnapshot.balances.ducats);
  const visibleGroups =
    selectedCategory === 'All'
      ? inventoryGroups
      : inventoryGroups.filter((group) => group.category === selectedCategory);

  return (
    <EventPanel
      title={t('ws.voidTrader')}
      count={isActive && voidTrader ? voidTrader.inventory.length : null}
      countTone="info"
      aside={
        <>
          {ducats !== null ? (
            <span className="flex items-center gap-1 font-mono text-[11px] tabular-nums text-ink">
              <img src={walletIcons.ducats} alt="" className="size-3.5" />
              {new Intl.NumberFormat().format(ducats)}
            </span>
          ) : null}
          <span
            className={`font-mono text-[11px] font-semibold tabular-nums ${
              isActive ? 'text-accent-green' : 'text-ink-dim'
            }`}
          >
            {nextCountdown}
          </span>
        </>
      }
      bodyClassName="flex flex-col gap-2 p-2"
    >
      {error ? (
        <EventError
          error={error}
          stale={hasUsableVoidTrader}
          onRetry={() => void refreshWorldStateVoidTrader()}
        />
      ) : null}

      {loading && !voidTrader ? <Skeleton type="table-row@4" leafClassName="h-5" /> : null}

      {voidTrader && !isActive ? (
        <EventEmpty
          icon="ti-clock"
          title={t('a11y.baroNotInRelay')}
          detail={t('evt.baroNotInRelayDetail')}
        />
      ) : null}

      {voidTrader && isActive ? (
        <span className="px-1 text-[11px] text-ink-dim">
          {voidTrader.character}
          {voidTrader.location ? ` · ${voidTrader.location}` : ''}
        </span>
      ) : null}

      {voidTrader && isActive && inventoryGroups.length > 0 ? (
        <>
          <div className="flex flex-wrap gap-1" role="tablist" aria-label={t('a11y.voidTraderCategories')}>
            {inventoryCategories.map((category) => {
              const active = selectedCategory === category;
              return (
                <Button
                  key={category}
                  variant="ghost"
                  size="sm"
                  static
                  role="tab"
                  aria-selected={active}
                  onClick={() => setSelectedCategory(category)}
                  className={`h-6 rounded px-2 text-[10px] ${
                    active ? 'bg-bg-elevated text-ink' : 'text-ink-dim hover:text-ink'
                  }`}
                >
                  {category === 'All'
                    ? t('evt.allWithCount', { n: voidTrader.inventory.length })
                    : t('evt.categoryCount', {
                        label: formatCategoryLabel(category),
                        n:
                          inventoryGroups.find((group) => group.category === category)?.items
                            .length ?? 0,
                      })}
                </Button>
              );
            })}
          </div>

          {/* Rows with fixed figure columns, not a card per item. Ducats, credits and the plat
              exit price are the SAME three facts on every item — you are comparing them down the
              list, and ~40 bordered cards with three pill chips each made that impossible while
              filling the screen (`ELEMENTS.md` §6). */}
          <div className="flex flex-col gap-2">
            {visibleGroups.map((group) => (
              <div key={group.category} className="flex min-w-0 flex-col">
                <span className="px-1 py-1 font-mono text-[9px] font-semibold tracking-[0.1em] text-ink-dim uppercase">
                  {group.label} · {group.items.length}
                </span>
                {group.items.map((item) => {
                  const imageUrl = resolveWfmAssetUrl(item.imagePath);
                  const exitPrice = voidTraderPrices[item.item];
                  const hasExitPrice = exitPrice !== undefined && exitPrice !== null;
                  return (
                    <EventRow
                      key={`${item.category}-${item.item}`}
                      lead={
                        <ItemThumb
                          src={imageUrl}
                          fallback={item.item.slice(0, 1)}
                          size="size-7"
                        />
                      }
                      title={
                        watchedNames.has(normalizeRewardName(item.item)) ? (
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate">{item.item}</span>
                            {/* The Watchlist's own glyph, so the marker names the list it refers
                                to. Deliberately `ink-dim` and not an accent: the accents mean
                                profit / loss / warning, and "you are tracking this" is none of
                                them — beside a green exit price a green marker would read as a
                                profit claim. */}
                            <i
                              className="ti ti-target shrink-0 text-[13px] text-ink-dim"
                              title={t('evt.onWatchlist')}
                              aria-label={t('evt.onWatchlist')}
                            />
                          </span>
                        ) : (
                          item.item
                        )
                      }
                      trailing={
                        <>
                          <RowFigure label={t('bal.ducats')} value={item.ducats ?? '—'} />
                          <RowFigure
                            label={t('bal.credits')}
                            value={
                              item.credits !== null && item.credits !== undefined
                                ? new Intl.NumberFormat().format(item.credits)
                                : '—'
                            }
                            tone="dim"
                            width="w-16"
                          />
                          {/* The reason to care: what it resells for. */}
                          <RowFigure
                            label={t('ws.exit')}
                            value={
                              hasExitPrice
                                ? `${exitPrice}p`
                                : voidTraderPricesLoading
                                  ? '…'
                                  : '—'
                            }
                            tone={hasExitPrice ? 'positive' : 'dim'}
                          />
                        </>
                      }
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </>
      ) : null}

      {voidTrader && isActive && inventoryGroups.length === 0 ? (
        <EventEmpty
          icon="ti-package"
          title={t('a11y.voidTraderInvUnavailable')}
          detail={t('evt.voidTraderInvUnavailableDetail')}
        />
      ) : null}

      {!loading && !voidTrader ? (
        <EventEmpty
          icon="ti-plug-connected-x"
          title={t('a11y.voidTraderUnavailableData')}
          detail={error ?? t('evt.voidTraderNoDataDetail')}
        />
      ) : null}
    </EventPanel>
  );
}
