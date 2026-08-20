/**
 * Tabs — adapted from shadcn/ui's Base UI tabs (MIT), in `ui-reference/shadcn-vite`.
 *
 * Changes from the source:
 * - Every `dark:` variant dropped. We have one theme; carrying both doubled the class list
 *   and made it hard to see what actually applies.
 * - `transition-all` replaced with named properties (the skill forbids `transition-all` on
 *   surfaces that re-render on a poll).
 * - `line` is the default variant, not `solid`. It matches the underline sub-tabs the app
 *   already uses (Home's Overview / Watchlist / Alerts), so migrating a page doesn't silently
 *   restyle its navigation.
 * - The active-underline uses an `::after` that animates opacity only — no layout properties,
 *   so switching tabs can't reflow the panel below it.
 */
import { Tabs as TabsPrimitive } from '@base-ui/react/tabs';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

function Tabs({ className, ...props }: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn('group/tabs flex flex-col gap-3', className)}
      {...props}
    />
  );
}

const tabsListVariants = cva('group/tabs-list inline-flex w-fit items-center', {
  variants: {
    variant: {
      line: 'gap-4 border-b border-line',
      solid: 'gap-1 rounded-lg bg-bg-elevated p-[3px]',
    },
  },
  defaultVariants: { variant: 'line' },
});

function TabsList({
  className,
  variant = 'line',
  ...props
}: TabsPrimitive.List.Props & VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        'relative inline-flex items-center justify-center gap-1.5 whitespace-nowrap',
        'cursor-default border-0 bg-transparent font-sans text-xs font-medium text-ink-dim',
        'transition-[color] duration-150 ease-out hover:text-ink',
        'outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        'disabled:pointer-events-none disabled:opacity-50',
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
        'data-active:text-ink',
        // line: underline sits on the list's border, opacity-only so nothing reflows.
        'group-data-[variant=line]/tabs-list:px-0.5 group-data-[variant=line]/tabs-list:pb-2',
        'group-data-[variant=line]/tabs-list:after:absolute group-data-[variant=line]/tabs-list:after:inset-x-0',
        'group-data-[variant=line]/tabs-list:after:-bottom-px group-data-[variant=line]/tabs-list:after:h-0.5',
        'group-data-[variant=line]/tabs-list:after:bg-primary group-data-[variant=line]/tabs-list:after:opacity-0',
        'group-data-[variant=line]/tabs-list:after:transition-opacity group-data-[variant=line]/tabs-list:after:duration-150',
        'group-data-[variant=line]/tabs-list:data-active:after:opacity-100',
        // solid: filled pill.
        'group-data-[variant=solid]/tabs-list:rounded-md group-data-[variant=solid]/tabs-list:px-2.5',
        'group-data-[variant=solid]/tabs-list:py-1',
        'group-data-[variant=solid]/tabs-list:data-active:bg-bg-panel',
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn('flex-1 outline-none', className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants };
