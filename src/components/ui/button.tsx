/**
 * Button — adapted from shadcn/ui's Base UI button (MIT), in `ui-reference/shadcn-vite`.
 *
 * Changes from the source:
 * - Colours moved onto our tokens.
 * - `transition-all` replaced with named properties. The source uses `transition-all`, which
 *   the interface-polish skill forbids: our panels re-render on every poll, so watching every
 *   animatable property is real cost, and incidental style changes animate visibly.
 * - Press feedback is `active:scale-[0.96]` (the skill's fixed value) rather than the source's
 *   `translate-y-px`, and it is opt-out via `static` for rows and dense contexts.
 * - Sizes shifted up slightly: the source's default is `h-7`, which is tight for a desktop app
 *   driven by mouse rather than a marketing page.
 */
import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const buttonVariants = cva(
  [
    // `appearance-none bg-transparent font-sans` neutralises the browser's native control
    // styling. Tailwind's preflight would normally do this, but we deliberately don't import
    // it during the migration (see src/index.css) — so without these, any variant that sets no
    // background of its own renders with the UA's light grey button face, which is exactly how
    // `outline` and `ghost` first shipped. twMerge drops `bg-transparent` when a variant
    // supplies a real background, so this is safe as a base.
    'appearance-none bg-transparent font-sans',
    'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap',
    'rounded-md border border-transparent font-medium select-none',
    'outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:border-ring',
    'disabled:pointer-events-none disabled:opacity-50',
    // Named properties only — never `transition-all`.
    'transition-[background-color,border-color,color,box-shadow,scale] duration-150 ease-out',
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ],
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/85',
        secondary: 'bg-bg-elevated text-ink hover:bg-line-strong',
        outline: 'border-line-strong text-ink hover:bg-bg-elevated',
        ghost: 'text-ink-dim hover:bg-bg-elevated hover:text-ink',
        destructive: 'bg-accent-red/15 text-accent-red hover:bg-accent-red/25',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-7 px-2 text-xs',
        default: 'h-8 px-3 text-xs',
        lg: 'h-9 px-4 text-sm',
        icon: 'size-8',
        'icon-sm': 'size-7',
      },
      /** Disables press feedback. Use in dense rows, where a shrinking control reads as broken. */
      static: { true: '', false: 'active:scale-[0.96]' },
    },
    defaultVariants: { variant: 'default', size: 'default', static: false },
  },
);

function Button({
  className,
  variant,
  size,
  static: isStatic,
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, static: isStatic, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
