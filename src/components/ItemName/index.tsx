import { type ReactNode, useEffect, useRef, useState } from 'react';
import { openExternalUrl } from '../../lib/tauriClient';
import { copyTextToClipboard } from '../../lib/marketMessages';
import { useAppStore } from '../../stores/useAppStore';
import { resolveLocalizedName } from '../../lib/itemNames';
import type { ItemQuickViewTarget } from '../../types';

type ItemNameProps = ItemQuickViewTarget & {
  className?: string;
  children?: ReactNode;
};

// Approximate menu size, used to keep it on-screen near the viewport edges.
const ITEM_MENU_WIDTH = 210;
const ITEM_MENU_HEIGHT = 116;

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
    void openItemInQuickView(target);
  };

  const handleCopy = (event: { stopPropagation: () => void }) => {
    stop(event);
    setMenu(null);
    void copyTextToClipboard(target.name)
      .then(() => pushToast('Item name copied', 'success'))
      .catch(() => pushToast("Couldn't copy the item name", 'error'));
  };

  const handleOpenWfm = (event: { stopPropagation: () => void }) => {
    stop(event);
    setMenu(null);
    if (!target.slug) {
      pushToast('No warframe.market link for this item', 'error');
      return;
    }
    void openExternalUrl(`https://warframe.market/items/${target.slug}`).catch(() =>
      pushToast("Couldn't open warframe.market", 'error'),
    );
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
      {menu ? (
        <div
          className="item-context-menu"
          style={{ top: menu.y, left: menu.x }}
          role="menu"
          onClick={stop}
        >
          <button type="button" className="item-context-menu-option" role="menuitem" onClick={handleOpen}>
            Open in Quick View
          </button>
          <button type="button" className="item-context-menu-option" role="menuitem" onClick={handleCopy}>
            Copy name
          </button>
          <button
            type="button"
            className="item-context-menu-option"
            role="menuitem"
            onClick={handleOpenWfm}
            disabled={!target.slug}
          >
            Open on warframe.market
          </button>
        </div>
      ) : null}
    </>
  );
}
