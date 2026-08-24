/**
 * Language, and the item-name packs that go with it.
 *
 * Two different things were stacked in one card before: *which language the app is in* (instant,
 * a reload) and *whether localized item names are installed* (multi-MB, downloadable, importable,
 * exportable). They are now two groups, because the second one only matters once you have picked
 * a non-English language.
 *
 * The full-screen switch overlay is kept as-is in behaviour: it is painted before the reload via a
 * double `rAF` so there is no frozen-looking gap, and its text renders in the **target** language
 * as a first taste of the switch.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { translate, useTranslation } from '../../i18n';
import type { TranslationKey } from '../../i18n/en';
import { LANGUAGES, type AppLanguage, wfmLangCode } from '../../lib/language';
import { exportLanguagePackFile, importLanguagePackFile } from '../../lib/languagePack';
import {
  getLanguagePackStatus,
  openExternalUrl,
  populateLanguageItemNames,
  type LanguagePackStatus,
} from '../../lib/tauriClient';
import { useAppStore } from '../../stores/useAppStore';
import { Note, SettingField, SettingGroup, StatusLine } from './parts';

const DISCORD_INVITE = 'https://discord.com/invite/jMZYkP2URF';

/** Maps a backend LANGPACK_* code to a localized message key. */
function packErrorKey(error: unknown): TranslationKey {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('LANGPACK_EMPTY')) return 'langpanel.err.empty';
  if (message.includes('LANGPACK_OFFLINE')) return 'langpanel.err.offline';
  if (message.includes('LANGPACK_STALE')) return 'langpanel.err.stale';
  return 'langpanel.err.badformat';
}

/** WFM code (e.g. "zh-hans") back to our AppLanguage. */
function appLanguageForWfm(code: string): AppLanguage | null {
  return LANGUAGES.find((option) => wfmLangCode(option.code) === code)?.code ?? null;
}

/**
 * Resolves after the browser has actually painted a pending React state change. A double rAF
 * clears the commit + the following frame, so a loading overlay set just before a heavy/blocking
 * step (a reload, a multi-MB name download) is guaranteed visible first — no frozen-looking gap.
 */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/** Rendered above everything while a switch/import is in flight, up to the reload. */
export function LanguageSwitchOverlay({
  target,
  applyingPack,
}: {
  target: AppLanguage;
  applyingPack: boolean;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-0 z-(--z-toast) flex flex-col items-center justify-center gap-3 bg-bg-base"
    >
      <span
        className="grid size-12 place-items-center rounded-full bg-accent-blue/12 text-2xl text-accent-blue"
        aria-hidden="true"
      >
        <i className="ti ti-language" />
      </span>
      <span className="text-sm font-medium text-ink">
        {translate(target, 'langpanel.switching', {
          lang: LANGUAGES.find((option) => option.code === target)?.native ?? target,
        })}
      </span>
      {applyingPack ? (
        <span className="text-[11px] text-ink-dim">
          {translate(target, 'langpanel.applyingPack')}
        </span>
      ) : null}
    </div>
  );
}

export function LanguageSection({
  onOverlayChange,
}: {
  onOverlayChange: (state: { target: AppLanguage; applyingPack: boolean } | null) => void;
}) {
  const language = useAppStore((s) => s.language);
  const setLanguage = useAppStore((s) => s.setLanguage);
  const pushToast = useAppStore((s) => s.pushToast);
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [status, setStatus] = useState<LanguagePackStatus | null>(null);
  const [busy, setBusy] = useState<'idle' | 'export' | 'import' | 'download' | 'switching'>('idle');

  const nativeName = LANGUAGES.find((o) => o.code === language)?.native ?? language;

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await getLanguagePackStatus(wfmLangCode(language)));
    } catch {
      setStatus(null);
    }
  }, [language]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  // Switching persists the choice, then does a FULL reload so every already-fetched surface
  // (worldstate, market, trades, quick view) re-renders in the new language. We deliberately do
  // NOT download item names here — that (multi-MB) work happens after the reload under the
  // startup screen via `ensureLanguagePackFresh`, so the switch itself is instant.
  const handleSwitchLanguage = useCallback(
    async (next: AppLanguage) => {
      setBusy('switching');
      onOverlayChange({ target: next, applyingPack: false });
      setLanguage(next);
      await nextPaint();
      window.location.reload();
    },
    [onOverlayChange, setLanguage],
  );

  // The download IS the task, so the overlay stays up (painted first) for its duration, then
  // reloads to apply the names everywhere.
  const handleDownload = useCallback(async () => {
    setBusy('download');
    onOverlayChange({ target: language, applyingPack: false });
    try {
      await nextPaint();
      await populateLanguageItemNames(wfmLangCode(language));
      window.location.reload();
    } catch {
      onOverlayChange(null);
      pushToast(t('langpanel.err.downloadFailed'), 'error');
      await refreshStatus();
      setBusy('idle');
    }
  }, [language, onOverlayChange, pushToast, refreshStatus, t]);

  const handleExport = async () => {
    setBusy('export');
    try {
      const count = await exportLanguagePackFile(wfmLangCode(language));
      pushToast(t('langpanel.exportOk', { lang: nativeName, count }), 'success');
    } catch (error) {
      pushToast(t(packErrorKey(error)), 'error');
    } finally {
      setBusy('idle');
    }
  };

  const handleImportFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy('import');
    // Show the overlay BEFORE the parse/DB import, which is the heavy step — otherwise the UI
    // would sit unresponsive with no feedback until reload.
    onOverlayChange({ target: language, applyingPack: true });
    try {
      await nextPaint();
      const result = await importLanguagePackFile(file);
      const applied = appLanguageForWfm(result.langCode);
      if (applied) {
        onOverlayChange({ target: applied, applyingPack: true });
        setLanguage(applied);
      }
      // Full reload so the imported language applies everywhere.
      window.location.reload();
    } catch (error) {
      onOverlayChange(null);
      pushToast(t(packErrorKey(error)), 'error');
      setBusy('idle');
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const isEnglish = language === 'en';
  const populated = isEnglish || (status?.populated ?? false);
  const canExport = !isEnglish && !!status?.populated && status.upToDate && status.wfstatReachable;
  const canDownload = !isEnglish && !populated && !!status?.wfstatReachable;

  const versionStatusKey: TranslationKey | null = !status
    ? null
    : !status.wfstatReachable
      ? 'langpanel.status.offline'
      : status.upToDate
        ? 'langpanel.status.upToDate'
        : 'langpanel.status.stale';

  return (
    <div className="flex flex-col gap-6">
      <SettingGroup title={t('langpanel.section.label')}>
        <SettingField label={t('settings.language')} htmlFor="settings-language">
          <Select
            id="settings-language"
            className="h-8"
            value={language}
            disabled={busy !== 'idle'}
            aria-label={t('settings.language.aria')}
            onChange={(event) => void handleSwitchLanguage(event.target.value as AppLanguage)}
          >
            {LANGUAGES.map((option) => (
              <option key={option.code} value={option.code}>
                {option.flag} {option.native}
              </option>
            ))}
          </Select>
        </SettingField>
        <Note tone="info">{t('langpanel.betaNote')}</Note>
      </SettingGroup>

      <SettingGroup title={t('langpanel.status.title')}>
        <StatusLine
          tone={populated ? 'positive' : status === null ? 'pending' : 'negative'}
          label={
            populated
              ? t('langpanel.status.installed', { count: isEnglish ? 0 : (status?.itemCount ?? 0) })
              : t('langpanel.status.notInstalled')
          }
          detail={!isEnglish && versionStatusKey ? t(versionStatusKey) : undefined}
        />

        {!isEnglish && !populated && status ? (
          <Note tone="warn">
            {status.wfstatReachable
              ? t('langpanel.notInstalledOnline', { lang: nativeName })
              : t('langpanel.fallback', { lang: nativeName })}
          </Note>
        ) : null}

        <input
          ref={fileInputRef}
          type="file"
          accept=".wslang"
          className="hidden"
          onChange={(event) => void handleImportFile(event.target.files?.[0])}
        />
        <div className="flex flex-wrap gap-2">
          {canDownload ? (
            <Button size="sm" disabled={busy !== 'idle'} onClick={() => void handleDownload()}>
              {busy === 'download' ? t('langpanel.downloading') : t('langpanel.download')}
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== 'idle'}
            onClick={() => fileInputRef.current?.click()}
          >
            {busy === 'import' ? t('langpanel.importing') : t('langpanel.import')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== 'idle' || !canExport}
            onClick={() => void handleExport()}
          >
            {busy === 'export' ? t('langpanel.exporting') : t('langpanel.export')}
          </Button>
        </div>
      </SettingGroup>

      <SettingGroup title={t('langpanel.help.title')} description={t('langpanel.help.desc')}>
        <div>
          <Button variant="outline" size="sm" onClick={() => void openExternalUrl(DISCORD_INVITE)}>
            <i className="ti ti-external-link" aria-hidden="true" />
            {t('langpanel.openDiscord')}
          </Button>
        </div>
      </SettingGroup>
    </div>
  );
}
