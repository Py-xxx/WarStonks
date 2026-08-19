/**
 * Skeleton — loading placeholders.
 *
 * The visual shell comes from shadcn/ui (MIT); the compositional `type` API is modelled on
 * Vuetify's `v-skeleton-loader` (MIT, API shape only — no Vuetify code). That API suits this
 * app because it is table-heavy: presets compose from primitives and `@n` repeats them, so a
 * six-column table skeleton is `table` rather than forty hand-written divs.
 *
 * Rules that matter (see the interface-polish skill's loading.md):
 * - The skeleton must MATCH the real layout, or it causes the layout jump it exists to prevent.
 * - Never skeleton data that is merely refreshing. Skeletons are for a surface with no data
 *   yet; swapping good values for grey boxes on every poll makes the app feel broken.
 * - Pulse, never shimmer. A travelling gradient across a dense page is noise and repaints a
 *   large area. The pulse is neutralised by the global `prefers-reduced-motion` block.
 */
import * as React from 'react';

import { cn } from '@/lib/utils';

/** Leaf shapes. Everything else composes from these. */
const PRIMITIVES = {
  text: 'h-3 w-full rounded-sm',
  heading: 'h-4 w-2/5 rounded-sm',
  avatar: 'size-8 shrink-0 rounded-full',
  image: 'h-28 w-full rounded-md',
  button: 'h-7 w-20 rounded-md',
  chip: 'h-5 w-14 rounded-full',
  divider: 'h-px w-full rounded-none',
  'table-cell': 'h-3 w-full rounded-sm',
} as const;

type PrimitiveName = keyof typeof PRIMITIVES;

/**
 * Composite presets. Values are parsed with the same grammar callers can pass directly, so
 * there is nothing a preset can express that a caller cannot.
 */
const PRESETS: Record<string, string> = {
  sentences: 'text@2',
  paragraph: 'text@3',
  article: 'heading, paragraph',
  'list-item': 'text',
  'list-item-avatar': 'avatar, text',
  card: 'image, heading, text',
  actions: 'button@2',
  'table-row': 'table-cell@6',
  'table-head': 'heading@6',
  table: 'table-head, divider, table-row@6',
  stat: 'heading, text',
};

/** Rows are laid out horizontally when they read as one line of content. */
const ROW_LAYOUT = new Set(['list-item-avatar', 'table-row', 'table-head', 'actions']);

interface ParsedNode {
  name: string;
  count: number;
}

/** `"text@3, avatar"` -> `[{name:'text',count:3},{name:'avatar',count:1}]` */
function parseType(type: string): ParsedNode[] {
  return type
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [name, rawCount] = part.split('@');
      const count = Number.parseInt(rawCount ?? '1', 10);
      return {
        name: name.trim(),
        // A malformed repeat ("text@abc") renders once rather than zero or NaN times —
        // a missing skeleton is a silent blank panel, which is harder to notice than one.
        count: Number.isFinite(count) && count > 0 ? count : 1,
      };
    });
}

function renderNode(node: ParsedNode, keyPrefix: string, depth: number): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  for (let index = 0; index < node.count; index += 1) {
    const key = `${keyPrefix}-${node.name}-${index}`;
    if (node.name in PRIMITIVES) {
      out.push(
        <span
          key={key}
          className={cn(
            'block animate-pulse bg-line-strong/60',
            PRIMITIVES[node.name as PrimitiveName],
          )}
        />,
      );
      continue;
    }
    const preset = PRESETS[node.name];
    if (!preset) {
      // Unknown name degrades to a text line rather than throwing. A skeleton is a loading
      // affordance; taking down the page because a preset name was mistyped is worse than
      // showing a slightly wrong placeholder.
      out.push(
        <span key={key} className={cn('block animate-pulse bg-line-strong/60', PRIMITIVES.text)} />,
      );
      continue;
    }
    out.push(
      <span
        key={key}
        className={cn(
          'flex min-w-0 gap-2',
          ROW_LAYOUT.has(node.name) ? 'flex-row items-center' : 'flex-col',
        )}
      >
        {parseType(preset).flatMap((child, childIndex) =>
          renderNode(child, `${key}-${childIndex}`, depth + 1),
        )}
      </span>,
    );
  }
  return out;
}

export interface SkeletonProps extends React.ComponentProps<'div'> {
  /** Composition string: a primitive, a preset, or a comma list, each optionally `@n`. */
  type?: string;
  /**
   * When provided, the component becomes a wrapper: it renders the skeleton while true and
   * `children` once false. Preferred over branching at the call site, so the loading decision
   * lives in one place per surface.
   */
  loading?: boolean;
}

function Skeleton({ className, type = 'text', loading, children, ...props }: SkeletonProps) {
  if (loading === false) {
    return <>{children}</>;
  }
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn('flex w-full flex-col gap-2', className)}
      {...props}
    >
      {parseType(type).flatMap((node, index) => renderNode(node, `s${index}`, 0))}
    </div>
  );
}

export { Skeleton };
