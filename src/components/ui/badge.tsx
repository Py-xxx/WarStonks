/**
 * Badge — a short tinted label attached to something else.
 *
 * The app had **five** of these. `legacy.css`'s `.badge` + `.badge-*` (mono 10px, `2px 7px`,
 * radius 4), `AlertsPanel`'s `BADGE_CLASS`, `OpportunityCard`'s exported `BADGE_CLASS` (whose
 * callers each rebuilt the wrapper by hand), `FarmNow`'s inline pill at 9px, and Scanners'
 * `ScanPill` at 9px uppercase. They agreed on the tone tints and on almost nothing else — two
 * font sizes, three paddings, and tabular-nums on some of the numeric ones but not others.
 *
 * Kept as a **pill**, deliberately. `ELEMENTS.md` §4 prescribes plain coloured uppercase text for
 * a *status label* in a panel header, where there is whitespace around it; a badge here sits
 * inline beside an item name or inside a dense table cell, where bare coloured text reads as part
 * of its neighbour. `OpportunityConfidence` remains the plain-text treatment and is not a Badge.
 *
 * `tabular-nums` is unconditional: badges routinely hold a figure (`8p`, `3/6`, a count) and it
 * costs nothing on the ones that don't.
 */
import { cn } from '@/lib/utils';

/** The accents keep their meaning here: green profit, red loss, amber warning, purple sets. */
const TONE_CLASS = {
  green: 'bg-accent-green/15 text-accent-green',
  amber: 'bg-accent-amber/15 text-accent-amber',
  red: 'bg-accent-red/15 text-accent-red',
  blue: 'bg-accent-blue/15 text-accent-blue',
  purple: 'bg-accent-purple/15 text-accent-purple',
  neutral: 'bg-bg-elevated text-ink-dim',
} as const;

/** `sm` is for a badge sitting inside a row title beside an item name, where the 10px version
 *  competes with the name itself. */
const SIZE_CLASS = {
  default: 'px-1.5 py-0.5 text-[10px]',
  sm: 'px-1 py-px text-[9px]',
} as const;

export type BadgeTone = keyof typeof TONE_CLASS;

function Badge({
  tone = 'neutral',
  size = 'default',
  uppercase = false,
  className,
  ...props
}: React.ComponentProps<'span'> & {
  tone?: BadgeTone;
  size?: keyof typeof SIZE_CLASS;
  /** Adds the letter-spacing with it — uppercase without tracking sets too tight at 9px. */
  uppercase?: boolean;
}) {
  return (
    <span
      data-slot="badge"
      className={cn(
        'shrink-0 rounded font-mono font-semibold whitespace-nowrap tabular-nums',
        SIZE_CLASS[size],
        TONE_CLASS[tone],
        uppercase && 'tracking-[0.04em] uppercase',
        className,
      )}
      {...props}
    />
  );
}

export { Badge, TONE_CLASS as BADGE_TONE_CLASS };
