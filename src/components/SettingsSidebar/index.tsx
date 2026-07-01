import { useEffect, useMemo } from 'react';
import { formatShortLocalDateTime } from '../../lib/dateTime';
import { LANGUAGES, type AppLanguage } from '../../lib/language';
import { useTranslation } from '../../i18n';
import type { TranslationKey } from '../../i18n/en';
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
    id: 'discord-webhook',
    labelKey: 'settings.section.discord.label',
    descKey: 'settings.section.discord.desc',
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
  const language = useAppStore((state) => state.language);
  const setLanguage = useAppStore((state) => state.setLanguage);
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

  const alecaframeStatus = useMemo<TranslationKey>(() => {
    if (!appSettings.alecaframe.enabled) {
      return 'status.disabled';
    }

    if (!appSettings.alecaframe.publicLink) {
      return 'status.missingLink';
    }

    if (walletSnapshot.errorMessage) {
      return 'status.syncError';
    }

    return 'status.enabled';
  }, [
    appSettings.alecaframe.enabled,
    appSettings.alecaframe.publicLink,
    walletSnapshot.errorMessage,
  ]);

  const discordStatus = useMemo<TranslationKey>(() => {
    if (!appSettings.discordWebhook.enabled) {
      return 'status.disabled';
    }

    if (!appSettings.discordWebhook.webhookUrl) {
      return 'status.missingUrl';
    }

    return 'status.enabled';
  }, [appSettings.discordWebhook.enabled, appSettings.discordWebhook.webhookUrl]);

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
      <aside className="settings-drawer" aria-label="Settings">
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

        <label className="settings-language-row">
          <span className="settings-language-glyph" aria-hidden="true">🌐</span>
          <span className="settings-language-label">{t('settings.language')}</span>
          <select
            className="settings-input settings-language-select"
            value={language}
            onChange={(event) => setLanguage(event.target.value as AppLanguage)}
            aria-label={t('settings.language.aria')}
          >
            {LANGUAGES.map((option) => (
              <option key={option.code} value={option.code}>
                {option.flag} {option.native}
              </option>
            ))}
          </select>
        </label>

        <nav className="settings-nav" aria-label="Settings sections">
          {mainSections.map((section) => {
            const notificationsStatus: TranslationKey =
              notificationSettings.desktopEnabled || notificationSettings.soundEnabled
                ? 'status.enabled'
                : 'status.disabled';
            const statusKey: TranslationKey | null =
              section.id === 'alecaframe'
                ? alecaframeStatus
                : section.id === 'discord-webhook'
                  ? discordStatus
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
                    <span className="settings-nav-label">{t(section.labelKey)}</span>
                    {statusKey ? (
                      <span className={`badge ${statusClassName}`}>{t(statusKey)}</span>
                    ) : null}
                  </span>
                  <span className="settings-nav-description">{t(section.descKey)}</span>
                  {section.id === 'alecaframe' ? (
                    <span className="settings-nav-subtext">
                      {t('settings.lastValidation')}{' '}
                      {formatShortLocalDateTime(appSettings.alecaframe.lastValidatedAt)}
                    </span>
                  ) : null}
                  {section.id === 'discord-webhook' ? (
                    <span className="settings-nav-subtext">
                      {t('settings.lastValidation')}{' '}
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
