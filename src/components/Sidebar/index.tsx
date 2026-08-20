import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { getAppVersion, openExternalUrl } from '../../lib/tauriClient';
import { useAppStore } from '../../stores/useAppStore';
import { useSubNav } from '../../hooks/useSubNav';
import { useTranslation } from '../../i18n';
import type { TranslationKey } from '../../i18n/en';
import type { NavSubItem } from '../../lib/navigation';
import type { PageId } from '../../types';

/**
 * The sidebar — now the app's ONLY navigation surface.
 *
 * Sub-views used to be tab rows inside each page, which split navigation across two places and
 * meant you had to open a page to discover what was in it. They are now nested under their page
 * here, so every navigational item lives in one list.
 *
 * Migrated off `legacy.css` in the same pass. Two things from the legacy design are deliberately
 * kept because they were good: the per-page accent identity, and the accent bar that grows in on
 * the active item.
 */

const ICON_PROPS = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
} as const;

const GridIcon = () => (
  <svg {...ICON_PROPS}>
    <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
    <rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" />
  </svg>
);
const TargetIcon = () => (
  <svg {...ICON_PROPS}>
    <circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1" />
  </svg>
);
const BarChartIcon = () => (
  <svg {...ICON_PROPS}>
    <line x1="18" y1="20" x2="18" y2="10" />
    <line x1="12" y1="20" x2="12" y2="4" />
    <line x1="6" y1="20" x2="6" y2="14" />
  </svg>
);
const CalendarIcon = () => (
  <svg {...ICON_PROPS}>
    <rect x="3" y="4" width="18" height="18" rx="2" />
    <line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" />
    <line x1="3" y1="10" x2="21" y2="10" />
  </svg>
);
const ScanIcon = () => (
  <svg {...ICON_PROPS}>
    <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
  </svg>
);
const ZapIcon = () => (
  <svg {...ICON_PROPS}>
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
  </svg>
);
const ArrowsIcon = () => (
  <svg {...ICON_PROPS}>
    <polyline points="17 1 21 5 17 9" />
    <path d="M3 11V9a4 4 0 0 1 4-4h14" />
    <polyline points="7 23 3 19 7 15" />
    <path d="M21 13v2a4 4 0 0 1-4 4H3" />
  </svg>
);
const BoxIcon = () => (
  <svg {...ICON_PROPS}>
    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
    <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
    <line x1="12" y1="22.08" x2="12" y2="12" />
  </svg>
);
const BriefcaseIcon = () => (
  <svg {...ICON_PROPS}>
    <rect x="2" y="7" width="20" height="14" rx="2" />
    <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
  </svg>
);
const GearIcon = () => (
  <svg {...ICON_PROPS}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);
const BookOpenIcon = () => (
  <svg {...ICON_PROPS}>
    <path d="M2 19.5A2.5 2.5 0 0 1 4.5 17H20" />
    <path d="M4.5 17H20V4.6a.6.6 0 0 0-.6-.6H6a4 4 0 0 0-4 4v11.5Z" />
    <path d="M8 8h8" /><path d="M8 12h6" />
  </svg>
);
const DiscordIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
    <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
  </svg>
);
const ChevronIcon = ({ right }: { right?: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points={right ? '9 18 15 12 9 6' : '15 18 9 12 15 6'} />
  </svg>
);

interface NavItemDef {
  id: PageId;
  icon: React.ReactNode;
  /** Page identity colour. Kept from the shipped sidebar — see the note on accents below. */
  accent: string;
}

/**
 * Per-page accent identity.
 *
 * This is a deliberate, bounded exception to "accents carry meaning". In a data surface, green
 * means profit and amber means warning, and spending them decoratively destroys that signal.
 * The sidebar is chrome: no numbers, no recommendations, nothing to misread. Here the colour is
 * page identity, and it is one of the few things giving the app character — so it stays.
 */
const NAV_ITEMS: NavItemDef[] = [
  { id: 'home', icon: <GridIcon />, accent: 'var(--color-accent-blue)' },
  { id: 'watchlist', icon: <TargetIcon />, accent: 'var(--color-accent-green)' },
  { id: 'market', icon: <BarChartIcon />, accent: 'var(--color-accent-green)' },
  { id: 'events', icon: <CalendarIcon />, accent: 'var(--color-accent-amber)' },
  { id: 'scanners', icon: <ScanIcon />, accent: 'var(--color-accent-purple)' },
  { id: 'opportunities', icon: <ZapIcon />, accent: 'var(--color-accent-amber)' },
  { id: 'inventory', icon: <BoxIcon />, accent: 'var(--color-accent-green)' },
  { id: 'trades', icon: <ArrowsIcon />, accent: 'var(--color-accent-blue)' },
  { id: 'portfolio', icon: <BriefcaseIcon />, accent: 'var(--color-accent-purple)' },
  { id: 'strategy', icon: <GearIcon />, accent: 'var(--color-accent-blue)' },
];

function SubNavLink({
  item,
  active,
  onSelect,
  className,
}: {
  item: NavSubItem;
  active: boolean;
  onSelect: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <Button
      variant="ghost"
      size="sm"
      static
      onClick={onSelect}
      aria-current={active ? 'page' : undefined}
      className={`h-7 w-full justify-start gap-2 px-2 text-[12px] font-medium ${
        active ? 'bg-white/[0.05] text-ink' : 'text-ink-dim hover:text-ink'
      } ${className ?? ''}`}
    >
      {/* A dot rather than a second icon set: sub-items are a list, and giving each one a glyph
          would compete with the page icons they sit under. */}
      <i
        className={`size-1 shrink-0 rounded-full ${active ? 'bg-(--nav-accent)' : 'bg-ink-faint'}`}
        aria-hidden="true"
      />
      {/* `title` because translated labels run longer than English — "Set Completion Planner"
          already fits with only a few pixels to spare, and German will not. */}
      <span className="truncate" title={t(item.labelKey)}>
        {t(item.labelKey)}
      </span>
      {item.beta ? (
        <span className="ml-auto shrink-0 rounded bg-accent-purple/15 px-1 font-mono text-[8px] font-bold tracking-[0.05em] text-accent-purple uppercase">
          BETA
        </span>
      ) : null}
    </Button>
  );
}

function NavEntry({ item }: { item: NavItemDef }) {
  const { t } = useTranslation();
  const activePage = useAppStore((s) => s.activePage);
  const setActivePage = useAppStore((s) => s.setActivePage);
  const collapsed = useAppStore((s) => s.sidebarCollapsed);
  const { items, active, select } = useSubNav(item.id);

  const isActive = activePage === item.id;
  const label = t(`nav.${item.id}` as TranslationKey);

  const trigger = (
    <Button
      variant="ghost"
      size="sm"
      static
      onClick={() => setActivePage(item.id)}
      aria-current={isActive ? 'page' : undefined}
      title={collapsed ? label : undefined}
      className={`relative h-9 w-full gap-2.5 rounded-md px-2.5 text-[13px] font-medium ${
        collapsed ? 'justify-center px-0' : 'justify-start'
      } ${
        isActive
          ? 'bg-(--nav-accent)/12 text-ink'
          : 'text-ink-dim hover:bg-white/[0.045] hover:text-ink'
      }`}
    >
      {/* The accent bar grows in rather than appearing — keyed to selection, which is a user
          action, so it never fires on its own. */}
      <span
        className={`absolute top-1/2 left-0 w-[3px] -translate-y-1/2 rounded-sm bg-(--nav-accent) transition-[height] duration-200 ease-out ${
          isActive ? 'h-3/5' : 'h-0'
        }`}
        aria-hidden="true"
      />
      <span className={isActive ? 'text-(--nav-accent)' : ''}>{item.icon}</span>
      {collapsed ? null : <span className="truncate">{label}</span>}
    </Button>
  );

  return (
    <div style={{ '--nav-accent': item.accent } as React.CSSProperties}>
      {collapsed && items.length > 0 ? (
        // Collapsed: the sub-items still have to be reachable, so the icon becomes a hover/focus
        // trigger for a flyout. Base UI's `openOnHover` handles the timing and the safe-triangle,
        // which is exactly the logic we must never hand-roll.
        <Popover>
          <PopoverTrigger openOnHover delay={120} render={trigger} />
          <PopoverContent className="flex flex-col gap-0.5">
            <span className="px-2 py-1 font-mono text-[9px] tracking-[0.07em] text-ink-faint uppercase">
              {label}
            </span>
            {items.map((sub) => (
              <SubNavLink
                key={sub.id}
                item={sub}
                active={active === sub.id}
                onSelect={() => {
                  setActivePage(item.id);
                  select(sub.id);
                }}
              />
            ))}
          </PopoverContent>
        </Popover>
      ) : (
        trigger
      )}

      {/* Expanded: sub-items sit under their page, but only for the page you are on. Showing
          every page's children at once would turn a 10-item list into a 30-item one. */}
      {!collapsed && isActive && items.length > 0 ? (
        <div className="mt-0.5 mb-1 ml-4 flex flex-col gap-0.5 border-l border-line pl-2">
          {items.map((sub) => (
            <SubNavLink
              key={sub.id}
              item={sub}
              active={active === sub.id}
              onSelect={() => select(sub.id)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function Sidebar() {
  const activePage = useAppStore((s) => s.activePage);
  const setActivePage = useAppStore((s) => s.setActivePage);
  const collapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const { t } = useTranslation();
  const [appVersion, setAppVersion] = useState<string>('…');

  const handleOpenDiscord = () => {
    void openExternalUrl('https://discord.com/invite/jMZYkP2URF').catch((error) => {
      console.warn('[sidebar] failed to open Discord invite', error);
    });
  };

  useEffect(() => {
    let isMounted = true;
    void getAppVersion()
      .then((version) => {
        if (isMounted) {
          setAppVersion(version);
        }
      })
      .catch((error) => {
        console.warn('[sidebar] failed to load app version', error);
        if (isMounted) {
          setAppVersion('-');
        }
      });
    return () => {
      isMounted = false;
    };
  }, []);

  return (
    <nav
      aria-label={t('a11y.mainNav')}
      className={`flex shrink-0 flex-col overflow-y-auto border-r border-line bg-bg-surface p-2 transition-[width] duration-200 ease-out ${
        collapsed ? 'w-14' : 'w-[216px]'
      }`}
    >
      <div className="flex flex-col gap-0.5">
        {NAV_ITEMS.map((item) => (
          <NavEntry key={item.id} item={item} />
        ))}
      </div>

      <div className="mt-auto flex flex-col gap-2 border-t border-line-subtle pt-2">
        <div className="flex flex-col gap-0.5">
          <Button
            variant="ghost"
            size="sm"
            static
            onClick={() => setActivePage('guide')}
            aria-current={activePage === 'guide' ? 'page' : undefined}
            title={collapsed ? t('nav.guide') : undefined}
            className={`h-9 w-full gap-2.5 px-2.5 text-[13px] font-medium ${
              collapsed ? 'justify-center px-0' : 'justify-start'
            } ${activePage === 'guide' ? 'bg-white/[0.05] text-ink' : 'text-ink-dim hover:text-ink'}`}
          >
            <BookOpenIcon />
            {collapsed ? null : <span className="truncate">{t('nav.guide')}</span>}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            static
            onClick={handleOpenDiscord}
            title={collapsed ? t('nav.discord') : undefined}
            className={`h-9 w-full gap-2.5 px-2.5 text-[13px] font-medium text-ink-dim hover:text-ink ${
              collapsed ? 'justify-center px-0' : 'justify-start'
            }`}
          >
            <DiscordIcon />
            {collapsed ? null : <span className="truncate">{t('nav.discord')}</span>}
          </Button>
        </div>

        <div className={`flex items-center gap-1 ${collapsed ? 'flex-col' : 'justify-between'}`}>
          {collapsed ? null : (
            <span className="rounded border border-line-subtle bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] text-ink-faint tabular-nums">
              {appVersion}
            </span>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={toggleSidebar}
            aria-label={collapsed ? t('nav.expandSidebar') : t('nav.collapseSidebar')}
          >
            <ChevronIcon right={collapsed} />
          </Button>
        </div>
      </div>
    </nav>
  );
}
