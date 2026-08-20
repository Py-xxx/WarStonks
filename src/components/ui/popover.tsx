/**
 * Popover — adapted from shadcn/ui's Base UI popover (MIT), in `ui-reference/shadcn-vite`.
 *
 * Changes from the source:
 * - `tw-animate-css` utility classes replaced with our `data-ws-overlay` keyframes, matching the
 *   tooltip primitive so every overlay in the app enters the same way. Their version carried a
 *   dozen `slide-in-from-*` variants we have no equivalent for.
 * - Hardcoded `z-50` replaced with the `--z-dropdown` layering token. A literal z-index is what
 *   the migration exists to stamp out, and the guard in `uiPrimitives.test.ts` rejects it.
 * - Colours moved onto our tokens; `ring-1 ring-foreground/10` becomes a real border, because a
 *   dense dark UI separates with borders and elevates with shadows.
 * - Fixed `w-72` dropped — the sidebar flyout sizes to its content, and a 288px panel next to a
 *   collapsed 56px rail is absurd.
 *
 * `PopoverTrigger` accepts Base UI's `openOnHover`, which is how the collapsed sidebar's nav
 * flyout works without us writing any hover/timeout logic of our own.
 */
import { Popover as PopoverPrimitive } from '@base-ui/react/popover';

import { cn } from '@/lib/utils';

function Popover(props: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger(props: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverContent({
  className,
  align = 'start',
  alignOffset = 0,
  side = 'right',
  sideOffset = 6,
  ...props
}: PopoverPrimitive.Popup.Props &
  Pick<PopoverPrimitive.Positioner.Props, 'align' | 'alignOffset' | 'side' | 'sideOffset'>) {
  return (
    <PopoverPrimitive.Portal>
      {/* Portalled, so no ancestor `overflow` clips it — the sidebar is a scroll container. */}
      <PopoverPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="z-(--z-dropdown)"
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          data-ws-overlay=""
          className={cn(
            'min-w-40 origin-(--transform-origin) rounded-md border border-white/12',
            'bg-bg-overlay p-1 text-xs text-ink shadow-float outline-none',
            className,
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverTrigger, PopoverContent };
