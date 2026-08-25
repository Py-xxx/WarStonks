import { useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import {
  cacheOrderHealth,
  marketLowCache,
  marketLowKey,
  tradeHealthCache,
  tradeOverviewCache,
  tradeOverviewLoadPromises,
} from '../../lib/tradeCache';
import { useSmartManageStates } from '../../hooks/useSmartManageStates';
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
import { formatPlatinumValue, formatTradeStatusLabel, tradeStatusTone } from '../../lib/trades';
import { rankWfmAutocompleteItems } from '../../lib/wfmAutocomplete';
import { resolveWfmAssetUrl } from '../../lib/wfmAssets';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Panel, PanelHeader, PanelTitle } from '@/components/ui/panel';
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Stat } from '@/components/ui/stat';
import { Switch } from '@/components/ui/switch';
import wfmLogo from '../../assets/branding/warframe-market.png';
import { ItemThumb } from '../../components/ListRow';
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
  if (normalized === 'green') return 'text-accent-green';
  if (normalized === 'blue') return 'text-accent-blue';
  if (normalized === 'red') return 'text-accent-red';
  return 'text-accent-amber';
}

/** `getGapClassName`'s three outcomes, on tokens. A positive gap means you are above market,
 *  which is the bad direction for a seller — the mapping is deliberately not "positive = green". */
const GAP_TONE_CLASS: Record<string, string> = {
  good: 'text-accent-green',
  bad: 'text-accent-red',
  neutral: 'text-ink-dim',
};

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

/** The two label scales inside the listing dialog and the Smart Manage popover: a 9px mono
 *  section marker, and a 10px mono field label. One definition each, shared by both columns. */
const SECTION_LABEL = 'font-mono text-[9px] font-semibold tracking-[0.1em] text-ink-dim uppercase';
const FIELD_LABEL = 'font-mono text-[10px] tracking-[0.08em] text-ink-dim uppercase';

/**
 * Per-listing Smart Manage strategy. A cheap fast-moving part and an expensive slow set want
 * different behaviour, so each listing can override the global preset and pin hard price bounds.
 * Empty fields inherit / mean "no bound" — nothing here is required.
 *
 * The chip and the panel are one component because the chip's only job is to show and open this
 * state. It replaced a portal positioned by `useAnchoredPopover`: `Popover` portals and runs its
 * own collision detection, so a row at the bottom of a long scrolling list flips correctly with
 * no measuring code of ours — and the popover's dismissal comes with it.
 *
 * Purple throughout: Smart Manage owns purple across the app (`ELEMENTS.md` §5).
 */
function SmartManageControl({
  initial,
  enabled,
  onToggleEnabled,
  onSave,
}: {
  initial: SmartListingOverrides;
  enabled: boolean;
  onToggleEnabled: () => void;
  onSave: (next: SmartListingOverrides) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<SmartListingOverrides>(initial);
  const [error, setError] = useState<string | null>(null);

  // The draft is seeded when the popover opens, not on every render: `overridesFor` builds a new
  // object each call, so an effect keyed on `initial` would reset the user's typing on every poll.
  const handleOpenChange = (next: boolean) => {
    if (next) {
      setDraft(initial);
      setError(null);
    }
    setOpen(next);
  };

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
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            static
            title={t('smart.perListingTitle')}
            aria-label={t('smart.perListingTitle')}
            className={`ml-auto h-6 shrink-0 gap-1 border px-1.5 font-mono text-[10px] tracking-[0.06em] uppercase ${
              enabled
                ? 'border-accent-purple/45 bg-accent-purple/12 text-accent-purple hover:bg-accent-purple/20'
                : 'border-line-strong text-ink-dim hover:text-ink'
            }`}
          />
        }
      >
        <i className="ti ti-robot text-[11px]" aria-hidden="true" />
        {t('smart.auto')}
      </PopoverTrigger>

      <PopoverContent
        side="bottom"
        align="end"
        className="flex w-64 flex-col gap-3 p-3"
        aria-label={t('smart.perListingTitle')}
      >
        <span className="text-xs font-semibold text-ink">{t('smart.perListingTitle')}</span>

        <label className="flex cursor-pointer items-center justify-between gap-2">
          <span className="text-[11px] font-medium text-ink-soft">{t('smart.enableAuto')}</span>
          <Switch tone="accent" checked={enabled} onCheckedChange={onToggleEnabled} />
        </label>

        <div className="flex flex-col gap-1.5">
          <span className={FIELD_LABEL}>{t('smart.aggressiveness')}</span>
          <Select
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
          </Select>
        </div>

        <div className="grid grid-cols-2 gap-2">
          {(
            [
              ['minPrice', t('smart.minPrice')],
              ['maxPrice', t('smart.maxPrice')],
            ] as const
          ).map(([key, label]) => (
            <div key={key} className="flex min-w-0 flex-col gap-1.5">
              <span className={FIELD_LABEL}>{label}</span>
              <span className="relative flex items-center">
                <Input
                  type="number"
                  min={1}
                  inputMode="numeric"
                  className="h-7 pr-6 tabular-nums"
                  value={draft[key] ?? ''}
                  placeholder={t('smart.noBound')}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, [key]: parseBound(event.target.value) }))
                  }
                />
                <span className="pointer-events-none absolute right-2 font-mono text-[10px] text-ink-dim">
                  p
                </span>
              </span>
            </div>
          ))}
        </div>

        {error ? <p className="text-[11px] text-accent-red">{error}</p> : null}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            {t('trades.modal.cancel')}
          </Button>
          <Button size="sm" onClick={handleSave}>
            {t('common.save')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
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

function getLiquidityBadgeClass(label: string): 'good' | 'bad' | 'neutral' {
  const l = label.toLowerCase();
  if (l.includes('high') || l.includes('active') || l.includes('good') || l.includes('strong')) return 'good';
  if (l.includes('low') || l.includes('poor') || l.includes('weak')) return 'bad';
  return 'neutral';
}

function getZoneQualityClass(quality: string): 'good' | 'bad' | 'neutral' {
  const q = quality.toLowerCase();
  if (q.includes('high') || q.includes('strong') || q.includes('good') || q.includes('great')) return 'good';
  if (q.includes('poor') || q.includes('weak') || q.includes('low')) return 'bad';
  return 'neutral';
}

function getTrendClass(direction: string): 'good' | 'bad' | 'neutral' {
  const d = direction.toLowerCase();
  if (d === 'up' || d === 'rising') return 'good';
  if (d === 'down' || d === 'falling' || d === 'declining') return 'bad';
  return 'neutral';
}

/** One section of either column of the listing dialog: a mono micro-label over its content. */
function FormSection({
  title,
  className,
  children,
}: {
  title: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`flex flex-col gap-2.5 px-4 py-3.5 ${className ?? ''}`}>
      <h3 className={SECTION_LABEL}>{title}</h3>
      {children}
    </section>
  );
}

/** A labelled control. `htmlFor` is omitted for the toggle, which labels itself. */
function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {htmlFor ? (
        <label className={FIELD_LABEL} htmlFor={htmlFor}>
          {label}
        </label>
      ) : (
        <span className={FIELD_LABEL}>{label}</span>
      )}
      {children}
      {hint ? <span className="text-[10px] leading-snug text-ink-dim">{hint}</span> : null}
    </div>
  );
}

/** Plain coloured uppercase text, not a pill — the status-label treatment from `ELEMENTS.md` §4. */
function AnalysisTag({ tone, children }: { tone: 'good' | 'bad' | 'neutral'; children: React.ReactNode }) {
  return (
    <span
      className={`font-mono text-[9px] font-semibold tracking-[0.08em] uppercase ${
        tone === 'good' ? 'text-accent-green' : tone === 'bad' ? 'text-accent-red' : 'text-ink-dim'
      }`}
    >
      {children}
    </span>
  );
}

function AnalysisKeyValue({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="shrink-0 font-mono text-[10px] tracking-[0.04em] text-ink-dim">{label}</span>
      <span className="text-right font-mono text-[11px] tabular-nums text-ink">{value}</span>
    </div>
  );
}

function ListingAnalysisPanel({ analysis, analytics, loading, error, orderType }: {
  analysis: ItemAnalysisResponse | null;
  analytics: ItemAnalyticsResponse | null;
  loading: boolean;
  error: string | null;
  orderType: 'sell' | 'buy';
}) {
  const { t } = useTranslation();

  const header = (freshness?: string) => (
    <header className="flex items-baseline justify-between gap-2 border-b border-line px-4 py-3">
      <h2 className="font-mono text-xs font-semibold tracking-[0.06em] text-ink-soft uppercase">
        {t('trades.analysis.title')}
      </h2>
      {freshness ? (
        <span className="font-mono text-[10px] tracking-[0.04em] text-ink-dim uppercase">
          {freshness}
        </span>
      ) : null}
    </header>
  );

  if (loading) {
    // The shape is known, so it is a skeleton, not the three bouncing dots this replaced — and
    // it is laid out like the real panel so nothing moves when the data lands.
    return (
      <div className="flex min-w-0 flex-col">
        {header()}
        <div className="flex flex-col gap-4 px-4 py-4">
          <Skeleton type="heading, text" leafClassName="first:h-8" />
          <Skeleton type="text@2" />
          <Skeleton type="text@3" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-w-0 flex-col">
        {header()}
        <p className="px-4 py-3 text-[11px] leading-relaxed text-accent-red">{error}</p>
      </div>
    );
  }

  if (!analysis) {
    return (
      <div className="flex min-w-0 flex-col">
        {header()}
        <EmptyState
          className="py-10"
          icon="ti-chart-histogram"
          title={t('trades.analysis.idle', {
            kind: t(orderType === 'buy' ? 'trades.analysis.entryPrice' : 'trades.analysis.exitPrice'),
          })}
        />
      </div>
    );
  }

  const { headline, liquidityDetail, trend } = analysis;
  const snapshot = analytics?.currentSnapshot ?? null;
  const pressure = analytics?.orderbookPressure ?? null;
  const zones = analytics?.entryExitZoneOverview ?? null;
  const heroPrice = orderType === 'buy' ? headline.entryPrice : headline.exitPrice;
  const zoneLow = orderType === 'buy' ? zones?.entryZoneLow : zones?.exitZoneLow;
  const zoneHigh = orderType === 'buy' ? zones?.entryZoneHigh : zones?.exitZoneHigh;
  const zoneRationale = orderType === 'buy' ? zones?.entryRationale : zones?.exitRationale;

  return (
    <div className="flex min-w-0 flex-col divide-y divide-line-subtle">
      {header(analysis.variantLabel)}

      {/* The one figure this column exists to deliver. `Stat`, stripped of its own frame so it
          reads as a band across the top of the column rather than a card inside it. */}
      <div className="bg-accent-green/[0.04]">
        <Stat
          className="gap-2 rounded-none border-0 bg-transparent px-4 py-3.5"
          icon="ti-target"
          tone="positive"
          label={orderType === 'buy' ? t('trades.analysis.recommendedEntry') : t('trades.analysis.recommendedExit')}
          value={heroPrice !== null ? formatPlatinumValue(heroPrice) : '—'}
        />
        {orderType === 'sell' && headline.exitPercentileLabel ? (
          <p className="px-4 pb-3 text-[10px] text-ink-dim">{headline.exitPercentileLabel}</p>
        ) : null}
      </div>

      <FormSection title={t('trades.analysis.liquidity')}>
        <div className="flex items-center gap-2">
          <span className="font-mono text-lg font-semibold tabular-nums text-ink">
            {headline.liquidityScore !== null ? Math.round(headline.liquidityScore) : '—'}
          </span>
          <AnalysisTag tone={getLiquidityBadgeClass(headline.liquidityLabel)}>
            {tHealth(t, headline.liquidityLabel)}
          </AnalysisTag>
        </div>
        {liquidityDetail.state ? (
          <p className="text-[10px] leading-relaxed text-ink-dim">{liquidityDetail.state}</p>
        ) : null}
      </FormSection>

      {snapshot || pressure ? (
        <FormSection title={t('trades.analysis.snapshot')} className="gap-1.5">
          {snapshot?.lowestSell !== null && snapshot?.lowestSell !== undefined ? (
            <AnalysisKeyValue
              label={t('trades.analysis.floor')}
              value={formatPlatinumValue(snapshot.lowestSell)}
            />
          ) : null}
          {pressure?.spread !== null && pressure?.spread !== undefined ? (
            <AnalysisKeyValue
              label={t('trades.analysis.spread')}
              value={`${formatPlatinumValue(pressure.spread)}${
                pressure.spreadPct !== null ? ` (${pressure.spreadPct.toFixed(1)}%)` : ''
              }`}
            />
          ) : null}
          {pressure?.pressureLabel ? (
            <AnalysisKeyValue
              label={t('trades.analysis.pressure')}
              value={tHealth(t, pressure.pressureLabel)}
            />
          ) : null}
        </FormSection>
      ) : null}

      {zoneLow !== null && zoneLow !== undefined && zoneHigh !== null && zoneHigh !== undefined ? (
        <FormSection title={orderType === 'buy' ? t('trades.analysis.entryZone') : t('trades.analysis.exitZone')}>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[13px] font-semibold tabular-nums text-ink">
              {formatPlatinumValue(zoneLow)} – {formatPlatinumValue(zoneHigh)}
            </span>
            <AnalysisTag tone={getZoneQualityClass(zones?.zoneQuality ?? '')}>
              {zones?.zoneQuality}
            </AnalysisTag>
          </div>
          {zoneRationale ? (
            <p className="text-[10px] leading-relaxed text-ink-dim">{zoneRationale}</p>
          ) : null}
        </FormSection>
      ) : null}

      <FormSection title={t('trades.analysis.trend')}>
        <div className="flex items-center gap-2">
          <span
            className={`font-mono text-xs font-semibold capitalize ${
              getTrendClass(trend.direction) === 'good'
                ? 'text-accent-green'
                : getTrendClass(trend.direction) === 'bad'
                  ? 'text-accent-red'
                  : 'text-ink-soft'
            }`}
          >
            {getTrendArrow(trend.direction)} {tHealth(t, trend.direction)}
          </span>
          {trend.confidence !== null ? (
            <span className="font-mono text-[10px] tabular-nums text-ink-dim">
              {t('trades.analysis.confPct', { pct: Math.round(trend.confidence) })}
            </span>
          ) : null}
        </div>
        {trend.summary ? (
          <p className="text-[10px] leading-relaxed text-ink-dim italic">{tTrendSummary(t, trend)}</p>
        ) : null}
      </FormSection>
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

/** 58px, `cover` not `contain` — this is a user's profile picture, not item art. */
const AVATAR_CLASS =
  'grid size-[58px] shrink-0 place-items-center overflow-hidden rounded-xl border border-line bg-bg-elevated';

function TradeAvatar({ imageUrl, name }: { imageUrl: string | null; name: string }) {
  if (imageUrl) {
    return (
      <span className={AVATAR_CLASS}>
        <img src={imageUrl} alt="" className="size-full object-cover" />
      </span>
    );
  }

  return (
    <span className={`${AVATAR_CLASS} font-mono text-lg font-bold text-ink`}>
      {initialsForName(name)}
    </span>
  );
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
      {/* A fixed height, not a `max-h`: the analysis column fills in asynchronously, and a dialog
          that grows under the cursor while you are typing a price is worse than one with space
          reserved for the panel that is coming. Taller and narrower than the first pass — the
          analysis column at 4xl was ~600px of column for values that are all under six
          characters, so the width was ornament and the height was the part in short supply. */}
      <DialogContent className="h-[min(670px,88vh)] max-w-2xl gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-line px-4 py-3">
          <DialogTitle>
            {form.mode === 'create'
              ? t(form.orderType === 'sell' ? 'trades.modal.createSell' : 'trades.modal.createBuy')
              : t(form.orderType === 'sell' ? 'trades.modal.editSell' : 'trades.modal.editBuy')}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t(form.orderType === 'sell' ? 'trades.modal.sell' : 'trades.modal.buy')}
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
          <div className="flex min-w-0 flex-col divide-y divide-line-subtle overflow-y-auto border-r border-line">
            <FormSection title={t('trades.modal.orderType')}>
              {/* The segmented group from the watchlist rows: a recessed track, the selected
                  option raised onto `bg-elevated`. Neutral by design — the title already says
                  which side this is, and green/red carry profit and loss here. */}
              <div
                className="inline-grid grid-cols-2 gap-0.5 rounded-md bg-bg-base p-0.5"
                role="group"
                aria-label={t('trades.modal.listingTypeAria')}
              >
                {(['sell', 'buy'] as TradeListingKind[]).map((type) => {
                  const active = form.orderType === type;
                  return (
                    <Button
                      key={type}
                      variant="ghost"
                      size="sm"
                      static
                      aria-pressed={active}
                      disabled={typeLocked}
                      onClick={() => onChange({ orderType: type })}
                      className={`h-7 rounded-sm font-mono text-[10px] tracking-[0.08em] uppercase ${
                        active ? 'bg-bg-elevated text-ink' : 'text-ink-dim hover:text-ink'
                      }`}
                    >
                      {type === 'sell' ? t('trades.modal.sell') : t('trades.modal.buy')}
                    </Button>
                  );
                })}
              </div>
            </FormSection>

            <FormSection title={t('trades.modal.itemSection')}>
              <Field label={t('trades.modal.itemName')} htmlFor="trade-listing-item">
                <Input
                  id="trade-listing-item"
                  value={form.itemName}
                  onChange={(event) =>
                    onChange({ itemName: event.target.value, selectedItem: null, rank: '', perTrade: '' })
                  }
                  placeholder={t('trades.searchPlaceholder')}
                  disabled={form.mode === 'edit'}
                />
              </Field>
              {form.mode === 'create' ? (
                <>
                  {!autocompleteReady && !autocompleteError ? (
                    <Skeleton type="list-item-avatar@3" leafClassName="h-6" />
                  ) : null}
                  {autocompleteError ? (
                    <p className="text-[11px] text-accent-red">{autocompleteError}</p>
                  ) : null}
                  {/* Gone once an item is chosen: selecting sets `itemName` to that item's own
                      name, which still matches the query, so the list cannot key off the text.
                      Editing the field clears `selectedItem` and brings it back. */}
                  {autocompleteReady && !form.selectedItem && suggestions.length > 0 ? (
                    <div className="flex max-h-52 flex-col overflow-y-auto rounded-md border border-line-strong bg-bg-base p-1">
                      {suggestions.map((item) => (
                        <Button
                          key={item.wfmId ?? item.slug}
                          variant="ghost"
                          size="sm"
                          static
                          onClick={() => onSelectItem(item)}
                          className="h-auto justify-start gap-2 px-1.5 py-1 text-left"
                        >
                          <span className="grid size-6 shrink-0 place-items-center overflow-hidden rounded-sm bg-bg-elevated font-mono text-[10px] text-ink-dim">
                            {resolveWfmAssetUrl(item.imagePath, item.slug) ? (
                              <img
                                className="size-full object-contain"
                                src={resolveWfmAssetUrl(item.imagePath, item.slug) ?? undefined}
                                alt=""
                              />
                            ) : (
                              item.name.slice(0, 1)
                            )}
                          </span>
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate text-[11px] text-ink">{item.name}</span>
                            <span className="truncate text-[10px] font-normal text-ink-dim">
                              {item.itemFamily ?? t('trades.modal.itemFamilyFallback')}
                            </span>
                          </span>
                        </Button>
                      ))}
                    </div>
                  ) : null}
                </>
              ) : null}
            </FormSection>

            <FormSection title={t('trades.modal.listingDetails')} className="flex-1">
              <div className="grid grid-cols-2 gap-x-3 gap-y-3">
                <Field label={t('trades.modal.price')} htmlFor="trade-listing-price">
                  <Input
                    id="trade-listing-price"
                    className="tabular-nums"
                    type="number"
                    min={1}
                    step={1}
                    value={form.price}
                    onChange={(event) => onChange({ price: event.target.value, priceTouched: true })}
                    placeholder={t('trades.pricePlaceholder')}
                  />
                </Field>
                <Field label={t('trades.col.quantity')} htmlFor="trade-listing-quantity">
                  <Input
                    id="trade-listing-quantity"
                    className="tabular-nums"
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
                </Field>
                {rankApplicable ? (
                  <Field label={t('trades.modal.rank')} htmlFor="trade-listing-rank">
                    <Select
                      id="trade-listing-rank"
                      className="h-8 tabular-nums"
                      value={form.rank}
                      onChange={(event) => onChange({ rank: event.target.value })}
                    >
                      {Array.from({ length: (form.selectedItem?.maxRank ?? 0) + 1 }, (_, index) => (
                        <option key={index} value={String(index)}>
                          {index}
                        </option>
                      ))}
                    </Select>
                  </Field>
                ) : null}
                {form.mode === 'create' && subtypeOptions.length > 1 ? (
                  <Field label={t('trades.modal.subtype')} htmlFor="trade-listing-subtype">
                    <Select
                      id="trade-listing-subtype"
                      className="h-8"
                      value={form.subtype || subtypeOptions[0]}
                      onChange={(event) => onChange({ subtype: event.target.value })}
                    >
                      {subtypeOptions.map((subtype) => (
                        <option key={subtype} value={subtype}>
                          {tSubtype(t, subtype)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                ) : null}
                {bulkApplicable ? (
                  <Field
                    label={t('trades.modal.perTrade')}
                    htmlFor="trade-listing-per-trade"
                    hint={t('trades.modal.bulkHint')}
                  >
                    <Select
                      id="trade-listing-per-trade"
                      className="h-8 tabular-nums"
                      value={form.perTrade || '1'}
                      onChange={(event) => onChange({ perTrade: event.target.value })}
                    >
                      {ptOptions.map((value) => (
                        <option key={value} value={String(value)}>
                          {value}
                        </option>
                      ))}
                    </Select>
                  </Field>
                ) : null}
                <Field label={t('trades.modal.visibility')}>
                  <label className="flex h-8 cursor-pointer items-center gap-2">
                    <Switch
                      tone="positive"
                      checked={form.visible}
                      onCheckedChange={(visible) => onChange({ visible })}
                    />
                    <span className="text-xs font-medium text-ink">
                      {form.visible ? t('common.on') : t('common.off')}
                    </span>
                  </label>
                </Field>
              </div>
              {errorMessage ? <p className="text-[11px] text-accent-red">{errorMessage}</p> : null}
            </FormSection>
          </div>

          <div className="min-w-0 overflow-y-auto">
            <ListingAnalysisPanel
              analysis={analysis?.analysis ?? null}
              analytics={analysis?.analytics ?? null}
              loading={analysis?.loading ?? false}
              error={analysis?.error ?? null}
              orderType={form.orderType}
            />
          </div>
        </div>

        <DialogFooter className="border-t border-line px-4 py-3">
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

/**
 * The sign-in screen — a **design pass** (`ELEMENTS.md` §1), not a migration. It was a 520px
 * bordered rectangle with a 24px heading, a 34-word paragraph and a right-aligned button, and it
 * had not been touched since long before the primitives existed.
 *
 * What changed and why:
 * - **It is the only thing on screen, so it gets the view's one Expressive moment** — a soft accent
 *   bloom behind the mark. One per view is the budget (`SKILL.md`), and this view has nothing else
 *   competing for it.
 * - Narrower (400px) and centred rather than 520px of half-empty card. A login form is two fields;
 *   width was making it look like there was more to fill in than there is.
 * - The paragraph explained how the integration works internally. Deleted, per `ui-copy`'s delete
 *   test, and replaced with the one fact a user actually needs before typing a password into a
 *   third-party app: where that password goes.
 * - **A show/hide control on the password.** Desktop, long password, no second chance before the
 *   request goes out — this is the one place the app should let you check what you typed. It reuses
 *   the `EyeIcon`/`EyeOffIcon` already in this file rather than risking a Tabler glyph that is not
 *   in the bundled subset.
 * - `Switch` for "stay signed in", `Input` for the fields, a full-width primary `Button`.
 * - Enter submits from either field, not just the password one.
 */
function SignInPanel() {
  const { t } = useTranslation();
  const tradeAccountLoading = useAppStore((s) => s.tradeAccountLoading);
  const tradeAccountError = useAppStore((s) => s.tradeAccountError);
  const signInTradeAccount = useAppStore((s) => s.signInTradeAccount);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordVisible, setPasswordVisible] = useState(false);
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

  const submitOnEnter = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter') {
      void handleSubmit();
    }
  };

  const error = localError ?? tradeAccountError;

  return (
    <div className="grid min-h-[60vh] place-items-center">
      <Panel className="relative w-full max-w-[400px] overflow-hidden p-6">
        {/* The one Expressive moment in this view. Purely decorative, so it is hidden from the
            accessibility tree and takes no pointer events. */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -top-20 left-1/2 h-40 w-64 -translate-x-1/2 rounded-full bg-accent-blue/15 blur-3xl"
        />

        <div className="relative flex flex-col gap-5">
          <div className="flex flex-col items-center gap-3 text-center">
            {/* The real warframe.market mark, not a stand-in glyph. No chrome around it — it is
                artwork on transparency, and a box drawn around a logo reads as a chip. */}
            <img
              src={wfmLogo}
              alt=""
              className="size-12 shrink-0 object-contain"
              aria-hidden="true"
            />
            <div className="flex flex-col gap-1">
              {/* Lowercase and untracked on purpose: it is a domain, and `uppercase` would render
                  it WARFRAME.MARKET. Text inherits `text-transform` — see the handoff's traps. */}
              <span className="font-mono text-[15px] font-semibold text-ink normal-case">
                {t('trades.auth.brand')}
              </span>
              <h2 className="text-xs font-medium text-ink-dim">{t('trades.auth.title')}</h2>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <Field label={t('trades.auth.email')} htmlFor="trade-signin-email">
              <Input
                id="trade-signin-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                onKeyDown={submitOnEnter}
                placeholder={t('trades.auth.emailPlaceholder')}
              />
            </Field>

            <Field label={t('trades.auth.password')} htmlFor="trade-signin-password">
              <span className="relative flex items-center">
                <Input
                  id="trade-signin-password"
                  className="pr-8"
                  type={passwordVisible ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  onKeyDown={submitOnEnter}
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  static
                  className="absolute right-0.5 size-7 [&_svg]:size-4"
                  aria-label={t(passwordVisible ? 'trades.auth.hidePassword' : 'trades.auth.showPassword')}
                  title={t(passwordVisible ? 'trades.auth.hidePassword' : 'trades.auth.showPassword')}
                  onClick={() => setPasswordVisible((current) => !current)}
                >
                  {passwordVisible ? <EyeOffIcon /> : <EyeIcon />}
                </Button>
              </span>
            </Field>
          </div>

          <label className="flex cursor-pointer items-center justify-between gap-2">
            <span className="text-xs text-ink-soft">{t('trades.auth.stayLoggedIn')}</span>
            <Switch tone="positive" checked={stayLoggedIn} onCheckedChange={setStayLoggedIn} />
          </label>

          {error ? (
            <p className="flex items-start gap-2 rounded-md border border-accent-red/25 bg-accent-red/8 px-2.5 py-2 text-[11px] leading-relaxed text-accent-red">
              <i className="ti ti-alert-triangle mt-px shrink-0 text-sm" aria-hidden="true" />
              {error}
            </p>
          ) : null}

          <div className="flex flex-col gap-3">
            <Button
              className="w-full"
              onClick={() => void handleSubmit()}
              disabled={tradeAccountLoading}
            >
              {tradeAccountLoading ? t('trades.auth.connecting') : t('trades.auth.connect')}
            </Button>
            <p className="text-center text-[10px] leading-relaxed text-ink-dim">
              {t('trades.auth.privacy')}
            </p>
          </div>
        </div>
      </Panel>
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
    const applyLabel = t('trades.row.applyAction', {
      action: tHealth(t, order.health?.actionLabel) || t('trades.health.apply'),
      price: formatPlatinumValue(recommendedPrice ?? 0),
    });
    return (
      <div
        key={order.orderId}
        className="grid grid-cols-[minmax(0,1.5fr)_92px_52px_128px] items-center gap-2 border-b border-line px-3 py-2 last:border-b-0"
      >
        {/* Only the data columns dim for a hidden listing — never the actions, or the popover
            menu (a child of the row) would inherit the opacity and become un-clickable. */}
        <div className={`flex min-w-0 items-center gap-2 ${order.visible ? '' : 'opacity-50'}`}>
          {/* The thumbnail doubles as the visibility toggle: hovering fades the art out to an eye.
              `group` + `peer`-free because both layers are inside this one button. */}
          <Button
            variant="ghost"
            size="icon"
            static
            disabled={pending}
            title={order.visible ? t('trades.row.hideListing') : t('trades.row.showListing')}
            aria-label={order.visible ? t('trades.row.hideListing') : t('trades.row.showListing')}
            onClick={() => void handleToggleOrderVisibility(order)}
            className="group relative size-8 p-0"
          >
            <span className="transition-opacity duration-150 ease-out group-hover:opacity-12 group-focus-visible:opacity-12">
              <ItemThumb
                src={resolveWfmAssetUrl(order.imagePath, order.slug)}
                fallback={order.name.slice(0, 1)}
                size="size-8"
              />
            </span>
            <span
              className="absolute inset-0 grid place-items-center rounded-md bg-bg-base/60 text-ink opacity-0 transition-opacity duration-150 ease-out group-hover:opacity-100 group-focus-visible:opacity-100"
              aria-hidden="true"
            >
              {order.visible ? <EyeIcon /> : <EyeOffIcon />}
            </span>
          </Button>
          <div className="min-w-0 flex-1">
            <ItemName
              className="block truncate text-xs font-semibold text-ink"
              name={order.name}
              slug={order.slug}
              itemId={order.itemId}
              imagePath={order.imagePath}
            />
            <span className="block truncate text-[10px] text-ink-dim">
              {order.maxRank !== null && order.maxRank !== undefined && order.maxRank > 0
                ? `${order.rank ?? 0}/${order.maxRank} · `
                : null}
              ×{order.quantity}
              {!order.visible ? ` · ${t('trades.row.hidden').toLowerCase()}` : null}
              {order.health ? (
                <span className={getTradeHealthToneClass(order.health.tone)}>
                  {' · '}{tHealth(t, order.health.label)}
                </span>
              ) : null}
              {eta ? <span className="text-accent-blue">{' · '}{eta}</span> : null}
              {order.health?.wouldRealizeLoss ? (
                <span className="text-accent-red">{' · '}{t('trades.health.wouldLose')}</span>
              ) : null}
              {type === 'sell' ? (
                <span>
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
            <SmartManageControl
              initial={smartStates.overridesFor(order.wfmId, order.rank)}
              enabled={smartStates.isManaged(order.wfmId, order.rank)}
              onToggleEnabled={() => void smartStates.toggle(order.wfmId, order.rank)}
              onSave={(next) => {
                void smartStates.saveOverrides(order.wfmId, order.rank, next);
              }}
            />
          ) : null}
        </div>
        <span className={`font-mono text-xs whitespace-nowrap tabular-nums ${order.visible ? '' : 'opacity-50'}`}>
          {formatPlatinumValue(order.yourPrice)}
          <span className="text-ink-dim">
            {' / '}
            {order.marketLow !== null && order.marketLow !== undefined
              ? formatPlatinumValue(order.marketLow)
              : '—'}
          </span>
        </span>
        <span
          className={`font-mono text-xs tabular-nums ${order.visible ? '' : 'opacity-50'} ${GAP_TONE_CLASS[getGapClassName(order.priceGap)]}`}
        >
          {order.marketLow !== null && order.marketLow !== undefined ? formatGap(order.priceGap) : '—'}
        </span>
        {/* The segmented icon group from the watchlist rows: every action is always present and
            an unavailable one is disabled, never removed, so the column keeps one width down the
            list. Apply used to disappear when there was nothing to apply, which moved the other
            three buttons on every row that had a recommendation. */}
        <span className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            static
            disabled={pending || !canApplyPrice}
            className="size-6.5 border border-accent-amber/40 bg-accent-amber/8 text-accent-amber hover:bg-accent-amber/16 hover:text-accent-amber"
            title={applyLabel}
            aria-label={applyLabel}
            onClick={() => void handleApplyRecommended(order)}
          >
            <BoltIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            static
            disabled={pending}
            className="size-6.5 border border-accent-green/35 text-accent-green hover:bg-accent-green/12 hover:text-accent-green"
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
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            static
            disabled={pending}
            className="size-6.5 border border-line-strong"
            title={t('trades.row.edit')}
            aria-label={t('trades.row.edit')}
            onClick={() => openEditListing(order)}
          >
            <PencilIcon />
          </Button>
          {/* Was a hand-rolled absolute panel plus a document `mousedown` listener, inside a row
              in a scrolling list. `Popover` portals it and handles dismissal. */}
          <Popover>
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  static
                  disabled={pending}
                  className="size-6.5 border border-line-strong data-[popup-open]:bg-bg-elevated data-[popup-open]:text-ink"
                  title={t('trades.row.more')}
                  aria-label={t('trades.row.more')}
                />
              }
            >
              <DotsIcon />
            </PopoverTrigger>
            <PopoverContent side="bottom" align="end" className="w-40">
              <PopoverClose
                render={
                  <Button
                    variant="ghost"
                    size="sm"
                    static
                    className="w-full justify-start"
                    onClick={() => void handleToggleOrderVisibility(order)}
                  />
                }
              >
                {order.visible ? t('trades.row.ariaHide') : t('trades.row.ariaShow')}
              </PopoverClose>
              <PopoverClose
                render={
                  <Button
                    variant="ghost"
                    size="sm"
                    static
                    className="w-full justify-start text-accent-red hover:bg-accent-red/12 hover:text-accent-red"
                    onClick={() => void handleDeleteOrder(order)}
                  />
                }
              >
                {t('trades.row.remove')}
              </PopoverClose>
            </PopoverContent>
          </Popover>
        </span>
      </div>
    );
  };

  const renderOrderPanel = (type: TradeListingKind) => {
    const panelOrders = type === 'sell' ? sellOrders : buyOrders;
    const visibleCount = panelOrders.filter((order) => order.visible).length;
    const allVisible = panelOrders.every((order) => order.visible);
    const allHidden = panelOrders.every((order) => !order.visible);
    return (
      <Panel>
        <PanelHeader className="px-3">
          <span className="flex min-w-0 items-center gap-2">
            <span
              className={`size-[7px] shrink-0 rounded-full ${
                type === 'sell' ? 'bg-accent-green' : 'bg-accent-blue'
              }`}
              aria-hidden="true"
            />
            <PanelTitle className="text-[10px] tracking-[0.1em] text-ink">
              {t(type === 'sell' ? 'trades.panel.sellOrders' : 'trades.panel.buyOrders')}
            </PanelTitle>
            <span className="font-mono text-[9px] tabular-nums text-ink-dim">
              {visibleCount}/{panelOrders.length}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              static
              className="h-6 px-2 text-[11px]"
              disabled={visibilityActionPending || allVisible}
              onClick={() => void handleSetAllVisibility(true, type)}
            >
              {t('trades.showAll')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              static
              className="h-6 px-2 text-[11px]"
              disabled={visibilityActionPending || allHidden}
              onClick={() => void handleSetAllVisibility(false, type)}
            >
              {t('trades.hideAll')}
            </Button>
          </span>
        </PanelHeader>
        <div className="grid grid-cols-[minmax(0,1.5fr)_92px_52px_128px] gap-2 border-b border-line px-3 py-1.5 font-mono text-[8px] tracking-[0.08em] text-ink-dim uppercase">
          <span>{t('trades.col.item')}</span>
          <span>{t(type === 'sell' ? 'trades.col.yoursLow' : 'trades.col.yoursMarket')}</span>
          <span>{t('trades.col.priceGap')}</span>
          <span className="text-right">{t('trades.col.actions')}</span>
        </div>
        {panelOrders.map((order) => renderOrderRow(order, type))}
        {overview && panelOrders.length === 0 ? (
          <EmptyState
            icon={type === 'sell' ? 'ti-tag' : 'ti-shopping-cart'}
            title={t(type === 'sell' ? 'trades.noSellOrders' : 'trades.noBuyOrders')}
            detail={t(type === 'sell' ? 'trades.createSellHint' : 'trades.createBuyHint')}
            action={
              type === 'sell' ? (
                <Button size="sm" onClick={() => openCreateListing('sell')}>
                  {t('trades.hero.createListing')}
                </Button>
              ) : null
            }
          />
        ) : null}
      </Panel>
    );
  };

  return (
    <>
      <Panel className="flex-row flex-wrap items-start justify-between gap-4 p-4">
        <div className="flex min-w-0 items-center gap-3.5">
          <TradeAvatar imageUrl={overview?.account.avatarUrl ?? tradeAccount.avatarUrl} name={tradeAccount.name} />
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-base font-semibold text-ink">{tradeAccount.name}</h2>
              <Badge tone={tradeStatusTone(tradeAccount.status)}>
                {formatTradeStatusLabel(tradeAccount.status)}
              </Badge>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-[11px] text-ink-dim">
              <span>{t('trades.hero.lastUpdated')} {formatShortLocalDateTime(overview?.lastUpdatedAt ?? tradeAccount.lastUpdatedAt)}</span>
              <span>{t('home.seller.filter')} {sellerMode === 'ingame-online' ? t('home.seller.ingameOnline') : t('home.seller.ingame')}</span>
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button onClick={() => openCreateListing('sell')}>
            <i className="ti ti-plus" aria-hidden="true" />
            {t('trades.hero.createListing')}
          </Button>
          <label className="flex h-8 cursor-pointer items-center gap-2 rounded-md border border-line bg-bg-base px-3">
            <Switch
              tone="positive"
              checked={autoWatchlistBuyOrdersEnabled}
              onCheckedChange={setAutoWatchlistBuyOrdersEnabled}
            />
            <span className="text-xs font-medium text-ink">{t('trades.autoBuyOrder')}</span>
            <InfoHint text="Adds and removes buy orders as items join and leave the watchlist" />
          </label>
          <Button variant="outline" onClick={() => void handleDisconnect()}>
            {t('trades.disconnect')}
          </Button>
        </div>
      </Panel>

      {/* The four figures the tab exists to deliver, on `Stat` — the same treatment as Health's
          summary and the Set Planner's, rather than the small bespoke tiles this page had. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          icon="ti-coins"
          label={t('trades.stat.activeTradeValue')}
          value={overview ? formatPlatinumValue(overview.activeTradeValue) : '—'}
        />
        <Stat
          icon="ti-receipt"
          label={t('trades.stat.buyExposure')}
          value={overview ? formatPlatinumValue(buyExposure) : '—'}
        />
        {/* `?? '—'`, never `String(value)`: both of these are nullable on the wire, and
            `String(null)` renders the literal text "null". */}
        <Stat
          icon="ti-checks"
          label={t('trades.stat.completedTrades')}
          value={overview?.totalCompletedTrades?.toLocaleString() ?? '—'}
        />
        <Stat
          icon="ti-package"
          label={t('trades.stat.openPositions')}
          value={overview?.openPositions?.toLocaleString() ?? '—'}
        />
      </div>

      {overviewError ? (
        <p className="flex items-start gap-2 rounded-md border border-accent-red/25 bg-accent-red/8 px-2.5 py-2 text-[11px] leading-relaxed text-accent-red">
          <i className="ti ti-alert-triangle mt-px shrink-0 text-sm" aria-hidden="true" />
          {overviewError}
        </p>
      ) : null}

      {/* Two flex columns rather than a grid: the sell and buy panels rarely hold the same number
          of rows, and a grid row is as tall as its tallest cell (`ELEMENTS.md` §6). */}
      <div className="grid grid-cols-1 items-start gap-3 xl:grid-cols-2">
        {overviewLoading && !overview ? (
          <>
            <Panel className="p-3">
              <Skeleton type="table-row@5" leafClassName="h-6" />
            </Panel>
            <Panel className="p-3">
              <Skeleton type="table-row@5" leafClassName="h-6" />
            </Panel>
          </>
        ) : (
          <>
            {renderOrderPanel('sell')}
            {renderOrderPanel('buy')}
          </>
        )}
      </div>

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
            <span className="font-mono text-[11px] tracking-[0.08em] text-ink-dim uppercase">
              {t('trades.subnav.liveOrders')}
            </span>
          ) : null
        }
      />
      {/* The container owns vertical rhythm — the children carry no margins, so this gap is the
          only thing spacing the hero, the stats and the order panels (`ELEMENTS.md` §6).
          `[&>*]:shrink-0` goes with it: `.page-content` is `flex: 1` + `overflow-y: auto`, so
          without it the browser squashes the short children instead of scrolling once the page
          overflows. That shipped as a vanishing world clock on Events. */}
      <div className="page-content trades-page-content flex flex-col gap-4 [&>*]:shrink-0">
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
