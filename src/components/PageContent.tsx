import { cn } from '@/lib/utils';

/**
 * The scroll area every page renders below its `PageHeading`.
 *
 * The last shared class in `legacy.css` — `.page-content`, `padding: 20px; flex: 1;
 * overflow-y: auto` — across 13 call sites. It is a component rather than a copied class string
 * for one reason: **`stack` bakes in `[&>*]:shrink-0`**, and forgetting that has already shipped
 * a bug.
 *
 * A column flex container shrinks its children, so a `flex flex-col` scroll area resolves
 * overflow by squashing its short children instead of scrolling. The Events world clock
 * *vanished* on Normal fissures (14 rows, page overflows) and reappeared on Steel Path (fewer
 * rows, fits) — a bug that looked like a data problem and wasn't. Every call site that made this
 * a column had to remember the fix; now none of them do.
 *
 * `stack` is also where §6's rule lands: the container owns vertical rhythm, children carry no
 * margins.
 */

/** Tailwind needs the literal class, so the gaps in use are enumerated rather than interpolated. */
const GAP_CLASS = { 3: 'gap-3', 4: 'gap-4', 5: 'gap-5' } as const;

export function PageContent({
  stack = false,
  gap = 4,
  className,
  ...props
}: React.ComponentProps<'div'> & {
  /** Lay the children out as a column with a gap — and with the shrink fix above. */
  stack?: boolean;
  gap?: keyof typeof GAP_CLASS;
}) {
  return (
    <div
      data-slot="page-content"
      className={cn(
        'flex-1 overflow-y-auto p-5',
        stack && `flex flex-col ${GAP_CLASS[gap]} [&>*]:shrink-0`,
        className,
      )}
      {...props}
    />
  );
}
