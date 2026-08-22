import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * The `i` beside a metric — **the app's only info hint**.
 *
 * There were three. This file used to hold a portal with 60-odd lines of
 * `getBoundingClientRect` clamping; Market's page held a second, already rebuilt on the `Tooltip`
 * primitive; Trades held a third that was pure CSS (`info-hint-tooltip left`) and so could not
 * flip, clamp, or escape a panel's overflow. Market's was the good one, so it moved here and the
 * other two were deleted.
 *
 * How that happened is worth remembering: `ELEMENTS.md` recorded the migrated hint as living in
 * `pages/Market/index.tsx`, so a later pass that reached for `components/InfoHint` — the obvious
 * name — silently picked up the old implementation. **A migrated element belongs at the obvious
 * import path**, not only in the register.
 *
 * The trigger is the padded wrapper, not the glyph. The dot is 16px, but a 16px hover target is a
 * coin-flip with a mouse — a 14px one read as "the tooltips don't work", because you mostly missed
 * it. `p-1.5 -m-1.5` gives a 28px target and cancels its own layout impact, so nothing shifts.
 * Still under the skill's 40×40 for standalone controls: 40px next to a 13px panel title would
 * swamp it. The density exception, applied honestly.
 *
 * Colour is `ink-dim` (~5:1), not `ink-faint` (~2:1, under the 3:1 non-text floor).
 */

/** Kept so existing call sites type-check. Base UI does real collision detection, so the hint no
 *  longer needs to be told where to go — the value is accepted and ignored. */
export type InfoHintPlacement = 'auto' | 'bottom' | 'left';

export function InfoHint({ text }: { text: string; placement?: InfoHintPlacement }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            aria-label={text}
            className="-m-1.5 inline-flex cursor-help p-1.5 text-ink-dim outline-none transition-colors duration-150 ease-out hover:text-ink focus-visible:text-ink"
          />
        }
      >
        <span className="grid size-4 place-items-center rounded-full border border-current text-[10px] leading-none font-bold">
          i
        </span>
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );
}
