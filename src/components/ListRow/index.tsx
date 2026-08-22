import { Button } from '@/components/ui/button';

/**
 * The furniture every expandable list page in this app is built from.
 *
 * Opportunities' three list pages — What To Farm Now, the Set Completion Planner and (next)
 * Scanners — are the same object at heart: a row you can scan, carrying art, a name, a couple of
 * right-aligned figures, that opens to a detail body. They had three separate implementations,
 * which is how the app ended up with rows that differed in border, hover, chevron and thumbnail
 * size on pages the user reads one after the other.
 *
 * Extracted when the Planner became the second consumer, rather than after the third.
 */

/**
 * Item art, or the first characters of its name. The picture is the fastest identifier the game
 * gives us; the initials fallback keeps the column aligned when art is missing.
 *
 * `chrome` draws the thumbnail box — a filled square with a hairline outline — which is right for
 * a part icon sitting on the panel ground. **Relics turn it off:** their art is a shaped icon on
 * transparency, so a box around it reads as a chip drawn around a picture rather than as the
 * picture itself. The container keeps its size either way, so nothing shifts.
 */
export function ItemThumb({
  src,
  fallback,
  size,
  chrome = true,
}: {
  src: string | null;
  fallback: string;
  size: string;
  chrome?: boolean;
}) {
  return (
    <span
      className={`grid ${size} shrink-0 place-items-center overflow-hidden font-mono text-[10px] text-ink-faint ${
        chrome ? 'rounded-md bg-bg-base outline outline-1 -outline-offset-1 outline-white/10' : ''
      }`}
      aria-hidden="true"
    >
      {/* `contain`, not `cover`: item art is a silhouette that must not be cropped to fill. */}
      {src ? <img src={src} alt="" loading="lazy" className="size-full object-contain" /> : fallback}
    </span>
  );
}

/** One right-aligned figure with its label above, for a collapsed row's metrics. Fixed width so
 *  the numbers form a column you can read down rather than tracking each row's own alignment. */
export function RowMetric({
  label,
  value,
  tone,
  width = 'w-20',
}: {
  label: string;
  value: string;
  tone?: 'positive' | 'negative';
  width?: string;
}) {
  return (
    <span className={`flex ${width} shrink-0 flex-col items-end gap-0.5`}>
      <span className="font-mono text-[9px] tracking-[0.07em] text-ink-faint uppercase">
        {label}
      </span>
      <span
        className={`font-mono text-[13px] font-bold tabular-nums ${
          tone === 'positive'
            ? 'text-accent-green'
            : tone === 'negative'
              ? 'text-accent-red'
              : 'text-ink'
        }`}
      >
        {value}
      </span>
    </span>
  );
}

/**
 * A labelled group inside an expanded row.
 *
 * The split is the point wherever it is used: the drops worth farming have to stand apart from the
 * Forma-tier filler, and the parts you still need from the ones you already have — otherwise every
 * line looks equally important and the row answers nothing.
 */
export function DetailGroup({
  label,
  tone,
  children,
}: {
  label: string;
  tone: 'primary' | 'muted';
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span
        className={`font-mono text-[9px] font-bold tracking-[0.07em] uppercase ${
          tone === 'primary' ? 'text-accent-amber' : 'text-ink-faint'
        }`}
      >
        {label}
      </span>
      <div className={`flex flex-col gap-1 ${tone === 'muted' ? 'opacity-60' : ''}`}>{children}</div>
    </div>
  );
}

/**
 * The accordion shell. One open at a time is the caller's business; this owns the frame.
 *
 * `aside` renders **outside** the toggle button, between the head and the chevron. That is not a
 * styling convenience: the Planner's completed sets carry their own "Sell now" control, and an
 * interactive element cannot legally nest inside a `<button>`. Where a page has no such control it
 * simply omits `aside`, and the chevron closes up against the head.
 *
 * Both the head and the chevron toggle, so the row stays operable from the keyboard either way.
 */
export function ListRow({
  expanded,
  onToggle,
  head,
  aside,
  toggleLabel,
  tone,
  children,
}: {
  expanded: boolean;
  onToggle: () => void;
  head: React.ReactNode;
  aside?: React.ReactNode;
  /** `aria-label` for the chevron. The head button is labelled by its own contents. */
  toggleLabel: string;
  /** A left edge in an accent, for rows that carry a status worth seeing before you read them. */
  tone?: 'green' | 'amber';
  children: React.ReactNode;
}) {
  const toneClass =
    tone === 'green'
      ? 'border-l-[3px] border-l-accent-green'
      : tone === 'amber'
        ? 'border-l-[3px] border-l-accent-amber'
        : '';

  return (
    <article
      className={`overflow-hidden rounded-lg border bg-bg-elevated transition-[border-color] duration-150 ease-out ${toneClass} ${
        expanded ? 'border-line-strong' : 'border-line hover:border-line-strong'
      }`}
    >
      <div className="flex items-stretch">
        <Button
          variant="ghost"
          static
          aria-expanded={expanded}
          onClick={onToggle}
          className="h-auto min-w-0 flex-1 justify-start gap-3 rounded-none px-3 py-2.5 text-left hover:bg-white/[0.03]"
        >
          {head}
        </Button>

        {aside ? <div className="flex shrink-0 items-center pr-1 pl-2">{aside}</div> : null}

        <Button
          variant="ghost"
          size="icon"
          static
          aria-expanded={expanded}
          aria-label={toggleLabel}
          onClick={onToggle}
          className="h-auto shrink-0 rounded-none px-2 text-ink-dim hover:bg-white/[0.03]"
        >
          <i className={`ti ${expanded ? 'ti-chevron-up' : 'ti-chevron-down'}`} aria-hidden="true" />
        </Button>
      </div>

      {expanded ? (
        <div className="flex flex-col gap-3 border-t border-line p-3">{children}</div>
      ) : null}
    </article>
  );
}
