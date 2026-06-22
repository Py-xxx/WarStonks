import { type ReactNode, useEffect, useState } from 'react';
import { openExternalUrl } from '../../lib/tauriClient';
import { useAppStore } from '../../stores/useAppStore';
import type { ItemQuickViewTarget } from '../../types';

type ItemNameProps = ItemQuickViewTarget & {
  className?: string;
  children?: ReactNode;
};

/**
 * A clickable item/set name used anywhere an item is displayed. Left-click opens the item
 * in the Home Quick View; right-click opens a small context menu (open / copy / open on
 * warframe.market). Click handlers stop propagation so wrapping rows aren't also triggered.
 */
export function ItemName({ className, children, ...target }: ItemNameProps) {
  const openItemInQuickView = useAppStore((state) => state.openItemInQuickView);
  const pushToast = useAppStore((state) => state.pushToast);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

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
    void navigator.clipboard
      .writeText(target.name)
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
        className={`item-name-link${className ? ` ${className}` : ''}`}
        role="button"
        tabIndex={0}
        title={`Open ${target.name} in Quick View`}
        onClick={handleOpen}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setMenu({ x: event.clientX, y: event.clientY });
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            handleOpen(event);
          }
        }}
      >
        {children ?? target.name}
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
