/**
 * Stat — the app's summary figure.
 *
 * Lineage matters here, because this file changed purpose. It began as a faithful port of the
 * shipped `.info-card` (`legacy.css:9375-9396`) — mono 9px label over a mono 18px value on a
 * bordered rectangle. That port was *correct* and also the problem: matching the shipped app
 * exactly is how the redesign kept arriving at the shipped app's visual quality.
 *
 * This is now the standard rather than a copy of one. The structure — icon medallion, label,
 * then a large value on its own line — is adapted from the `web3-dashboard` stat card in
 * `ui-reference/watermelon` (MIT). Changes from that source:
 * - Their glossy `inset` highlight on a fully saturated medallion is dropped for a 15% tint with
 *   the icon in the accent itself. On a near-black ground the candy treatment reads as a toy,
 *   and a solid accent block that large starts competing with the data.
 * - Their `text-3xl` value is kept — the typographic contrast is the entire point. Every figure
 *   on Home used to sit between 9px and 18px, which is why the page had no focal point.
 * - Colours are our tokens, so accents keep their meaning: green profit, red loss, amber warning.
 *
 * The label stays mono 9px/.07em from the original `.info-card`, so a `Stat` still reads as part
 * of the same family as an un-migrated page's stat during the transition.
 */
import { cn } from '@/lib/utils';

type StatTone = 'neutral' | 'positive' | 'negative' | 'muted';

const VALUE_CLASS: Record<StatTone, string> = {
  neutral: 'text-ink',
  positive: 'text-accent-green',
  negative: 'text-accent-red',
  muted: 'text-ink-dim',
};

const MEDALLION_CLASS: Record<StatTone, string> = {
  neutral: 'bg-accent-blue/12 text-accent-blue',
  positive: 'bg-accent-green/12 text-accent-green',
  negative: 'bg-accent-red/12 text-accent-red',
  muted: 'bg-bg-elevated text-ink-faint',
};

function Stat({
  label,
  value,
  icon,
  tone = 'neutral',
  className,
  ...props
}: Omit<React.ComponentProps<'div'>, 'children'> & {
  label: string;
  value: string;
  /** Tabler glyph name, e.g. `ti-target`. Icons are 16px — one of the three token sizes. */
  icon?: string;
  tone?: StatTone;
}) {
  return (
    <div
      data-slot="stat"
      className={cn(
        'flex min-w-0 flex-col gap-3 rounded-lg border border-line bg-bg-panel p-3',
        className,
      )}
      {...props}
    >
      <div className="flex min-w-0 items-center gap-2">
        {icon ? (
          <span
            className={cn(
              'grid size-7 shrink-0 place-items-center rounded-md text-base',
              MEDALLION_CLASS[tone],
            )}
            aria-hidden="true"
          >
            <i className={`ti ${icon}`} />
          </span>
        ) : null}
        <span className="truncate font-mono text-[9px] tracking-[0.07em] text-ink-dim uppercase">
          {label}
        </span>
      </div>
      {/* `tabular-nums` even though this is mono: these counts re-derive on every poll, and the
          rule is to apply it wherever a number can change rather than reason about the face. */}
      <span
        className={cn(
          'font-mono text-3xl leading-none font-bold tracking-tight tabular-nums',
          VALUE_CLASS[tone],
        )}
      >
        {value}
      </span>
    </div>
  );
}

export { Stat };
