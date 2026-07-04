import { useEffect, useMemo, useState } from 'react';
import { tActive, useTranslation } from '../../i18n';
import {
  formatWorldStateCountdown,
  formatWorldStateDateTime,
  isWorldStateWindowActive,
} from '../../lib/worldState';
import { EventsPanelEmpty, EventsPanelNotice } from '../EventsPanelState';
import { resolveWfmAssetUrl } from '../../lib/wfmAssets';
import { useAppStore } from '../../stores/useAppStore';
import type { VoidTraderInventoryItem } from '../../types';

function formatCategoryLabel(category: string): string {
  return category
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function buildInventoryGroups(items: VoidTraderInventoryItem[]) {
  const grouped = new Map<string, VoidTraderInventoryItem[]>();

  for (const item of items) {
    const category = item.category.trim().length > 0 ? item.category : tActive('evt.otherCategory');
    const bucket = grouped.get(category) ?? [];
    bucket.push(item);
    grouped.set(category, bucket);
  }

  return [...grouped.entries()]
    .map(([category, entries]) => ({
      category,
      label: formatCategoryLabel(category),
      items: [...entries].sort((left, right) => left.item.localeCompare(right.item)),
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

export function VoidTraderPanel() {
  const { t } = useTranslation();
  const voidTrader = useAppStore((state) => state.worldStateVoidTrader);
  const loading = useAppStore((state) => state.worldStateVoidTraderLoading);
  const error = useAppStore((state) => state.worldStateVoidTraderError);
  const lastUpdatedAt = useAppStore((state) => state.worldStateVoidTraderLastUpdatedAt);
  const refreshWorldStateVoidTrader = useAppStore((state) => state.refreshWorldStateVoidTrader);
  const voidTraderPrices = useAppStore((state) => state.voidTraderPrices);
  const voidTraderPricesLoading = useAppStore((state) => state.voidTraderPricesLoading);

  const [nowMs, setNowMs] = useState(Date.now());
  const [selectedCategory, setSelectedCategory] = useState<string>('All');

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, []);

  const inventoryGroups = useMemo(
    () => buildInventoryGroups(voidTrader?.inventory ?? []),
    [voidTrader?.inventory],
  );
  const inventoryCategories = useMemo(
    () => ['All', ...inventoryGroups.map((group) => group.category)],
    [inventoryGroups],
  );

  useEffect(() => {
    if (!inventoryCategories.includes(selectedCategory)) {
      setSelectedCategory('All');
    }
  }, [inventoryCategories, selectedCategory]);

  const isActive = voidTrader
    ? isWorldStateWindowActive(voidTrader.activation, voidTrader.expiry, nowMs)
    : false;
  const filteredInventory =
    selectedCategory === 'All'
      ? voidTrader?.inventory ?? []
      : inventoryGroups.find((group) => group.category === selectedCategory)?.items ?? [];
  const nextCountdown = formatWorldStateCountdown(
    isActive ? voidTrader?.expiry ?? null : voidTrader?.activation ?? null,
    nowMs,
  );
  const hasUsableVoidTrader = Boolean(voidTrader);

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-label">{t('ws.voidTrader')}</span>
        <span className={`badge ${isActive ? 'badge-green' : 'badge-amber'}`}>
          {isActive ? t('evt.active') : t('evt.notActive')}
        </span>
        <div className="card-actions">
          <button
            className="text-btn"
            type="button"
            onClick={() => {
              void refreshWorldStateVoidTrader();
            }}
          >
            {loading ? t('common.refreshing') : t('common.refresh')}
          </button>
        </div>
      </div>

      <div className="card-body">
        {lastUpdatedAt ? (
          <div className="world-event-updated-at">
            {t('evt.lastSync', { time: formatWorldStateDateTime(lastUpdatedAt) })}
          </div>
        ) : null}

        <EventsPanelNotice
          message={error}
          tone={hasUsableVoidTrader ? 'warning' : 'error'}
          loading={loading}
          onRefresh={() => {
            void refreshWorldStateVoidTrader();
          }}
        />

        {loading && !voidTrader ? (
          <EventsPanelEmpty
            title={t('a11y.loadingVoidTrader')}
            detail={t('evt.checkingVoidTrader')}
          />
        ) : null}

        {voidTrader ? (
          <div className="void-trader-stack">
            <div className="void-trader-hero">
              <div className="void-trader-hero-main">
                <div className="void-trader-title-row">
                  <span className="void-trader-name">{voidTrader.character}</span>
                  <span className={`badge ${isActive ? 'badge-green' : 'badge-blue'}`}>
                    {isActive ? t('evt.leftCountdown', { time: nextCountdown }) : t('evt.untilArrival', { time: nextCountdown })}
                  </span>
                </div>
                <div className="void-trader-location">
                  {voidTrader.location ?? t('evt.relayUnavailable')}
                </div>
              </div>

              <div className="void-trader-meta-grid">
                <div className="void-trader-meta-card">
                  <span className="qv-stat-label">{isActive ? t('evt.leaves') : t('evt.arrives')}</span>
                  <span className="void-trader-meta-value">
                    {formatWorldStateDateTime(isActive ? voidTrader.expiry : voidTrader.activation)}
                  </span>
                </div>
                <div className="void-trader-meta-card">
                  <span className="qv-stat-label">{t('ws.countdown')}</span>
                  <span className="void-trader-meta-value">{nextCountdown}</span>
                </div>
                <div className="void-trader-meta-card">
                  <span className="qv-stat-label">{t('ws.inventory')}</span>
                  <span className="void-trader-meta-value">
                    {t('evt.itemsCount', { n: voidTrader.inventory.length })}
                  </span>
                </div>
              </div>
            </div>

            {!isActive ? (
              <EventsPanelEmpty
                title={t('a11y.baroNotInRelay')}
                detail={t('evt.baroNotInRelayDetail')}
              />
            ) : null}

            {isActive && inventoryGroups.length > 0 ? (
              <>
                <div className="void-trader-tabs" role="tablist" aria-label={t('a11y.voidTraderCategories')}>
                  {inventoryCategories.map((category) => (
                    <button
                      key={category}
                      className={`void-trader-tab${selectedCategory === category ? ' active' : ''}`}
                      type="button"
                      onClick={() => setSelectedCategory(category)}
                    >
                      {category === 'All'
                        ? t('evt.allWithCount', { n: voidTrader.inventory.length })
                        : t('evt.categoryCount', {
                            label: formatCategoryLabel(category),
                            n: inventoryGroups.find((group) => group.category === category)?.items.length ?? 0,
                          })}
                    </button>
                  ))}
                </div>

                <div className="void-trader-grid">
                  {filteredInventory.map((item) => {
                    const imageUrl = resolveWfmAssetUrl(item.imagePath);
                    const exitPrice = voidTraderPrices[item.item];
                    const hasExitPrice = exitPrice !== undefined && exitPrice !== null;

                    return (
                      <article key={`${item.category}-${item.item}`} className="void-trader-item-card">
                        <div className="void-trader-item-head">
                          <div className="void-trader-item-thumb" aria-hidden="true">
                            {imageUrl ? <img src={imageUrl} alt="" /> : item.item.slice(0, 2)}
                          </div>
                          <div className="void-trader-item-copy">
                            <div className="void-trader-item-name">{item.item}</div>
                            <div className="void-trader-item-category">
                              {formatCategoryLabel(item.category)}
                            </div>
                          </div>
                        </div>

                        <div className="void-trader-cost-row">
                          <div className="void-trader-cost-pill">
                            <span className="qv-stat-label">{t('bal.ducats')}</span>
                            <span className="void-trader-cost-value">{item.ducats ?? '—'}</span>
                          </div>
                          <div className="void-trader-cost-pill">
                            <span className="qv-stat-label">{t('bal.credits')}</span>
                            <span className="void-trader-cost-value">{item.credits ?? '—'}</span>
                          </div>
                          <div className="void-trader-cost-pill void-trader-cost-pill-exit">
                            <span className="qv-stat-label">{t('ws.exit')}</span>
                            <span className="void-trader-cost-value">
                              {hasExitPrice
                                ? `${exitPrice} pt`
                                : voidTraderPricesLoading
                                  ? '…'
                                  : '—'}
                            </span>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </>
            ) : null}

            {isActive && inventoryGroups.length === 0 ? (
              <EventsPanelEmpty
                title={t('a11y.voidTraderInvUnavailable')}
                detail={t('evt.voidTraderInvUnavailableDetail')}
              />
            ) : null}
          </div>
        ) : null}

        {!loading && !voidTrader && error ? (
          <EventsPanelEmpty
            title={t('a11y.voidTraderFailed')}
            detail={error}
            actionLabel={t('common.retry')}
            onAction={() => {
              void refreshWorldStateVoidTrader();
            }}
          />
        ) : null}

        {!loading && !voidTrader && !error ? (
          <EventsPanelEmpty
            title={t('a11y.voidTraderUnavailableData')}
            detail={t('evt.voidTraderNoDataDetail')}
          />
        ) : null}
      </div>
    </div>
  );
}
