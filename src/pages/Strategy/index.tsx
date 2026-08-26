import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Metric, MetricGrid } from '@/components/ui/metric';
import { Panel, PanelHeader, PanelTitle } from '@/components/ui/panel';
import { Switch } from '@/components/ui/switch';
import { PageContent } from '../../components/PageContent';
import { PageHeading } from '../../components/PageHeading';
import { MarketChip } from '../Market/parts';
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

const FIELD_LABEL = 'font-mono text-[10px] tracking-[0.08em] text-ink-dim uppercase';

function reasonLabel(t: ReturnType<typeof useTranslation>['t'], code: string): string {
  const key = `smart.reason.${code}` as Parameters<typeof t>[0];
  const label = t(key);
  return label === key ? code : label;
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
      {/* Strategy has one view, so it has no sub-tab row — `PageHeading` is what a page shows
          instead (`ELEMENTS.md` §7). The `subnav` + single disabled tab it used to render was a
          tab bar you could not navigate. */}
      <PageHeading
        page="strategy"
        aside={<MarketChip tone="amber">{t('opp.beta')}</MarketChip>}
      />

      <PageContent stack>
        {/* Two columns that pack independently: settings on the left, the activity feed on the
            right. The feed is the tallest thing here and grows without bound. */}
        <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
          <div className="flex min-w-0 flex-col gap-4">
            <Panel className="gap-4 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <PanelTitle variant="heading">{t('smart.title')}</PanelTitle>
                  <p className="text-[11px] leading-relaxed text-ink-dim">{t('smart.desc')}</p>
                </div>
                <label className="flex shrink-0 cursor-pointer items-center gap-2">
                  <Switch
                    tone="positive"
                    checked={form.enabled}
                    aria-label={t('smart.masterAria')}
                    onCheckedChange={(next) => patch('enabled', next)}
                  />
                  <span className="text-xs font-medium text-ink">
                    {form.enabled ? t('smart.on') : t('smart.off')}
                  </span>
                </label>
              </div>

              {/* Only when it is actually live: this states that real prices are being changed on
                  Warframe.Market, which is not a thing to say speculatively. */}
              {form.enabled ? (
                <p className="flex items-center gap-2 rounded-md border border-accent-green/25 bg-accent-green/8 px-2.5 py-2 text-[11px] text-accent-green">
                  <i className="ti ti-bolt shrink-0 text-sm" aria-hidden="true" />
                  {t('smart.liveBody')}
                </p>
              ) : null}

              <div className="flex flex-col gap-1.5">
                <span className={FIELD_LABEL}>{t('smart.aggressiveness')}</span>
                <span className="text-[11px] leading-relaxed text-ink-dim">
                  {t('smart.aggressivenessHelp')}
                </span>
                {/* The segmented group — the app's one treatment for "pick one of N". */}
                <div className="flex items-center gap-0.5 self-start rounded-md bg-bg-base p-0.5" role="group">
                  {AGGRESSIVENESS.map((level) => (
                    <Button
                      key={level}
                      variant="ghost"
                      size="sm"
                      static
                      aria-pressed={form.aggressiveness === level}
                      onClick={() => patch('aggressiveness', level)}
                      className={`h-7 rounded-sm px-2.5 text-[11px] ${
                        form.aggressiveness === level
                          ? 'bg-bg-elevated text-ink'
                          : 'text-ink-dim hover:text-ink'
                      }`}
                    >
                      {t(`smart.agg.${level}` as Parameters<typeof t>[0])}
                    </Button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {(
                  [
                    ['minMarginPct', t('smart.minMargin'), 0],
                    ['maxChangesPerDay', t('smart.maxPerDay'), 1],
                    ['minIntervalMinutes', t('smart.minInterval'), 1],
                  ] as const
                ).map(([key, label, min]) => (
                  <label key={key} className="flex min-w-0 flex-col gap-1.5">
                    <span className={FIELD_LABEL}>{label}</span>
                    <Input
                      className="tabular-nums"
                      type="number"
                      min={min}
                      step="1"
                      value={form[key]}
                      onChange={(event) =>
                        patch(key, Number.parseInt(event.target.value || String(min), 10))
                      }
                    />
                  </label>
                ))}
              </div>

              {settingsError ? (
                <p role="alert" className="rounded-md border border-accent-red/25 bg-accent-red/8 px-2.5 py-2 text-[11px] text-accent-red">
                  {settingsError}
                </p>
              ) : null}
              {saved && !settingsError ? (
                <p className="rounded-md border border-accent-green/25 bg-accent-green/8 px-2.5 py-2 text-[11px] text-accent-green">
                  {t('strategy.saved')}
                </p>
              ) : null}

              <div className="flex justify-end">
                <Button size="sm" disabled={settingsLoading} onClick={() => void handleSave()}>
                  {settingsLoading ? t('common.saving') : t('common.save')}
                </Button>
              </div>
            </Panel>

            {/* Listings Smart Manage gave up on after repeated failures. Amber, because each one
                is a listing silently no longer being managed. */}
            {impact && impact.stuck.length > 0 ? (
              <Panel className="gap-2 border-accent-amber/30 p-4">
                <div className="flex flex-col gap-0.5">
                  <span className="text-xs font-semibold text-accent-amber">
                    {t('smart.stuckTitle', { count: String(impact.stuck.length) })}
                  </span>
                  <span className="text-[11px] leading-relaxed text-ink-dim">
                    {t('smart.stuckSub')}
                  </span>
                </div>
                <ul className="flex flex-col gap-1">
                  {impact.stuck.map((entry) => (
                    <li
                      key={`${entry.wfmId}-${entry.variantKey}`}
                      className="flex min-w-0 items-center gap-2 rounded-md border border-line bg-bg-base px-2.5 py-1.5"
                    >
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <strong className="truncate text-[11px] text-ink">
                          {entry.itemName || entry.slug}
                        </strong>
                        <span className="truncate text-[10px] text-ink-dim">
                          {t('smart.stuckFailures', { count: String(entry.failures) })}
                          {entry.lastReason ? ` · ${entry.lastReason}` : ''}
                        </span>
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 shrink-0 px-2 text-[11px]"
                        onClick={() => {
                          void clearSmartManageFailures(entry.wfmId, entry.variantKey)
                            .then(refreshLog)
                            .catch(() => undefined);
                        }}
                      >
                        {t('smart.stuckRetry')}
                      </Button>
                    </li>
                  ))}
                </ul>
              </Panel>
            ) : null}

            {impact && impact.sampleCount > 0 ? (
              <Panel className="gap-3 p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <PanelTitle variant="heading">{t('smart.impactTitle')}</PanelTitle>
                  <span className="font-mono text-[10px] tabular-nums text-ink-dim">
                    {t('smart.impactSub', { count: String(impact.sampleCount) })}
                  </span>
                </div>
                <MetricGrid columns={3}>
                  <Metric
                    label={t('smart.impactTotal')}
                    value={`${impact.totalDeltaPlat >= 0 ? '+' : ''}${impact.totalDeltaPlat}p`}
                    tone={impact.totalDeltaPlat >= 0 ? 'green' : 'red'}
                  />
                  <Metric
                    label={t('smart.impactAvg')}
                    value={`${impact.avgDeltaPlat >= 0 ? '+' : ''}${impact.avgDeltaPlat.toFixed(1)}p`}
                    tone={impact.avgDeltaPlat >= 0 ? 'green' : 'red'}
                  />
                  <Metric
                    label={t('smart.impactRecord')}
                    value={`${impact.wins}W / ${impact.losses}L`}
                  />
                </MetricGrid>
                {/* What the figures are measured against — a profit number with no baseline
                    stated is not a claim anyone can check. */}
                <p className="text-[10px] leading-relaxed text-ink-dim">{t('smart.impactNote')}</p>
              </Panel>
            ) : null}
          </div>

          <Panel className="gap-0">
            <PanelHeader className="px-4">
              <PanelTitle variant="heading">{t('smart.activity')}</PanelTitle>
              <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={refreshLog}>
                <i className="ti ti-refresh" aria-hidden="true" />
                {t('common.refresh')}
              </Button>
            </PanelHeader>
            <div className="min-w-0 p-2">
              {log.length === 0 ? (
                <EmptyState
                  icon="ti-clock"
                  title={t('smart.feedEmpty')}
                  detail={t('smart.feedEmptyHint')}
                />
              ) : (
                <div className="flex max-h-[70vh] flex-col overflow-y-auto">
                  {log.map((entry) => {
                    const changed = entry.newPrice !== entry.oldPrice;
                    const raised = entry.newPrice > entry.oldPrice;
                    const tag = entry.preview
                      ? { label: t('smart.tagPreview'), tone: 'blue' as const }
                      : !changed
                        ? { label: t('smart.tagHeld'), tone: 'muted' as const }
                        : entry.applied
                          ? { label: t('smart.tagApplied'), tone: 'green' as const }
                          : { label: t('smart.tagFailed'), tone: 'red' as const };
                    return (
                      <div
                        key={entry.logId}
                        className="flex min-w-0 items-center gap-2 border-b border-line-subtle px-1.5 py-1.5 last:border-b-0"
                      >
                        {/* Direction as a coloured glyph: raised is green, trimmed is red, held
                            is neutral — the accents' own meanings, not a decorative palette. */}
                        <span
                          className={`grid size-5 shrink-0 place-items-center rounded-full text-[11px] ${
                            !changed
                              ? 'bg-bg-elevated text-ink-faint'
                              : raised
                                ? 'bg-accent-green/15 text-accent-green'
                                : 'bg-accent-red/15 text-accent-red'
                          }`}
                          aria-hidden="true"
                        >
                          <i
                            className={`ti ti-${!changed ? 'minus' : raised ? 'arrow-up' : 'arrow-down'}`}
                          />
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="truncate text-[11px] text-ink capitalize">
                            {entry.slug.replace(/_/g, ' ')}
                          </span>
                          <span className="truncate text-[10px] text-ink-dim">
                            {reasonLabel(t, entry.reasonCode)}
                          </span>
                        </span>
                        <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-dim">
                          {changed ? (
                            <>
                              {formatPlatinumValue(entry.oldPrice)} →{' '}
                              <strong className="text-ink">
                                {formatPlatinumValue(entry.newPrice)}
                              </strong>
                            </>
                          ) : (
                            <strong className="text-ink">
                              {formatPlatinumValue(entry.newPrice)}
                            </strong>
                          )}
                        </span>
                        <MarketChip tone={tag.tone === 'muted' ? 'neutral' : tag.tone}>
                          {tag.label}
                        </MarketChip>
                        <span className="shrink-0 font-mono text-[9px] tabular-nums text-ink-faint">
                          {formatShortLocalDateTime(entry.at)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </Panel>
        </div>
      </PageContent>
    </>
  );
}
