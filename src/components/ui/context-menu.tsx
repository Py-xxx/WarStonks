/**
 * ContextMenu — Base UI's context menu, on our tokens.
 *
 * **Why this is a primitive rather than the hand-rolled menu it replaces.** `ItemName`'s
 * right-click menu was the last hand-positioned overlay in the app: it read `event.clientX/Y`,
 * clamped them against the viewport itself, and portalled to `<body>` — the exact pattern that
 * `useAnchoredPopover` was deleted for. It also carried its own `Shift+F10` / ContextMenu-key
 * handling and its own outside-click dismissal, all of which Base UI does correctly.
 *
 * The portal is not optional and the reason is worth keeping: rows use `opacity` for their
 * dimmed and hidden states, and **any ancestor with `opacity < 1` both fades its descendants and
 * traps their z-index in a new stacking context** — which rendered this menu translucent and
 * behind other panels before it was portalled out.
 *
 * Surface matches `popover.tsx` and `tooltip.tsx`: `bg-overlay`, a `white/12` border and
 * `shadow-float`, because an overlay must read as *above* the page and `bg-elevated` sits at
 * 1.04:1 against a panel.
 */
import { ContextMenu as ContextMenuPrimitive } from '@base-ui/react/context-menu';

import { cn } from '@/lib/utils';

function ContextMenu(props: ContextMenuPrimitive.Root.Props) {
  return <ContextMenuPrimitive.Root {...props} />;
}

function ContextMenuTrigger(props: ContextMenuPrimitive.Trigger.Props) {
  return <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />;
}

function ContextMenuContent({ className, ...props }: ContextMenuPrimitive.Popup.Props) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner className="z-(--z-dropdown)">
        <ContextMenuPrimitive.Popup
          data-slot="context-menu-content"
          data-ws-overlay=""
          className={cn(
            'min-w-44 origin-(--transform-origin) rounded-md border border-white/12',
            'bg-bg-overlay p-1 text-xs text-ink shadow-float outline-none',
            className,
          )}
          {...props}
        />
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  );
}

/**
 * One menu row. `variant="primary"` tints the entries that are the *point* of opening the menu on
 * a given item — a relic drop's "View drop details" and "Farm item" — so they are not lost among
 * the five generic actions every item has.
 */
function ContextMenuItem({
  className,
  variant = 'default',
  ...props
}: ContextMenuPrimitive.Item.Props & { variant?: 'default' | 'primary' }) {
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      className={cn(
        'flex w-full cursor-pointer items-center rounded-sm px-2 py-1.5 text-xs outline-none select-none',
        'transition-colors duration-150 ease-out',
        'data-highlighted:bg-bg-elevated',
        'data-disabled:pointer-events-none data-disabled:opacity-50',
        variant === 'primary'
          ? 'text-accent-blue data-highlighted:bg-accent-blue/12 data-highlighted:text-accent-blue'
          : 'text-ink-soft data-highlighted:text-ink',
        className,
      )}
      {...props}
    />
  );
}

/** A non-interactive line naming what the menu is about — the item's own price, here. */
function ContextMenuLabel({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="context-menu-label"
      className={cn(
        'px-2 py-1.5 font-mono text-[10px] tracking-[0.04em] text-ink-dim tabular-nums',
        className,
      )}
      {...props}
    />
  );
}

function ContextMenuSeparator({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="context-menu-separator"
      role="separator"
      className={cn('my-1 h-px bg-line', className)}
      {...props}
    />
  );
}

export {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
};
