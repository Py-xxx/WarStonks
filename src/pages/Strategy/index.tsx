import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from '../../i18n';
import { useAppStore } from '../../stores/useAppStore';
import {
  getSmartManageLog,
  clearSmartManageFailures,
  getSmartManageImpact,
  subscribeToSmartManageChanges,
  isTauriRuntime,
} from '../../lib/tauriClient';
import type { SmartAggressiveness, SmartManageLogEntry, SmartManageImpact } from '../../types';
import { formatPlatinumValue } from '../../lib/trades';
import { formatShortLocalDateTime } from '../../lib/dateTime';

const AGGRESSIVENESS: SmartAggressiveness[] = ['conservative', 'balanced', 'aggressive'];

function reasonLabel(t: ReturnType<typeof useTranslation>['t'], code: string): string {
  const key = `smart.reason.${code}` as Parameters<typeof t>[0];
  const label = t(key);
  return label === key ? code : label;
}

function StrategyEnginePanel() {
  const { t } = useTranslation();
  const strategy = useAppStore((s) => s.appSettings.strategy);
  const settingsLoading = useAppStore((s) => s.settingsLoading);
  const settingsError = useAppStore((s) => s.settingsError);
  const saveStrategyConfiguration = useAppStore((s) => s.saveStrategyConfiguration);

  const [minEdgeInput, setMinEdgeInput] = useState(String(strategy.minEdgePlat));
  const [tradeValueInput, setTradeValueInput] = useState(String(strategy.tradeValuePlat));
  const [localError, setLocalError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

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
    <aside className="strategy-side" aria-label={t('strategy.engineTitle')}>
      <div className="strategy-side-header">
        <span className="panel-title-eyebrow">{t('strategy.engineTitle')}</span>
        <p>{t('strategy.engineDesc')}</p>
      </div>
      <label className="settings-field">
        <span className="settings-field-label">{t('strategy.minEdgeLabel')}</span>
        <span className="settings-field-help">{t('strategy.minEdgeHelp')}</span>
        <input className="settings-input strategy-number-input" type="number" min="0" step="1" inputMode="numeric"
          value={minEdgeInput} onChange={(e) => setMinEdgeInput(e.target.value)} />
      </label>
      <label className="settings-field">
        <span className="settings-field-label">{t('strategy.tradeValueLabel')}</span>
        <span className="settings-field-help">{t('strategy.tradeValueHelp')}</span>
        <input className="settings-input strategy-number-input" type="number" min="0" step="1" inputMode="numeric"
          value={tradeValueInput} onChange={(e) => setTradeValueInput(e.target.value)} />
      </label>
      {localError ? <div className="settings-inline-error">{localError}</div> : null}
      {settingsError && !localError ? <div className="settings-inline-error">{settingsError}</div> : null}
      {saved && !localError && !settingsError ? <div className="settings-inline-success">{t('strategy.saved')}</div> : null}
      <div className="settings-form-actions">
        <button type="button" className="settings-primary-btn" disabled={settingsLoading} onClick={() => void handleSave()}>
          {settingsLoading ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </aside>
  );
}

export function StrategyPage() {
  const { t } = useTranslation();
  const smart = useAppStore((s) => s.appSettings.smartManage);
  const settingsLoading = useAppStore((s) => s.settingsLoading);
  const settingsError = useAppStore((s) => s.settingsError);
  const saveSmartManage = useAppStore((s) => s.saveSmartManageConfiguration);

  const [form, setForm] = useState(smart);
  const [saved, setSaved] = useState(false);
  const [log, setLog] = useState<SmartManageLogEntry[]>([]);
  const [impact, setImpact] = useState<SmartManageImpact | null>(null);

  useEffect(() => {
    setForm(smart);
  }, [smart]);

  const refreshLog = useCallback(() => {
    if (!isTauriRuntime()) {
      return;
    }
    void getSmartManageLog(60).then(setLog).catch(() => undefined);
    void getSmartManageImpact().then(setImpact).catch(() => undefined);
  }, []);

  useEffect(() => {
    refreshLog();
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void subscribeToSmartManageChanges(() => refreshLog()).then((unlisten) => {
      if (cancelled) unlisten();
      else dispose = unlisten;
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [refreshLog]);

  const patch = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setSaved(false);
  };

  const handleSave = async () => {
    setSaved(false);
    try {
      await saveSmartManage(form);
      setSaved(true);
    } catch {
      // settingsError surfaces it.
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
          <div className="strategy-main smart-manage-main">
            <div className="smart-panel">
              <div className="smart-panel-head">
                <div>
                  <span className="panel-title-eyebrow">{t('smart.title')}</span>
                  <p className="smart-panel-desc">{t('smart.desc')}</p>
                </div>
                <button
                  type="button"
                  className={`smart-master-toggle${form.enabled ? ' on' : ''}`}
                  role="switch"
                  aria-checked={form.enabled}
                  aria-label={t('smart.masterAria')}
                  onClick={() => patch('enabled', !form.enabled)}
                >
                  <span className="smart-master-toggle-track"><span className="smart-master-toggle-thumb" /></span>
                  <span>{form.enabled ? t('smart.on') : t('smart.off')}</span>
                </button>
              </div>

              {form.enabled ? (
                <div className="smart-live-banner">
                  <i className="ti ti-bolt" aria-hidden="true" />
                  <span>{t('smart.liveBody')}</span>
                </div>
              ) : null}

              <div className="smart-field">
                <span className="settings-field-label">{t('smart.aggressiveness')}</span>
                <span className="settings-field-help">{t('smart.aggressivenessHelp')}</span>
                <div className="smart-seg">
                  {AGGRESSIVENESS.map((level) => (
                    <button
                      key={level}
                      type="button"
                      className={`smart-seg-btn${form.aggressiveness === level ? ' active' : ''}`}
                      onClick={() => patch('aggressiveness', level)}
                    >
                      {t(`smart.agg.${level}` as Parameters<typeof t>[0])}
                    </button>
                  ))}
                </div>
              </div>

              <div className="smart-numbers">
                <label className="settings-field">
                  <span className="settings-field-label">{t('smart.minMargin')}</span>
                  <input className="settings-input strategy-number-input" type="number" min="0" step="1"
                    value={form.minMarginPct} onChange={(e) => patch('minMarginPct', Number.parseInt(e.target.value || '0', 10))} />
                </label>
                <label className="settings-field">
                  <span className="settings-field-label">{t('smart.maxPerDay')}</span>
                  <input className="settings-input strategy-number-input" type="number" min="1" step="1"
                    value={form.maxChangesPerDay} onChange={(e) => patch('maxChangesPerDay', Number.parseInt(e.target.value || '1', 10))} />
                </label>
                <label className="settings-field">
                  <span className="settings-field-label">{t('smart.minInterval')}</span>
                  <input className="settings-input strategy-number-input" type="number" min="1" step="1"
                    value={form.minIntervalMinutes} onChange={(e) => patch('minIntervalMinutes', Number.parseInt(e.target.value || '1', 10))} />
                </label>
              </div>

              {settingsError ? <div className="settings-inline-error">{settingsError}</div> : null}
              {saved && !settingsError ? <div className="settings-inline-success">{t('strategy.saved')}</div> : null}
              <div className="settings-form-actions">
                <button type="button" className="settings-primary-btn" disabled={settingsLoading} onClick={() => void handleSave()}>
                  {settingsLoading ? t('common.saving') : t('common.save')}
                </button>
              </div>
            </div>

            {impact && impact.stuck.length > 0 ? (
              <div className="smart-stuck">
                <div className="smart-stuck-head">
                  <span className="smart-stuck-title">
                    {t('smart.stuckTitle', { count: String(impact.stuck.length) })}
                  </span>
                  <span className="smart-stuck-sub">{t('smart.stuckSub')}</span>
                </div>
                <ul className="smart-stuck-list">
                  {impact.stuck.map((entry) => (
                    <li key={`${entry.wfmId}-${entry.variantKey}`} className="smart-stuck-row">
                      <div className="smart-stuck-item">
                        <strong>{entry.itemName || entry.slug}</strong>
                        <span className="smart-stuck-reason">
                          {t('smart.stuckFailures', { count: String(entry.failures) })}
                          {entry.lastReason ? ` · ${entry.lastReason}` : ''}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="act-btn"
                        onClick={() => {
                          void clearSmartManageFailures(entry.wfmId, entry.variantKey)
                            .then(refreshLog)
                            .catch(() => undefined);
                        }}
                      >
                        {t('smart.stuckRetry')}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {impact && impact.sampleCount > 0 ? (
              <div className="smart-impact">
                <div className="smart-impact-head">
                  <span className="panel-title-eyebrow">{t('smart.impactTitle')}</span>
                  <span className="smart-impact-sub">
                    {t('smart.impactSub', { count: String(impact.sampleCount) })}
                  </span>
                </div>
                <div className="smart-impact-grid">
                  <div className="smart-impact-stat">
                    <span>{t('smart.impactTotal')}</span>
                    <strong className={impact.totalDeltaPlat >= 0 ? 'pos' : 'neg'}>
                      {impact.totalDeltaPlat >= 0 ? '+' : ''}{impact.totalDeltaPlat}p
                    </strong>
                  </div>
                  <div className="smart-impact-stat">
                    <span>{t('smart.impactAvg')}</span>
                    <strong className={impact.avgDeltaPlat >= 0 ? 'pos' : 'neg'}>
                      {impact.avgDeltaPlat >= 0 ? '+' : ''}{impact.avgDeltaPlat.toFixed(1)}p
                    </strong>
                  </div>
                  <div className="smart-impact-stat">
                    <span>{t('smart.impactRecord')}</span>
                    <strong>{impact.wins}W / {impact.losses}L</strong>
                  </div>
                </div>
                <p className="smart-impact-note">{t('smart.impactNote')}</p>
                {impact.sellTimeCalibration != null ? (
                  <p className="smart-impact-note">
                    {t('smart.calibrationNote', {
                      factor: impact.sellTimeCalibration.toFixed(2),
                      direction: t(
                        impact.sellTimeCalibration >= 1
                          ? 'smart.calibrationSlower'
                          : 'smart.calibrationFaster',
                      ),
                    })}
                  </p>
                ) : null}
              </div>
            ) : null}

            <div className="smart-feed">
              <div className="smart-feed-head">
                <span className="panel-title-eyebrow">{t('smart.activity')}</span>
                <button type="button" className="act-btn" onClick={refreshLog}>{t('common.refresh')}</button>
              </div>
              {log.length === 0 ? (
                <div className="empty-state">
                  <span className="empty-primary">{t('smart.feedEmpty')}</span>
                  <span className="empty-sub">{t('smart.feedEmptyHint')}</span>
                </div>
              ) : (
                <div className="smart-feed-list">
                  {log.map((entry) => {
                    const changed = entry.newPrice !== entry.oldPrice;
                    const raised = entry.newPrice > entry.oldPrice;
                    const dir = !changed ? 'hold' : raised ? 'up' : 'down';
                    const icon = !changed ? 'minus' : raised ? 'arrow-up' : 'arrow-down';
                    return (
                      <div key={entry.logId} className="smart-feed-row">
                        <span className={`smart-feed-dir ${dir}`}>
                          <i className={`ti ti-${icon}`} aria-hidden="true" />
                        </span>
                        <div className="smart-feed-copy">
                          <span className="smart-feed-item">{entry.slug.replace(/_/g, ' ')}</span>
                          <span className="smart-feed-reason">{reasonLabel(t, entry.reasonCode)}</span>
                        </div>
                        <span className="smart-feed-prices">
                          {changed ? (
                            <>{formatPlatinumValue(entry.oldPrice)} → <strong>{formatPlatinumValue(entry.newPrice)}</strong></>
                          ) : (
                            <strong>{formatPlatinumValue(entry.newPrice)}</strong>
                          )}
                        </span>
                        <span className={`smart-feed-tag ${entry.preview ? 'preview' : !changed ? 'held' : entry.applied ? 'applied' : 'failed'}`}>
                          {entry.preview
                            ? t('smart.tagPreview')
                            : !changed
                              ? t('smart.tagHeld')
                              : entry.applied
                                ? t('smart.tagApplied')
                                : t('smart.tagFailed')}
                        </span>
                        <span className="smart-feed-time">{formatShortLocalDateTime(entry.at)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <StrategyEnginePanel />
        </div>
      </div>

    </>
  );
}

