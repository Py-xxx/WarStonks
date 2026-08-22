/**
 * EmptyState — what a panel shows when it has nothing to show.
 *
 * Home had six of these and every one was the same centred grey sentence, which is the visual
 * signature of a screen nobody designed. Structure (medallion, line, optional detail) follows
 * the empty patterns in `ui-reference/watermelon` (MIT); the sizing is ours, because theirs are
 * built for full-page states and these sit in 276px rail panels.
 *
 * `action` is optional and holds the one control that resolves the state — "Open Scanners" for a
 * missing scan, "Retry" for a failed load. An empty state that names a cause without offering the
 * fix makes the user go and find it; three of Farm Now's gates exist precisely to route somewhere.
 *
 * The `tone` distinction is the point of the component. "Nothing on the watchlist yet" is an
 * absence the user should fix, but "No plays right now" means the board is clear and you are
 * caught up — the same treatment for both tells the user nothing. `positive` says done;
 * `neutral` says empty.
 */
import { cn } from '@/lib/utils';

const TONE_CLASS = {
  neutral: 'bg-bg-elevated text-ink-faint',
  positive: 'bg-accent-green/12 text-accent-green',
} as const;

function EmptyState({
  icon,
  title,
  detail,
  action,
  tone = 'neutral',
  className,
  ...props
}: Omit<React.ComponentProps<'div'>, 'title'> & {
  /** Tabler glyph name, e.g. `ti-checks`. */
  icon: string;
  title: string;
  detail?: string;
  /** The single control that resolves this state. */
  action?: React.ReactNode;
  tone?: keyof typeof TONE_CLASS;
}) {
  return (
    <div
      data-slot="empty-state"
      className={cn('flex flex-col items-center gap-2 px-3 py-6 text-center', className)}
      {...props}
    >
      <span
        className={cn('grid size-8 place-items-center rounded-full text-base', TONE_CLASS[tone])}
        aria-hidden="true"
      >
        <i className={`ti ${icon}`} />
      </span>
      <span className="text-xs font-medium text-ink-soft">{title}</span>
      {detail ? <span className="text-[11px] text-ink-dim">{detail}</span> : null}
      {action ? <span className="mt-1">{action}</span> : null}
    </div>
  );
}

export { EmptyState };
