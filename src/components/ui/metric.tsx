/**
 * Metric / MetricGrid — a labelled figure, and a set of them.
 *
 * This is the **metric strip** already registered in `ELEMENTS.md` §2, finally made a component.
 * Market alone hand-rolled it 35 times as `.market-metric-card`, and Trades → Health, Quick View
 * and Portfolio each have their own copy.
 *
 * The one deliberate change from the shipped versions: **no border and no background.** The old
 * `.market-metric-card` was a bordered, tinted box, so a four-metric panel rendered as four boxes
 * inside a box inside a grid — three levels of border doing one job, and the page read as a wall
 * of rectangles with nowhere for the eye to rest.
 *
 * Per `ELEMENTS.md` §5c: space separates, borders claim two things are genuinely different
 * regions. Four metrics in one panel are not four regions. They are one region with four figures
 * in it, and generous spacing says that better than any border can.
 *
 * Density is unaffected — this holds exactly the same facts in the same space. It removes
 * ornament, not information.
 */
import { cn } from '@/lib/utils';

type MetricTone = 'neutral' | 'green' | 'amber' | 'red' | 'blue';

const TONE_CLASS: Record<MetricTone, string> = {
  neutral: 'text-ink',
  green: 'text-accent-green',
  amber: 'text-accent-amber',
  red: 'text-accent-red',
  blue: 'text-accent-blue',
};

function Metric({
  label,
  value,
  tone = 'neutral',
  hint,
  className,
  ...props
}: Omit<React.ComponentProps<'div'>, 'children'> & {
  label: string;
  value: React.ReactNode;
  tone?: MetricTone;
  /** Optional trailing node — an InfoHint, a delta, a unit. */
  hint?: React.ReactNode;
}) {
  return (
    <div data-slot="metric" className={cn('flex min-w-0 flex-col gap-1', className)} {...props}>
      <span className="flex min-w-0 items-center gap-1 font-mono text-[9px] tracking-[0.07em] text-ink-dim uppercase">
        <span className="truncate">{label}</span>
        {hint}
      </span>
      {/* `tabular-nums` unconditionally: these are polled figures, and the rule is to apply it
          wherever a number can change rather than reason about which face it lands in. */}
      <span className={cn('font-mono text-sm font-bold tabular-nums', TONE_CLASS[tone])}>
        {value}
      </span>
    </div>
  );
}

/**
 * A row of metrics. `gap-x-6` is the point — it is what replaces the borders, and it is
 * deliberately wider than the old 10px grid gap.
 */
function MetricGrid({
  className,
  columns = 2,
  ...props
}: React.ComponentProps<'div'> & { columns?: 2 | 3 | 4 }) {
  const columnClass =
    columns === 4
      ? 'grid-cols-2 lg:grid-cols-4'
      : columns === 3
        ? 'grid-cols-2 lg:grid-cols-3'
        : 'grid-cols-2';
  return (
    <div
      data-slot="metric-grid"
      className={cn('grid gap-x-6 gap-y-4', columnClass, className)}
      {...props}
    />
  );
}

export { Metric, MetricGrid };
