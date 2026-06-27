import { useEffect, useMemo } from 'react';
import { formatShortLocalDateTime } from '../../lib/dateTime';
import { useAppStore } from '../../stores/useAppStore';
import type { SettingsSection } from '../../types';

const CloseIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </svg>
);

const ChevronIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="m9 18 6-6-6-6" />
  </svg>
);

interface SectionConfig {
  id: SettingsSection;
  label: string;
  description: string;
}

const mainSections: SectionConfig[] = [
  {
    id: 'alecaframe',
    label: 'Alecaframe API',
    description: 'Wallet sync, public stats validation, and top-bar balances.',
  },
  {
    id: 'discord-webhook',
    label: 'Discord Webhook',
    description: 'Reserved for outbound alerts and status push workflows.',
  },
  {
    id: 'notifications',
    label: 'Notifications',
    description: 'Desktop alerts and in-app sound for watchlist hits and more.',
  },
  {
    id: 'import-export',
    label: 'Import & Export',
    description: 'Back up or restore your inventory, watchlist, trades, and market data.',
  },
];

const footerSections: SectionConfig[] = [];

export function SettingsSidebar() {
  const sidebarOpen = useAppStore((state) => state.settingsSidebarOpen);
  const closeSidebar = useAppStore((state) => state.closeSettingsSidebar);
  const setSection = useAppStore((state) => state.setSettingsSection);
  const openAlecaframeModal = useAppStore((state) => state.openAlecaframeModal);
  const openDiscordWebhookModal = useAppStore((state) => state.openDiscordWebhookModal);
  const openNotificationsModal = useAppStore((state) => state.openNotificationsModal);
  const openImportExportModal = useAppStore((state) => state.openImportExportModal);
  const notificationSettings = useAppStore((state) => state.notificationSettings);
  const appSettings = useAppStore((state) => state.appSettings);
  const walletSnapshot = useAppStore((state) => state.walletSnapshot);
  // The drawer hosts the Alecaframe/Discord/Notifications modals; when one is open it owns
  // Escape/focus, so the drawer must defer to it.
  const anySubModalOpen = useAppStore(
    (state) =>
      state.alecaframeModalOpen || state.discordWebhookModalOpen || state.notificationsModalOpen,
  );

  // Lock background scroll while the drawer is open. (A full focus-trap is intentionally NOT
  // used here — it would fight the focus-traps of the nested modals this drawer opens.)
  useEffect(() => {
    if (!sidebarOpen) {
      return undefined;
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [sidebarOpen]);

  // Escape closes the drawer, but only when no nested modal is open — those handle their own
  // Escape, and the drawer shouldn't close out from under them.
  useEffect(() => {
    if (!sidebarOpen || anySubModalOpen) {
      return undefined;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeSidebar();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [sidebarOpen, anySubModalOpen, closeSidebar]);

  const alecaframeStatus = useMemo(() => {
    if (!appSettings.alecaframe.enabled) {
      return 'Disabled';
    }

    if (!appSettings.alecaframe.publicLink) {
      return 'Missing link';
    }

    if (walletSnapshot.errorMessage) {
      return 'Sync error';
    }

    return 'Enabled';
  }, [
    appSettings.alecaframe.enabled,
    appSettings.alecaframe.publicLink,
    walletSnapshot.errorMessage,
  ]);

  const discordStatus = useMemo(() => {
    if (!appSettings.discordWebhook.enabled) {
      return 'Disabled';
    }

    if (!appSettings.discordWebhook.webhookUrl) {
      return 'Missing URL';
    }

    return 'Enabled';
  }, [appSettings.discordWebhook.enabled, appSettings.discordWebhook.webhookUrl]);

  if (!sidebarOpen) {
    return null;
  }

  return (
    <>
      <button
        className="settings-backdrop"
        type="button"
        aria-label="Close settings"
        onClick={closeSidebar}
      />
      <aside className="settings-drawer" aria-label="Settings">
        <div className="settings-drawer-header">
          <div>
            <span className="card-label">Settings</span>
            <h2>Integrations</h2>
          </div>
          <button
            className="settings-close-btn"
            type="button"
            aria-label="Close settings"
            onClick={closeSidebar}
          >
            <CloseIcon />
          </button>
        </div>

        <nav className="settings-nav" aria-label="Settings sections">
          {mainSections.map((section) => {
            const notificationsStatus =
              notificationSettings.desktopEnabled || notificationSettings.soundEnabled
                ? 'Enabled'
                : 'Disabled';
            const statusLabel =
              section.id === 'alecaframe'
                ? alecaframeStatus
                : section.id === 'discord-webhook'
                  ? discordStatus
                  : section.id === 'notifications'
                    ? notificationsStatus
                    : null;

            const statusClassName =
              statusLabel === 'Enabled'
                ? 'badge-green'
                : statusLabel === 'Sync error'
                  ? 'badge-red'
                  : 'badge-muted';

            return (
              <button
                key={section.id}
                className="settings-nav-item"
                type="button"
                onClick={() => {
                  setSection(section.id);
                  if (section.id === 'alecaframe') {
                    openAlecaframeModal();
                  } else if (section.id === 'discord-webhook') {
                    openDiscordWebhookModal();
                  } else if (section.id === 'notifications') {
                    openNotificationsModal();
                  } else if (section.id === 'import-export') {
                    openImportExportModal();
                  }
                }}
              >
                <span className="settings-nav-copy">
                  <span className="settings-nav-head">
                    <span className="settings-nav-label">{section.label}</span>
                    {statusLabel ? (
                      <span className={`badge ${statusClassName}`}>{statusLabel}</span>
                    ) : null}
                  </span>
                  <span className="settings-nav-description">{section.description}</span>
                  {section.id === 'alecaframe' ? (
                    <span className="settings-nav-subtext">
                      Last validation:{' '}
                      {formatShortLocalDateTime(appSettings.alecaframe.lastValidatedAt)}
                    </span>
                  ) : null}
                  {section.id === 'discord-webhook' ? (
                    <span className="settings-nav-subtext">
                      Last validation:{' '}
                      {formatShortLocalDateTime(appSettings.discordWebhook.lastValidatedAt)}
                    </span>
                  ) : null}
                </span>
                <ChevronIcon />
              </button>
            );
          })}

          {walletSnapshot.errorMessage ? (
            <div className="settings-inline-warning">{walletSnapshot.errorMessage}</div>
          ) : null}

          {footerSections.length > 0 ? (
            <div className="settings-nav-footer">
              {footerSections.map((section) => (
                <button
                  key={section.id}
                  className="settings-nav-item"
                  type="button"
                  onClick={() => setSection(section.id)}
                >
                  <span className="settings-nav-copy">
                    <span className="settings-nav-head">
                      <span className="settings-nav-label">{section.label}</span>
                      <span className="badge badge-muted">Soon</span>
                    </span>
                    <span className="settings-nav-description">{section.description}</span>
                  </span>
                  <ChevronIcon />
                </button>
              ))}
            </div>
          ) : null}
        </nav>
      </aside>
    </>
  );
}
