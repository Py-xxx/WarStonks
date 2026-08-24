import { useEffect, useState } from 'react';
import { ItemName } from '../ItemName';
import { ItemThumb } from '../ListRow';
import { useTranslation } from '../../i18n';
import { WatchlistPurchaseModal } from '../WatchlistPurchaseModal';
import { QuantityStepper } from '../QuantityStepper';
import { formatElapsedTime } from '../../lib/dateTime';
import { formatHomeErrorMessage } from '../../lib/homeErrorHandling';
import { copyWhisperMessage } from '../../lib/marketMessages';
import { getWatchlistVisualState } from '../../lib/watchlist';
import type { WatchlistTone } from '../../lib/watchlist';
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
import { EmptyState } from '@/components/ui/empty-state';
import { useAppStore } from '../../stores/useAppStore';
import type { WatchlistItem } from '../../types';

/** A dismissible status line above the table. Three call sites had it inline. */
function Banner({
  tone,
  children,
  onDismiss,
  dismissLabel,
}: {
  tone: 'success' | 'error';
  children: React.ReactNode;
  onDismiss?: () => void;
  dismissLabel?: string;
}) {
  return (
    <p
      role={tone === 'error' ? 'alert' : 'status'}
      className={`mb-2 flex items-start gap-2 rounded-md border px-2.5 py-2 text-[11px] leading-relaxed ${
        tone === 'error'
          ? 'border-accent-red/25 bg-accent-red/8 text-accent-red'
          : 'border-accent-green/25 bg-accent-green/8 text-accent-green'
      }`}
    >
      <i
        className={`ti ${tone === 'error' ? 'ti-alert-triangle' : 'ti-check'} mt-px shrink-0 text-sm`}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1">{children}</span>
      {onDismiss ? (
        <Button
          variant="ghost"
          size="sm"
          static
          onClick={onDismiss}
          className="-my-0.5 h-5 shrink-0 px-1.5 text-[10px] text-current hover:bg-white/10 hover:text-current"
        >
          {dismissLabel}
        </Button>
      ) : null}
    </p>
  );
}

const COPY_RESET_DELAY_MS = 1800;
const SUCCESS_DISMISS_DELAY_MS = 4000;

type WatchlistTableVariant = 'compact' | 'full';

/** Urgency order for the compact card: target hit first, then closest to target. */
const TONE_RANK: Record<WatchlistTone, number> = { green: 0, amber: 1, neutral: 2 };

/** The three row actions, always rendered as one adjacent group so the column never changes
 *  width and the buttons never move. An action that doesn't apply is disabled, not removed. */
function RowActions({
  canCopy,
  copied,
  onCopy,
  onMarkBought,
  onRemove,
  copyLabel,
  boughtLabel,
  removeLabel,
}: {
  canCopy: boolean;
  copied: boolean;
  onCopy: () => void;
  onMarkBought: () => void;
  onRemove: () => void;
  copyLabel: string;
  boughtLabel: string;
  removeLabel: string;
}) {
  return (
    // `stopPropagation` because the whole row is a selection target — clicking an action must not
    // also select the row underneath it.
    <div
      className="inline-flex shrink-0 divide-x divide-line overflow-hidden rounded-md border border-line"
      onClick={(event) => event.stopPropagation()}
    >
      <Button
        variant="ghost"
        size="icon-sm"
        static
        className={`h-6.5 w-7 rounded-none bg-bg-base ${copied ? 'text-accent-green' : ''}`}
        title={copyLabel}
        aria-label={copyLabel}
        disabled={!canCopy}
        onClick={onCopy}
      >
        <i className="ti ti-copy" aria-hidden="true" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        static
        className="h-6.5 w-7 rounded-none bg-bg-base"
        title={boughtLabel}
        aria-label={boughtLabel}
        onClick={onMarkBought}
      >
        <i className="ti ti-shopping-cart" aria-hidden="true" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        static
        className="h-6.5 w-7 rounded-none bg-bg-base hover:bg-accent-red/12 hover:text-accent-red"
        title={removeLabel}
        aria-label={removeLabel}
        onClick={onRemove}
      >
        <i className="ti ti-trash" aria-hidden="true" />
      </Button>
    </div>
  );
}

/** Tone → the row's left edge and tint. Green means the target is hit; amber means it is close. */
const ROW_TONE: Record<WatchlistTone, string> = {
  green: 'border-l-accent-green bg-accent-green/8',
  amber: 'border-l-accent-amber bg-accent-amber/8',
  neutral: 'border-l-line-strong bg-bg-base',
};

/** In the full table the tone tints the cells and the edge sits on the first one. */
const CELL_TONE: Record<WatchlistTone, string> = {
  green: '[&>td]:bg-accent-green/8 hover:[&>td]:bg-accent-green/12',
  amber: '[&>td]:bg-accent-amber/8 hover:[&>td]:bg-accent-amber/12',
  neutral: 'hover:[&>td]:bg-bg-elevated',
};

const EDGE_TONE: Record<WatchlistTone, string> = {
  green: 'border-l-accent-green',
  amber: 'border-l-accent-amber',
  neutral: 'border-l-transparent',
};

const PRICE_TONE: Record<WatchlistTone, string> = {
  green: 'text-accent-green',
  amber: 'text-accent-amber',
  neutral: 'text-ink',
};

/**
 * Shared watchlist table used by both the dashboard Overview card and the full-screen
 * Watchlist tab. Centralises row actions (copy whisper, mark bought, remove) plus their
 * error/success handling so fixes only have to happen in one place.
 */
export function WatchlistTable({
  variant,
  toneFilter = null,
}: {
  variant: WatchlistTableVariant;
  /** Full tab only — restricts rows to one status. `null` shows everything. */
  /** One tone, or several. Home passes `['green','amber']` to show only rows worth acting on. */
  toneFilter?: WatchlistTone | WatchlistTone[] | null;
}) {
  const { t } = useTranslation();
  const watchlist = useAppStore((state) => state.watchlist);
  const selectedId = useAppStore((state) => state.selectedWatchlistId);
  const setSelected = useAppStore((state) => state.setSelectedWatchlist);
  const removeItem = useAppStore((state) => state.removeWatchlistItem);
  const markWatchlistItemBought = useAppStore((state) => state.markWatchlistItemBought);
  const setWatchlistItemQuantity = useAppStore((state) => state.setWatchlistItemQuantity);
  const watchlistActionError = useAppStore((state) => state.watchlistActionError);
  const setWatchlistActionError = useAppStore((state) => state.setWatchlistActionError);

  const [purchaseItemId, setPurchaseItemId] = useState<string | null>(null);
  const [purchaseLoading, setPurchaseLoading] = useState(false);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);
  const [purchaseSuccess, setPurchaseSuccess] = useState<string | null>(null);
  const [copiedWatchlistId, setCopiedWatchlistId] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [removeItemId, setRemoveItemId] = useState<string | null>(null);

  const purchaseItem = watchlist.find((item) => item.id === purchaseItemId) ?? null;
  const removeTarget = watchlist.find((item) => item.id === removeItemId) ?? null;

  // Auto-dismiss the success banner so it doesn't linger forever (#5).
  useEffect(() => {
    if (!purchaseSuccess) {
      return undefined;
    }
    const timeoutId = window.setTimeout(() => setPurchaseSuccess(null), SUCCESS_DISMISS_DELAY_MS);
    return () => window.clearTimeout(timeoutId);
  }, [purchaseSuccess]);

  const handleCopy = (item: WatchlistItem) => {
    if (!item.currentSeller || item.currentPrice === null) {
      return;
    }
    setCopyError(null);
    void copyWhisperMessage(
      {
        username: item.currentSeller,
        platinum: item.currentPrice,
        rank: item.currentRank,
        maxRank: item.maxRank,
      },
      item.displayName,
    )
      .then(() => {
        setCopiedWatchlistId(item.id);
        window.setTimeout(() => {
          setCopiedWatchlistId((current) => (current === item.id ? null : current));
        }, COPY_RESET_DELAY_MS);
      })
      .catch(() => {
        // Surface the failure on its own banner — previously it was written to the
        // purchase-modal error slot and never shown (#1, #8).
        setCopyError(formatHomeErrorMessage('watchlist-copy', new Error('copy failed')));
      });
  };

  return (
    <>
      {purchaseSuccess ? <Banner tone="success">{purchaseSuccess}</Banner> : null}
      {copyError ? (
        <Banner tone="error" onDismiss={() => setCopyError(null)} dismissLabel={t('wl.dismiss')}>
          {copyError}
        </Banner>
      ) : null}
      {watchlistActionError ? (
        <Banner
          tone="error"
          onDismiss={() => setWatchlistActionError(null)}
          dismissLabel={t('wl.dismiss')}
        >
          {watchlistActionError}
        </Banner>
      ) : null}

      {(() => {
        const ordered = [...watchlist].sort((left, right) => {
          const leftState = getWatchlistVisualState(left);
          const rightState = getWatchlistVisualState(right);
          const byTone = TONE_RANK[leftState.tone] - TONE_RANK[rightState.tone];
          if (byTone !== 0) {
            return byTone;
          }
          // Within a tone, closest to its own target first — "how near am I?" is the question
          // this card exists to answer, and it's comparable across items of different prices.
          const distance = (item: WatchlistItem) =>
            item.currentPrice === null || item.targetPrice <= 0
              ? Number.POSITIVE_INFINITY
              : (item.currentPrice - item.targetPrice) / item.targetPrice;
          return distance(left) - distance(right);
        });
        const wantedTones = toneFilter
          ? new Set(Array.isArray(toneFilter) ? toneFilter : [toneFilter])
          : null;
        const rows = wantedTones
          ? ordered.filter((item) => wantedTones.has(getWatchlistVisualState(item).tone))
          : ordered;

        if (watchlist.length === 0) {
          return (
            <EmptyState icon="ti-target" title={t('wl.noItems')} detail={t('wl.searchToAddHint')} />
          );
        }
        if (rows.length === 0) {
          return (
            <EmptyState icon="ti-filter" title={t('wl.noneMatchFilter')} />
          );
        }

        const renderActions = (item: WatchlistItem, canCopy: boolean) => (
          <RowActions
            canCopy={canCopy}
            copied={copiedWatchlistId === item.id}
            copyLabel={t('hm.copyMessage')}
            boughtLabel={t('wl.markBought')}
            removeLabel={t('wl.remove')}
            onCopy={() => handleCopy(item)}
            onMarkBought={() => {
              setPurchaseError(null);
              setPurchaseSuccess(null);
              setPurchaseItemId(item.id);
            }}
            onRemove={() => setRemoveItemId(item.id)}
          />
        );

        if (variant === 'compact') {
          return (
            <div className="flex flex-col gap-1">
              {rows.map((item) => {
                const visualState = getWatchlistVisualState(item);
                const imageUrl = resolveWfmAssetUrl(item.imagePath, item.slug);
                const canCopy =
                  visualState.tone === 'green' && Boolean(item.currentSeller) && item.currentPrice !== null;
                return (
                  // The tone row from `ELEMENTS.md` §4: a 3px left border in the tone plus a ~8%
                  // tint of the same accent. Green = target hit, amber = close.
                  <div
                    key={item.id}
                    className={`flex cursor-pointer items-center gap-2.5 rounded-sm border-l-[3px] px-2.5 py-2 transition-colors duration-150 ease-out ${
                      ROW_TONE[visualState.tone]
                    } ${selectedId === item.id ? 'ring-1 ring-inset ring-accent-blue/35' : ''}`}
                    onClick={() => setSelected(item.id)}
                  >
                    <ItemThumb
                      src={imageUrl}
                      fallback={item.displayName.slice(0, 1)}
                      size="size-8"
                    />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-xs font-medium text-ink">
                        <ItemName
                          name={item.displayName}
                          slug={item.slug}
                          itemId={item.itemId}
                          imagePath={item.imagePath}
                        />
                      </span>
                      <span className="truncate text-[10px] text-ink-dim">
                        {visualState.label}
                        {item.currentSeller ? ` · ${item.currentSeller}` : ''}
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-px font-mono text-xs tabular-nums">
                      <span className={PRICE_TONE[visualState.tone]}>
                        {item.currentPrice !== null ? `${item.currentPrice} pt` : '—'}
                      </span>
                      <span className="text-[10px] text-ink-faint">
                        {t('wl.targetShort', { n: item.targetPrice })}
                      </span>
                    </span>
                    {renderActions(item, canCopy)}
                  </div>
                );
              })}
            </div>
          );
        }

        return (
          // A real `<table>`, kept: this is tabular data with a header row, and the semantics
          // are worth more than the convenience of a div grid. `table-fixed` plus the per-column
          // widths below are what stop the item name from squeezing the numbers.
          <table className="w-full table-fixed border-collapse">
            <thead>
              <tr className="[&>th]:border-b [&>th]:border-line-subtle [&>th]:px-2.5 [&>th]:py-2 [&>th]:text-left [&>th]:font-mono [&>th]:text-[9px] [&>th]:font-semibold [&>th]:tracking-[0.07em] [&>th]:text-ink-dim [&>th]:uppercase">
                <th>{t('wl.item')}</th>
                <th className="w-[68px] text-right">{t('wl.target')}</th>
                <th className="w-[68px] text-right">{t('wl.lowest')}</th>
                <th className="w-24">{t('wl.want')}</th>
                <th className="w-24">{t('wl.seller')}</th>
                <th className="w-[108px] text-right">{t('wl.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((item) => {
                const visualState = getWatchlistVisualState(item);
                const imageUrl = resolveWfmAssetUrl(item.imagePath, item.slug);
                const canCopy =
                  visualState.tone === 'green' && Boolean(item.currentSeller) && item.currentPrice !== null;
                return (
                  <tr
                    key={item.id}
                    onClick={() => setSelected(item.id)}
                    // The tone tints the CELLS, not the row: a `<tr>` background is painted under
                    // its cells and the tint would not show.
                    className={`cursor-pointer [&>td]:border-b [&>td]:border-line-subtle [&>td]:px-2.5 [&>td]:py-2 [&>td]:text-xs ${
                      CELL_TONE[visualState.tone]
                    } ${selectedId === item.id ? '[&>td]:bg-accent-blue/10' : ''}`}
                    title={t('wl.refreshedAt', { time: formatElapsedTime(item.lastUpdatedAt) })}
                  >
                    {/* The tone's left edge lives on the first cell, so it reads as an edge on
                        the row rather than a border inside it. */}
                    <td className={`border-l-[3px] ${EDGE_TONE[visualState.tone]}`}>
                      <div className="flex min-w-0 items-center gap-2">
                        <ItemThumb
                          src={imageUrl}
                          fallback={item.displayName.slice(0, 1)}
                          size="size-7"
                        />
                        <span className="truncate text-ink">
                          <ItemName
                            name={item.displayName}
                            slug={item.slug}
                            itemId={item.itemId}
                            imagePath={item.imagePath}
                          />
                        </span>
                      </div>
                    </td>
                    <td className="text-right font-mono tabular-nums text-ink-dim">
                      {item.targetPrice}
                    </td>
                    <td className={`text-right font-mono tabular-nums ${PRICE_TONE[visualState.tone]}`}>
                      {item.currentPrice !== null ? item.currentPrice : '—'}
                    </td>
                    <td>
                      <QuantityStepper
                        value={item.quantity}
                        onChange={(next) => setWatchlistItemQuantity(item.id, next)}
                      />
                    </td>
                    <td className="truncate text-ink-soft">{item.currentSeller ?? '—'}</td>
                    <td className="text-right">
                      <div className="flex justify-end">{renderActions(item, canCopy)}</div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        );
      })()}

      {purchaseItem ? (
        <WatchlistPurchaseModal
          itemName={purchaseItem.displayName}
          defaultPrice={purchaseItem.targetPrice}
          maxQuantity={purchaseItem.quantity}
          loading={purchaseLoading}
          errorMessage={purchaseError}
          onClose={() => {
            if (purchaseLoading) {
              return;
            }
            setPurchaseItemId(null);
            setPurchaseError(null);
          }}
          onSubmit={(price, quantity) => {
            setPurchaseLoading(true);
            setPurchaseError(null);
            void markWatchlistItemBought(purchaseItem.id, price, quantity)
              .then((result) => {
                setPurchaseSuccess(result.confirmationMessage);
                setPurchaseItemId(null);
              })
              .catch((error) => {
                setPurchaseError(formatHomeErrorMessage('watchlist-mark-bought', error));
              })
              .finally(() => {
                setPurchaseLoading(false);
              });
          }}
        />
      ) : null}

      {/* `Dialog`, not `ModalPortal` + `modal-backdrop` + `useModalA11y`. Base UI owns the focus
          trap, Escape and focus restore; running `useModalA11y` alongside it would fight. */}
      <Dialog open={removeTarget !== null} onOpenChange={(open) => !open && setRemoveItemId(null)}>
        <DialogContent className="max-w-sm">
          {removeTarget ? (
            <>
              <DialogHeader>
                <DialogTitle>{t('wl.removeTitle')}</DialogTitle>
                <DialogDescription className="text-[11px] leading-relaxed text-ink-soft">
                  {(() => {
                    // The item name is bolded inside the sentence, so the string is split on a
                    // sentinel rather than concatenated — the clause order differs by language.
                    const [before, after] = t('wl.removeBody', { name: '\u0000' }).split('\u0000');
                    return (
                      <>
                        {before}
                        <strong className="text-ink">{removeTarget.displayName}</strong>
                        {after}
                      </>
                    );
                  })()}
                  {removeTarget.linkedBuyOrderId ? ` ${t('wl.removeLinked')}` : ''}
                </DialogDescription>
              </DialogHeader>

              <DialogFooter>
                <Button variant="ghost" size="sm" onClick={() => setRemoveItemId(null)}>
                  {t('common.cancel')}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => {
                    removeItem(removeTarget.id);
                    setRemoveItemId(null);
                  }}
                >
                  {t('trades.row.remove')}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
