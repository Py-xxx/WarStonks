import { Button } from '@/components/ui/button';
import { Panel, PanelHeader, PanelTitle, PanelWell } from '@/components/ui/panel';

/**
 * The shared shell for Home's panels, built on the `src/components/ui` primitives.
 *
 * An earlier pass hand-rolled this markup three times (Act now, Watchlist, each rail panel) and
 * hand-rolled the header links as raw `<button>` elements. That is what the primitives exist to
 * prevent, and it produced a real bug: a bare `<button>` with no `appearance-none` inherits the
 * browser's own control styling, because Tailwind's preflight is deliberately not imported while
 * the legacy CSS migration is in flight. The links rendered as white boxes. `Button` already
 * neutralises that — using it is the fix, not adding another one-off reset.
 *
 * The content sits in a `PanelWell` — recessed onto the darker page ground. The header no longer
 * carries a bottom border, because the change of surface already separates it, and stacking a
 * line on top of that reads as two separators doing one job.
 */
export function HomePanel({
  title,
  dotClass,
  count,
  meta,
  linkLabel,
  onLink,
  children,
}: {
  title: string;
  dotClass: string;
  count?: number;
  meta?: string | null;
  linkLabel?: string;
  onLink?: () => void;
  children: React.ReactNode;
}) {
  return (
    <Panel className="gap-1 p-1">
      <PanelHeader className="gap-2.5 border-b-0 px-2">
        <i className={`size-[5px] shrink-0 rounded-full ${dotClass}`} aria-hidden="true" />
        <PanelTitle>{title}</PanelTitle>
        {typeof count === 'number' ? (
          <span className="shrink-0 rounded bg-bg-elevated px-1.5 py-0.5 font-mono text-[10px] font-semibold text-ink-faint tabular-nums">
            {count}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-2.5">
          {meta ? <span className="font-mono text-[10px] text-ink-faint">{meta}</span> : null}
          {linkLabel && onLink ? (
            <Button variant="ghost" size="sm" onClick={onLink} className="px-1.5 text-[11px]">
              {linkLabel}
              <i className="ti ti-chevron-right" aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      </PanelHeader>
      <PanelWell>{children}</PanelWell>
    </Panel>
  );
}
