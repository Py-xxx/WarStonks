import { type ReactNode, useState } from 'react';
import { copyTextToClipboard } from '../../lib/marketMessages';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useAppStore } from '../../stores/useAppStore';
import { useTranslation } from '../../i18n';
import { resolveLocalizedName } from '../../lib/itemNames';
import type { ItemQuickViewTarget } from '../../types';

type ItemNameProps = ItemQuickViewTarget & {
  className?: string;
  children?: ReactNode;
};

// Approximate menu size, used to keep it on-screen near the viewport edges.
// Tallest case: drop-details + divider + 4 options.

/**
 * A clickable item/set name used anywhere an item is displayed. Left-click opens the item
 * in the Home Quick View; right-click opens a small context menu (open / copy / open on
 * warframe.market). Click handlers stop propagation so wrapping rows aren't also triggered.
 */
export function ItemName({ className, children, ...target }: ItemNameProps) {
  const openItemInQuickView = useAppStore((state) => state.openItemInQuickView);
  const pushToast = useAppStore((state) => state.pushToast);
  const itemNameMap = useAppStore((state) => state.itemNameMap);
  const relicDropSlugs = useAppStore((state) => state.relicDropSlugs);
  const itemExitPrices = useAppStore((state) => state.itemExitPrices);
  const requestOpportunitiesTab = useAppStore((state) => state.requestOpportunitiesTab);
  const startFarmingForItem = useAppStore((state) => state.startFarmingForItem);
  const addExplicitItemToWatchlist = useAppStore((state) => state.addExplicitItemToWatchlist);
  const [pricePrompt, setPricePrompt] = useState<string | null>(null);
  const { t } = useTranslation();
  const displayName = resolveLocalizedName(itemNameMap, target);

  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();

  const handleOpen = (event: { stopPropagation: () => void }) => {
    stop(event);
    // 'market', not 'home': Quick View moved to Market when Home was rebuilt, so 'home' landed
    // you on a page that does not show the item at all.
    void openItemInQuickView(target, 'market');
  };

  const handleCopy = (event: { stopPropagation: () => void }) => {
    stop(event);
    void copyTextToClipboard(target.name)
      .then(() => pushToast(t('itm.copied'), 'success'))
      .catch(() => pushToast(t('itm.copyFailed'), 'error'));
  };

  // Only meaningful for items a relic can actually drop, so the entry is hidden otherwise
  // rather than dead-ending on an empty farm-now search.
  const dropsFromRelic = Boolean(target.slug && relicDropSlugs.has(target.slug));
  const exitPrice = target.slug ? itemExitPrices.get(target.slug) : undefined;
  const sellsForLabel = exitPrice ? t('itm.sellsFor', { price: `${Math.round(exitPrice)}p` }) : null;

  const handleViewDropDetails = (event: { stopPropagation: () => void }) => {
    stop(event);
    requestOpportunitiesTab('farm-now', target.name);
  };

  const handleOpenMarketPage = (event: { stopPropagation: () => void }) => {
    stop(event);
    void openItemInQuickView(target, 'market');
  };

  const handleCopyWfmLink = (event: { stopPropagation: () => void }) => {
    stop(event);
    if (!target.slug) {
      pushToast(t('itm.noWfmLink'), 'error');
      return;
    }
    void copyTextToClipboard(`https://warframe.market/items/${target.slug}`)
      .then(() => pushToast(t('itm.linkCopied'), 'success'))
      .catch(() => pushToast(t('itm.copyFailed'), 'error'));
  };

  const handleFarmItem = (event: { stopPropagation: () => void }) => {
    stop(event);
    if (target.slug) {
      void startFarmingForItem(target.slug, target.name);
    }
  };

  // Watchlist needs a price, so the menu hands off to a tiny prompt rather than guessing.
  const handleAddToWatchlist = (event: { stopPropagation: () => void }) => {
    stop(event);
    setPricePrompt('');
  };

  const submitWatchlistPrice = () => {
    const price = Number.parseInt(pricePrompt ?? '', 10);
    if (!Number.isInteger(price) || price <= 0) {
      pushToast(t('itm.enterPrice'), 'error');
      return;
    }
    addExplicitItemToWatchlist(
      {
        itemId: target.itemId ?? 0,
        wfmId: null,
        name: target.name,
        slug: target.slug ?? '',
        maxRank: null,
        itemFamily: null,
        imagePath: target.imagePath ?? null,
        bulkTradable: false,
      },
      'base',
      'Base Market',
      price,
    );
    setPricePrompt(null);
    pushToast(t('itm.addedToWatchlist'), 'success');
  };

  return (
    <>
      {/* `ContextMenu` replaces a hand-positioned portal that read `event.clientX/Y`, clamped
          them against the viewport itself, and carried its own Shift+F10 handling and outside-
          click dismissal. Base UI does all of that, and correctly. */}
      <ContextMenu>
        <ContextMenuTrigger
          render={
            <span
              className={`item-name-link${className ? ` ${className}` : ''}`}
              role="button"
              tabIndex={0}
              title={t('itm.openQvTitle', { item: displayName })}
              onClick={handleOpen}
              onKeyDown={(event: React.KeyboardEvent) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  handleOpen(event);
                }
              }}
            />
          }
        >
          {children ?? displayName}
        </ContextMenuTrigger>

        <ContextMenuContent>
          {sellsForLabel ? <ContextMenuLabel>{sellsForLabel}</ContextMenuLabel> : null}
          {/* A relic drop's two actions are the reason you would open this menu on that item, so
              they lead and they are tinted; the five generic ones follow. */}
          {dropsFromRelic ? (
            <>
              <ContextMenuItem variant="primary" onClick={handleViewDropDetails}>
                {t('itm.viewDropDetails')}
              </ContextMenuItem>
              <ContextMenuItem variant="primary" onClick={handleFarmItem}>
                {t('itm.farmItem')}
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          ) : null}
          <ContextMenuItem onClick={handleAddToWatchlist}>
            {t('itm.addToWatchlist')}
          </ContextMenuItem>
          <ContextMenuItem onClick={handleOpen}>{t('itm.openQv')}</ContextMenuItem>
          <ContextMenuItem onClick={handleOpenMarketPage}>{t('itm.openMarket')}</ContextMenuItem>
          <ContextMenuItem onClick={handleCopy}>{t('itm.copyName')}</ContextMenuItem>
          <ContextMenuItem onClick={handleCopyWfmLink} disabled={!target.slug}>
            {t('itm.copyWfmLink')}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {/* Watchlist needs a price, so the menu hands off to this rather than guessing one. A
          `Dialog` and not an inline popover: it takes focus and a typed value. */}
      <Dialog
        open={pricePrompt !== null}
        onOpenChange={(open) => !open && setPricePrompt(null)}
      >
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle>{t('itm.addToWatchlist')}</DialogTitle>
            <DialogDescription>
              {t('itm.watchPricePrompt', { item: displayName })}
            </DialogDescription>
          </DialogHeader>

          <Input
            autoFocus
            className="tabular-nums"
            type="number"
            min={1}
            step={1}
            value={pricePrompt ?? ''}
            placeholder={exitPrice ? String(Math.round(exitPrice)) : '0'}
            onChange={(event) => setPricePrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submitWatchlistPrice();
            }}
          />

          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setPricePrompt(null)}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" onClick={submitWatchlistPrice}>
              {t('itm.addToWatchlist')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
