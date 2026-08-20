/**
 * Panel — the app's primary surface. Modelled on shadcn's Card (MIT) but renamed, because
 * "panel" is what this app has always called these and what `legacy.css` names them
 * (`--bg-panel`, `.market-panel`, `.farm-panel`). Keeping the existing vocabulary means a
 * migrated page reads the same as an un-migrated one during the transition.
 *
 * Borders, not shadows. A dense dark UI relies on borders for separation — the interface-polish
 * skill inverts shadcn's "shadows over borders" for exactly this surface. `PanelHeader` keeps a
 * bottom border rather than floating on elevation.
 *
 * Radii are concentric by construction: the panel is `rounded-lg` (8px) with `p-3` (12px), so a
 * control sitting directly inside it should be `rounded-sm` (4px) — outer = inner + padding
 * does not hold above ~24px padding, which is why the panel padding stays modest.
 */
import { cn } from '@/lib/utils';

function Panel({ className, ...props }: React.ComponentProps<'section'>) {
  return (
    <section
      data-slot="panel"
      className={cn(
        'flex min-w-0 flex-col rounded-lg border border-line bg-bg-panel',
        className,
      )}
      {...props}
    />
  );
}

function PanelHeader({ className, ...props }: React.ComponentProps<'header'>) {
  return (
    <header
      data-slot="panel-header"
      className={cn(
        'flex min-h-9 shrink-0 items-center justify-between gap-2 border-b border-line px-3',
        className,
      )}
      {...props}
    />
  );
}

/**
 * Two treatments, because a panel title does two different jobs.
 *
 * `label` (default) — JetBrains Mono 12/600/.06em uppercase, the app's panel-label signature from
 * `.card-label`. Right when the title is a small marker over content that speaks for itself.
 *
 * `heading` — Inter 14/600 in full ink. Use it when the title is the panel's ONLY heading, which
 * is most of the analysis panels. The mono micro-label reads as a caption there, not a heading.
 * Deliberately larger than tooltip/body text (12px) so the hierarchy is visible rather than a
 * 1px difference nobody can see.
 *
 * This is a prop rather than a className each caller repeats — the same override string had
 * already been copy-pasted into two files, which is how a third variant starts.
 *
 * Renders an <h2> either way, so the page keeps a real outline for screen readers and keyboard
 * navigation — which matters in a keyboard-heavy tool.
 */
function PanelTitle({
  className,
  variant = 'label',
  ...props
}: React.ComponentProps<'h2'> & { variant?: 'label' | 'heading' }) {
  return (
    <h2
      data-slot="panel-title"
      data-variant={variant}
      className={cn(
        'truncate',
        variant === 'heading'
          ? 'font-sans text-sm font-semibold tracking-normal text-ink normal-case'
          : 'font-mono text-xs font-semibold tracking-[0.06em] text-ink-soft uppercase',
        className,
      )}
      {...props}
    />
  );
}

function PanelBody({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="panel-body" className={cn('min-w-0 flex-1 p-3', className)} {...props} />;
}

/**
 * PanelWell — an inset, darker ground for a panel's content.
 *
 * Adapted from the `web3-dashboard` template in `ui-reference/watermelon` (MIT), which nests a
 * near-black content area inside a lighter card frame. Changes: their radii and heavy ring
 * shadows are dropped for our tokens, and the ground is `--color-bg-base` rather than pure black.
 *
 * Why it earns its place: every surface in the app was one flat panel colour separated from the
 * next by a 1px line, so a page read as a grid of identical rectangles with no depth and no
 * sense of frame-versus-content. Recessing the content gives the header something to be a header
 * *of*, and it separates by surface rather than by adding yet another border.
 *
 * Radii are concentric by construction: `Panel` is `rounded-lg` (8px) and holds the well at
 * `p-1` (4px), so the well is `rounded-sm` (4px) — outer = inner + padding.
 */
function PanelWell({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="panel-well"
      className={cn('min-w-0 overflow-hidden rounded-sm bg-bg-base', className)}
      {...props}
    />
  );
}

function PanelFooter({ className, ...props }: React.ComponentProps<'footer'>) {
  return (
    <footer
      data-slot="panel-footer"
      className={cn('flex shrink-0 items-center gap-2 border-t border-line px-3 py-2', className)}
      {...props}
    />
  );
}

export { Panel, PanelHeader, PanelTitle, PanelBody, PanelWell, PanelFooter };
