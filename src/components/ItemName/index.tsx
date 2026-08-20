import { type ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { copyTextToClipboard } from '../../lib/marketMessages';
import { useAppStore } from '../../stores/useAppStore';
import { useTranslation } from '../../i18n';
import { resolveLocalizedName } from '../../lib/itemNames';
import type { ItemQuickViewTarget } from '../../types';

type ItemNameProps = ItemQuickViewTarget & {
  className?: string;
  children?: ReactNode;
};

// Approximate menu size, used to keep it on-screen near the viewport edges.
const ITEM_MENU_WIDTH = 210;
// Tallest case: drop-details + divider + 4 options.
const ITEM_MENU_HEIGHT = 196;

function clampMenuPosition(x: number, y: number): { x: number; y: number } {
  const maxX = Math.max(8, window.innerWidth - ITEM_MENU_WIDTH - 8);
  const maxY = Math.max(8, window.innerHeight - ITEM_MENU_HEIGHT - 8);
  return { x: Math.min(x, maxX), y: Math.min(y, maxY) };
}

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
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!menu) {
      return undefined;
    }
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenu(null);
      }
    };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [menu]);

  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();

  const handleOpen = (event: { stopPropagation: () => void }) => {
    stop(event);
    setMenu(null);
    // 'market', not 'home': Quick View moved to Market when Home was rebuilt, so 'home' landed
    // you on a page that does not show the item at all.
    void openItemInQuickView(target, 'market');
  };

  const handleCopy = (event: { stopPropagation: () => void }) => {
    stop(event);
    setMenu(null);
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
    setMenu(null);
    requestOpportunitiesTab('farm-now', target.name);
  };

  const handleOpenMarketPage = (event: { stopPropagation: () => void }) => {
    stop(event);
    setMenu(null);
    void openItemInQuickView(target, 'market');
  };

  const handleCopyWfmLink = (event: { stopPropagation: () => void }) => {
    stop(event);
    setMenu(null);
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
    setMenu(null);
    if (target.slug) {
      void startFarmingForItem(target.slug, target.name);
    }
  };

  // Watchlist needs a price, so the menu hands off to a tiny prompt rather than guessing.
  const handleAddToWatchlist = (event: { stopPropagation: () => void }) => {
    stop(event);
    setMenu(null);
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
      <span
        ref={triggerRef}
        className={`item-name-link${className ? ` ${className}` : ''}`}
        role="button"
        tabIndex={0}
        title={`Open ${displayName} in Quick View`}
        onClick={handleOpen}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setMenu(clampMenuPosition(event.clientX, event.clientY));
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            handleOpen(event);
            return;
          }
          // Keyboard access to the context menu: ContextMenu key or Shift+F10, anchored to the
          // element so it's reachable without a mouse.
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault();
            event.stopPropagation();
            const rect = triggerRef.current?.getBoundingClientRect();
            setMenu(clampMenuPosition(rect?.left ?? 0, rect?.bottom ?? 0));
          }
        }}
      >
        {children ?? displayName}
      </span>
      {/* Portaled to <body>: rows use `opacity` for dimmed/hidden states, and any ancestor with
          opacity < 1 both fades its descendants and traps their z-index in a new stacking
          context — which made this menu render translucent and behind other panels. */}
      {pricePrompt !== null
        ? createPortal(
        <div className="item-price-prompt" role="dialog" onClick={stop}>
          <span className="item-price-prompt-label">
            {t('itm.watchPricePrompt', { item: displayName })}
          </span>
          <div className="item-price-prompt-row">
            <input
              autoFocus
              type="number"
              min={1}
              step={1}
              value={pricePrompt}
              placeholder={exitPrice ? String(Math.round(exitPrice)) : '0'}
              onChange={(event) => setPricePrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submitWatchlistPrice();
                if (event.key === 'Escape') setPricePrompt(null);
              }}
            />
            <button type="button" className="act-btn" onClick={() => setPricePrompt(null)}>
              {t('common.cancel')}
            </button>
            <button type="button" className="btn-primary" onClick={submitWatchlistPrice}>
              {t('itm.addToWatchlist')}
            </button>
          </div>
        </div>,
            document.body,
          )
        : null}
      {menu
        ? createPortal(
        <div
          className="item-context-menu"
          style={{ top: menu.y, left: menu.x }}
          role="menu"
          onClick={stop}
        >
          {sellsForLabel ? (
            <span className="item-context-menu-header">{sellsForLabel}</span>
          ) : null}
          {dropsFromRelic ? (
            <>
              <button
                type="button"
                className="item-context-menu-option is-primary"
                role="menuitem"
                onClick={handleViewDropDetails}
              >
                {t('itm.viewDropDetails')}
              </button>
              <button
                type="button"
                className="item-context-menu-option is-primary"
                role="menuitem"
                onClick={handleFarmItem}
              >
                {t('itm.farmItem')}
              </button>
              <span className="item-context-menu-divider" role="separator" />
            </>
          ) : null}
          <button
            type="button"
            className="item-context-menu-option"
            role="menuitem"
            onClick={handleAddToWatchlist}
          >
            {t('itm.addToWatchlist')}
          </button>
          <button type="button" className="item-context-menu-option" role="menuitem" onClick={handleOpen}>
            {t('itm.openQv')}
          </button>
          <button
            type="button"
            className="item-context-menu-option"
            role="menuitem"
            onClick={handleOpenMarketPage}
          >
            {t('itm.openMarket')}
          </button>
          <button type="button" className="item-context-menu-option" role="menuitem" onClick={handleCopy}>
            {t('itm.copyName')}
          </button>
          <button
            type="button"
            className="item-context-menu-option"
            role="menuitem"
            onClick={handleCopyWfmLink}
            disabled={!target.slug}
          >
            {t('itm.copyWfmLink')}
          </button>
        </div>,
            document.body,
          )
        : null}
    </>
  );
}
