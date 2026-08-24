/**
 * The furniture the whole Events surface is built from.
 *
 * **The problem this solves is density, not looks.** Eleven panels each carried a `card` header, a
 * "last synced" line, its own Refresh link, a notice slot and an empty state — five rows of chrome
 * around what was often two rows of data. Fissures rendered one bordered card per relic tier;
 * Baro rendered a bordered card per item with three pill-shaped cost chips inside it. The page was
 * mostly boxes.
 *
 * Three rules replace that:
 *
 * 1. **Repeated facts are columns, not cards** (`ELEMENTS.md` §6). Baro's ducats/credits/exit and a
 *    fissure's node/faction/timer are the same three facts on every row, so they line up and you
 *    read *down* them. A card per item makes that impossible.
 * 2. **Refresh is a page-level control, not eleven of them.** `EventsPage` refreshes every source
 *    at once. A panel only surfaces a refresh when it has an error worth retrying — which is the
 *    only time the per-panel one was ever the right control.
 * 3. **"Last synced" is not worth a row.** It moves to a `title` on the panel's own header.
 *
 * Everything here composes `Panel`/`EmptyState`/`Button` from `components/ui`. There is no second
 * panel surface on this page any more.
 */
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Panel, PanelHeader, PanelTitle } from '@/components/ui/panel';
import { cn } from '@/lib/utils';

/**
 * A panel of worldstate. `count` renders the "how many" every one of these wants; `aside` takes a
 * mode toggle or a filter row. `updatedAt` becomes a tooltip rather than a line of body text.
 */
export function EventPanel({
  title,
  count,
  countTone = 'muted',
  updatedAt,
  aside,
  className,
  bodyClassName,
  children,
}: {
  title: string;
  count?: number | string | null;
  countTone?: 'muted' | 'positive' | 'info';
  updatedAt?: string | null;
  aside?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <Panel className={cn('min-w-0', className)}>
      <PanelHeader className="gap-3 px-3" title={updatedAt ?? undefined}>
        <span className="flex min-w-0 items-center gap-2">
          <PanelTitle className="text-[10px] tracking-[0.1em] text-ink">{title}</PanelTitle>
          {count !== null && count !== undefined ? (
            <span
              className={cn(
                'shrink-0 font-mono text-[10px] font-semibold tabular-nums',
                countTone === 'positive'
                  ? 'text-accent-green'
                  : countTone === 'info'
                    ? 'text-accent-blue'
                    : 'text-ink-dim',
              )}
            >
              {count}
            </span>
          ) : null}
        </span>
        {aside ? <span className="flex shrink-0 items-center gap-1">{aside}</span> : null}
      </PanelHeader>
      <div className={cn('min-w-0 p-2', bodyClassName)}>{children}</div>
    </Panel>
  );
}

/**
 * One dense row: an optional lead (art, a tier icon, a dot), a title, a meta line, and
 * right-aligned trailing content.
 *
 * 28px of vertical padding total. The old `activity-list-card` was a bordered box with 12px
 * padding and a chip row; this holds the same facts in about a third of the height.
 */
export function EventRow({
  lead,
  title,
  meta,
  trailing,
  className,
}: {
  lead?: React.ReactNode;
  title: React.ReactNode;
  meta?: React.ReactNode;
  trailing?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex min-w-0 items-center gap-2.5 rounded-sm px-2 py-1.5',
        // A hairline between rows stacked on one surface. Callers that give each row its own
        // ground (the fissure eras) pass `border-b-0` — a divider AND a surface change is two
        // separators doing one job.
        'border-b border-line-subtle last:border-b-0',
        className,
      )}
    >
      {lead}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-xs font-medium text-ink">{title}</span>
        {meta ? <span className="truncate text-[10px] text-ink-dim">{meta}</span> : null}
      </span>
      {trailing ? (
        <span className="flex shrink-0 items-center gap-2 text-right">{trailing}</span>
      ) : null}
    </div>
  );
}

/** A countdown. Always `tabular-nums` — these tick every second and would jitter without it. */
export function Countdown({
  value,
  tone = 'neutral',
}: {
  value: string;
  tone?: 'neutral' | 'urgent' | 'dim';
}) {
  return (
    <span
      className={cn(
        'font-mono text-[11px] tabular-nums',
        tone === 'urgent' ? 'text-accent-amber' : tone === 'dim' ? 'text-ink-dim' : 'text-ink-soft',
      )}
    >
      {value}
    </span>
  );
}

/** A small labelled figure for a row's trailing slot — Baro's ducats, an exit price. */
export function RowFigure({
  label,
  value,
  tone = 'neutral',
  width = 'w-14',
}: {
  label: string;
  value: React.ReactNode;
  tone?: 'neutral' | 'positive' | 'dim';
  width?: string;
}) {
  return (
    <span className={cn('flex shrink-0 flex-col items-end gap-0.5', width)}>
      <span className="font-mono text-[8px] tracking-[0.08em] text-ink-faint uppercase">
        {label}
      </span>
      <span
        className={cn(
          'font-mono text-[11px] font-semibold tabular-nums',
          tone === 'positive' ? 'text-accent-green' : tone === 'dim' ? 'text-ink-dim' : 'text-ink',
        )}
      >
        {value}
      </span>
    </span>
  );
}

/** Compact chip for a modifier, faction or tag. */
export function EventTag({
  tone = 'muted',
  children,
}: {
  tone?: 'muted' | 'green' | 'amber' | 'blue' | 'purple' | 'red';
  children: React.ReactNode;
}) {
  const TONE = {
    muted: 'bg-bg-elevated text-ink-dim',
    green: 'bg-accent-green/15 text-accent-green',
    amber: 'bg-accent-amber/15 text-accent-amber',
    blue: 'bg-accent-blue/15 text-accent-blue',
    purple: 'bg-accent-purple/15 text-accent-purple',
    red: 'bg-accent-red/15 text-accent-red',
  } as const;
  return (
    <span
      className={cn(
        'shrink-0 rounded px-1.5 py-px font-mono text-[9px] font-semibold tracking-[0.04em]',
        TONE[tone],
      )}
    >
      {children}
    </span>
  );
}

/** Empty and error, at panel scale rather than page scale. */
export function EventEmpty({ icon, title, detail }: { icon: string; title: string; detail?: string }) {
  return <EmptyState className="py-4" icon={icon} title={title} detail={detail} />;
}

/**
 * A failed refresh. `stale` means we are still showing cached data, so this is a warning line
 * rather than the panel's whole content — the rule every worldstate panel already followed.
 */
export function EventError({
  error,
  stale,
  onRetry,
}: {
  error: string;
  stale: boolean;
  onRetry: () => void;
}) {
  return (
    <p
      role="alert"
      className={cn(
        'flex items-start gap-2 rounded-md border px-2 py-1.5 text-[11px] leading-relaxed',
        stale
          ? 'border-accent-amber/25 bg-accent-amber/8 text-accent-amber'
          : 'border-accent-red/25 bg-accent-red/8 text-accent-red',
      )}
    >
      <i className="ti ti-alert-triangle mt-px shrink-0 text-sm" aria-hidden="true" />
      <span className="min-w-0 flex-1">{error}</span>
      <Button
        variant="ghost"
        size="sm"
        static
        onClick={onRetry}
        className="-my-0.5 h-5 shrink-0 px-1.5 text-[10px] text-current hover:bg-white/10 hover:text-current"
      >
        <i className="ti ti-refresh" aria-hidden="true" />
      </Button>
    </p>
  );
}
