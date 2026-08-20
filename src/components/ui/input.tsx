/**
 * Input — adapted from shadcn/ui's Base UI input (MIT), in `ui-reference/shadcn-vite`.
 *
 * Changes from the source: `dark:` variants dropped (one theme), colours on our tokens, and
 * `appearance-none` plus an explicit font added — without Tailwind's preflight (deliberately
 * not imported during the migration) a native `<input>` keeps the UA's own border, background
 * and system font, which is the same trap that made `outline` buttons render as light pills.
 *
 * `tabular-nums` is NOT applied here by default: an input holding a name should use
 * proportional figures. Numeric inputs must opt in — `<Input className="tabular-nums" />` —
 * which is the one place the skill's "when in doubt, apply it" rule is inverted, because the
 * component cannot know what it holds.
 */
import { Input as InputPrimitive } from '@base-ui/react/input';

import { cn } from '@/lib/utils';

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        'h-8 w-full min-w-0 appearance-none rounded-md border border-line-strong',
        'bg-bg-base px-2 font-sans text-xs text-ink',
        'placeholder:text-ink-faint',
        'transition-[border-color,box-shadow] duration-150 ease-out',
        'outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
