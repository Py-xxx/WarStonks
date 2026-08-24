/**
 * The shared furniture inside Market's panels.
 *
 * `AnalyticsPanel` (the panel shell) migrated in an earlier pass; its **contents** did not, and
 * that is where the remaining ~190 legacy classes live. This file is the first chunk of that:
 * the small elements repeated across the Overview panels.
 *
 * **The consolidation that mattered here:** `market-signal-*` and `qv-meter-*` were two
 * implementations of the same thing — a labelled bar with a tone-coloured value — differing only
 * in which CSS file's gradient they used. `QvMeter` was already registered in `ELEMENTS.md` §3 as
 * "the labelled signal bar", so the signal board was a second version of a registered element.
 * `SignalMeter` here is the one implementation; Quick View and the demand/risk boards both use it.
 */
import { cn } from '@/lib/utils';

export type MarketTone = 'neutral' | 'blue' | 'green' | 'amber' | 'red' | 'cyan';

const VALUE_TONE: Record<MarketTone, string> = {
  neutral: 'text-ink',
  blue: 'text-accent-blue',
  green: 'text-accent-green',
  amber: 'text-accent-amber',
  red: 'text-accent-red',
  cyan: 'text-accent-blue',
};

const FILL_TONE: Record<MarketTone, string> = {
  neutral: 'bg-ink-faint',
  blue: 'bg-accent-blue',
  green: 'bg-accent-green',
  amber: 'bg-accent-amber',
  red: 'bg-accent-red',
  cyan: 'bg-accent-blue',
};

/**
 * A labelled bar. **The fill must plot a real value** — its `market-signal-fill` predecessor took
 * a tone and its `qv-meter-fill` twin took a fraction, and one of the two was picking 0.92/0.58/
 * 0.18 from a tone rather than measuring anything (`market-inventory.md` §4).
 *
 * `fill` is a 0–1 fraction and is clamped here so a caller cannot overflow the track.
 */
export function SignalMeter({
  label,
  value,
  fill,
  tone = 'blue',
}: {
  label: string;
  value: string;
  fill: number;
  tone?: MarketTone;
}) {
  const pct = Math.round(Math.min(1, Math.max(0, fill)) * 100);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate font-mono text-[9px] tracking-[0.07em] text-ink-dim uppercase">
          {label}
        </span>
        <span className={cn('shrink-0 font-mono text-xs font-semibold tabular-nums', VALUE_TONE[tone])}>
          {value}
        </span>
      </div>
      <span className="block h-1.5 overflow-hidden rounded-full bg-bg-base" aria-hidden="true">
        <span
          className={cn('block h-full rounded-full', FILL_TONE[tone])}
          style={{ width: `${pct}%` }}
        />
      </span>
    </div>
  );
}

/**
 * A status label. Plain coloured uppercase text, **not a pill** — the treatment `ELEMENTS.md` §4
 * pins, and what `market-inventory.md` §5 already decided for this page. `.market-panel-badge` was
 * still rendering a bordered, tinted, rounded-full pill in seven places, which is the treatment
 * that decision replaced.
 */
export function MarketStatus({ tone = 'neutral', children }: { tone?: MarketTone; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'shrink-0 font-mono text-[10px] font-semibold tracking-[0.08em] uppercase',
        tone === 'neutral' ? 'text-ink-dim' : VALUE_TONE[tone],
      )}
    >
      {children}
    </span>
  );
}

/** A small chip for a named signal — "price war", "thin book". Repeated, never unique. */
export function MarketChip({ tone = 'neutral', children }: { tone?: MarketTone; children: React.ReactNode }) {
  const CHIP: Record<MarketTone, string> = {
    neutral: 'bg-bg-elevated text-ink-dim',
    blue: 'bg-accent-blue/15 text-accent-blue',
    green: 'bg-accent-green/15 text-accent-green',
    amber: 'bg-accent-amber/15 text-accent-amber',
    red: 'bg-accent-red/15 text-accent-red',
    cyan: 'bg-accent-blue/15 text-accent-blue',
  };
  return (
    <span
      className={cn(
        'shrink-0 rounded px-1.5 py-px font-mono text-[9px] font-semibold tracking-[0.04em]',
        CHIP[tone],
      )}
    >
      {children}
    </span>
  );
}

/**
 * A signed figure over a proportional bar — the slope cards.
 *
 * The bar is **magnitude, not sign**: direction is already carried by the value's colour and its
 * `+`/`−`, so plotting a negative as a shorter bar would say the same thing twice and make a
 * steep fall look like a small one.
 */
export function SlopeCard({
  label,
  value,
  magnitude,
  positive,
}: {
  label: string;
  value: string;
  magnitude: number;
  positive: boolean;
}) {
  const pct = Math.round(Math.min(1, Math.max(0, magnitude)) * 100);
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-md bg-bg-base p-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate font-mono text-[9px] tracking-[0.07em] text-ink-dim uppercase">
          {label}
        </span>
        <span
          className={cn(
            'shrink-0 font-mono text-xs font-semibold tabular-nums',
            positive ? 'text-accent-green' : 'text-accent-red',
          )}
        >
          {value}
        </span>
      </div>
      <span className="block h-1 overflow-hidden rounded-full bg-bg-panel" aria-hidden="true">
        <span
          className={cn('block h-full rounded-full', positive ? 'bg-accent-green' : 'bg-accent-red')}
          style={{ width: `${pct}%` }}
        />
      </span>
    </div>
  );
}

/** A key/value line inside a panel — the smallest repeated shape on the page. */
export function MarketFact({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: React.ReactNode;
  tone?: MarketTone;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="min-w-0 shrink-0 font-mono text-[10px] tracking-[0.04em] text-ink-dim">
        {label}
      </span>
      <span className={cn('truncate text-right font-mono text-[11px] tabular-nums', VALUE_TONE[tone])}>
        {value}
      </span>
    </div>
  );
}
