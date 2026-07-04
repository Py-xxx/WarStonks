import { useEffect, useState } from 'react';
import { useTranslation } from '../../i18n';
import { useAppStore } from '../../stores/useAppStore';

export function StrategyPage() {
  const { t } = useTranslation();
  const strategy = useAppStore((s) => s.appSettings.strategy);
  const settingsLoading = useAppStore((s) => s.settingsLoading);
  const settingsError = useAppStore((s) => s.settingsError);
  const saveStrategyConfiguration = useAppStore((s) => s.saveStrategyConfiguration);

  const [minEdgeInput, setMinEdgeInput] = useState(String(strategy.minEdgePlat));
  const [tradeValueInput, setTradeValueInput] = useState(String(strategy.tradeValuePlat));
  const [localError, setLocalError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Re-sync the inputs when persisted settings arrive/refresh (e.g. loaded after mount).
  useEffect(() => {
    setMinEdgeInput(String(strategy.minEdgePlat));
    setTradeValueInput(String(strategy.tradeValuePlat));
  }, [strategy.minEdgePlat, strategy.tradeValuePlat]);

  const handleSave = async () => {
    const minEdgePlat = Number.parseFloat(minEdgeInput);
    const tradeValuePlat = Number.parseFloat(tradeValueInput);
    if (!Number.isFinite(minEdgePlat) || !Number.isFinite(tradeValuePlat) || minEdgePlat < 0 || tradeValuePlat < 0) {
      setLocalError(t('strategy.invalidNumbers'));
      setSaved(false);
      return;
    }

    setLocalError(null);
    setSaved(false);
    try {
      await saveStrategyConfiguration({ minEdgePlat, tradeValuePlat });
      setSaved(true);
    } catch {
      // Store surfaces the error via settingsError.
    }
  };

  return (
    <>
      <div className="subnav">
        <div className="subnav-left">
          <span className="page-title">{t('strategy.title')}</span>
        </div>
      </div>
      <div className="page-content">
        <div className="strategy-layout">
          <div className="strategy-main">
            <div className="empty-state">
              <span className="empty-primary">{t('strategy.empty.title')}</span>
              <span className="empty-sub">{t('strategy.empty.sub')}</span>
            </div>
          </div>

          <aside className="strategy-side" aria-label={t('strategy.engineTitle')}>
            <div className="strategy-side-header">
              <span className="panel-title-eyebrow">{t('strategy.engineTitle')}</span>
              <p>{t('strategy.engineDesc')}</p>
            </div>

            <label className="settings-field">
              <span className="settings-field-label">{t('strategy.minEdgeLabel')}</span>
              <span className="settings-field-help">{t('strategy.minEdgeHelp')}</span>
              <input
                className="settings-input strategy-number-input"
                type="number"
                min="0"
                step="1"
                inputMode="numeric"
                value={minEdgeInput}
                onChange={(event) => setMinEdgeInput(event.target.value)}
              />
            </label>

            <label className="settings-field">
              <span className="settings-field-label">{t('strategy.tradeValueLabel')}</span>
              <span className="settings-field-help">{t('strategy.tradeValueHelp')}</span>
              <input
                className="settings-input strategy-number-input"
                type="number"
                min="0"
                step="1"
                inputMode="numeric"
                value={tradeValueInput}
                onChange={(event) => setTradeValueInput(event.target.value)}
              />
            </label>

            {localError ? <div className="settings-inline-error">{localError}</div> : null}
            {settingsError && !localError ? (
              <div className="settings-inline-error">{settingsError}</div>
            ) : null}
            {saved && !localError && !settingsError ? (
              <div className="settings-inline-success">{t('strategy.saved')}</div>
            ) : null}

            <div className="settings-form-actions">
              <button
                type="button"
                className="settings-primary-btn"
                disabled={settingsLoading}
                onClick={() => void handleSave()}
              >
                {settingsLoading ? t('common.saving') : t('common.save')}
              </button>
            </div>
          </aside>
        </div>
      </div>
    </>
  );
}
