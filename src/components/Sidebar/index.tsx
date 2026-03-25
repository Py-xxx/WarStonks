import { useEffect, useState } from 'react';
import { getAppVersion, openExternalUrl } from '../../lib/tauriClient';
import { useAppStore } from '../../stores/useAppStore';
import type { PageId } from '../../types';

interface NavItemDef {
  id: PageId;
  label: string;
  icon: React.ReactNode;
}

const GridIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
    <rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>
  </svg>
);
const BarChartIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <line x1="18" y1="20" x2="18" y2="10"/>
    <line x1="12" y1="20" x2="12" y2="4"/>
    <line x1="6"  y1="20" x2="6"  y2="14"/>
  </svg>
);
const CalendarIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="3" y="4" width="18" height="18" rx="2"/>
    <line x1="16" y1="2" x2="16" y2="6"/>
    <line x1="8"  y1="2" x2="8"  y2="6"/>
    <line x1="3"  y1="10" x2="21" y2="10"/>
  </svg>
);
const ScanIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
  </svg>
);
const ZapIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
  </svg>
);
const ArrowsIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points="17 1 21 5 17 9"/>
    <path d="M3 11V9a4 4 0 0 1 4-4h14"/>
    <polyline points="7 23 3 19 7 15"/>
    <path d="M21 13v2a4 4 0 0 1-4 4H3"/>
  </svg>
);
const BriefcaseIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="2" y="7" width="20" height="14" rx="2"/>
    <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>
  </svg>
);
const GearIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="12" cy="12" r="3"/>
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
  </svg>
);
const BookOpenIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M2 19.5A2.5 2.5 0 0 1 4.5 17H20" />
    <path d="M4.5 17H20V4.6a.6.6 0 0 0-.6-.6H6a4 4 0 0 0-4 4v11.5Z" />
    <path d="M8 8h8" />
    <path d="M8 12h6" />
  </svg>
);
const DiscordIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
    <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
  </svg>
);
const ChevronLeftIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
    <polyline points="15 18 9 12 15 6"/>
  </svg>
);
const ChevronRightIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
    <polyline points="9 18 15 12 9 6"/>
  </svg>
);

const NAV_ITEMS: NavItemDef[] = [
  { id: 'home',          label: 'Home',          icon: <GridIcon /> },
  { id: 'market',        label: 'Market',        icon: <BarChartIcon /> },
  { id: 'events',        label: 'Events',        icon: <CalendarIcon /> },
  { id: 'scanners',      label: 'Scanners',      icon: <ScanIcon /> },
  { id: 'opportunities', label: 'Opportunities', icon: <ZapIcon /> },
  { id: 'trades',        label: 'Trades',        icon: <ArrowsIcon /> },
  { id: 'portfolio',     label: 'Portfolio',     icon: <BriefcaseIcon /> },
  { id: 'strategy',      label: 'Strategy',      icon: <GearIcon /> },
];

export function Sidebar() {
  const activePage = useAppStore((s) => s.activePage);
  const setActivePage = useAppStore((s) => s.setActivePage);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
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
        if (!isMounted) {
          return;
        }

        setAppVersion(version);
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
    <nav className={`sidebar${sidebarCollapsed ? ' collapsed' : ''}`} aria-label="Main navigation">
      {NAV_ITEMS.map((item) => (
        <div
          key={item.id}
          className={`nav-item${activePage === item.id ? ' active' : ''}`}
          onClick={() => setActivePage(item.id)}
          role="button"
          tabIndex={0}
          aria-label={item.label}
          aria-current={activePage === item.id ? 'page' : undefined}
          onKeyDown={(e) => e.key === 'Enter' && setActivePage(item.id)}
        >
          <span className="nav-icon">{item.icon}</span>
          <span className="nav-label">{item.label}</span>
        </div>
      ))}

      <div className="sidebar-footer">
        <div className="sidebar-footer-links">
          <div
            className={`nav-item sidebar-footer-link${activePage === 'guide' ? ' active' : ''}`}
            onClick={() => setActivePage('guide')}
            role="button"
            tabIndex={0}
            aria-label="Guide"
            aria-current={activePage === 'guide' ? 'page' : undefined}
            onKeyDown={(e) => e.key === 'Enter' && setActivePage('guide')}
          >
            <span className="nav-icon"><BookOpenIcon /></span>
            <span className="nav-label">Guide</span>
          </div>
          <div
            className="nav-item sidebar-footer-link"
            onClick={handleOpenDiscord}
            role="button"
            tabIndex={0}
            aria-label="Join Discord"
            onKeyDown={(e) => e.key === 'Enter' && handleOpenDiscord()}
          >
            <span className="nav-icon"><DiscordIcon /></span>
            <span className="nav-label">Join Discord</span>
          </div>
        </div>
        <div className="sidebar-footer-meta">
          <span className="version">{appVersion}</span>
          <button
            className="icon-btn-sm"
            onClick={toggleSidebar}
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {sidebarCollapsed ? <ChevronRightIcon /> : <ChevronLeftIcon />}
          </button>
        </div>
      </div>
    </nav>
  );
}
