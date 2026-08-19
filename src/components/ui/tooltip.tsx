/**
 * Tooltip — adapted from shadcn/ui's Base UI tooltip (MIT), in `ui-reference/shadcn-vite`.
 *
 * Changes from the source:
 * - `tw-animate-css` utility classes replaced with our own `data-ws-overlay` keyframes
 *   (src/index.css), so durations/easing match the interface-polish skill and we carry
 *   one less dependency.
 * - Colours moved onto our tokens; the arrow is dropped (a 10px rotated square on a dark
 *   popover reads as noise at our density, and it fights the collision-flipped sides).
 * - `delay` defaults to 250ms rather than 0: a zero-delay tooltip fires while the pointer
 *   is merely crossing a dense table, which is most of what this app is.
 *
 * THIS IS THE ONLY TOOLTIP. It replaces four divergent implementations that clipped under
 * panels and broke on resize (`.info-hint-tooltip`, `.world-event-tooltip`,
 * `.market-info-hint-tooltip`, `.info-hint-tooltip-floating`). Never hand-position another
 * one — Base UI's Portal + Positioner is what gives us collision detection, flipping, and
 * repositioning on scroll instead of the old "dismiss because the coordinates went stale".
 */
import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip';

import { cn } from '@/lib/utils';

function TooltipProvider({ delay = 250, ...props }: TooltipPrimitive.Provider.Props) {
  return <TooltipPrimitive.Provider data-slot="tooltip-provider" delay={delay} {...props} />;
}

function Tooltip(props: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

function TooltipTrigger(props: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({
  className,
  side = 'top',
  sideOffset = 6,
  align = 'center',
  alignOffset = 0,
  children,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<TooltipPrimitive.Positioner.Props, 'align' | 'alignOffset' | 'side' | 'sideOffset'>) {
  return (
    <TooltipPrimitive.Portal>
      {/* Portalled to the body, so no ancestor's `overflow` can clip it and no ancestor
          `transform` can trap it — the latter being why hover-lift cards used to break
          tooltips, and only while hovered. */}
      <TooltipPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="z-(--z-tooltip)"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          data-ws-overlay=""
          className={cn(
            'max-w-xs origin-(--transform-origin) rounded-md border border-line-strong',
            'bg-bg-elevated px-2.5 py-1.5 text-xs text-ink shadow-float',
            'text-pretty',
            className,
          )}
          {...props}
        >
          {children}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
