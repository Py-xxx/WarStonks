/**
 * Scanners' own furniture.
 *
 * **The point of this pass is that most of it should not exist.** Both scanner result rows —
 * Arbitrage's sets and Relic ROI's relics — were the `sp-set*` accordion markup copied out of the
 * Set Completion Planner: an `<article>` with a `<button>` head carrying a rank, a thumbnail, a
 * title, a subtitle and right-aligned metrics, opening to a body. That is `components/ListRow`,
 * which was extracted for exactly this and which the handoff has listed Scanners as "the third
 * consumer of" since it was written. Both rows now compose it.
 *
 * What genuinely is Scanners-specific stays here: the rank badge, the status pill, and the
 * component/drop row that both result types nest.
 */
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Metric, MetricGrid } from '@/components/ui/metric';
import { Panel } from '@/components/ui/panel';
import { cn } from '@/lib/utils';
import { ItemThumb } from '../../components/ListRow';

/** The result's position in the ranking. Scanners is the only page that ranks its rows. */
export function ScanRank({ index }: { index: number }) {
  return (
    <span className="w-5 shrink-0 text-center font-mono text-[11px] tabular-nums text-ink-faint">
      {index + 1}
    </span>
  );
}

/**
 * A status pill — confidence, vaulted/unvaulted, rarity.
 *
 * Kept as a **pill** rather than the plain coloured text `ELEMENTS.md` §4 prescribes for status
 * labels, and deliberately: on this page the label sits inline *inside a row title*, next to the
 * item name, where bare coloured text reads as part of the name. The register's treatment is for
 * a status in a panel header, which has whitespace around it. Same information, different
 * neighbours.
 */
export function ScanPill({
  tone = 'muted',
  children,
}: {
  tone?: 'green' | 'blue' | 'amber' | 'red' | 'muted';
  children: React.ReactNode;
}) {
  return (
    <Badge size="sm" uppercase tone={tone === 'muted' ? 'neutral' : tone} className="px-1.5">
      {children}
    </Badge>
  );
}

/** A titled group inside an expanded row — "Parts to buy", "Prime rewards". */
export function ScanGroup({
  label,
  meta,
  actions,
  children,
}: {
  label: string;
  meta?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[9px] font-semibold tracking-[0.1em] text-ink-dim uppercase">
          {label}
        </span>
        {meta ? <span className="text-[10px] text-ink-faint">{meta}</span> : null}
        {actions ? <span className="ml-auto flex items-center gap-1.5">{actions}</span> : null}
      </div>
      {children}
    </div>
  );
}

/**
 * A component of a set, or a drop from a relic. Both are the same object: art, a name, a badge or
 * two, and a small metric grid — with the arbitrage version adding a target-price input and an
 * Add button on the right.
 */
export function ScanItemRow({
  imageUrl,
  fallback,
  name,
  badges,
  metrics,
  actions,
  relicArt = false,
}: {
  imageUrl: string | null;
  fallback: string;
  name: React.ReactNode;
  badges?: React.ReactNode;
  metrics: Array<{ label: string; value: React.ReactNode }>;
  actions?: React.ReactNode;
  /** Relic art draws no thumbnail chrome — see `ELEMENTS.md` §7. */
  relicArt?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2.5 rounded-md border border-line bg-bg-base px-2.5 py-2">
      <ItemThumb src={imageUrl} fallback={fallback} size="size-8" chrome={!relicArt} />
      <div className="flex min-w-40 flex-1 flex-col gap-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[11px] font-medium text-ink">{name}</span>
          {badges}
        </span>
        <MetricGrid columns={3} className="gap-x-4 gap-y-1">
          {metrics.map((metric) => (
            <Metric key={metric.label} label={metric.label} value={metric.value} />
          ))}
        </MetricGrid>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
    </div>
  );
}

/**
 * The header above a result list: what the scan found, and the best figure in it.
 *
 * Both tabs had this markup inline and identical apart from the icon and the labels, so a change
 * to one silently left the other behind.
 */
export function ScanSummary({
  icon,
  title,
  subtitle,
  stats,
}: {
  icon: string;
  title: string;
  subtitle: string;
  stats: Array<{ label: string; value: string; positive?: boolean }>;
}) {
  return (
    <Panel className="flex-row flex-wrap items-center gap-4 px-3 py-2.5">
      <span className="flex min-w-0 flex-1 items-center gap-2.5">
        <span
          className="grid size-8 shrink-0 place-items-center rounded-md bg-accent-blue/12 text-base text-accent-blue"
          aria-hidden="true"
        >
          <i className={`ti ${icon}`} />
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-xs font-semibold text-ink">{title}</span>
          <span className="truncate text-[10px] text-ink-dim">{subtitle}</span>
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-5">
        {stats.map((stat) => (
          <span key={stat.label} className="flex flex-col items-end gap-0.5">
            <span className="font-mono text-[9px] tracking-[0.07em] text-ink-faint uppercase">
              {stat.label}
            </span>
            <span
              className={cn(
                'font-mono text-sm font-bold tabular-nums',
                stat.positive ? 'text-accent-green' : 'text-ink',
              )}
            >
              {stat.value}
            </span>
          </span>
        ))}
      </span>
    </Panel>
  );
}

/** The search box above a result list. Renders whatever the result count is — see the note at
 *  its call site: it used to live inside `results.length > 0`, so an empty search removed the
 *  box that caused it. */
export function ScanSearch({
  value,
  placeholder,
  onChange,
}: {
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <span className="relative flex min-w-0 flex-1 items-center">
      <i
        className="ti ti-search pointer-events-none absolute left-2.5 text-sm text-ink-dim"
        aria-hidden="true"
      />
      <Input
        type="search"
        className="h-8 pl-8"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </span>
  );
}
