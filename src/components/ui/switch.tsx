/**
 * Switch — adapted from `ui-reference/watermelon/src/components/base-ui/switch.tsx` (MIT), which
 * is actually Radix under the name; this is the same anatomy rebuilt on Base UI's `Switch`.
 *
 * Why it exists: the app shipped **four** hand-rolled switches — Trades' listing visibility, the
 * auto-buy-order toggle in the Trades hero, Smart Manage's per-listing enable, and Portfolio's
 * Keep toggle — each a raw `<button>` with its own track/thumb CSS, its own size, and its own
 * idea of what "on" looks like. They were also the last thing keeping Trades and Portfolio out of
 * `MIGRATED_GLOBS`.
 *
 * Changes from the source:
 * - Radix → Base UI, so it emits `data-checked` / `data-unchecked` like every other primitive here.
 * - Sizes cut to `sm` (20×12) and `default` (26×15). Watermelon's 32px default is a touch target;
 *   this is a dense desktop app and a switch sits inline beside 11px labels.
 * - `dark:` variants dropped (one theme) and colours on our tokens.
 * - **`tone`**: `default` (blue) for a neutral preference, `positive` (green) where on/off means
 *   visible/hidden or live/paused, and `accent` (purple) for Smart Manage, which owns purple
 *   across the app. Tone colours the *track*, never the label — accents carry meaning here.
 * - `transition-transform`/`transition-colors` are named, never bare `transition`: a switch can
 *   sit in a row that re-renders on every poll.
 *
 * The invisible `after:` hit-area expansion from the source is kept: the control is 15px tall and
 * the rule is 40px for a standalone target, which a pseudo-element buys without layout cost.
 */
import { Switch as SwitchPrimitive } from '@base-ui/react/switch';

import { cn } from '@/lib/utils';

const TONE_CHECKED: Record<'default' | 'positive' | 'accent', string> = {
  default: 'data-checked:bg-accent-blue',
  positive: 'data-checked:bg-accent-green',
  accent: 'data-checked:bg-accent-purple',
};

function Switch({
  className,
  size = 'default',
  tone = 'default',
  ...props
}: SwitchPrimitive.Root.Props & {
  size?: 'sm' | 'default';
  tone?: 'default' | 'positive' | 'accent';
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        'group/switch relative inline-flex shrink-0 cursor-pointer items-center rounded-full',
        'border border-transparent p-0.5 outline-none',
        'after:absolute after:-inset-x-2 after:-inset-y-3',
        'transition-[background-color,box-shadow] duration-150 ease-out',
        'focus-visible:ring-2 focus-visible:ring-ring/40',
        'data-unchecked:bg-line-strong',
        'data-disabled:cursor-not-allowed data-disabled:opacity-50',
        size === 'sm' ? 'h-3 w-5' : 'h-[15px] w-[26px]',
        TONE_CHECKED[tone],
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          'pointer-events-none block rounded-full bg-ink shadow-sm',
          'transition-transform duration-150 ease-out',
          'data-checked:bg-bg-base',
          size === 'sm'
            ? 'size-2 data-checked:translate-x-2'
            : 'size-[11px] data-checked:translate-x-[11px]',
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
