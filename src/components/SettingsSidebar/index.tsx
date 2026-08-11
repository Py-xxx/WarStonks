import { useEffect, useMemo, useState } from 'react';
import { formatShortLocalDateTime } from '../../lib/dateTime';
import { useTranslation } from '../../i18n';
import type { TranslationKey } from '../../i18n/en';
import { probeLocalSources } from '../../lib/tauriClient';
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

const iconProps = {
  width: 20,
  height: 20,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

// Alecaframe API — wallet/sync: a wallet with a sync arc.
const AlecaframeIcon = () => (
  <svg {...iconProps}>
    <rect x="3" y="6" width="18" height="13" rx="2" />
    <path d="M3 10h18" />
    <circle cx="16.5" cy="14.5" r="1.5" />
  </svg>
);

// Discord webhook — outbound message/paper-plane through a portal.
const DiscordWebhookIcon = () => (
  <svg {...iconProps}>
    <path d="m22 2-7 20-4-9-9-4Z" />
    <path d="M22 2 11 13" />
  </svg>
);

// Notifications — bell.
const NotificationsIcon = () => (
  <svg {...iconProps}>
    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
  </svg>
);

// Import & Export — box with up/down arrows.
const ImportExportIcon = () => (
  <svg {...iconProps}>
    <path d="M21 8v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8" />
    <path d="M3 8 12 3l9 5" />
    <path d="M9 12h6" />
    <path d="m12 9-3 3 3 3" />
    <path d="m12 15 3-3-3-3" />
  </svg>
);

// Language — globe.
const LanguageIcon = () => (
  <svg {...iconProps}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18" />
  </svg>
);

const SECTION_ICONS: Record<SettingsSection, () => JSX.Element> = {
  alecaframe: AlecaframeIcon,
  'discord-webhook': DiscordWebhookIcon,
  notifications: NotificationsIcon,
  'import-export': ImportExportIcon,
  language: LanguageIcon,
};

interface SectionConfig {
  id: SettingsSection;
  labelKey: TranslationKey;
  descKey: TranslationKey;
}

const mainSections: SectionConfig[] = [
  {
    id: 'alecaframe',
    labelKey: 'settings.section.alecaframe.label',
    descKey: 'settings.section.alecaframe.desc',
  },
  {
    id: 'notifications',
    labelKey: 'settings.section.notifications.label',
    descKey: 'settings.section.notifications.desc',
  },
  {
    id: 'import-export',
    labelKey: 'settings.section.importExport.label',
    descKey: 'settings.section.importExport.desc',
  },
  {
    id: 'language',
    labelKey: 'langpanel.section.label',
    descKey: 'langpanel.section.desc',
  },
];

const footerSections: SectionConfig[] = [];

export function SettingsSidebar() {
  const sidebarOpen = useAppStore((state) => state.settingsSidebarOpen);
  const closeSidebar = useAppStore((state) => state.closeSettingsSidebar);
  const setSection = useAppStore((state) => state.setSettingsSection);
  const openAlecaframeModal = useAppStore((state) => state.openAlecaframeModal);
  const openNotificationsModal = useAppStore((state) => state.openNotificationsModal);
  const openImportExportModal = useAppStore((state) => state.openImportExportModal);
  const openLanguageModal = useAppStore((state) => state.openLanguageModal);
  const { t } = useTranslation();
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

  // No link to validate any more — the source is a local file, so the only states are
  // off, on-and-present, and on-but-not-found.
  const [alecaframeDetected, setAlecaframeDetected] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void probeLocalSources()
      .then((availability) => {
        if (!cancelled) {
          setAlecaframeDetected(availability.alecaframeInventory.status === 'available');
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [sidebarOpen]);

  const alecaframeStatus = useMemo<TranslationKey>(() => {
    if (!appSettings.alecaframe.enabled) {
      return 'status.disabled';
    }
    return alecaframeDetected ? 'status.enabled' : 'status.notFound';
  }, [appSettings.alecaframe.enabled, alecaframeDetected]);

  if (!sidebarOpen) {
    return null;
  }

  return (
    <>
      <button
        className="settings-backdrop"
        type="button"
        aria-label={t('settings.close')}
        onClick={closeSidebar}
      />
      <aside className="settings-drawer" aria-label={t('settings.title')}>
        <div className="settings-drawer-header">
          <div>
            <span className="card-label">{t('settings.title')}</span>
            <h2>{t('settings.heading')}</h2>
          </div>
          <button
            className="settings-close-btn"
            type="button"
            aria-label={t('settings.close')}
            onClick={closeSidebar}
          >
            <CloseIcon />
          </button>
        </div>

        <nav className="settings-nav" aria-label={t('a11y.settingsSections')}>
          {mainSections.map((section) => {
            const notificationsStatus: TranslationKey =
              notificationSettings.desktopEnabled || notificationSettings.soundEnabled
                ? 'status.enabled'
                : 'status.disabled';
            const statusKey: TranslationKey | null =
              section.id === 'alecaframe'
                ? alecaframeStatus
                : section.id === 'notifications'
                  ? notificationsStatus
                  : null;

            const statusClassName =
              statusKey === 'status.enabled'
                ? 'badge-green'
                : statusKey === 'status.syncError'
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
                  } else if (section.id === 'notifications') {
                    openNotificationsModal();
                  } else if (section.id === 'import-export') {
                    openImportExportModal();
                  } else if (section.id === 'language') {
                    openLanguageModal();
                  }
                }}
              >
                <span className="settings-nav-icon" aria-hidden="true">
                  {(() => {
                    const SectionIcon = SECTION_ICONS[section.id];
                    return <SectionIcon />;
                  })()}
                </span>
                <span className="settings-nav-copy">
                  <span className="settings-nav-head">
                    <span className="settings-nav-label">{t(section.labelKey)}</span>
                    {section.id === 'language' ? (
                      <span className="badge settings-beta-badge">{t('opp.beta')}</span>
                    ) : null}
                    {statusKey ? (
                      <span className={`badge ${statusClassName}`}>{t(statusKey)}</span>
                    ) : null}
                  </span>
                  <span className="settings-nav-description">
                    {t(section.descKey)}
                    {/* Called out rather than buried in the sentence: with this off the
                        inventory, relic and currency views have no data at all. */}
                    {section.id === 'alecaframe' ? (
                      <span className="settings-nav-recommend">
                        {' '}
                        {t('settings.section.alecaframe.recommended')}
                      </span>
                    ) : null}
                  </span>
                  {section.id === 'alecaframe' ? (
                    <span className="settings-nav-subtext">
                      {t('settings.lastValidation')}{' '}
                      {formatShortLocalDateTime(appSettings.alecaframe.lastValidatedAt)}
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
                      <span className="settings-nav-label">{t(section.labelKey)}</span>
                      <span className="badge badge-muted">{t('status.soon')}</span>
                    </span>
                    <span className="settings-nav-description">{t(section.descKey)}</span>
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
