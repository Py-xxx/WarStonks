import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from '../../i18n';
import type { TranslationKey } from '../../i18n/en';
import {
  formatWorldStateCountdown,
  formatWorldStateDateTime,
  isWorldStateWindowActive,
} from '../../lib/worldState';
import { EventsPanelEmpty, EventsPanelNotice } from '../EventsPanelState';
import { useAppStore } from '../../stores/useAppStore';
import type { WfstatFlashSale, WfstatNewsItem } from '../../types';

const INVALID_WORLDSTATE_DATE = '1970-01-01T00:00:00.000Z';

function formatMeaningfulDate(value: string | null): string | null {
  if (!value || value === INVALID_WORLDSTATE_DATE) {
    return null;
  }

  return formatWorldStateDateTime(value);
}

function buildNewsTone(item: WfstatNewsItem, t: (key: TranslationKey) => string): string {
  if (item.priority) {
    return t('evt.newsTonePriority');
  }

  if (item.primeAccess) {
    return t('evt.newsTonePrimeAccess');
  }

  if (item.stream) {
    return t('evt.newsToneStream');
  }

  if (item.update) {
    return t('evt.newsToneUpdate');
  }

  return t('evt.newsToneNews');
}

function sortNewsItems(left: WfstatNewsItem, right: WfstatNewsItem): number {
  const leftDate = Date.parse(left.date ?? left.activation ?? left.expiry ?? '');
  const rightDate = Date.parse(right.date ?? right.activation ?? right.expiry ?? '');

  return Number(right.priority) - Number(left.priority)
    || (Number.isFinite(rightDate) ? rightDate : 0) - (Number.isFinite(leftDate) ? leftDate : 0)
    || left.message.localeCompare(right.message);
}

function sortFlashSales(left: WfstatFlashSale, right: WfstatFlashSale): number {
  const leftActive = Number(isWorldStateWindowActive(left.activation, left.expiry));
  const rightActive = Number(isWorldStateWindowActive(right.activation, right.expiry));
  const leftEndsAt = Date.parse(left.expiry ?? left.activation ?? '');
  const rightEndsAt = Date.parse(right.expiry ?? right.activation ?? '');

  return rightActive - leftActive
    || (Number.isFinite(leftEndsAt) ? leftEndsAt : Number.MAX_SAFE_INTEGER)
      - (Number.isFinite(rightEndsAt) ? rightEndsAt : Number.MAX_SAFE_INTEGER)
    || left.item.localeCompare(right.item);
}

export function MarketNewsPanel() {
  const { t } = useTranslation();
  const news = useAppStore((state) => state.worldStateNews);
  const flashSales = useAppStore((state) => state.worldStateFlashSales);
  const loading = useAppStore((state) => state.worldStateMarketNewsLoading);
  const error = useAppStore((state) => state.worldStateMarketNewsError);
  const lastUpdatedAt = useAppStore((state) => state.worldStateMarketNewsLastUpdatedAt);
  const refreshWorldStateMarketNews = useAppStore((state) => state.refreshWorldStateMarketNews);
  const [nowMs, setNowMs] = useState(Date.now());

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, []);

  const sortedNews = useMemo(() => [...news].sort(sortNewsItems), [news]);
  const visibleFlashSales = useMemo(
    () => flashSales.filter((sale) => !sale.expired).sort(sortFlashSales),
    [flashSales],
  );
  const hasUsableData = sortedNews.length > 0 || visibleFlashSales.length > 0;

  return (
    <div className="market-news-stack">
      <div className="market-news-toolbar">
        <div className="market-news-toolbar-copy">
          <span className="page-title">{t('evt.marketNewsTitle')}</span>
          <span className="market-news-toolbar-subtitle">
            {t('ws.newsCacheHint')}
          </span>
        </div>

        <div className="market-news-toolbar-actions">
          {lastUpdatedAt ? (
            <span className="world-event-updated-at">
              {t('evt.lastSync', { time: formatWorldStateDateTime(lastUpdatedAt) })}
            </span>
          ) : null}
          <button
            className="text-btn"
            type="button"
            onClick={() => {
              void refreshWorldStateMarketNews();
            }}
          >
            {loading ? t('common.refreshing') : t('common.refresh')}
          </button>
        </div>
      </div>

      <EventsPanelNotice
        message={error}
        tone={hasUsableData ? 'warning' : 'error'}
        loading={loading}
        onRefresh={() => {
          void refreshWorldStateMarketNews();
        }}
      />

      <div className="market-news-layout">
        <section className="card market-news-card">
          <div className="card-header">
            <span className="card-label">{t('ws.news')}</span>
            <span className={`badge ${sortedNews.length > 0 ? 'badge-blue' : 'badge-muted'}`}>
              {t('evt.storiesCount', { n: sortedNews.length })}
            </span>
          </div>

          <div className="card-body">
            {loading && sortedNews.length === 0 ? (
              <EventsPanelEmpty
                title={t('a11y.loadingNews')}
                detail={t('evt.pullingLatestNews')}
              />
            ) : null}

            {!loading && sortedNews.length === 0 && error && !hasUsableData ? (
              <EventsPanelEmpty
                title={t('a11y.newsFailed')}
                detail={error}
                actionLabel={t('common.retry')}
                onAction={() => {
                  void refreshWorldStateMarketNews();
                }}
              />
            ) : null}

            {!loading && sortedNews.length === 0 && (!error || hasUsableData) ? (
              <EventsPanelEmpty
                title={t('a11y.noNews')}
                detail={t('evt.noNewsDetail')}
              />
            ) : null}

            {sortedNews.length > 0 ? (
              <div className="market-news-list">
                {sortedNews.map((item) => {
                  const publishedAt = formatMeaningfulDate(item.date);

                  return (
                    <article key={item.id} className="market-news-item">
                      <a
                        className="market-news-thumb"
                        href={item.link ?? undefined}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={item.link ? t('evt.openLabel', { message: item.message }) : undefined}
                      >
                        {item.imageLink ? <img src={item.imageLink} alt="" loading="lazy" /> : 'N'}
                      </a>

                      <div className="market-news-copy">
                        <div className="market-news-item-topline">
                          <span className="market-news-item-title">{item.message}</span>
                          <span className={`badge ${item.priority ? 'badge-amber' : 'badge-muted'}`}>
                            {buildNewsTone(item, t)}
                          </span>
                        </div>

                        <div className="market-news-item-meta">
                          {publishedAt ? <span>{publishedAt}</span> : null}
                          {item.mobileOnly ? <span>{t('ws.mobile')}</span> : null}
                          {item.link ? (
                            <a href={item.link} target="_blank" rel="noreferrer">
                              {t('evt.openSource')}
                            </a>
                          ) : null}
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : null}
          </div>
        </section>

        <section className="card market-news-card">
          <div className="card-header">
            <span className="card-label">{t('ws.flashSales')}</span>
            <span className={`badge ${visibleFlashSales.length > 0 ? 'badge-green' : 'badge-muted'}`}>
              {t('evt.trackedCount', { n: visibleFlashSales.length })}
            </span>
          </div>

          <div className="card-body">
            {loading && visibleFlashSales.length === 0 ? (
              <EventsPanelEmpty
                title={t('a11y.loadingFlashSales')}
                detail={t('evt.checkingFlashSales')}
              />
            ) : null}

            {!loading && visibleFlashSales.length === 0 && error && !hasUsableData ? (
              <EventsPanelEmpty
                title={t('a11y.flashSalesFailed')}
                detail={error}
                actionLabel={t('common.retry')}
                onAction={() => {
                  void refreshWorldStateMarketNews();
                }}
              />
            ) : null}

            {!loading && visibleFlashSales.length === 0 && (!error || hasUsableData) ? (
              <EventsPanelEmpty
                title={t('a11y.noFlashSales')}
                detail={t('evt.noFlashSalesDetail')}
              />
            ) : null}

            {visibleFlashSales.length > 0 ? (
              <div className="flash-sales-grid">
                {visibleFlashSales.map((sale) => {
                  const isActive = isWorldStateWindowActive(sale.activation, sale.expiry, nowMs);
                  const countdown = formatWorldStateCountdown(
                    isActive ? sale.expiry : sale.activation,
                    nowMs,
                  );

                  return (
                    <article key={sale.id} className="flash-sale-card">
                      <div className="flash-sale-topline">
                        <span className="flash-sale-item-name">{sale.item}</span>
                        <span className={`badge ${isActive ? 'badge-green' : 'badge-blue'}`}>
                          {isActive ? t('evt.active') : t('evt.upcoming')}
                        </span>
                      </div>

                      <div className="flash-sale-stat-grid">
                        <div className="flash-sale-stat">
                          <span className="qv-stat-label">{isActive ? t('evt.endsInLower') : t('evt.startsInLower')}</span>
                          <span className="flash-sale-stat-value">{countdown}</span>
                        </div>
                        <div className="flash-sale-stat">
                          <span className="qv-stat-label">{t('ws.discount')}</span>
                          <span className="flash-sale-stat-value">
                            {sale.discount !== null ? `${sale.discount}%` : '—'}
                          </span>
                        </div>
                        <div className="flash-sale-stat">
                          <span className="qv-stat-label">{t('ws.plat')}</span>
                          <span className="flash-sale-stat-value">
                            {sale.premiumOverride ?? '—'}
                          </span>
                        </div>
                        <div className="flash-sale-stat">
                          <span className="qv-stat-label">{t('ws.credit')}</span>
                          <span className="flash-sale-stat-value">
                            {sale.regularOverride ?? '—'}
                          </span>
                        </div>
                      </div>

                      <div className="flash-sale-footer">
                        <span>{sale.isShownInMarket ? t('evt.visibleInMarket') : t('evt.hiddenInMarket')}</span>
                        <span>{formatWorldStateDateTime(isActive ? sale.expiry : sale.activation)}</span>
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}
