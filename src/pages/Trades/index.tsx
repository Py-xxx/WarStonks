import { useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useModalA11y } from '../../hooks/useModalA11y';
import { formatTradesErrorMessage } from '../../lib/tradesErrorHandling';
import {
  closeWfmSellOrder,
  createWfmBuyOrder,
  createWfmSellOrder,
  deleteWfmBuyOrder,
  deleteWfmSellOrder,
  getItemAnalysis,
  getItemAnalytics,
  getTradeSellOrderHealth,
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
import { ItemName } from '../../components/ItemName';
import { ModalPortal } from '../../components/ModalPortal';
import { useAppStore } from '../../stores/useAppStore';
import { wfstatLangCode } from '../../lib/language';
import { useTranslation } from '../../i18n';
import { tHealth, tSubtype, tTrendSummary } from '../../lib/healthLabels';
import type {
  ItemAnalysisResponse,
  ItemAnalyticsResponse,
  TradeCreateListingInput,
  TradeOverview,
  TradeSellOrder,
  TradeUpdateListingInput,
  WfmAutocompleteItem,
  SellerMode,
  TradeListingHealth,
} from '../../types';

type ListingModalMode = 'create' | 'edit';
type TradeListingKind = 'sell' | 'buy';

function InfoHint({ text }: { text: string }) {
  return (
    <span className="info-hint trade-info-hint" tabIndex={0} aria-label={text}>
      <span className="info-hint-glyph" aria-hidden="true">i</span>
      <span className="info-hint-tooltip left">
        {text}
      </span>
    </span>
  );
}

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
}

const DEFAULT_MARK_SOLD_QTY = '1';
const tradeOverviewCache = new Map<SellerMode, TradeOverview>();
const tradeOverviewLoadPromises = new Map<SellerMode, Promise<TradeOverview>>();

// Persists the last known market low value and timestamp across overview refreshes
// and component remounts. Keyed by "slug:rank" so it survives order-id changes.
const marketLowCache = new Map<string, { marketLow: number | null; refreshedAt: number }>();
const tradeHealthCache = new Map<string, { health: TradeListingHealth; yourPrice: number }>();

function marketLowKey(slug: string, rank: number | null): string {
  return rank !== null && rank !== undefined ? `${slug}:${rank}` : slug;
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

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const REFRESH_INTERVAL_MS = 5_000;
    const MEDIUM_THRESHOLD_MS = 45_000;
    const HIGH_THRESHOLD_MS = 60_000;

    const tick = () => {
      for (const order of sellOrdersRef.current) {
        if (healthInFlight.current.has(order.orderId)) {
          continue;
        }
        const parsedHealthRefresh = order.health?.refreshedAt
          ? Date.parse(order.health.refreshedAt)
          : Number.NaN;
        const lastRefresh = healthRefreshedAt.current[order.orderId]
          ?? (Number.isFinite(parsedHealthRefresh) ? parsedHealthRefresh : 0);
        const ageMs = Date.now() - (Number.isFinite(lastRefresh) ? lastRefresh : 0);
        if (lastRefresh > 0 && ageMs < MEDIUM_THRESHOLD_MS) {
          continue;
        }
        const priority: 'high' | 'medium' | 'low' =
          ageMs >= HIGH_THRESHOLD_MS ? 'high' : ageMs >= MEDIUM_THRESHOLD_MS ? 'medium' : 'low';

        healthInFlight.current.add(order.orderId);
        void getTradeSellOrderHealth(
          order.itemId,
          order.slug,
          order.rank,
          order.yourPrice,
          sellerMode,
          priority,
        )
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
            tradeHealthCache.set(order.orderId, { health, yourPrice: order.yourPrice });
            setOverview((current) => {
              if (!current) {
                return current;
              }
              return {
                ...current,
                sellOrders: current.sellOrders.map((candidate) =>
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
      }
    };

    tick();
    const interval = setInterval(tick, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [enabled, onHealthRefreshed, onHealthRefreshFailed, sellerMode, setOverview]);

  return { sellOrdersRef };
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
  const modalRef = useModalA11y<HTMLDivElement>({ onClose });
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
                        {resolveWfmAssetUrl(item.imagePath) ? (
                          <img src={resolveWfmAssetUrl(item.imagePath) ?? undefined} alt="" />
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
              onChange={(event) => onChange({ price: event.target.value })}
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
    <ModalPortal>
    <div className="modal-backdrop" role="presentation">
      {/* Backdrop intentionally does NOT close on click — an accidental outside click would
          discard a half-typed listing. Use Cancel, the × button, or Escape to close. */}
      <div
        ref={modalRef}
        className={`settings-modal trade-listing-modal${showAnalysis ? ' has-analysis' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="trade-listing-modal-title"
      >
        <div className="settings-modal-header">
          <div className="settings-modal-title">
            <span className="card-label">{t('trades.title')}</span>
            <h3 id="trade-listing-modal-title">
              {form.mode === 'create'
                ? t(form.orderType === 'sell' ? 'trades.modal.createSell' : 'trades.modal.createBuy')
                : t(form.orderType === 'sell' ? 'trades.modal.editSell' : 'trades.modal.editBuy')}
            </h3>
          </div>
          <button className="settings-close-btn" type="button" onClick={onClose} aria-label={t('trades.modal.closeAria')}>
            ×
          </button>
        </div>

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

        <div className="settings-modal-actions">
          <button className="act-btn" type="button" onClick={onClose}>{t('trades.modal.cancel')}</button>
          <button className="btn-primary" type="button" onClick={onSubmit} disabled={submitting}>
            {submitting
              ? t('common.saving')
              : form.mode === 'create'
                ? t(form.orderType === 'sell' ? 'trades.modal.postSell' : 'trades.modal.postBuy')
                : t('trades.modal.saveChanges')}
          </button>
        </div>
      </div>
    </div>
    </ModalPortal>
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

function HealthTab() {
  const { t } = useTranslation();
  const tradeAccount = useAppStore((s) => s.tradeAccount);
  const loadTradeAccount = useAppStore((s) => s.loadTradeAccount);
  const syncWatchlistTradeOverview = useAppStore((s) => s.syncWatchlistTradeOverview);
  const sellerMode = useAppStore((s) => s.sellerMode);
  const [overview, setOverview] = useState<TradeOverview | null>(() => tradeOverviewCache.get(sellerMode) ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { sellOrdersRef } = useTradeSellHealthRefresh({
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
  }, [loadTradeAccount, sellerMode, syncWatchlistTradeOverview, tradeAccount]);

  sellOrdersRef.current = overview?.sellOrders ?? [];

  const sellOrders = useMemo(
    () =>
      [...(overview?.sellOrders ?? [])].sort((left, right) => {
        const priorityDelta = getTradeHealthPriority(left) - getTradeHealthPriority(right);
        if (priorityDelta !== 0) {
          return priorityDelta;
        }
        const scoreDelta = (left.health?.score ?? -1) - (right.health?.score ?? -1);
        if (scoreDelta !== 0) {
          return scoreDelta;
        }
        return left.name.localeCompare(right.name);
      }),
    [overview?.sellOrders],
  );

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
    <div className="trade-health-page">
      <div className="trade-health-summary-grid">
        <div className="info-card trade-health-summary-card">
          <div className="info-card-label">{t('trades.health.needsAction')}</div>
          <div className="info-card-val neutral">{actionNeededCount}</div>
        </div>
        <div className="info-card trade-health-summary-card">
          <div className="info-card-label">{t('trades.health.competitive')}</div>
          <div className="info-card-val neutral">{competitiveCount}</div>
        </div>
        <div className="info-card trade-health-summary-card">
          <div className="info-card-label">{t('trades.health.likelySoon')}</div>
          <div className="info-card-val neutral">{likelySoonCount}</div>
        </div>
      </div>

      {error ? <div className="trade-inline-error">{error}</div> : null}

      <div className="trade-health-list">
        {loading && !overview ? (
          <div className="trade-placeholder-card">
            <span className="card-label">{t('trades.title')}</span>
            <h3>{t('trades.col.listingHealth')}</h3>
            <p>{t('trades.health.building')}</p>
          </div>
        ) : null}

        {!loading && sellOrders.length === 0 ? (
          <div className="trade-placeholder-card">
            <span className="card-label">{t('trades.title')}</span>
            <h3>{t('trades.health.noListings')}</h3>
            <p>{t('trades.health.noListingsHint')}</p>
          </div>
        ) : null}

        {sellOrders.map((order) => {
          const health = order.health;
          return (
            <div key={order.orderId} className="trade-health-card">
              <div className="trade-health-card-main">
                <span className="item-thumb trade-item-thumb trade-health-thumb">
                  {resolveWfmAssetUrl(order.imagePath) ? (
                    <img src={resolveWfmAssetUrl(order.imagePath) ?? undefined} alt="" />
                  ) : (
                    <span>{order.name.slice(0, 1)}</span>
                  )}
                </span>
                <div className="trade-health-copy">
                  <div className="trade-health-copy-top">
                    <div>
                      <ItemName
                        className="item-name trade-health-item-name"
                        name={order.name}
                        slug={order.slug}
                        itemId={order.itemId}
                        imagePath={order.imagePath}
                      />
                      <div className="trade-health-item-meta">
                        {health ? t('common.updatedAt', { time: formatShortLocalDateTime(health.refreshedAt) }) : t('trades.refreshingLiveHealth')}
                      </div>
                    </div>
                    <div className="trade-health-badges">
                      <span className={`market-panel-badge ${getTradeHealthToneClass(health?.tone ?? 'amber')}`}>
                        {tHealth(t, health?.label) || t('trades.row.building')}
                      </span>
                      <span className={`market-panel-badge ${getTradeHealthToneClass(health?.actionTone ?? 'blue')}`}>
                        {tHealth(t, health?.actionLabel) || t('trades.row.building')}
                      </span>
                    </div>
                  </div>

                  <div className="trade-health-metrics">
                    <div className="trade-health-metric">
                      <span className="trade-health-metric-label">{t('trades.health.yourPrice')}</span>
                      <strong>{formatPlatinumValue(order.yourPrice)}</strong>
                    </div>
                    <div className="trade-health-metric">
                      <span className="trade-health-metric-label">{t('trades.health.marketLow')}</span>
                      <strong>{formatPlatinumValue(health?.marketLow ?? order.marketLow ?? null)}</strong>
                    </div>
                    <div className="trade-health-metric">
                      <span className="trade-health-metric-label">{t('trades.health.queue')}</span>
                      <strong>{health ? `${health.sellersAhead} ahead` : '—'}</strong>
                    </div>
                    <div className="trade-health-metric">
                      <span className="trade-health-metric-label">{t('trades.health.direction')}</span>
                      <strong>{tHealth(t, health?.marketDirection) || t('trades.row.building')}</strong>
                    </div>
                    <div className="trade-health-metric">
                      <span className="trade-health-metric-label">{t('trades.health.outlook')}</span>
                      <strong>{tHealth(t, health?.outlookLabel) || t('trades.row.building')}</strong>
                    </div>
                    <div className="trade-health-metric">
                      <span className="trade-health-metric-label">{t('trades.health.suggested')}</span>
                      <strong>
                        {health?.recommendedPrice !== null && health?.recommendedPrice !== undefined
                          ? formatPlatinumValue(health.recommendedPrice)
                          : tHealth(t, health?.actionLabel) || '—'}
                      </strong>
                    </div>
                  </div>

                  <div className="trade-health-reason">
                    {health?.reason ?? t('trades.buildingMarketPicture')}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ListingsTab({ listingType }: { listingType: TradeListingKind }) {
  const { t } = useTranslation();
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
  const [soldQuantities, setSoldQuantities] = useState<Record<string, string>>({});
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
  const sessionExpiredRef = useModalA11y<HTMLDivElement>({
    onClose: () => setSessionExpiredPopupOpen(false),
    active: sessionExpiredPopupOpen,
  });
  // Analysis preview for the create-listing modal (cleared on modal close).
  const [listingAnalysis, setListingAnalysis] = useState<ListingAnalysisState | null>(null);
  // Display-layer state: epoch ms when each order's market_low was last fetched.
  // Kept in state so the "X ago" label re-renders when a fetch completes.
  const [marketLowTimestamps, setMarketLowTimestamps] = useState<Record<string, number>>({});
  // Orders whose background health refresh has failed repeatedly — shown as "couldn't refresh"
  // instead of an endless "refreshing…".
  const [staleHealthIds, setStaleHealthIds] = useState<readonly string[]>([]);
  const { sellOrdersRef } = useTradeSellHealthRefresh({
    enabled: Boolean(tradeAccount) && listingType === 'sell',
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
        setOverview(cachedOverview);
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
  }, [loadTradeAccount, sellerMode, syncWatchlistTradeOverview, tradeAccount]);

  useEffect(() => {
    if (!tradeAccount) {
      return;
    }

    let cancelled = false;

    const loadAutocomplete = async () => {
      setAutocompleteLoading(true);
      setAutocompleteError(null);
      try {
        const items = await getWfmAutocompleteItems(wfstatLangCode(useAppStore.getState().language));
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

  // Ticker: forces the "X ago" labels to stay current between market_low fetches.
  useEffect(() => {
    if (listingType !== 'sell') {
      return;
    }
    const interval = setInterval(() => {
      setMarketLowTimestamps((prev) => ({ ...prev }));
    }, 15_000);
    return () => clearInterval(interval);
  }, [listingType]);

  // Fetch market analysis whenever the listing modal is open and an item is known.
  // Both getItemAnalysis and getItemAnalytics use RequestPriority::Instant internally.
  const analysisItem = listingModal?.selectedItem ?? null;
  const analysisRank = isRankApplicable(analysisItem) ? listingModal?.rank ?? '' : '';
  const analysisVariantKey = analysisRank.trim() !== '' ? `rank:${analysisRank.trim()}` : null;

  useEffect(() => {
    if (!analysisItem) {
      setListingAnalysis(null);
      return;
    }

    setListingAnalysis({ analysis: null, analytics: null, loading: true, error: null });
    let cancelled = false;
    const { itemId, slug } = analysisItem;

    // Debounced: both calls run at Instant priority on the WFM scheduler, and the variant key
    // changes on every keystroke in the rank field — without the delay, typing "15" would fire
    // full analysis rounds for rank 1 and then rank 15.
    const timeoutId = window.setTimeout(() => {
      // Fire analytics in background — fills in market snapshot once it arrives.
      // Analytics failure is non-fatal; the main analysis section still renders.
      void getItemAnalytics(itemId ?? 0, slug, analysisVariantKey, sellerMode, '48h', '1h')
        .then((analytics) => {
          if (!cancelled) {
            setListingAnalysis((prev) => (prev ? { ...prev, analytics } : null));
          }
        })
        .catch(() => { /* non-fatal */ });

      // Main analysis fires at Instant priority — panel renders as soon as this resolves.
      void getItemAnalysis(itemId ?? 0, slug, analysisVariantKey, sellerMode)
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
      if (!current || current.price !== '') return current;
      return { ...current, price: String(recommendedAutoFillPrice) };
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

  const updateOrderFn = listingType === 'sell' ? updateWfmSellOrder : updateWfmBuyOrder;

  const handleToggleOrderVisibility = async (order: TradeSellOrder) => {
    if (!beginOrderAction(order.orderId)) {
      return;
    }
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

  const handleSetAllVisibility = async (visible: boolean) => {
    const targets = orders.filter((order) => order.visible !== visible);
    if (targets.length === 0 || visibilityActionPending) {
      return;
    }

    setVisibilityActionPending(true);
    setOverviewError(null);
    try {
      // One bulk call (PATCH /orders/group/all, scoped to this tab's order type) instead of
      // one request per order — far lighter on WFM and instant for the user.
      const latestOverview = await setWfmOrdersVisibility(visible, listingType, sellerMode);
      await applyOverview(latestOverview);
    } catch (error) {
      handleTradeActionFailure(error);
    } finally {
      setVisibilityActionPending(false);
    }
  };

  const openCreateListing = () => {
    setListingActionError(null);
    setListingAnalysis(null);
    setListingModal(createListingModalState('create', listingType, null));
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
    if (!pendingTradeListing || pendingTradeListing.orderType !== listingType) {
      return;
    }
    const request = pendingTradeListing;
    let cancelled = false;
    void (async () => {
      let item: WfmAutocompleteItem | null = null;
      try {
        const catalog = await getWfmAutocompleteItems(wfstatLangCode(useAppStore.getState().language));
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
      const base = createListingModalState('create', listingType, item);
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
  }, [pendingTradeListing, listingType, clearPendingTradeListing]);

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

  const handleMarkAsSold = async (order: TradeSellOrder) => {
    const raw = soldQuantities[order.orderId] ?? DEFAULT_MARK_SOLD_QTY;
    const quantity = Number.parseInt(raw, 10);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      setOverviewError(t('trades.markSoldWholeNumber'));
      return;
    }

    if (!beginOrderAction(order.orderId)) {
      return;
    }
    try {
      const nextOverview = await closeWfmSellOrder(
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

  const handleDeleteOrder = async (orderId: string) => {
    if (!beginOrderAction(orderId)) {
      return;
    }
    try {
      const nextOverview =
        listingType === 'sell'
          ? await deleteWfmSellOrder(orderId, sellerMode)
          : await deleteWfmBuyOrder(orderId, sellerMode);
      await applyOverview(nextOverview);
    } catch (error) {
      handleTradeActionFailure(error);
    } finally {
      endOrderAction(orderId);
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

  const orders = listingType === 'sell' ? (overview?.sellOrders ?? []) : (overview?.buyOrders ?? []);

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
          <button className="btn-primary" type="button" onClick={openCreateListing}>
            {t(listingType === 'sell' ? 'trades.hero.createSellOrder' : 'trades.hero.createBuyOrder')}
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

      {orders.length > 0 ? (
        <div className="trade-visibility-bar">
          <span className="trade-visibility-bar-label">
            {orders.filter((order) => order.visible).length}/{orders.length} {listingType} orders visible
          </span>
          <div className="trade-visibility-bar-actions">
            <button
              className="act-btn"
              type="button"
              disabled={visibilityActionPending || orders.every((order) => order.visible)}
              onClick={() => void handleSetAllVisibility(true)}
            >
              {t('trades.showAll')}
            </button>
            <button
              className="act-btn"
              type="button"
              disabled={visibilityActionPending || orders.every((order) => !order.visible)}
              onClick={() => void handleSetAllVisibility(false)}
            >
              {t('trades.hideAll')}
            </button>
          </div>
        </div>
      ) : null}

      <div className="card trade-list-card">
        {overviewLoading && !overview ? (
          <div className="empty-state">
            <span className="empty-primary">
              {t(listingType === 'sell' ? 'trades.loadingSellOrders' : 'trades.loadingBuyOrders')}
            </span>
            <span className="empty-sub">{t('trades.syncingAccount')}</span>
          </div>
        ) : null}

        {!overviewLoading || overview ? (
          <table className="listing-table">
            <thead>
              <tr>
                <th>{t('trades.col.item')}</th>
                <th>{t('pf.rank')}</th>
                <th>{t('trades.col.visible')}</th>
                <th>{t('trades.col.yourPrice')}</th>
                <th>{t('trades.col.marketLow')}</th>
                <th>{t('trades.col.priceGap')}</th>
                <th>{t('trades.col.listingHealth')}</th>
                <th>{t('trades.col.quantity')}</th>
                <th>{t('trades.col.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.orderId} className={order.visible ? undefined : 'trade-row-hidden'}>
                  <td>
                    <div className="item-cell">
                      <span className="item-thumb trade-item-thumb">
                        {resolveWfmAssetUrl(order.imagePath) ? (
                          <img src={resolveWfmAssetUrl(order.imagePath) ?? undefined} alt="" />
                        ) : (
                          <span>{order.name.slice(0, 1)}</span>
                        )}
                      </span>
                      <div>
                        <ItemName
                          className="item-name"
                          name={order.name}
                          slug={order.slug}
                          itemId={order.itemId}
                          imagePath={order.imagePath}
                        />
                        <div className="trade-cell-age">
                          {marketLowTimestamps[order.orderId]
                            ? formatMarketLowAge(marketLowTimestamps[order.orderId])
                            : listingType === 'sell'
                              ? (staleHealthIds.includes(order.orderId) ? t('trades.row.cantRefresh') : t('trades.row.refreshing'))
                              : null}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <div className="trade-cell-value">
                      {order.rank !== null && order.rank !== undefined
                        ? order.maxRank !== null && order.maxRank !== undefined && order.maxRank > 0
                          ? `${order.rank}/${order.maxRank}`
                          : order.rank
                        : <span className="trade-cell-pending">—</span>}
                    </div>
                  </td>
                  <td>
                    <button
                      type="button"
                      className={`trade-row-visibility${order.visible ? ' on' : ' off'}`}
                      disabled={visibilityActionPending || isOrderPending(order.orderId)}
                      onClick={() => void handleToggleOrderVisibility(order)}
                      title={order.visible ? t('trades.row.titleVisible') : t('trades.row.titleHidden')}
                      aria-label={order.visible ? t('trades.row.ariaHide') : t('trades.row.ariaShow')}
                    >
                      {order.visible ? t('trades.row.visible') : t('trades.row.hidden')}
                    </button>
                  </td>
                  <td>
                    <div className="trade-cell-value">{formatPlatinumValue(order.yourPrice)}</div>
                  </td>
                  <td>
                    <div className="trade-cell-value">
                      {order.marketLow !== null && order.marketLow !== undefined
                        ? formatPlatinumValue(order.marketLow)
                        : <span className="trade-cell-pending">—</span>}
                    </div>
                  </td>
                  <td>
                    <div className={`trade-cell-value ${getGapClassName(order.priceGap)}`}>
                      {order.marketLow !== null && order.marketLow !== undefined
                        ? formatGap(order.priceGap)
                        : <span className="trade-cell-pending">—</span>}
                    </div>
                  </td>
                  <td>
                    {listingType === 'sell' ? (
                      <div className="trade-health-stack">
                        <span className={`market-panel-badge ${getTradeHealthToneClass(order.health?.tone ?? 'amber')}`}>
                          {order.health ? tHealth(t, order.health.label) : t('trades.row.building')}
                        </span>
                        <span className="health-note">
                          {order.health
                            ? `${tHealth(t, order.health.actionLabel)} · ${tHealth(t, order.health.outlookLabel)}`
                            : t('trades.row.refreshingContext')}
                        </span>
                      </div>
                    ) : (
                      <span className="trade-cell-pending">—</span>
                    )}
                  </td>
                  <td>
                    <div className="trade-cell-value">{order.quantity}</div>
                  </td>
                  <td>
                    <div className="actions-cell trade-actions-cell">
                      {listingType === 'sell' ? (
                        <div className="trade-sold-action">
                          <input
                            className="qty-input"
                            type="number"
                            min={1}
                            max={order.quantity}
                            aria-label={t('trades.row.markSoldAria', { name: order.name })}
                            value={soldQuantities[order.orderId] ?? DEFAULT_MARK_SOLD_QTY}
                            onChange={(event) =>
                              setSoldQuantities((current) => ({
                                ...current,
                                [order.orderId]: event.target.value,
                              }))
                            }
                          />
                          <button
                            className="act-btn"
                            type="button"
                            disabled={isOrderPending(order.orderId)}
                            onClick={() => void handleMarkAsSold(order)}
                          >
                            {isOrderPending(order.orderId) ? t('trades.row.working') : t('trades.row.markSold')}
                          </button>
                        </div>
                      ) : null}
                      <button
                        className="act-btn"
                        type="button"
                        disabled={isOrderPending(order.orderId)}
                        onClick={() => openEditListing(order)}
                      >{t('trades.row.edit')}</button>
                      <button
                        className="act-btn danger"
                        type="button"
                        disabled={isOrderPending(order.orderId)}
                        onClick={() => void handleDeleteOrder(order.orderId)}
                      >{t('trades.row.remove')}</button>
                    </div>
                  </td>
                </tr>
              ))}

              {overview && orders.length === 0 ? (
                <tr>
                  <td colSpan={8}>
                    <div className="empty-state">
                      <span className="empty-primary">
                        {t(listingType === 'sell' ? 'trades.noSellOrders' : 'trades.noBuyOrders')}
                      </span>
                      <span className="empty-sub">
                        {t(listingType === 'sell' ? 'trades.createSellHint' : 'trades.createBuyHint')}
                      </span>
                    </div>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        ) : null}
      </div>

      {sessionExpiredPopupOpen ? (
        <ModalPortal>
        <div className="modal-backdrop" role="presentation">
          <div
            ref={sessionExpiredRef}
            className="settings-modal trade-session-expired-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="trade-session-expired-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="settings-modal-header">
              <div className="settings-modal-title">
                <span className="card-label">{t('trades.title')}</span>
                <h3 id="trade-session-expired-title">{t('trades.sessionExpired')}</h3>
              </div>
              <button
                className="settings-close-btn"
                type="button"
                onClick={() => setSessionExpiredPopupOpen(false)}
                aria-label={t('a11y.closeSessionExpired')}
              >
                ×
              </button>
            </div>
            <div className="settings-modal-body">
              <p className="trade-session-expired-copy">
                {t('trades.sessionExpiredCopy')}
              </p>
            </div>
            <div className="settings-modal-actions">
              <button
                className="btn-secondary"
                type="button"
                onClick={() => setSessionExpiredPopupOpen(false)}
              >
                {t('a11y.dismiss')}
              </button>
              <button
                className="btn-primary"
                type="button"
                onClick={() => {
                  setSessionExpiredPopupOpen(false);
                  // Clear the dead session so the sign-in panel takes over immediately.
                  void signOutTradeAccount().catch(() => undefined);
                }}
              >
                {t('trades.signInAgain')}
              </button>
            </div>
          </div>
        </div>
        </ModalPortal>
      ) : null}

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
  const setTradesSubTab = useAppStore((s) => s.setTradesSubTab);
  const { t } = useTranslation();

  useEffect(() => {
    void loadTradeAccount();
  }, [loadTradeAccount]);

  return (
    <>
      <div className="subnav trades-page-subnav">
        <div className="subnav-left">
          <span className="page-title">{t('trades.title')}</span>
          <div className="subnav-tabs" role="tablist" aria-label={t('trades.sections')}>
            <button
              type="button"
              className={`subtab${tradesSubTab === 'sell-orders' ? ' active' : ''}`}
              onClick={() => setTradesSubTab('sell-orders')}
              role="tab"
              aria-selected={tradesSubTab === 'sell-orders'}
            >
              {t('trades.tab.sell')}
            </button>
            <button
              type="button"
              className={`subtab${tradesSubTab === 'buy-orders' ? ' active' : ''}`}
              onClick={() => setTradesSubTab('buy-orders')}
              role="tab"
              aria-selected={tradesSubTab === 'buy-orders'}
            >
              {t('trades.tab.buy')}
            </button>
            <button
              type="button"
              className={`subtab${tradesSubTab === 'health' ? ' active' : ''}`}
              onClick={() => setTradesSubTab('health')}
              role="tab"
              aria-selected={tradesSubTab === 'health'}
            >
              {t('trades.tab.health')}
            </button>
          </div>
        </div>
        {tradeAccount && (tradesSubTab === 'sell-orders' || tradesSubTab === 'buy-orders') ? (
          <div className="subnav-right">
            <span className="trade-subnav-hint">
              {t(tradesSubTab === 'sell-orders' ? 'trades.subnav.liveSell' : 'trades.subnav.liveBuy')}
            </span>
          </div>
        ) : null}
      </div>
      <div className="page-content trades-page-content">
        {!tradeAccount ? (
          <SignInPanel />
        ) : (
          <>
            {tradesSubTab === 'sell-orders' && <ListingsTab listingType="sell" />}
            {tradesSubTab === 'buy-orders' && <ListingsTab listingType="buy" />}
            {tradesSubTab === 'health' && <HealthTab />}
          </>
        )}
      </div>
    </>
  );
}
