import { useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { createPortal } from 'react-dom';
import {
  cacheOrderHealth,
  marketLowCache,
  marketLowKey,
  tradeHealthCache,
  tradeOverviewCache,
  tradeOverviewLoadPromises,
} from '../../lib/tradeCache';
import { useSmartManageStates } from '../../hooks/useSmartManageStates';
import { useAnchoredPopover } from '../../hooks/useAnchoredPopover';
import { formatTradesErrorMessage } from '../../lib/tradesErrorHandling';
import {
  closeWfmSellOrder,
  closeWfmBuyOrder,
  createWfmBuyOrder,
  createWfmSellOrder,
  deleteWfmBuyOrder,
  deleteWfmSellOrder,
  getItemAnalysis,
  getItemAnalytics,
  getTradeSellOrderHealth,
  getTradeBuyOrderHealth,
  subscribeToTradeHealthStale,
  getWfmAutocompleteItems,
  getWfmItemSubtypes,
  getWfmTradeOverview,
  setWfmOrdersVisibility,
  updateWfmBuyOrder,
  updateWfmSellOrder,
} from '../../lib/tauriClient';
import { formatShortLocalDateTime } from '../../lib/dateTime';
import { formatPlatinumValue, formatTradeStatusLabel, getTradeStatusToneClass } from '../../lib/trades';
import { rankWfmAutocompleteItems } from '../../lib/wfmAutocomplete';
import { resolveWfmAssetUrl } from '../../lib/wfmAssets';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { InfoHint } from '../../components/InfoHint';
import { ItemName } from '../../components/ItemName';
import { PageHeading } from '../../components/PageHeading';
import { HealthTab } from './HealthTab';
import { useAppStore } from '../../stores/useAppStore';
import { TradeDetectionComparison } from '../../components/TradeDetectionComparison';
import { useTranslation } from '../../i18n';
import { maybeFireHealthAlert } from '../../lib/tradeHealthAlerts';
import { tHealth, tSubtype, tTrendSummary } from '../../lib/healthLabels';
import type {
  ItemAnalysisResponse,
  ItemAnalyticsResponse,
  TradeCreateListingInput,
  TradeOverview,
  TradeSellOrder,
  TradeUpdateListingInput,
  SmartAggressiveness,
  SmartListingOverrides,
  WfmAutocompleteItem,
  SellerMode,
} from '../../types';

type ListingModalMode = 'create' | 'edit';
type TradeListingKind = 'sell' | 'buy';

const CheckIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

const PencilIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
  </svg>
);

const DotsIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
    <circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" />
  </svg>
);

const BoltIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />
  </svg>
);

interface ListingModalState {
  mode: ListingModalMode;
  orderType: TradeListingKind;
  orderId: string | null;
  selectedItem: WfmAutocompleteItem | null;
  itemName: string;
  price: string;
  quantity: string;
  rank: string;
  perTrade: string;
  /** Chosen WFM subtype; '' until the item's subtypes load (or when it has none). */
  subtype: string;
  visible: boolean;
  /** True once the user types in the price field. Auto-fill then stops overwriting their value —
   *  re-suggesting on every rank/subtype tweak would silently discard a deliberate price. */
  priceTouched: boolean;
}


function hydrateOverviewFromCache(
  overview: TradeOverview,
): { overview: TradeOverview; timestamps: Record<string, number> } {
  const timestamps: Record<string, number> = {};
  const sellOrders = overview.sellOrders.map((order) => {
    let nextOrder = order;
    const cached = marketLowCache.get(marketLowKey(order.slug, order.rank));
    if (cached) {
      timestamps[order.orderId] = cached.refreshedAt;
      if (nextOrder.marketLow === null) {
        const priceGap = cached.marketLow !== null ? order.yourPrice - cached.marketLow : null;
        nextOrder = { ...nextOrder, marketLow: cached.marketLow, priceGap };
      }
    }
    const cachedHealth = tradeHealthCache.get(order.orderId);
    if (cachedHealth && cachedHealth.yourPrice === order.yourPrice) {
      nextOrder = {
        ...nextOrder,
        marketLow: cachedHealth.health.marketLow ?? nextOrder.marketLow,
        priceGap:
          cachedHealth.health.priceGap
          ?? (cachedHealth.health.marketLow !== null ? order.yourPrice - cachedHealth.health.marketLow : nextOrder.priceGap),
        healthScore: cachedHealth.health.score,
        healthNote: cachedHealth.health.reason,
        health: cachedHealth.health,
      };
    }
    return nextOrder;
  });
  return { overview: { ...overview, sellOrders }, timestamps };
}

function evictRemovedOrdersFromCache(
  prevOrders: TradeSellOrder[],
  nextOrders: TradeSellOrder[],
): void {
  const nextKeys = new Set(nextOrders.map((o) => marketLowKey(o.slug, o.rank)));
  const nextOrderIds = new Set(nextOrders.map((order) => order.orderId));
  for (const o of prevOrders) {
    const key = marketLowKey(o.slug, o.rank);
    if (!nextKeys.has(key)) {
      marketLowCache.delete(key);
    }
    if (!nextOrderIds.has(o.orderId)) {
      tradeHealthCache.delete(o.orderId);
    }
  }
}

function getTradeHealthToneClass(tone: string): string {
  const normalized = tone.trim().toLowerCase();
  if (normalized === 'green') return 'tone-green';
  if (normalized === 'blue') return 'tone-blue';
  if (normalized === 'red') return 'tone-red';
  return 'tone-amber';
}

function getTradeHealthPriority(order: TradeSellOrder): number {
  const health = order.health;
  if (!health) return 5;
  switch (health.label) {
    case 'Action Needed':
      return 0;
    case 'Weak':
      return 1;
    case 'Watch':
      return 2;
    case 'Healthy':
      return 3;
    case 'Strong':
      return 4;
    default:
      return 5;
  }
}

function useTradeSellHealthRefresh({
  enabled,
  sellerMode,
  setOverview,
  onHealthRefreshed,
  onHealthRefreshFailed,
}: {
  enabled: boolean;
  sellerMode: SellerMode;
  setOverview: Dispatch<SetStateAction<TradeOverview | null>>;
  onHealthRefreshed?: (orderId: string, refreshedAt: number) => void;
  onHealthRefreshFailed?: (orderId: string) => void;
}) {
  const healthRefreshedAt = useRef<Record<string, number>>({});
  const healthInFlight = useRef<Set<string>>(new Set());
  const healthFailures = useRef<Record<string, number>>({});
  const sellOrdersRef = useRef<TradeSellOrder[]>([]);
  const buyOrdersRef = useRef<TradeSellOrder[]>([]);

  // #20 Event-driven refresh: when the firehose reports a live undercut on an item we have a
  // listing on, expire that listing's last-refresh stamp so the next tick re-polls it now.
  useEffect(() => {
    if (!enabled) {
      return;
    }
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void subscribeToTradeHealthStale((wfmItemId) => {
      for (const order of [...sellOrdersRef.current, ...buyOrdersRef.current]) {
        if (order.wfmId === wfmItemId) {
          healthRefreshedAt.current[order.orderId] = 0;
        }
      }
    }).then((unlisten) => {
      if (cancelled) {
        unlisten();
      } else {
        dispose = unlisten;
      }
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const REFRESH_INTERVAL_MS = 5_000;
    const MEDIUM_THRESHOLD_MS = 45_000;
    const HIGH_THRESHOLD_MS = 60_000;

    const refreshOrder = (order: TradeSellOrder, kind: 'sell' | 'buy') => {
      if (healthInFlight.current.has(order.orderId)) {
        return;
      }
      const parsedHealthRefresh = order.health?.refreshedAt
        ? Date.parse(order.health.refreshedAt)
        : Number.NaN;
      const lastRefresh = healthRefreshedAt.current[order.orderId]
        ?? (Number.isFinite(parsedHealthRefresh) ? parsedHealthRefresh : 0);
      const ageMs = Date.now() - (Number.isFinite(lastRefresh) ? lastRefresh : 0);
      if (lastRefresh > 0 && ageMs < MEDIUM_THRESHOLD_MS) {
        return;
      }
      const priority: 'high' | 'medium' | 'low' =
        ageMs >= HIGH_THRESHOLD_MS ? 'high' : ageMs >= MEDIUM_THRESHOLD_MS ? 'medium' : 'low';

      healthInFlight.current.add(order.orderId);
      const request =
        kind === 'sell'
          ? getTradeSellOrderHealth(
              order.wfmId,
              order.slug,
              order.rank,
              order.yourPrice,
              sellerMode,
              priority,
              order.createdAt,
              order.bulkTradable ? order.perTrade : null,
              order.orderId,
              order.wfmId,
              order.quantity,
              order.visible,
              order.bulkTradable,
            )
          : getTradeBuyOrderHealth(
              order.wfmId,
              order.slug,
              order.rank,
              order.yourPrice,
              sellerMode,
              priority,
            );
      void request
        .then((health) => {
          const refreshedAt = Date.parse(health.refreshedAt);
          const refreshedAtMs = Number.isFinite(refreshedAt) ? refreshedAt : Date.now();
          healthRefreshedAt.current[order.orderId] = refreshedAtMs;
          healthFailures.current[order.orderId] = 0;
          onHealthRefreshed?.(order.orderId, refreshedAtMs);
          marketLowCache.set(marketLowKey(order.slug, order.rank), {
            marketLow: health.marketLow,
            refreshedAt: refreshedAtMs,
          });
          cacheOrderHealth(order.orderId, order.slug, order.rank, order.yourPrice, health);
          setOverview((current) => {
            if (!current) {
              return current;
            }
            const listKey = kind === 'sell' ? 'sellOrders' : 'buyOrders';
            const next = {
              ...current,
              [listKey]: current[listKey].map((candidate) =>
                candidate.orderId === order.orderId
                  ? {
                      ...candidate,
                      marketLow: health.marketLow,
                      priceGap: health.priceGap,
                      healthScore: health.score,
                      healthNote: health.reason,
                      health,
                    }
                  : candidate,
              ),
            };
            // #15 Fire the proactive alert off the freshly-updated sell orders (throttled + opt-in).
            if (kind === 'sell') {
              maybeFireHealthAlert(next.sellOrders);
            }
            return next;
          });
        })
        .catch(() => {
          // Non-blocking background refresh — but after several consecutive failures, flag the
          // order so the UI can show "couldn't refresh" instead of spinning on "refreshing…".
          const count = (healthFailures.current[order.orderId] ?? 0) + 1;
          healthFailures.current[order.orderId] = count;
          if (count >= 3) {
            onHealthRefreshFailed?.(order.orderId);
          }
        })
        .finally(() => {
          healthInFlight.current.delete(order.orderId);
        });
    };

    const tick = () => {
      for (const order of sellOrdersRef.current) {
        refreshOrder(order, 'sell');
      }
      for (const order of buyOrdersRef.current) {
        refreshOrder(order, 'buy');
      }
    };

    tick();
    const interval = setInterval(tick, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [enabled, onHealthRefreshed, onHealthRefreshFailed, sellerMode, setOverview]);

  return { sellOrdersRef, buyOrdersRef };
}

async function loadTradeOverviewSnapshot(sellerMode: SellerMode): Promise<TradeOverview> {
  const inFlight = tradeOverviewLoadPromises.get(sellerMode);
  if (inFlight) {
    return inFlight;
  }

  const loadPromise = getWfmTradeOverview(sellerMode)
    .then((overview) => {
      tradeOverviewCache.set(sellerMode, overview);
      return overview;
    })
    .finally(() => {
      if (tradeOverviewLoadPromises.get(sellerMode) === loadPromise) {
        tradeOverviewLoadPromises.delete(sellerMode);
      }
    });

  tradeOverviewLoadPromises.set(sellerMode, loadPromise);
  return loadPromise;
}

/**
 * Per-listing Smart Manage strategy. A cheap fast-moving part and an expensive slow set want
 * different behaviour, so each listing can override the global preset and pin hard price bounds.
 * Empty fields inherit / mean "no bound" — nothing here is required.
 */
function SmartListingStrategyPopover({
  initial,
  enabled,
  anchorEl,
  onToggleEnabled,
  onClose,
  onSave,
}: {
  initial: SmartListingOverrides;
  enabled: boolean;
  anchorEl: HTMLElement | null;
  onToggleEnabled: () => void;
  onClose: () => void;
  onSave: (next: SmartListingOverrides) => void;
}) {
  const { t } = useTranslation();
  const { popoverRef, style } = useAnchoredPopover(anchorEl, true, onClose);
  const [draft, setDraft] = useState<SmartListingOverrides>(initial);
  const [error, setError] = useState<string | null>(null);

  const parseBound = (raw: string): number | null => {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const value = Number.parseInt(trimmed, 10);
    return Number.isFinite(value) && value > 0 ? value : null;
  };

  const handleSave = () => {
    if (draft.minPrice !== null && draft.maxPrice !== null && draft.maxPrice < draft.minPrice) {
      setError(t('smart.boundsInvalid'));
      return;
    }
    onSave(draft);
    onClose();
  };

  return createPortal(
    <div
      ref={popoverRef}
      style={style}
      className="smart-strategy-pop"
      role="dialog"
      aria-label={t('smart.perListingTitle')}
    >
      <div className="smart-strategy-head">
        <span>{t('smart.perListingTitle')}</span>
        <button type="button" className="smart-strategy-close" onClick={onClose} aria-label={t('common.close')}>
          <i className="ti ti-x" aria-hidden="true" />
        </button>
      </div>

      <button
        type="button"
        className={`smart-strategy-toggle${enabled ? ' on' : ''}`}
        role="switch"
        aria-checked={enabled}
        onClick={onToggleEnabled}
      >
        <span className="smart-strategy-toggle-label">{t('smart.enableAuto')}</span>
        <span className="smart-strategy-toggle-state">
          {enabled ? t('common.on') : t('common.off')}
          <span className="smart-strategy-toggle-track">
            <span className="smart-strategy-toggle-thumb" />
          </span>
        </span>
      </button>

      <p className="smart-strategy-note">{t('smart.perListingNote')}</p>

      <label className="smart-strategy-field">
        <span>{t('smart.aggressiveness')}</span>
        <select
          value={draft.aggressiveness ?? ''}
          onChange={(event) =>
            setDraft((current: SmartListingOverrides) => ({
              ...current,
              aggressiveness: (event.target.value || null) as SmartAggressiveness | null,
            }))
          }
        >
          <option value="">{t('smart.inheritGlobal')}</option>
          <option value="conservative">{t('smart.agg.conservative')}</option>
          <option value="balanced">{t('smart.agg.balanced')}</option>
          <option value="aggressive">{t('smart.agg.aggressive')}</option>
        </select>
      </label>

      <div className="smart-strategy-bounds">
        <label className="smart-strategy-field">
          <span>{t('smart.minPrice')}</span>
          <div className="smart-strategy-price-input">
            <input
              type="number"
              min={1}
              inputMode="numeric"
              value={draft.minPrice ?? ''}
              placeholder={t('smart.noBound')}
              onChange={(event) =>
                setDraft((current) => ({ ...current, minPrice: parseBound(event.target.value) }))
              }
            />
            <span>p</span>
          </div>
        </label>
        <label className="smart-strategy-field">
          <span>{t('smart.maxPrice')}</span>
          <div className="smart-strategy-price-input">
            <input
              type="number"
              min={1}
              inputMode="numeric"
              value={draft.maxPrice ?? ''}
              placeholder={t('smart.noBound')}
              onChange={(event) =>
                setDraft((current) => ({ ...current, maxPrice: parseBound(event.target.value) }))
              }
            />
            <span>p</span>
          </div>
        </label>
      </div>

      {error ? <p className="smart-strategy-error">{error}</p> : null}

      <div className="smart-strategy-actions">
        <button type="button" className="smart-strategy-btn secondary" onClick={onClose}>
          {t('common.close')}
        </button>
        <button type="button" className="smart-strategy-btn primary" onClick={handleSave}>
          {t('common.save')}
        </button>
      </div>
    </div>,
    document.body,
  );
}

const EyeIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const EyeOffIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
    <path d="M6.61 6.61A13.53 13.53 0 0 0 2 12s3.5 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
    <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
    <path d="m2 2 20 20" />
  </svg>
);

function buildItemFromOrder(order: TradeSellOrder): WfmAutocompleteItem {
  return {
    itemId: order.itemId ?? 0,
    wfmId: order.wfmId,
    name: order.name,
    slug: order.slug,
    maxRank: order.maxRank,
    itemFamily: null,
    imagePath: order.imagePath,
    bulkTradable: order.bulkTradable,
  };
}

function createListingModalState(
  mode: ListingModalMode,
  orderType: TradeListingKind,
  item: WfmAutocompleteItem | null,
  order?: TradeSellOrder,
): ListingModalState {
  const maxRank = item?.maxRank ?? order?.maxRank ?? null;
  const rankValue =
    maxRank && maxRank > 0
      ? String(order?.rank ?? 0)
      : '';

  return {
    mode,
    orderType: order?.orderType ?? orderType,
    orderId: order?.orderId ?? null,
    selectedItem: item,
    itemName: item?.name ?? order?.name ?? '',
    price: order ? String(order.yourPrice) : '',
    quantity: order ? String(order.quantity) : '1',
    rank: rankValue,
    perTrade: isBulkTradable(item) ? String(order?.perTrade ?? 1) : '',
    subtype: '',
    visible: order?.visible ?? true,
    // Editing starts "touched": the existing price is the user's own, not a suggestion to replace.
    priceTouched: mode !== 'create',
  };
}

function isRankApplicable(item: WfmAutocompleteItem | null): boolean {
  return Boolean(item?.maxRank && item.maxRank > 0);
}

function isBulkTradable(item: WfmAutocompleteItem | null): boolean {
  return Boolean(item?.bulkTradable);
}

/** Valid per-trade batch sizes for a quantity: divisors of `quantity` capped at WFM's max of 6. */
function perTradeOptions(quantity: number): number[] {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return [1];
  }
  const options: number[] = [];
  for (let value = 1; value <= Math.min(6, quantity); value += 1) {
    if (quantity % value === 0) {
      options.push(value);
    }
  }
  return options;
}

function formatGap(value: number | null): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '—';
  }

  return `${value > 0 ? '+' : ''}${value}p`;
}

function getGapClassName(value: number | null): string {
  if (value === null || value === undefined) {
    return 'neutral';
  }

  if (value > 0) {
    return 'bad';
  }

  if (value < 0) {
    return 'good';
  }

  return 'neutral';
}

function formatMarketLowAge(timestampMs: number | undefined): string {
  if (!timestampMs) {
    return 'refreshing…';
  }
  const ageSeconds = Math.floor((Date.now() - timestampMs) / 1000);
  if (ageSeconds < 5) {
    return 'just now';
  }
  if (ageSeconds < 60) {
    return `${ageSeconds}s ago`;
  }
  const ageMinutes = Math.floor(ageSeconds / 60);
  if (ageMinutes < 60) {
    return `${ageMinutes}m ago`;
  }
  return `${Math.floor(ageMinutes / 60)}h ago`;
}

// Compact "time to sell" label from an estimated hours figure. Rounds to human units so a
// velocity estimate reads as "~3h" / "~2d", never "2.83 hours".
function formatEtaHours(hours: number | null | undefined): string | null {
  if (hours === null || hours === undefined || !Number.isFinite(hours) || hours <= 0) {
    return null;
  }
  if (hours < 1) {
    return '<1h';
  }
  if (hours < 48) {
    return `~${Math.round(hours)}h`;
  }
  return `~${Math.round(hours / 24)}d`;
}

function isTradeSessionExpiredMessage(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return (
    normalized.includes('session expired')
    || normalized.includes('sign in to warframe market first')
  );
}

interface ListingAnalysisState {
  analysis: ItemAnalysisResponse | null;
  analytics: ItemAnalyticsResponse | null;
  loading: boolean;
  error: string | null;
}

function getTrendArrow(direction: string): string {
  const d = direction.toLowerCase();
  if (d === 'up' || d === 'rising') return '↑';
  if (d === 'down' || d === 'falling' || d === 'declining') return '↓';
  return '→';
}

function getLiquidityBadgeClass(label: string): string {
  const l = label.toLowerCase();
  if (l.includes('high') || l.includes('active') || l.includes('good') || l.includes('strong')) return 'good';
  if (l.includes('low') || l.includes('poor') || l.includes('weak')) return 'bad';
  return 'neutral';
}

function getZoneQualityClass(quality: string): string {
  const q = quality.toLowerCase();
  if (q.includes('high') || q.includes('strong') || q.includes('good') || q.includes('great')) return 'good';
  if (q.includes('poor') || q.includes('weak') || q.includes('low')) return 'bad';
  return 'neutral';
}

function getTrendClass(direction: string): string {
  const d = direction.toLowerCase();
  if (d === 'up' || d === 'rising') return 'good';
  if (d === 'down' || d === 'falling' || d === 'declining') return 'bad';
  return 'neutral';
}

function ListingAnalysisPanel({ analysis, analytics, loading, error, orderType }: {
  analysis: ItemAnalysisResponse | null;
  analytics: ItemAnalyticsResponse | null;
  loading: boolean;
  error: string | null;
  orderType: 'sell' | 'buy';
}) {
  const { t } = useTranslation();
  if (loading) {
    return (
      <div className="listing-analysis-panel">
        <div className="listing-analysis-panel-header">
          <span className="card-label">{t('trades.analysis.title')}</span>
        </div>
        <div className="listing-analysis-loading">
          <span className="listing-analysis-loading-dot" />
          <span className="listing-analysis-loading-dot" />
          <span className="listing-analysis-loading-dot" />
          <span className="listing-analysis-loading-text">{t('trades.analysis.fetching')}</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="listing-analysis-panel">
        <div className="listing-analysis-panel-header">
          <span className="card-label">{t('trades.analysis.title')}</span>
        </div>
        <div className="listing-analysis-error">{error}</div>
      </div>
    );
  }

  if (!analysis) {
    return (
      <div className="listing-analysis-panel">
        <div className="listing-analysis-panel-header">
          <span className="card-label">{t('trades.analysis.title')}</span>
        </div>
        <div className="listing-analysis-idle">
          {t('trades.analysis.idle', { kind: t(orderType === 'buy' ? 'trades.analysis.entryPrice' : 'trades.analysis.exitPrice') })}
        </div>
      </div>
    );
  }

  const { headline, liquidityDetail, trend } = analysis;
  const snapshot = analytics?.currentSnapshot ?? null;
  const pressure = analytics?.orderbookPressure ?? null;
  const zones = analytics?.entryExitZoneOverview ?? null;
  const heroPrice = orderType === 'buy' ? headline.entryPrice : headline.exitPrice;

  return (
    <div className="listing-analysis-panel">
      <div className="listing-analysis-panel-header">
        <span className="card-label">{t('trades.analysis.title')}</span>
        <span className="listing-analysis-freshness">{analysis.variantLabel}</span>
      </div>

      {/* Recommended entry / exit price */}
      <div className="listing-analysis-section listing-analysis-exit-hero">
        <div className="listing-analysis-exit-label">
          {orderType === 'buy' ? t('trades.analysis.recommendedEntry') : t('trades.analysis.recommendedExit')}
        </div>
        <div className="listing-analysis-exit-price">
          {heroPrice !== null
            ? formatPlatinumValue(heroPrice)
            : <span className="listing-analysis-muted">—</span>}
        </div>
        {orderType === 'sell' && headline.exitPercentileLabel && (
          <div className="listing-analysis-exit-sub">{headline.exitPercentileLabel}</div>
        )}
      </div>

      {/* Liquidity */}
      <div className="listing-analysis-section">
        <div className="listing-analysis-section-title">{t('trades.analysis.liquidity')}</div>
        <div className="listing-analysis-row">
          <span className="listing-analysis-metric">
            {headline.liquidityScore !== null
              ? Math.round(headline.liquidityScore)
              : '—'}
          </span>
          <span className={`listing-analysis-badge ${getLiquidityBadgeClass(headline.liquidityLabel)}`}>
            {tHealth(t, headline.liquidityLabel)}
          </span>
        </div>
        {liquidityDetail.state && (
          <div className="listing-analysis-note">{liquidityDetail.state}</div>
        )}
      </div>

      {/* Market snapshot */}
      {(snapshot || pressure) && (
        <div className="listing-analysis-section">
          <div className="listing-analysis-section-title">{t('trades.analysis.snapshot')}</div>
          {snapshot?.lowestSell !== null && snapshot?.lowestSell !== undefined && (
            <div className="listing-analysis-kv">
              <span className="listing-analysis-kv-label">{t('trades.analysis.floor')}</span>
              <span className="listing-analysis-kv-value">{formatPlatinumValue(snapshot.lowestSell)}</span>
            </div>
          )}
          {pressure?.spread !== null && pressure?.spread !== undefined && (
            <div className="listing-analysis-kv">
              <span className="listing-analysis-kv-label">{t('trades.analysis.spread')}</span>
              <span className="listing-analysis-kv-value">
                {formatPlatinumValue(pressure.spread)}
                {pressure.spreadPct !== null ? ` (${pressure.spreadPct.toFixed(1)}%)` : ''}
              </span>
            </div>
          )}
          {pressure?.pressureLabel && (
            <div className="listing-analysis-kv">
              <span className="listing-analysis-kv-label">{t('trades.analysis.pressure')}</span>
              <span className="listing-analysis-kv-value">{tHealth(t, pressure.pressureLabel)}</span>
            </div>
          )}
        </div>
      )}

      {/* Entry / Exit zone */}
      {orderType === 'buy' ? (
        zones?.entryZoneLow !== null && zones?.entryZoneLow !== undefined
          && zones?.entryZoneHigh !== null && zones?.entryZoneHigh !== undefined && (
          <div className="listing-analysis-section">
            <div className="listing-analysis-section-title">{t('trades.analysis.entryZone')}</div>
            <div className="listing-analysis-zone-band">
              <span className="listing-analysis-zone-range">
                {formatPlatinumValue(zones.entryZoneLow)} – {formatPlatinumValue(zones.entryZoneHigh)}
              </span>
              <span className={`listing-analysis-badge ${getZoneQualityClass(zones.zoneQuality)}`}>
                {zones.zoneQuality}
              </span>
            </div>
            {zones.entryRationale && (
              <div className="listing-analysis-note">{zones.entryRationale}</div>
            )}
          </div>
        )
      ) : (
        zones?.exitZoneLow !== null && zones?.exitZoneLow !== undefined
          && zones?.exitZoneHigh !== null && zones?.exitZoneHigh !== undefined && (
          <div className="listing-analysis-section">
            <div className="listing-analysis-section-title">{t('trades.analysis.exitZone')}</div>
            <div className="listing-analysis-zone-band">
              <span className="listing-analysis-zone-range">
                {formatPlatinumValue(zones.exitZoneLow)} – {formatPlatinumValue(zones.exitZoneHigh)}
              </span>
              <span className={`listing-analysis-badge ${getZoneQualityClass(zones.zoneQuality)}`}>
                {zones.zoneQuality}
              </span>
            </div>
            {zones.exitRationale && (
              <div className="listing-analysis-note">{zones.exitRationale}</div>
            )}
          </div>
        )
      )}

      {/* Trend */}
      <div className="listing-analysis-section">
        <div className="listing-analysis-section-title">{t('trades.analysis.trend')}</div>
        <div className="listing-analysis-row">
          <span className={`listing-analysis-trend-dir ${getTrendClass(trend.direction)}`}>
            {getTrendArrow(trend.direction)} {tHealth(t, trend.direction)}
          </span>
          {trend.confidence !== null && (
            <span className="listing-analysis-muted">{t('trades.analysis.confPct', { pct: Math.round(trend.confidence) })}</span>
          )}
        </div>
        {trend.summary && (
          <div className="listing-analysis-note listing-analysis-trend-summary">{tTrendSummary(t, trend)}</div>
        )}
      </div>
    </div>
  );
}

function initialsForName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return '?';
  }
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

function TradeAvatar({ imageUrl, name }: { imageUrl: string | null; name: string }) {
  if (imageUrl) {
    return (
      <span className="trade-avatar">
        <img src={imageUrl} alt="" />
      </span>
    );
  }

  return <span className="trade-avatar fallback">{initialsForName(name)}</span>;
}

function ListingModal({
  form,
  suggestions,
  submitting,
  errorMessage,
  autocompleteReady,
  autocompleteError,
  analysis,
  onClose,
  onSubmit,
  onChange,
  onSelectItem,
}: {
  form: ListingModalState;
  suggestions: WfmAutocompleteItem[];
  submitting: boolean;
  errorMessage: string | null;
  autocompleteReady: boolean;
  autocompleteError: string | null;
  analysis: ListingAnalysisState | null;
  onClose: () => void;
  onSubmit: () => void;
  onChange: (patch: Partial<ListingModalState>) => void;
  onSelectItem: (item: WfmAutocompleteItem) => void;
}) {
  const { t } = useTranslation();
  const rankApplicable = isRankApplicable(form.selectedItem);
  const bulkApplicable = isBulkTradable(form.selectedItem);
  const quantityNumber = Number.parseInt(form.quantity, 10);
  const ptOptions = perTradeOptions(Number.isInteger(quantityNumber) ? quantityNumber : 0);
  const typeLocked = form.mode === 'edit';
  const showAnalysis = true;

  // Subtyped items (Atragraph-variant mods, relics, fish…) get a variant picker; the choice is
  // reset whenever the item changes so a stale value can never be submitted for the wrong item.
  const [subtypeOptions, setSubtypeOptions] = useState<string[]>([]);
  const subtypeWfmId = form.selectedItem?.wfmId ?? null;
  useEffect(() => {
    setSubtypeOptions([]);
    onChange({ subtype: '' });
    if (!subtypeWfmId) {
      return;
    }
    let cancelled = false;
    void getWfmItemSubtypes(subtypeWfmId)
      .then((subtypes) => {
        if (!cancelled) {
          setSubtypeOptions(subtypes);
        }
      })
      .catch(() => {
        // Missing options just hide the picker; the backend still applies the item default.
      });
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subtypeWfmId]);

  const formContent = (
    <>
      <div className="listing-form-section listing-form-section-type">
        <div className="listing-form-section-title">{t('trades.modal.orderType')}</div>
        <div className="trade-listing-type-tabs" role="tablist" aria-label={t('trades.modal.listingTypeAria')}>
          {(['sell', 'buy'] as TradeListingKind[]).map((type) => (
            <button
              key={type}
              className={`trade-listing-type-tab${form.orderType === type ? ' active' : ''}`}
              type="button"
              role="tab"
              aria-selected={form.orderType === type}
              disabled={typeLocked}
              onClick={() => onChange({ orderType: type })}
            >
              {type === 'sell' ? t('trades.modal.sell') : t('trades.modal.buy')}
            </button>
          ))}
        </div>
      </div>

      <div className="listing-form-section listing-form-section-item">
        <div className="listing-form-section-title">{t('trades.modal.itemSection')}</div>
        <div className="trade-listing-fieldset">
          <label className="trade-listing-label" htmlFor="trade-listing-item">{t('trades.modal.itemName')}</label>
          <input
            id="trade-listing-item"
            className="field-input"
            value={form.itemName}
            onChange={(event) =>
              onChange({ itemName: event.target.value, selectedItem: null, rank: '', perTrade: '' })
            }
            placeholder={t('trades.searchPlaceholder')}
            disabled={form.mode === 'edit'}
          />
          {form.mode === 'create' ? (
            <div className="trade-listing-autocomplete">
              {!autocompleteReady && !autocompleteError ? (
                <div className="trade-listing-autocomplete-state">{t('trades.modal.loadingCatalog')}</div>
              ) : null}
              {autocompleteError ? (
                <div className="trade-listing-autocomplete-state error">{autocompleteError}</div>
              ) : null}
              {autocompleteReady && suggestions.length > 0 ? (
                <div className="trade-listing-autocomplete-list">
                  {suggestions.map((item) => (
                    <button
                      key={item.wfmId ?? item.slug}
                      className="trade-listing-autocomplete-option"
                      type="button"
                      onClick={() => onSelectItem(item)}
                    >
                      <span className="trade-listing-autocomplete-thumb">
                        {resolveWfmAssetUrl(item.imagePath, item.slug) ? (
                          <img src={resolveWfmAssetUrl(item.imagePath, item.slug) ?? undefined} alt="" />
                        ) : (
                          <span>{item.name.slice(0, 1)}</span>
                        )}
                      </span>
                      <span className="trade-listing-autocomplete-copy">
                        <span className="trade-listing-autocomplete-name">{item.name}</span>
                        <span className="trade-listing-autocomplete-meta">
                          {item.itemFamily ?? t('trades.modal.itemFamilyFallback')}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <div className="listing-form-section listing-form-section-details">
        <div className="listing-form-section-title">{t('trades.modal.listingDetails')}</div>
        <div className="trade-listing-grid">
          <div className="trade-listing-fieldset">
            <label className="trade-listing-label" htmlFor="trade-listing-price">{t('trades.modal.price')}</label>
            <input
              id="trade-listing-price"
              className="field-input"
              type="number"
              min={1}
              step={1}
              value={form.price}
              onChange={(event) => onChange({ price: event.target.value, priceTouched: true })}
              placeholder={t('trades.pricePlaceholder')}
            />
          </div>
          <div className="trade-listing-fieldset">
            <label className="trade-listing-label" htmlFor="trade-listing-quantity">{t('trades.col.quantity')}</label>
            <input
              id="trade-listing-quantity"
              className="field-input"
              type="number"
              min={1}
              step={1}
              value={form.quantity}
              onChange={(event) => {
                const nextQuantity = event.target.value;
                if (!bulkApplicable) {
                  onChange({ quantity: nextQuantity });
                  return;
                }
                // Keep perTrade valid: it must divide the new quantity and stay ≤ 6.
                const parsed = Number.parseInt(nextQuantity, 10);
                const opts = perTradeOptions(Number.isInteger(parsed) ? parsed : 0);
                const current = Number.parseInt(form.perTrade, 10);
                const nextPerTrade = String(opts.includes(current) ? current : 1);
                onChange({ quantity: nextQuantity, perTrade: nextPerTrade });
              }}
              placeholder={t('trades.quantityPlaceholder')}
            />
          </div>
          {rankApplicable ? (
            <div className="trade-listing-fieldset">
              <label className="trade-listing-label" htmlFor="trade-listing-rank">{t('trades.modal.rank')}</label>
              <select
                id="trade-listing-rank"
                className="field-input"
                value={form.rank}
                onChange={(event) => onChange({ rank: event.target.value })}
              >
                {Array.from({ length: (form.selectedItem?.maxRank ?? 0) + 1 }, (_, index) => (
                  <option key={index} value={String(index)}>
                    {index}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {form.mode === 'create' && subtypeOptions.length > 1 ? (
            <div className="trade-listing-fieldset">
              <label className="trade-listing-label" htmlFor="trade-listing-subtype">{t('trades.modal.subtype')}</label>
              <select
                id="trade-listing-subtype"
                className="field-input"
                value={form.subtype || subtypeOptions[0]}
                onChange={(event) => onChange({ subtype: event.target.value })}
              >
                {subtypeOptions.map((subtype) => (
                  <option key={subtype} value={subtype}>
                    {tSubtype(t, subtype)}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {bulkApplicable ? (
            <div className="trade-listing-fieldset">
              <label className="trade-listing-label" htmlFor="trade-listing-per-trade">{t('trades.modal.perTrade')}</label>
              <select
                id="trade-listing-per-trade"
                className="field-input"
                value={form.perTrade || '1'}
                onChange={(event) => onChange({ perTrade: event.target.value })}
              >
                {ptOptions.map((value) => (
                  <option key={value} value={String(value)}>
                    {value}
                  </option>
                ))}
              </select>
              <span className="trade-listing-hint">{t('trades.modal.bulkHint')}</span>
            </div>
          ) : null}
          <div className="trade-listing-fieldset trade-listing-toggle-field">
            <span className="trade-listing-label">{t('trades.modal.visibility')}</span>
            <button
              className={`trade-visibility-toggle${form.visible ? ' on' : ''}`}
              type="button"
              onClick={() => onChange({ visible: !form.visible })}
            >
              <span className="trade-visibility-toggle-track" />
              <span className="trade-visibility-toggle-copy">
                {form.visible ? t('common.on') : t('common.off')}
              </span>
            </button>
          </div>
        </div>
        {errorMessage ? <div className="trade-inline-error">{errorMessage}</div> : null}
      </div>
    </>
  );

  return (
    // Outside clicks deliberately do NOT close this: an accidental one would discard a half-typed
    // listing. Cancel, the × and Escape all still close it — the same three ways as before.
    // Base UI has no `dismissible` prop; it reports *why* the dialog wants to close instead.
    <Dialog
      open
      onOpenChange={(open, details) => {
        if (!open && details.reason !== 'outside-press') {
          onClose();
        }
      }}
    >
      <DialogContent className={showAnalysis ? 'max-w-4xl' : 'max-w-lg'}>
        <DialogHeader>
          <DialogTitle>
            {form.mode === 'create'
              ? t(form.orderType === 'sell' ? 'trades.modal.createSell' : 'trades.modal.createBuy')
              : t(form.orderType === 'sell' ? 'trades.modal.editSell' : 'trades.modal.editBuy')}
          </DialogTitle>
        </DialogHeader>

        {showAnalysis ? (
          <div className="trade-listing-modal-columns">
            <div className="trade-listing-form-col">
              <div className="settings-modal-body trade-listing-modal-body">
                {formContent}
              </div>
            </div>
            <div className="trade-listing-analysis-col">
              <ListingAnalysisPanel
                analysis={analysis?.analysis ?? null}
                analytics={analysis?.analytics ?? null}
                loading={analysis?.loading ?? false}
                error={analysis?.error ?? null}
                orderType={form.orderType}
              />
            </div>
          </div>
        ) : (
          <div className="settings-modal-body trade-listing-modal-body">
            {formContent}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('trades.modal.cancel')}
          </Button>
          <Button size="sm" onClick={onSubmit} disabled={submitting}>
            {submitting
              ? t('common.saving')
              : form.mode === 'create'
                ? t(form.orderType === 'sell' ? 'trades.modal.postSell' : 'trades.modal.postBuy')
                : t('trades.modal.saveChanges')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SignInPanel() {
  const { t } = useTranslation();
  const tradeAccountLoading = useAppStore((s) => s.tradeAccountLoading);
  const tradeAccountError = useAppStore((s) => s.tradeAccountError);
  const signInTradeAccount = useAppStore((s) => s.signInTradeAccount);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // Default on so the session persists across restarts (saves credentials for automatic
  // re-auth once the session token expires). Users can opt out by toggling it off.
  const [stayLoggedIn, setStayLoggedIn] = useState(true);
  const [localError, setLocalError] = useState<string | null>(null);

  const handleSubmit = async () => {
    const trimmedEmail = email.trim();
    const trimmedPassword = password.trim();
    if (!trimmedEmail || !trimmedPassword) {
      setLocalError(t('trades.needEmailPassword'));
      return;
    }

    setLocalError(null);
    try {
      await signInTradeAccount({
        email: trimmedEmail,
        password: trimmedPassword,
        stayLoggedIn,
      });
    } catch {
      // Store error is surfaced below.
    }
  };

  return (
    <div className="trade-auth-shell">
      <div className="trade-auth-card">
        <span className="card-label">{t('trades.auth.brand')}</span>
        <h2 className="trade-auth-title">{t('trades.auth.title')}</h2>
        <p className="trade-auth-copy">
          {t('trades.auth.copy')}
        </p>

        <div className="trade-auth-grid">
          <label className="trade-listing-label" htmlFor="trade-signin-email">
            {t('trades.auth.email')}
          </label>
          <input
            id="trade-signin-email"
            className="field-input"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder={t('trades.auth.emailPlaceholder')}
          />

          <label className="trade-listing-label" htmlFor="trade-signin-password">
            {t('trades.auth.password')}
          </label>
          <input
            id="trade-signin-password"
            className="field-input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder={t('trades.auth.passwordPlaceholder')}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                void handleSubmit();
              }
            }}
          />
        </div>

        <div className="trade-auth-options">
          <div className="toggle-wrap">
            <button
              className={`toggle${stayLoggedIn ? ' on' : ''}`}
              type="button"
              aria-pressed={stayLoggedIn}
              onClick={() => setStayLoggedIn((current) => !current)}
            />
            <span>{t('trades.auth.stayLoggedIn')}</span>
          </div>
        </div>

        {localError || tradeAccountError ? (
          <div className="trade-inline-error">{localError ?? tradeAccountError}</div>
        ) : null}

        <div className="trade-auth-actions">
          <button className="btn-primary" type="button" onClick={() => void handleSubmit()} disabled={tradeAccountLoading}>
            {tradeAccountLoading ? t('trades.auth.connecting') : t('trades.auth.connect')}
          </button>
        </div>
      </div>
    </div>
  );
}

// Circumference of the score-gauge ring (r=19) — used to convert a 0-100 score into a
// stroke-dashoffset so the arc fills proportionally.
function HealthTabContainer() {
  const { t } = useTranslation();
  const tradeAccount = useAppStore((s) => s.tradeAccount);
  const loadTradeAccount = useAppStore((s) => s.loadTradeAccount);
  const syncWatchlistTradeOverview = useAppStore((s) => s.syncWatchlistTradeOverview);
  const setTradesSubTab = useAppStore((s) => s.setTradesSubTab);
  const tradeOverviewReloadNonce = useAppStore((s) => s.tradeOverviewReloadNonce);
  const sellerMode = useAppStore((s) => s.sellerMode);
  const [overview, setOverview] = useState<TradeOverview | null>(() => tradeOverviewCache.get(sellerMode) ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { sellOrdersRef, buyOrdersRef } = useTradeSellHealthRefresh({
    enabled: Boolean(tradeAccount),
    sellerMode,
    setOverview,
    onHealthRefreshed: undefined,
  });

  useEffect(() => {
    if (!tradeAccount) {
      setOverview(null);
      setError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    const loadOverview = async () => {
      const cachedOverview = tradeOverviewCache.get(sellerMode) ?? null;
      if (cachedOverview) {
        setOverview(cachedOverview);
      }
      setLoading(!cachedOverview);
      setError(null);
      try {
        const nextOverview = await loadTradeOverviewSnapshot(sellerMode);
        const syncedOverview = await syncWatchlistTradeOverview(nextOverview);
        if (!cancelled) {
          const hydrated = hydrateOverviewFromCache(syncedOverview);
          tradeOverviewCache.set(sellerMode, hydrated.overview);
          setOverview(hydrated.overview);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(t('trades.refreshHealthFailed'));
          void loadTradeAccount();
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void loadOverview();
    return () => {
      cancelled = true;
    };
  }, [loadTradeAccount, sellerMode, syncWatchlistTradeOverview, tradeAccount, tradeOverviewReloadNonce]);

  sellOrdersRef.current = overview?.sellOrders ?? [];
  buyOrdersRef.current = overview?.buyOrders ?? [];

  // Staleness weight: an old listing that is also priced above market is the most "stuck" —
  // age in days × how many plat over market. Surfaces genuinely-neglected orders first.
  const stalenessWeight = (order: TradeSellOrder): number => {
    const ageHours = order.health?.listingAgeHours ?? 0;
    const gap = Math.max(order.priceGap ?? 0, 0);
    return (ageHours / 24) * gap;
  };

  const sellOrders = useMemo(
    () =>
      [...(overview?.sellOrders ?? [])].sort((left, right) => {
        const priorityDelta = getTradeHealthPriority(left) - getTradeHealthPriority(right);
        if (priorityDelta !== 0) {
          return priorityDelta;
        }
        // Within the same health tier, float the most stuck (old × overpriced) listings up.
        const staleDelta = stalenessWeight(right) - stalenessWeight(left);
        if (Math.abs(staleDelta) > 0.01) {
          return staleDelta;
        }
        const scoreDelta = (left.health?.score ?? -1) - (right.health?.score ?? -1);
        if (scoreDelta !== 0) {
          return scoreDelta;
        }
        return left.name.localeCompare(right.name);
      }),
    [overview?.sellOrders],
  );

  // Orders whose health recommends a concrete price change we can apply in one click.
  const fixableOrders = useMemo(
    () =>
      sellOrders.filter(
        (order) =>
          order.health?.recommendedPrice != null
          && order.health.recommendedPrice > 0
          && order.health.recommendedPrice !== order.yourPrice,
      ),
    [sellOrders],
  );

  const [healthActionPending, setHealthActionPending] = useState<readonly string[]>([]);
  const [fixAllRunning, setFixAllRunning] = useState(false);
  const isHealthActionPending = (orderId: string) => healthActionPending.includes(orderId);

  const applyHealthPrice = async (order: TradeSellOrder): Promise<boolean> => {
    const target = order.health?.recommendedPrice;
    if (target == null || target <= 0 || target === order.yourPrice) {
      return false;
    }
    setHealthActionPending((current) =>
      current.includes(order.orderId) ? current : [...current, order.orderId],
    );
    const updateOrderFn = order.orderType === 'sell' ? updateWfmSellOrder : updateWfmBuyOrder;
    try {
      const nextOverview = await updateOrderFn(
        {
          orderId: order.orderId,
          price: target,
          quantity: order.quantity,
          rank: order.rank ?? null,
          visible: order.visible,
          wfmId: order.wfmId,
          perTrade: order.bulkTradable ? order.perTrade : null,
        } satisfies TradeUpdateListingInput,
        sellerMode,
      );
      const hydrated = hydrateOverviewFromCache(nextOverview);
      tradeOverviewCache.set(sellerMode, hydrated.overview);
      setOverview(hydrated.overview);
      return true;
    } catch {
      setError(t('trades.refreshHealthFailed'));
      return false;
    } finally {
      setHealthActionPending((current) => current.filter((id) => id !== order.orderId));
    }
  };

  const handleFixAll = async () => {
    if (fixAllRunning || fixableOrders.length === 0) {
      return;
    }
    setFixAllRunning(true);
    try {
      // Sequential so we don't fire a burst of WFM writes at once.
      for (const order of fixableOrders) {
        await applyHealthPrice(order);
      }
    } finally {
      setFixAllRunning(false);
    }
  };

  const actionNeededCount = sellOrders.filter((order) => {
    const label = order.health?.label ?? '';
    return label === 'Action Needed' || label === 'Weak';
  }).length;
  const competitiveCount = sellOrders.filter((order) => {
    const label = order.health?.label ?? '';
    return label === 'Strong' || label === 'Healthy';
  }).length;
  const likelySoonCount = sellOrders.filter((order) => order.health?.outlookLabel === 'Likely soon').length;

  return (
    <HealthTab
      orders={sellOrders}
      fixableOrders={fixableOrders}
      loading={loading}
      hasOverview={Boolean(overview)}
      errorMessage={error}
      counts={{
        actionNeeded: actionNeededCount,
        competitive: competitiveCount,
        likelySoon: likelySoonCount,
      }}
      isApplyPending={isHealthActionPending}
      fixAllRunning={fixAllRunning}
      onApply={(order) => void applyHealthPrice(order)}
      onFixAll={() => void handleFixAll()}
      onEdit={() => setTradesSubTab('orders')}
    />
  );
}

function ListingsTab() {
  const { t } = useTranslation();
  const smartStates = useSmartManageStates();
  const [strategyPopoverId, setStrategyPopoverId] = useState<string | null>(null);
  const [strategyAnchorEl, setStrategyAnchorEl] = useState<HTMLElement | null>(null);
  const tradeOverviewReloadNonce = useAppStore((s) => s.tradeOverviewReloadNonce);
  const tradeAccount = useAppStore((s) => s.tradeAccount);
  const loadTradeAccount = useAppStore((s) => s.loadTradeAccount);
  const pushToast = useAppStore((s) => s.pushToast);
  const syncWatchlistTradeOverview = useAppStore((s) => s.syncWatchlistTradeOverview);
  const sellerMode = useAppStore((s) => s.sellerMode);
  const autoWatchlistBuyOrdersEnabled = useAppStore((s) => s.autoWatchlistBuyOrdersEnabled);
  const setAutoWatchlistBuyOrdersEnabled = useAppStore((s) => s.setAutoWatchlistBuyOrdersEnabled);
  const signOutTradeAccount = useAppStore((s) => s.signOutTradeAccount);

  const [overview, setOverview] = useState<TradeOverview | null>(() => tradeOverviewCache.get(sellerMode) ?? null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [autocompleteItems, setAutocompleteItems] = useState<WfmAutocompleteItem[]>([]);
  const [autocompleteLoading, setAutocompleteLoading] = useState(false);
  const [autocompleteError, setAutocompleteError] = useState<string | null>(null);
  const [listingModal, setListingModal] = useState<ListingModalState | null>(null);
  const [listingActionPending, setListingActionPending] = useState(false);
  const [listingActionError, setListingActionError] = useState<string | null>(null);
  const [sessionExpiredPopupOpen, setSessionExpiredPopupOpen] = useState(false);
  const [visibilityActionPending, setVisibilityActionPending] = useState(false);
  // Per-order in-flight guard for row mutations (toggle visibility / mark sold / remove). The
  // ref blocks a rapid second click synchronously (before state commits); the state array
  // drives the disabled buttons. Without this, double-clicks fire duplicate WFM mutations —
  // e.g. closing more quantity than intended, or two deletes racing.
  const pendingOrderIdsRef = useRef<Set<string>>(new Set());
  const [pendingOrderIds, setPendingOrderIds] = useState<readonly string[]>([]);
  const beginOrderAction = (orderId: string): boolean => {
    if (pendingOrderIdsRef.current.has(orderId)) {
      return false;
    }
    pendingOrderIdsRef.current.add(orderId);
    setPendingOrderIds(Array.from(pendingOrderIdsRef.current));
    return true;
  };
  const endOrderAction = (orderId: string) => {
    pendingOrderIdsRef.current.delete(orderId);
    setPendingOrderIds(Array.from(pendingOrderIdsRef.current));
  };
  const isOrderPending = (orderId: string) => pendingOrderIds.includes(orderId);
  const [actionMenuOrderId, setActionMenuOrderId] = useState<string | null>(null);
  // Quantity popup for closing part of a stacked order (quantity > 1).
  const [closeQtyTarget, setCloseQtyTarget] = useState<TradeSellOrder | null>(null);
  const [closeQtyValue, setCloseQtyValue] = useState('1');
  // Analysis preview for the create-listing modal (cleared on modal close).
  const [listingAnalysis, setListingAnalysis] = useState<ListingAnalysisState | null>(null);
  // Display-layer state: epoch ms when each order's market_low was last fetched.
  // Kept in state so the "X ago" label re-renders when a fetch completes.
  const [marketLowTimestamps, setMarketLowTimestamps] = useState<Record<string, number>>({});
  // Orders whose background health refresh has failed repeatedly — shown as "couldn't refresh"
  // instead of an endless "refreshing…".
  const [staleHealthIds, setStaleHealthIds] = useState<readonly string[]>([]);
  const { sellOrdersRef, buyOrdersRef } = useTradeSellHealthRefresh({
    enabled: Boolean(tradeAccount),
    sellerMode,
    setOverview,
    onHealthRefreshed: (orderId, refreshedAt) => {
      setMarketLowTimestamps((prev) => ({ ...prev, [orderId]: refreshedAt }));
      setStaleHealthIds((prev) => (prev.includes(orderId) ? prev.filter((id) => id !== orderId) : prev));
    },
    onHealthRefreshFailed: (orderId) =>
      setStaleHealthIds((prev) => (prev.includes(orderId) ? prev : [...prev, orderId])),
  });

  const listingSuggestions = useMemo(
    () =>
      listingModal && listingModal.mode === 'create'
        ? rankWfmAutocompleteItems(autocompleteItems, listingModal.itemName, 6)
        : [],
    [autocompleteItems, listingModal],
  );

  // Drop "couldn't refresh" flags for orders that no longer exist (sold/removed/signed out) so
  // a stale flag can't linger. Only updates state when something was actually pruned.
  useEffect(() => {
    const currentIds = new Set((overview?.sellOrders ?? []).map((order) => order.orderId));
    setStaleHealthIds((prev) => {
      const next = prev.filter((id) => currentIds.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [overview]);

  useEffect(() => {
    if (!tradeAccount) {
      setOverview(null);
      setOverviewError(null);
      setOverviewLoading(false);
      return;
    }

    let cancelled = false;

    const loadOverview = async () => {
      const cachedOverview = tradeOverviewCache.get(sellerMode) ?? null;
      if (cachedOverview) {
        // Hydrate before painting: the background refresher caches the raw overview and the
        // scored health separately, so without this the instant paint would show orders with
        // blank health until the refetch landed.
        const { overview: warmOverview, timestamps } = hydrateOverviewFromCache(cachedOverview);
        setOverview(warmOverview);
        setMarketLowTimestamps((prev) => ({ ...prev, ...timestamps }));
      }
      setOverviewLoading(!cachedOverview);
      setOverviewError(null);
      try {
        const nextOverview = await loadTradeOverviewSnapshot(sellerMode);
        const syncedOverview = await syncWatchlistTradeOverview(nextOverview);
        if (!cancelled) {
          const { overview: hydratedOverview, timestamps } = hydrateOverviewFromCache(syncedOverview);
          tradeOverviewCache.set(sellerMode, hydratedOverview);
          setOverview(hydratedOverview);
          setMarketLowTimestamps((prev) => ({ ...prev, ...timestamps }));
          setOverviewError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setOverviewError(formatTradesErrorMessage('trade-overview-load', error));
          void loadTradeAccount();
        }
      } finally {
        if (!cancelled) {
          setOverviewLoading(false);
        }
      }
    };

    void loadOverview();

    return () => {
      cancelled = true;
    };
  }, [loadTradeAccount, sellerMode, syncWatchlistTradeOverview, tradeAccount, tradeOverviewReloadNonce]);

  useEffect(() => {
    if (!tradeAccount) {
      return;
    }

    let cancelled = false;

    const loadAutocomplete = async () => {
      setAutocompleteLoading(true);
      setAutocompleteError(null);
      try {
        const items = await getWfmAutocompleteItems(useAppStore.getState().language);
        if (!cancelled) {
          setAutocompleteItems(items);
        }
      } catch (error) {
        if (!cancelled) {
          setAutocompleteError(formatTradesErrorMessage('trade-autocomplete-load', error));
        }
      } finally {
        if (!cancelled) {
          setAutocompleteLoading(false);
        }
      }
    };

    void loadAutocomplete();

    return () => {
      cancelled = true;
    };
  }, [tradeAccount]);

  sellOrdersRef.current = overview?.sellOrders ?? [];
  buyOrdersRef.current = overview?.buyOrders ?? [];

  // Ticker: forces the "X ago" labels to stay current between market_low fetches.
  useEffect(() => {
    const interval = setInterval(() => {
      setMarketLowTimestamps((prev) => ({ ...prev }));
    }, 15_000);
    return () => clearInterval(interval);
  }, []);

  // Fetch market analysis whenever the listing modal is open and an item is known.
  // Both getItemAnalysis and getItemAnalytics use RequestPriority::Instant internally.
  const analysisItem = listingModal?.selectedItem ?? null;
  const analysisRank = isRankApplicable(analysisItem) ? listingModal?.rank ?? '' : '';
  const analysisVariantKey = analysisRank.trim() !== '' ? `rank:${analysisRank.trim()}` : null;

  useEffect(() => {
    if (!analysisItem || !analysisItem.wfmId) {
      setListingAnalysis(null);
      return;
    }

    setListingAnalysis({ analysis: null, analytics: null, loading: true, error: null });
    let cancelled = false;
    const { wfmId: itemKey, slug } = analysisItem;

    // Debounced: both calls run at Instant priority on the WFM scheduler, and the variant key
    // changes on every keystroke in the rank field — without the delay, typing "15" would fire
    // full analysis rounds for rank 1 and then rank 15.
    const timeoutId = window.setTimeout(() => {
      // Fire analytics in background — fills in market snapshot once it arrives.
      // Analytics failure is non-fatal; the main analysis section still renders.
      void getItemAnalytics(itemKey, slug, analysisVariantKey, sellerMode, '48h', '1h')
        .then((analytics) => {
          if (!cancelled) {
            setListingAnalysis((prev) => (prev ? { ...prev, analytics } : null));
          }
        })
        .catch(() => { /* non-fatal */ });

      // Main analysis fires at Instant priority — panel renders as soon as this resolves.
      void getItemAnalysis(itemKey, slug, analysisVariantKey, sellerMode)
        .then((analysis) => {
          if (!cancelled) {
            setListingAnalysis((prev) =>
              prev
                ? { ...prev, analysis, loading: false }
                : { analysis, analytics: null, loading: false, error: null },
            );
          }
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            setListingAnalysis({
              analysis: null,
              analytics: null,
              loading: false,
              error: formatTradesErrorMessage('listing-analysis-load', error),
            });
          }
        });
    }, 350);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysisItem, analysisVariantKey, sellerMode]);

  // Auto-fill price with the recommended price when analysis arrives and the
  // price field has not yet been touched by the user.
  const recommendedAutoFillPrice =
    listingModal?.orderType === 'buy'
      ? (listingAnalysis?.analysis?.headline.entryPrice ?? null)
      : (listingAnalysis?.analysis?.headline.exitPrice ?? null);
  useEffect(() => {
    if (recommendedAutoFillPrice === null) return;
    setListingModal((current) => {
      // Only while creating: an existing listing's price is the user's real live price, and
      // re-suggesting over it on an unrelated edit would be destructive.
      if (!current || current.mode !== 'create' || current.priceTouched) return current;
      const next = String(recommendedAutoFillPrice);
      return current.price === next ? current : { ...current, price: next };
    });
  }, [recommendedAutoFillPrice]);

  const applyOverview = async (nextOverview: TradeOverview) => {
    evictRemovedOrdersFromCache(overview?.sellOrders ?? [], nextOverview.sellOrders);
    const { overview: hydratedOverview, timestamps } = hydrateOverviewFromCache(nextOverview);
    tradeOverviewCache.set(sellerMode, hydratedOverview);
    setOverview(hydratedOverview);
    setOverviewError(null);
    setMarketLowTimestamps((prev) => ({ ...prev, ...timestamps }));

    const syncedOverview = await syncWatchlistTradeOverview(nextOverview);
    const { overview: hydratedSynced } = hydrateOverviewFromCache(syncedOverview);
    tradeOverviewCache.set(sellerMode, hydratedSynced);
    setOverview(hydratedSynced);
  };

  const handleToggleOrderVisibility = async (order: TradeSellOrder) => {
    if (!beginOrderAction(order.orderId)) {
      return;
    }
    const updateOrderFn = order.orderType === 'sell' ? updateWfmSellOrder : updateWfmBuyOrder;
    try {
      const nextOverview = await updateOrderFn(
        {
          orderId: order.orderId,
          price: order.yourPrice,
          quantity: order.quantity,
          rank: order.rank ?? null,
          visible: !order.visible,
          wfmId: order.wfmId,
          perTrade: order.bulkTradable ? order.perTrade : null,
        } satisfies TradeUpdateListingInput,
        sellerMode,
      );
      await applyOverview(nextOverview);
    } catch (error) {
      handleTradeActionFailure(error);
    } finally {
      endOrderAction(order.orderId);
    }
  };

  const handleSetAllVisibility = async (visible: boolean, orderType: TradeListingKind) => {
    const scoped = orderType === 'sell' ? sellOrders : buyOrders;
    const targets = scoped.filter((order) => order.visible !== visible);
    if (targets.length === 0 || visibilityActionPending) {
      return;
    }

    setVisibilityActionPending(true);
    setOverviewError(null);
    try {
      // One bulk call (PATCH /orders/group/all, scoped to this tab's order type) instead of
      // one request per order — far lighter on WFM and instant for the user.
      const latestOverview = await setWfmOrdersVisibility(visible, orderType, sellerMode);
      await applyOverview(latestOverview);
    } catch (error) {
      handleTradeActionFailure(error);
    } finally {
      setVisibilityActionPending(false);
    }
  };

  const openCreateListing = (orderType: TradeListingKind) => {
    setListingActionError(null);
    setListingAnalysis(null);
    setListingModal(createListingModalState('create', orderType, null));
  };

  const openEditListing = (order: TradeSellOrder) => {
    setListingActionError(null);
    const item = buildItemFromOrder(order);
    setListingModal(createListingModalState('edit', order.orderType, item, order));
  };

  const closeListingModal = () => {
    if (listingActionPending) {
      return;
    }
    setListingActionError(null);
    setListingModal(null);
    setListingAnalysis(null);
  };

  // Consume a pre-filled listing request from an Opportunities action button: resolve the item to
  // a full WFM entry (so the order is confirmable) and open the create modal with name + price set.
  const pendingTradeListing = useAppStore((s) => s.pendingTradeListing);
  const clearPendingTradeListing = useAppStore((s) => s.clearPendingTradeListing);
  useEffect(() => {
    if (!pendingTradeListing) {
      return;
    }
    const request = pendingTradeListing;
    let cancelled = false;
    void (async () => {
      let item: WfmAutocompleteItem | null = null;
      try {
        const catalog = await getWfmAutocompleteItems(useAppStore.getState().language);
        item =
          catalog.find((entry) => entry.slug === request.slug) ??
          catalog.find((entry) => entry.name === request.name) ??
          null;
      } catch {
        // Couldn't resolve — open with the name pre-typed so the user can pick it manually.
      }
      if (cancelled) {
        return;
      }
      setListingActionError(null);
      setListingAnalysis(null);
      const base = createListingModalState('create', request.orderType, item);
      setListingModal({
        ...base,
        itemName: request.name,
        price: request.price != null ? String(request.price) : base.price,
        rank: request.rank != null && (item?.maxRank ?? 0) > 0 ? String(request.rank) : base.rank,
      });
      // Clear only AFTER the modal is open — clearing earlier re-runs this effect and its cleanup
      // cancels the in-flight resolve, so the modal would never open.
      clearPendingTradeListing();
    })();
    return () => {
      cancelled = true;
    };
  }, [pendingTradeListing, clearPendingTradeListing]);

  const handleTradeActionFailure = (error: unknown) => {
    const rawMessage = error instanceof Error ? error.message : String(error);
    if (isTradeSessionExpiredMessage(rawMessage)) {
      setSessionExpiredPopupOpen(true);
      setOverviewError(null);
      void loadTradeAccount();
      return;
    }
    const friendly = formatTradesErrorMessage('trade-action', error);
    setOverviewError(friendly);
    // Also toast it — a row action's failure shouldn't only appear in the top-of-page banner,
    // far from the button the user just clicked.
    pushToast(friendly, 'error');
    void loadTradeAccount();
  };

  const handleListingModalSubmit = async () => {
    if (!listingModal) {
      return;
    }

    const selectedItem = listingModal.selectedItem;
    const price = Number.parseInt(listingModal.price, 10);
    const quantity = Number.parseInt(listingModal.quantity, 10);
    const rank = listingModal.rank === '' ? null : Number.parseInt(listingModal.rank, 10);
    const bulkTradable = isBulkTradable(selectedItem);
    const perTrade =
      bulkTradable && listingModal.perTrade !== ''
        ? Number.parseInt(listingModal.perTrade, 10)
        : null;

    if (!selectedItem) {
      setListingActionError(t('trades.selectItemFirst'));
      return;
    }

    if (!selectedItem.wfmId) {
      setListingActionError(t('trades.marketIdUnavailable'));
      return;
    }

    if (listingModal.mode === 'edit' && !listingModal.orderId) {
      setListingActionError(t('trades.orderIdMissing'));
      return;
    }

    if (!Number.isInteger(price) || price <= 0) {
      setListingActionError(t('trades.priceWholeNumber'));
      return;
    }

    if (!Number.isInteger(quantity) || quantity <= 0) {
      setListingActionError(t('trades.quantityWholeNumber'));
      return;
    }

    if (rank !== null && (!Number.isInteger(rank) || rank < 0)) {
      setListingActionError(t('trades.rankWholeNumber'));
      return;
    }

    if (perTrade !== null && (perTrade < 1 || perTrade > 6 || quantity % perTrade !== 0)) {
      setListingActionError(t('trades.perTradeRange'));
      return;
    }

    setListingActionPending(true);
    setListingActionError(null);

    try {
      const nextOverview =
        listingModal.mode === 'create'
          ? await (listingModal.orderType === 'sell' ? createWfmSellOrder : createWfmBuyOrder)(
              {
                wfmId: selectedItem.wfmId,
                price,
                quantity,
                rank,
                visible: listingModal.visible,
                perTrade,
                // '' = untouched picker → omit so the backend applies the item default.
                subtype: listingModal.subtype || null,
              } satisfies TradeCreateListingInput,
              sellerMode,
            )
          : await (listingModal.orderType === 'sell' ? updateWfmSellOrder : updateWfmBuyOrder)(
              {
                orderId: listingModal.orderId ?? '',
                price,
                quantity,
                rank,
                visible: listingModal.visible,
                wfmId: selectedItem.wfmId,
                perTrade,
              } satisfies TradeUpdateListingInput,
              sellerMode,
            );

      // Close the modal immediately — the order was created/updated on WFM's side.
      // Apply the refreshed overview in the background so the table stays current.
      setListingModal(null);
      setListingAnalysis(null);
      setListingActionPending(false);
      // An edit hands manual control back to the user — resync the per-listing Auto chips.
      smartStates.refresh();
      void applyOverview(nextOverview).catch((error) => {
        setOverviewError(formatTradesErrorMessage('trade-overview-refresh', error));
      });
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      if (isTradeSessionExpiredMessage(rawMessage)) {
        setSessionExpiredPopupOpen(true);
        setListingActionError(null);
        void loadTradeAccount();
        setListingActionPending(false);
        return;
      }
      setListingActionError(formatTradesErrorMessage('trade-action', error));
      setListingActionPending(false);
      void loadTradeAccount();
    }
  };

  const handleCloseOrder = async (order: TradeSellOrder, quantityOverride?: number) => {
    const quantity = quantityOverride ?? 1;
    if (!Number.isInteger(quantity) || quantity <= 0) {
      setOverviewError(t('trades.markSoldWholeNumber'));
      return;
    }

    if (!beginOrderAction(order.orderId)) {
      return;
    }
    const closeOrderFn = order.orderType === 'sell' ? closeWfmSellOrder : closeWfmBuyOrder;
    try {
      const nextOverview = await closeOrderFn(
        order.orderId,
        Math.min(quantity, order.quantity),
        sellerMode,
      );
      await applyOverview(nextOverview);
    } catch (error) {
      handleTradeActionFailure(error);
    } finally {
      endOrderAction(order.orderId);
    }
  };

  // One-click fix for a drifted sell listing: reprice straight to the current market low.
  // One-click apply of the health engine's recommended price. Works for both sides: a sell
  // gets repriced to the recommended exit (market low / trim target), a buy gets raised to the
  // recommended bid (match top bid). Falls back to market low for sells with no explicit target.
  const handleApplyRecommended = async (order: TradeSellOrder) => {
    // Apply exactly the engine's recommended price (reprice/trim/match) — no floor fallback.
    const target = order.health?.recommendedPrice ?? null;
    if (target === null || target === undefined || target <= 0 || target === order.yourPrice) {
      return;
    }
    if (!beginOrderAction(order.orderId)) {
      return;
    }
    const updateOrderFn = order.orderType === 'sell' ? updateWfmSellOrder : updateWfmBuyOrder;
    try {
      const nextOverview = await updateOrderFn(
        {
          orderId: order.orderId,
          price: target,
          quantity: order.quantity,
          rank: order.rank ?? null,
          visible: order.visible,
          wfmId: order.wfmId,
          perTrade: order.bulkTradable ? order.perTrade : null,
        } satisfies TradeUpdateListingInput,
        sellerMode,
      );
      await applyOverview(nextOverview);
      // A manual sell update flips this listing to manual on the backend — resync the chip.
      if (order.orderType === 'sell') {
        smartStates.refresh();
      }
    } catch (error) {
      handleTradeActionFailure(error);
    } finally {
      endOrderAction(order.orderId);
    }
  };

  const handleDeleteOrder = async (order: TradeSellOrder) => {
    if (!beginOrderAction(order.orderId)) {
      return;
    }
    try {
      const nextOverview =
        order.orderType === 'sell'
          ? await deleteWfmSellOrder(order.orderId, sellerMode)
          : await deleteWfmBuyOrder(order.orderId, sellerMode);
      await applyOverview(nextOverview);
    } catch (error) {
      handleTradeActionFailure(error);
    } finally {
      endOrderAction(order.orderId);
    }
  };

  const handleDisconnect = async () => {
    try {
      await signOutTradeAccount();
    } catch (error) {
      handleTradeActionFailure(error);
    }
  };

  if (!tradeAccount) {
    return <SignInPanel />;
  }

  const sellOrders = overview?.sellOrders ?? [];
  const buyOrders = overview?.buyOrders ?? [];
  const buyExposure = buyOrders.reduce((sum, order) => sum + order.yourPrice * order.quantity, 0);

  const renderOrderRow = (order: TradeSellOrder, type: TradeListingKind) => {
    const pending = isOrderPending(order.orderId);
    // Only offer the one-click action when the health engine actually recommends a price change
    // (reprice / trim / match bid) — never a blind reprice-to-floor just because we're undercut.
    const recommendedPrice = order.health?.recommendedPrice ?? null;
    const canApplyPrice =
      recommendedPrice !== null && recommendedPrice !== undefined
      && recommendedPrice > 0 && recommendedPrice !== order.yourPrice;
    const eta = type === 'sell' ? formatEtaHours(order.health?.estSellHoursAtPrice) : null;
    const menuOpen = actionMenuOrderId === order.orderId;
    return (
      <div
        key={order.orderId}
        className={`trade-split-row${order.visible ? '' : ' trade-row-hidden'}`}
      >
        <div className="trade-split-item">
          <button
            type="button"
            className="item-thumb trade-item-thumb trade-thumb-toggle"
            disabled={pending}
            title={order.visible ? t('trades.row.hideListing') : t('trades.row.showListing')}
            aria-label={order.visible ? t('trades.row.hideListing') : t('trades.row.showListing')}
            onClick={() => void handleToggleOrderVisibility(order)}
          >
            <span className="trade-thumb-art" aria-hidden="true">
              {resolveWfmAssetUrl(order.imagePath, order.slug) ? (
                <img src={resolveWfmAssetUrl(order.imagePath, order.slug) ?? undefined} alt="" />
              ) : (
                <span>{order.name.slice(0, 1)}</span>
              )}
            </span>
            <span className="trade-thumb-eye" aria-hidden="true">
              {order.visible ? <EyeIcon /> : <EyeOffIcon />}
            </span>
          </button>
          <div className="trade-split-item-copy">
            <ItemName
              className="item-name trade-split-item-name"
              name={order.name}
              slug={order.slug}
              itemId={order.itemId}
              imagePath={order.imagePath}
            />
            <span className="trade-split-subline">
              {order.maxRank !== null && order.maxRank !== undefined && order.maxRank > 0
                ? `${order.rank ?? 0}/${order.maxRank} · `
                : null}
              ×{order.quantity}
              {!order.visible ? ` · ${t('trades.row.hidden').toLowerCase()}` : null}
              {order.health ? (
                <span className={`trade-split-health ${getTradeHealthToneClass(order.health.tone)}`}>
                  {' · '}{tHealth(t, order.health.label)}
                </span>
              ) : null}
              {eta ? <span className="trade-split-eta">{' · '}{eta}</span> : null}
              {order.health?.wouldRealizeLoss ? (
                <span className="trade-split-loss">{' · '}{t('trades.health.wouldLose')}</span>
              ) : null}
              {type === 'sell' ? (
                <span className="trade-split-age">
                  {' · '}
                  {marketLowTimestamps[order.orderId]
                    ? formatMarketLowAge(marketLowTimestamps[order.orderId])
                    : staleHealthIds.includes(order.orderId)
                      ? t('trades.row.cantRefresh')
                      : t('trades.row.refreshing')}
                </span>
              ) : null}
            </span>
          </div>
          {type === 'sell' && order.wfmId ? (
            <div className="smart-strategy-anchor">
              <button
                type="button"
                className={`trade-auto-chip ${smartStates.isManaged(order.wfmId, order.rank) ? 'on' : 'off'}`}
                title={t('smart.perListingTitle')}
                aria-label={t('smart.perListingTitle')}
                aria-expanded={strategyPopoverId === order.orderId}
                onClick={(event) => {
                  const trigger = event.currentTarget;
                  setStrategyPopoverId((current) => {
                    const next = current === order.orderId ? null : order.orderId;
                    setStrategyAnchorEl(next ? trigger : null);
                    return next;
                  });
                }}
              >
                <i className="ti ti-robot" aria-hidden="true" />
                {t('smart.auto')}
              </button>
              {strategyPopoverId === order.orderId ? (
                <SmartListingStrategyPopover
                  initial={smartStates.overridesFor(order.wfmId, order.rank)}
                  enabled={smartStates.isManaged(order.wfmId, order.rank)}
                  anchorEl={strategyAnchorEl}
                  onToggleEnabled={() => void smartStates.toggle(order.wfmId, order.rank)}
                  onClose={() => setStrategyPopoverId(null)}
                  onSave={(next) => {
                    void smartStates.saveOverrides(order.wfmId, order.rank, next);
                  }}
                />
              ) : null}
            </div>
          ) : null}
        </div>
        <span className="trade-split-prices">
          {formatPlatinumValue(order.yourPrice)}
          <span className="trade-split-market">
            {' / '}
            {order.marketLow !== null && order.marketLow !== undefined
              ? formatPlatinumValue(order.marketLow)
              : '—'}
          </span>
        </span>
        <span className={`trade-split-gap ${getGapClassName(order.priceGap)}`}>
          {order.marketLow !== null && order.marketLow !== undefined ? formatGap(order.priceGap) : '—'}
        </span>
        <span className="trade-split-actions">
          {canApplyPrice ? (
            <button
              type="button"
              className="trade-icon-btn trade-icon-btn-warn"
              disabled={pending}
              title={t('trades.row.applyAction', {
                action: tHealth(t, order.health?.actionLabel) || t('trades.health.apply'),
                price: formatPlatinumValue(recommendedPrice ?? 0),
              })}
              aria-label={t('trades.row.applyAction', {
                action: tHealth(t, order.health?.actionLabel) || t('trades.health.apply'),
                price: formatPlatinumValue(recommendedPrice ?? 0),
              })}
              onClick={() => void handleApplyRecommended(order)}
            >
              <BoltIcon />
            </button>
          ) : null}
          <button
            type="button"
            className="trade-icon-btn trade-icon-btn-good"
            disabled={pending}
            title={t(type === 'sell' ? 'trades.row.markSold' : 'trades.row.markBought')}
            aria-label={t(type === 'sell' ? 'trades.row.markSoldAria' : 'trades.row.markBoughtAria', { name: order.name })}
            onClick={() => {
              if (order.quantity > 1) {
                setCloseQtyValue('1');
                setCloseQtyTarget(order);
              } else {
                void handleCloseOrder(order, 1);
              }
            }}
          >
            <CheckIcon />
          </button>
          <button
            type="button"
            className="trade-icon-btn"
            disabled={pending}
            title={t('trades.row.edit')}
            aria-label={t('trades.row.edit')}
            onClick={() => openEditListing(order)}
          >
            <PencilIcon />
          </button>
          <span className="trade-split-menu-wrap">
            <button
              type="button"
              className={`trade-icon-btn${menuOpen ? ' open' : ''}`}
              disabled={pending}
              title={t('trades.row.more')}
              aria-label={t('trades.row.more')}
              aria-expanded={menuOpen}
              onClick={() => setActionMenuOrderId(menuOpen ? null : order.orderId)}
            >
              <DotsIcon />
            </button>
            {menuOpen ? (
              <div className="trade-split-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setActionMenuOrderId(null);
                    void handleToggleOrderVisibility(order);
                  }}
                >
                  {order.visible ? t('trades.row.ariaHide') : t('trades.row.ariaShow')}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="danger"
                  onClick={() => {
                    setActionMenuOrderId(null);
                    void handleDeleteOrder(order);
                  }}
                >
                  {t('trades.row.remove')}
                </button>
              </div>
            ) : null}
          </span>
        </span>
      </div>
    );
  };

  const renderOrderPanel = (type: TradeListingKind) => {
    const panelOrders = type === 'sell' ? sellOrders : buyOrders;
    const visibleCount = panelOrders.filter((order) => order.visible).length;
    return (
      <div className="trade-order-panel">
        <div className="trade-order-panel-head">
          <span className={`trade-order-panel-dot ${type}`} />
          <span className="trade-order-panel-title">
            {t(type === 'sell' ? 'trades.panel.sellOrders' : 'trades.panel.buyOrders')}
          </span>
          <span className="trade-order-panel-count">
            {visibleCount}/{panelOrders.length}
          </span>
          <span className="trade-order-panel-head-actions">
            <button
              className="act-btn"
              type="button"
              disabled={visibilityActionPending || panelOrders.every((order) => order.visible)}
              onClick={() => void handleSetAllVisibility(true, type)}
            >
              {t('trades.showAll')}
            </button>
            <button
              className="act-btn"
              type="button"
              disabled={visibilityActionPending || panelOrders.every((order) => !order.visible)}
              onClick={() => void handleSetAllVisibility(false, type)}
            >
              {t('trades.hideAll')}
            </button>
          </span>
        </div>
        <div className="trade-split-header">
          <span>{t('trades.col.item')}</span>
          <span>{t(type === 'sell' ? 'trades.col.yoursLow' : 'trades.col.yoursMarket')}</span>
          <span>{t('trades.col.priceGap')}</span>
          <span className="trade-split-header-actions">{t('trades.col.actions')}</span>
        </div>
        {panelOrders.map((order) => renderOrderRow(order, type))}
        {overview && panelOrders.length === 0 ? (
          <div className="empty-state trade-split-empty">
            <span className="empty-primary">
              {t(type === 'sell' ? 'trades.noSellOrders' : 'trades.noBuyOrders')}
            </span>
            <span className="empty-sub">
              {t(type === 'sell' ? 'trades.createSellHint' : 'trades.createBuyHint')}
            </span>
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <>
      <div className="trade-hero">
        <div className="trade-hero-main">
          <TradeAvatar imageUrl={overview?.account.avatarUrl ?? tradeAccount.avatarUrl} name={tradeAccount.name} />
          <div className="trade-hero-copy">
            <div className="trade-hero-title-row">
              <h2 className="trade-hero-title">{tradeAccount.name}</h2>
              <span className={`badge ${getTradeStatusToneClass(tradeAccount.status)}`}>
                {formatTradeStatusLabel(tradeAccount.status)}
              </span>
            </div>
            <div className="trade-hero-meta">
              <span>{t('trades.hero.lastUpdated')} {formatShortLocalDateTime(overview?.lastUpdatedAt ?? tradeAccount.lastUpdatedAt)}</span>
              <span>{t('home.seller.filter')} {sellerMode === 'ingame-online' ? t('home.seller.ingameOnline') : t('home.seller.ingame')}</span>
            </div>
          </div>
        </div>
        <div className="trade-hero-actions">
          <button className="btn-primary" type="button" onClick={() => openCreateListing('sell')}>
            {t('trades.hero.createListing')}
          </button>
          <div className="trade-visibility-toggle-wrap">
            <button
              className={`trade-visibility-toggle${autoWatchlistBuyOrdersEnabled ? ' on' : ''}`}
              type="button"
              onClick={() => setAutoWatchlistBuyOrdersEnabled(!autoWatchlistBuyOrdersEnabled)}
            >
              <span className="trade-visibility-toggle-track" />
              <span className="trade-visibility-toggle-copy">
                {t('trades.autoBuyOrder')}
              </span>
            </button>
            <div className="trade-visibility-toggle-info">
              <InfoHint text="Automatically adds and removes buy orders for items added/removed from the watchlist. Recommended: On" />
            </div>
          </div>
          <button className="btn-secondary" type="button" onClick={() => void handleDisconnect()}>
            {t('trades.disconnect')}
          </button>
        </div>
      </div>

      <div className="stats-strip trade-stats-strip">
        <div className="stat-mini">
          <div className="stat-mini-label">{t('trades.stat.activeTradeValue')}</div>
          <div className="stat-mini-val neutral">
            {overview ? formatPlatinumValue(overview.activeTradeValue) : '—'}
          </div>
        </div>
        <div className="stat-mini">
          <div className="stat-mini-label">{t('trades.stat.buyExposure')}</div>
          <div className="stat-mini-val neutral">
            {overview ? formatPlatinumValue(buyExposure) : '—'}
          </div>
        </div>
        <div className="stat-mini">
          <div className="stat-mini-label">{t('trades.stat.completedTrades')}</div>
          <div className="stat-mini-val neutral">
            {overview?.totalCompletedTrades ?? '—'}
          </div>
        </div>
        <div className="stat-mini">
          <div className="stat-mini-label">{t('trades.stat.openPositions')}</div>
          <div className="stat-mini-val neutral">
            {overview?.openPositions ?? '—'}
          </div>
        </div>
      </div>

      {overviewError ? <div className="trade-inline-error">{overviewError}</div> : null}

      {overviewLoading && !overview ? (
        <div className="card trade-list-card">
          <div className="empty-state">
            <span className="empty-primary">{t('trades.loadingSellOrders')}</span>
            <span className="empty-sub">{t('trades.syncingAccount')}</span>
          </div>
        </div>
      ) : (
        <div className="trade-orders-split">
          {renderOrderPanel('sell')}
          {renderOrderPanel('buy')}
        </div>
      )}

      <Dialog
        open={closeQtyTarget !== null}
        onOpenChange={(open) => !open && setCloseQtyTarget(null)}
      >
        <DialogContent className="max-w-sm">
          {closeQtyTarget ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  {t(
                    closeQtyTarget.orderType === 'sell'
                      ? 'trades.row.markSold'
                      : 'trades.row.markBought',
                  )}
                </DialogTitle>
                <DialogDescription>
                  {closeQtyTarget.name} ·{' '}
                  {t(
                    closeQtyTarget.orderType === 'sell'
                      ? 'trades.closeQty.promptSold'
                      : 'trades.closeQty.promptBought',
                    { count: String(closeQtyTarget.quantity) },
                  )}
                </DialogDescription>
              </DialogHeader>

              <div className="flex flex-wrap items-center gap-2">
                <Input
                  type="number"
                  min={1}
                  max={closeQtyTarget.quantity}
                  autoFocus
                  className="w-20 text-right tabular-nums"
                  value={closeQtyValue}
                  onChange={(event) => setCloseQtyValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      const parsed = Number.parseInt(closeQtyValue, 10);
                      if (Number.isInteger(parsed) && parsed >= 1) {
                        const target = closeQtyTarget;
                        setCloseQtyTarget(null);
                        void handleCloseOrder(target, Math.min(parsed, target.quantity));
                      }
                    }
                  }}
                  aria-label={t('trades.closeQty.inputAria')}
                />
                {/* 1 / half / all — the three quantities anyone actually picks. */}
                {[1, Math.ceil(closeQtyTarget.quantity / 2), closeQtyTarget.quantity]
                  .filter((value, index, all) => value >= 1 && all.indexOf(value) === index)
                  .map((value) => {
                    const active = Number.parseInt(closeQtyValue, 10) === value;
                    return (
                      <Button
                        key={value}
                        variant="ghost"
                        size="sm"
                        static
                        aria-pressed={active}
                        onClick={() => setCloseQtyValue(String(value))}
                        className={`h-7 rounded-md px-2.5 text-[11px] font-medium ${
                          active
                            ? 'bg-bg-elevated text-ink'
                            : 'text-ink-dim hover:bg-white/[0.04] hover:text-ink'
                        }`}
                      >
                        {value === closeQtyTarget.quantity
                          ? t('trades.closeQty.all', { count: String(value) })
                          : value}
                      </Button>
                    );
                  })}
              </div>

              <DialogFooter>
                <Button variant="ghost" size="sm" onClick={() => setCloseQtyTarget(null)}>
                  {t('a11y.dismiss')}
                </Button>
                <Button
                  size="sm"
                  disabled={
                    !Number.isInteger(Number.parseInt(closeQtyValue, 10)) ||
                    Number.parseInt(closeQtyValue, 10) < 1
                  }
                  onClick={() => {
                    const parsed = Number.parseInt(closeQtyValue, 10);
                    const target = closeQtyTarget;
                    setCloseQtyTarget(null);
                    void handleCloseOrder(target, Math.min(parsed, target.quantity));
                  }}
                >
                  {t(
                    closeQtyTarget.orderType === 'sell'
                      ? 'trades.row.markSold'
                      : 'trades.row.markBought',
                  )}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={sessionExpiredPopupOpen} onOpenChange={setSessionExpiredPopupOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('trades.sessionExpired')}</DialogTitle>
            <DialogDescription>{t('trades.sessionExpiredCopy')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setSessionExpiredPopupOpen(false)}>
              {t('a11y.dismiss')}
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setSessionExpiredPopupOpen(false);
                // Clear the dead session so the sign-in panel takes over immediately.
                void signOutTradeAccount().catch(() => undefined);
              }}
            >
              {t('trades.signInAgain')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {listingModal ? (
        <ListingModal
          form={listingModal}
          suggestions={listingSuggestions}
          submitting={listingActionPending}
          errorMessage={listingActionError}
          autocompleteReady={!autocompleteLoading}
          autocompleteError={autocompleteError}
          analysis={listingAnalysis}
          onClose={closeListingModal}
          onSubmit={() => void handleListingModalSubmit()}
          onChange={(patch) =>
            setListingModal((current) => (current ? { ...current, ...patch } : current))
          }
          onSelectItem={(item) =>
            setListingModal((current) =>
              current
                ? {
                    ...current,
                    selectedItem: item,
                    itemName: item.name,
                    rank: isRankApplicable(item) ? '0' : '',
                    perTrade: isBulkTradable(item) ? '1' : '',
                  }
                : current,
            )
          }
        />
      ) : null}
    </>
  );
}

export function TradesPage() {
  const tradeAccount = useAppStore((s) => s.tradeAccount);
  const loadTradeAccount = useAppStore((s) => s.loadTradeAccount);
  const tradesSubTab = useAppStore((s) => s.tradesSubTab);
  const { t } = useTranslation();

  useEffect(() => {
    void loadTradeAccount();
  }, [loadTradeAccount]);

  return (
    <>
      <PageHeading
        page="trades"
        actions={
          tradeAccount && tradesSubTab === 'orders' ? (
            <span className="trade-subnav-hint">{t('trades.subnav.liveOrders')}</span>
          ) : null
        }
      />
      <div className="page-content trades-page-content">
        {!tradeAccount ? (
          <SignInPanel />
        ) : (
          <>
            {tradesSubTab === 'orders' && <ListingsTab />}
            {tradesSubTab === 'health' && <HealthTabContainer />}
            {tradesSubTab === 'detection' && <TradeDetectionComparison />}
          </>
        )}
      </div>
    </>
  );
}
