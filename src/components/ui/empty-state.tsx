/**
 * EmptyState — what a panel shows when it has nothing to show.
 *
 * Home had six of these and every one was the same centred grey sentence, which is the visual
 * signature of a screen nobody designed. Structure (medallion, line, optional detail) follows
 * the empty patterns in `ui-reference/watermelon` (MIT); the sizing is ours, because theirs are
 * built for full-page states and these sit in 276px rail panels.
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
  tone = 'neutral',
  className,
  ...props
}: Omit<React.ComponentProps<'div'>, 'title'> & {
  /** Tabler glyph name, e.g. `ti-checks`. */
  icon: string;
  title: string;
  detail?: string;
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
    </div>
  );
}

export { EmptyState };
