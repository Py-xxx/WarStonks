/**
 * Select — a styled native `<select>`.
 *
 * Deliberately **not** Base UI's `Select`, which is a portalled popup with its own positioner. The
 * two things this app selects between are short lists of plain words (relic era, sort order); a
 * native control gets keyboard behaviour, type-ahead and mobile pickers for free, and renders its
 * option list through the OS, so there is no overlay for us to position and no z-index to spend.
 * Reach for Base UI's version only when an option needs rich content — an icon, a second line, a
 * value — which a native `<option>` cannot hold.
 *
 * `appearance-none` and the explicit font are the same non-negotiables as `Input` and `Button`:
 * Tailwind's preflight is deliberately not imported during the migration, so without them a native
 * select keeps the UA's light grey control face. That is what `<select>` looked like everywhere on
 * the Farm Now tab before this existed.
 *
 * The chevron is a sibling span rather than a background-image, so it inherits the disabled and
 * focus colours instead of being a fixed-colour asset.
 */
import { cn } from '@/lib/utils';

function Select({
  className,
  children,
  ...props
}: Omit<React.ComponentProps<'select'>, 'size'>) {
  return (
    <span className="relative inline-flex min-w-0 items-center">
      <select
        data-slot="select"
        className={cn(
          'h-7 w-full min-w-0 appearance-none rounded-md border border-line-strong',
          'bg-bg-base py-0 pr-7 pl-2 font-sans text-[11px] text-ink',
          'transition-[border-color,box-shadow] duration-150 ease-out',
          'outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30',
          'disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <i
        className="ti ti-chevron-down pointer-events-none absolute right-2 text-[12px] text-ink-dim"
        aria-hidden="true"
      />
    </span>
  );
}

export { Select };
