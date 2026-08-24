/**
 * Settings — one dialog, a section rail, and the section's content.
 *
 * **What this replaced, and why the shape changed.** Settings used to be a right-hand drawer whose
 * entire job was to be a menu: four rows, each of which opened a *modal on top of the drawer*. Two
 * layers of overlay to flip one switch, and the drawer stayed on screen behind the thing it had
 * opened. Everything awkward about the old code followed from that — four `useModalA11y` focus
 * traps, a drawer that deliberately had none so it would not fight them, its own Escape listener
 * conditioned on `anySubModalOpen`, a hand-rolled backdrop, and five booleans in the store.
 *
 * One `Dialog` removes all of it: one overlay, one focus trap, one Escape owner, all from the
 * primitive. `SettingsSection` in the store is now the only piece of state, and the four modal
 * booleans are gone.
 *
 * See `.claude/design/settings-inventory.md` for the full functional inventory this pass had to
 * preserve — everything in §1 still works, including the parts that are easy to miss (the
 * re-probe on open, the optimistic desktop-permission enable, the pre-reload language overlay).
 */
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useTranslation } from '../../i18n';
import type { TranslationKey } from '../../i18n/en';
import type { AppLanguage } from '../../lib/language';
import { useAppStore } from '../../stores/useAppStore';
import type { SettingsSection } from '../../types';
import { AlecaframeSection } from './AlecaframeSection';
import { DataSection } from './DataSection';
import { LanguageSection, LanguageSwitchOverlay } from './LanguageSection';
import { NotificationsSection } from './NotificationsSection';

interface SectionConfig {
  id: SettingsSection;
  labelKey: TranslationKey;
  /** Tabler glyph. Checked against the bundled subset — see the handoff's traps. */
  icon: string;
}

/** Ordered by how often a section is touched, not alphabetically. */
const SECTIONS: SectionConfig[] = [
  { id: 'notifications', labelKey: 'settings.section.notifications.label', icon: 'ti-bell-check' },
  { id: 'alecaframe', labelKey: 'settings.section.alecaframe.label', icon: 'ti-plug-connected-x' },
  { id: 'language', labelKey: 'langpanel.section.label', icon: 'ti-language' },
  { id: 'data', labelKey: 'settings.section.importExport.label', icon: 'ti-database' },
];

export function SettingsDialog() {
  const open = useAppStore((state) => state.settingsOpen);
  const closeSettings = useAppStore((state) => state.closeSettings);
  const section = useAppStore((state) => state.settingsSection);
  const setSection = useAppStore((state) => state.setSettingsSection);
  const notificationSettings = useAppStore((state) => state.notificationSettings);
  const appSettings = useAppStore((state) => state.appSettings);
  const walletSnapshot = useAppStore((state) => state.walletSnapshot);
  const { t } = useTranslation();

  // The language switch paints a full-screen overlay and then reloads. It has to outlive the
  // dialog's own layer, so it is hoisted here rather than living inside the section.
  const [langOverlay, setLangOverlay] = useState<{
    target: AppLanguage;
    applyingPack: boolean;
  } | null>(null);

  const activeLabel = SECTIONS.find((entry) => entry.id === section)?.labelKey;

  return (
    <>
      {langOverlay ? (
        <LanguageSwitchOverlay
          target={langOverlay.target}
          applyingPack={langOverlay.applyingPack}
        />
      ) : null}

      <Dialog open={open} onOpenChange={(next) => !next && closeSettings()}>
        <DialogContent className="h-[min(640px,88vh)] max-w-3xl gap-0 overflow-hidden p-0">
          <DialogTitle className="sr-only">{t('settings.heading')}</DialogTitle>
          <DialogDescription className="sr-only">{t('settings.title')}</DialogDescription>

          <div className="grid min-h-0 flex-1 grid-cols-[168px_minmax(0,1fr)]">
            <nav
              className="flex min-w-0 flex-col gap-2 border-r border-line bg-bg-base/40 p-3"
              aria-label={t('a11y.settingsSections')}
            >
              <span className="px-2 pt-1 pb-1 font-mono text-[9px] tracking-[0.14em] text-ink-dim uppercase">
                {t('settings.title')}
              </span>
              <div className="flex flex-col gap-0.5">
                {SECTIONS.map((entry) => {
                  const active = entry.id === section;
                  // A status dot beside the row, so "is AlecaFrame actually working" is legible
                  // without opening the section. It used to be a pill you had to go looking for.
                  const on =
                    entry.id === 'alecaframe'
                      ? appSettings.alecaframe.enabled
                      : entry.id === 'notifications'
                        ? notificationSettings.desktopEnabled || notificationSettings.soundEnabled
                        : null;
                  return (
                    <Button
                      key={entry.id}
                      variant="ghost"
                      size="sm"
                      static
                      aria-current={active ? 'page' : undefined}
                      onClick={() => setSection(entry.id)}
                      className={`h-8 justify-start gap-2 px-2 text-xs ${
                        active
                          ? 'bg-bg-elevated text-ink'
                          : 'text-ink-dim hover:bg-white/[0.04] hover:text-ink'
                      }`}
                    >
                      <i className={`ti ${entry.icon} text-sm`} aria-hidden="true" />
                      <span className="min-w-0 truncate">{t(entry.labelKey)}</span>
                      {on !== null ? (
                        <span
                          className={`ml-auto size-1.5 shrink-0 rounded-full ${
                            on ? 'bg-accent-green' : 'bg-ink-faint'
                          }`}
                          aria-hidden="true"
                        />
                      ) : null}
                    </Button>
                  );
                })}
              </div>

              {walletSnapshot.errorMessage ? (
                <p className="mt-auto px-2 text-[10px] leading-relaxed text-accent-amber">
                  {walletSnapshot.errorMessage}
                </p>
              ) : null}
            </nav>

            <div className="flex min-w-0 flex-col overflow-hidden">
              <header className="flex shrink-0 items-center border-b border-line px-5 py-3 pr-12">
                <h2 className="truncate font-sans text-sm font-semibold text-ink">
                  {activeLabel ? t(activeLabel) : t('settings.heading')}
                </h2>
              </header>
              {/* `key` remounts the section on change, which is what re-runs AlecaFrame's probe
                  and the language pack status fetch — both of which must be fresh each visit. */}
              <div key={section} className="min-w-0 flex-1 overflow-y-auto p-5">
                {section === 'notifications' ? <NotificationsSection /> : null}
                {section === 'alecaframe' ? <AlecaframeSection /> : null}
                {section === 'language' ? (
                  <LanguageSection onOverlayChange={setLangOverlay} />
                ) : null}
                {section === 'data' ? <DataSection /> : null}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
