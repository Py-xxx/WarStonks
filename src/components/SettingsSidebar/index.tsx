import { useMemo } from 'react';
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
];

const footerSections: SectionConfig[] = [
  {
    id: 'import-export',
    label: 'Import & Export',
    description: 'Reserved for future app-data import/export actions.',
  },
];

function formatTimestamp(value: string | null): string {
  if (!value) {
    return 'Not available';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString();
}

export function SettingsSidebar() {
  const sidebarOpen = useAppStore((state) => state.settingsSidebarOpen);
  const activeSection = useAppStore((state) => state.settingsSection);
  const closeSidebar = useAppStore((state) => state.closeSettingsSidebar);
  const setSection = useAppStore((state) => state.setSettingsSection);
  const openAlecaframeModal = useAppStore((state) => state.openAlecaframeModal);
  const appSettings = useAppStore((state) => state.appSettings);
  const walletSnapshot = useAppStore((state) => state.walletSnapshot);
  const settingsLoading = useAppStore((state) => state.settingsLoading);
  const settingsError = useAppStore((state) => state.settingsError);

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

        <div className="settings-drawer-layout">
          <nav className="settings-nav" aria-label="Settings sections">
            {mainSections.map((section) => (
              <button
                key={section.id}
                className={`settings-nav-item${activeSection === section.id ? ' active' : ''}`}
                type="button"
                onClick={() => {
                  setSection(section.id);
                  if (section.id === 'alecaframe') {
                    openAlecaframeModal();
                  }
                }}
              >
                <span className="settings-nav-copy">
                  <span className="settings-nav-label">{section.label}</span>
                  <span className="settings-nav-description">{section.description}</span>
                </span>
                <ChevronIcon />
              </button>
            ))}

            <div className="settings-nav-footer">
              {footerSections.map((section) => (
                <button
                  key={section.id}
                  className={`settings-nav-item${activeSection === section.id ? ' active' : ''}`}
                  type="button"
                  onClick={() => setSection(section.id)}
                >
                  <span className="settings-nav-copy">
                    <span className="settings-nav-label">{section.label}</span>
                    <span className="settings-nav-description">{section.description}</span>
                  </span>
                  <ChevronIcon />
                </button>
              ))}
            </div>
          </nav>

          <section className="settings-detail">
            {activeSection === 'alecaframe' ? (
              <div className="settings-detail-stack">
                <div className="settings-detail-card">
                  <div className="settings-detail-head">
                    <div>
                      <span className="card-label">Alecaframe API</span>
                      <h3>Wallet sync</h3>
                    </div>
                    <span
                      className={`badge ${
                        alecaframeStatus === 'Enabled'
                          ? 'badge-green'
                          : alecaframeStatus === 'Sync error'
                            ? 'badge-red'
                            : 'badge-muted'
                      }`}
                    >
                      {alecaframeStatus}
                    </span>
                  </div>

                  <p className="settings-detail-body">
                    Validate a public Alecaframe link, persist it in app data outside the repo,
                    and use it to populate the top-bar wallet balances.
                  </p>

                  <div className="settings-detail-meta">
                    <div>
                      <span className="settings-meta-label">Public user</span>
                      <span className="settings-meta-value">
                        {appSettings.alecaframe.usernameWhenPublic ?? 'Not linked'}
                      </span>
                    </div>
                    <div>
                      <span className="settings-meta-label">Last validation</span>
                      <span className="settings-meta-value">
                        {formatTimestamp(appSettings.alecaframe.lastValidatedAt)}
                      </span>
                    </div>
                  </div>

                  {walletSnapshot.errorMessage ? (
                    <div className="settings-inline-error">{walletSnapshot.errorMessage}</div>
                  ) : null}

                  {settingsError ? (
                    <div className="settings-inline-error">{settingsError}</div>
                  ) : null}

                  <button
                    className="settings-primary-btn"
                    type="button"
                    onClick={openAlecaframeModal}
                    disabled={settingsLoading}
                  >
                    {settingsLoading ? 'Opening…' : 'Configure Alecaframe'}
                  </button>
                </div>
              </div>
            ) : null}

            {activeSection === 'discord-webhook' ? (
              <div className="settings-detail-card">
                <div className="settings-detail-head">
                  <div>
                    <span className="card-label">Discord Webhook</span>
                    <h3>Pending integration</h3>
                  </div>
                  <span className="badge badge-muted">Soon</span>
                </div>
                <p className="settings-detail-body">
                  The Discord webhook slot is available in settings now, but outbound webhook
                  delivery has not been implemented yet.
                </p>
              </div>
            ) : null}

            {activeSection === 'import-export' ? (
              <div className="settings-detail-card">
                <div className="settings-detail-head">
                  <div>
                    <span className="card-label">Import &amp; Export</span>
                    <h3>Reserved slot</h3>
                  </div>
                  <span className="badge badge-muted">Soon</span>
                </div>
                <p className="settings-detail-body">
                  Import and export actions are reserved here for a later pass. The slot is in the
                  drawer now so the layout matches the planned settings structure.
                </p>
              </div>
            ) : null}
          </section>
        </div>
      </aside>
    </>
  );
}
