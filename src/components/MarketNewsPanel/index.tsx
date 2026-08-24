import { useMemo } from 'react';
import { useTranslation } from '../../i18n';
import type { TranslationKey } from '../../i18n/en';
import {
  formatWorldStateDateTime,
} from '../../lib/worldState';
import { Skeleton } from '@/components/ui/skeleton';
import { ItemThumb } from '../ListRow';
import { EventEmpty, EventError, EventPanel, EventRow, EventTag } from '../Events/parts';
import { useAppStore } from '../../stores/useAppStore';
import type { WfstatNewsItem } from '../../types';

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

export function MarketNewsPanel() {
  const { t } = useTranslation();
  const news = useAppStore((state) => state.worldStateNews);
  const loading = useAppStore((state) => state.worldStateMarketNewsLoading);
  const error = useAppStore((state) => state.worldStateMarketNewsError);
  const lastUpdatedAt = useAppStore((state) => state.worldStateMarketNewsLastUpdatedAt);
  const refreshWorldStateMarketNews = useAppStore((state) => state.refreshWorldStateMarketNews);

  const sortedNews = useMemo(() => [...news].sort(sortNewsItems), [news]);
  const hasUsableData = sortedNews.length > 0;

  return (
    <EventPanel
      title={t('ws.news')}
      count={sortedNews.length}
      countTone={sortedNews.length > 0 ? 'info' : 'muted'}
      updatedAt={
        lastUpdatedAt ? t('evt.lastSync', { time: formatWorldStateDateTime(lastUpdatedAt) }) : null
      }
      bodyClassName="flex flex-col gap-0.5 p-2"
    >
      {error ? (
        <EventError
          error={error}
          stale={hasUsableData}
          onRetry={() => void refreshWorldStateMarketNews()}
        />
      ) : null}

      {loading && sortedNews.length === 0 ? (
        <Skeleton type="table-row@4" leafClassName="h-5" />
      ) : null}

      {!loading && sortedNews.length === 0 && !error ? (
        <EventEmpty icon="ti-news" title={t('a11y.noNews')} />
      ) : null}

      {/* One row per story. It was a 96px-thumbnail card with the headline wrapped over three
          lines and a separate "Open source" link underneath — three or four stories filled the
          column. The whole row is the link now, and the thumbnail is a 28px identifier rather
          than a picture you are meant to look at. */}
      {sortedNews.map((item) => {
        const date = formatMeaningfulDate(item.date ?? item.activation);
        return (
          <a
            key={item.id}
            href={item.link ?? undefined}
            target="_blank"
            rel="noreferrer noopener"
            className="min-w-0 rounded-sm no-underline transition-colors duration-150 ease-out hover:bg-white/[0.03]"
          >
            <EventRow
              className="border-b-0"
              lead={
                <ItemThumb
                  src={item.imageLink}
                  fallback={item.message.slice(0, 1)}
                  size="size-7"
                />
              }
              title={item.message}
              meta={date ?? undefined}
              trailing={
                <>
                  {item.priority ? (
                    <EventTag tone="amber">{t('evt.newsTonePriority')}</EventTag>
                  ) : (
                    <EventTag>{buildNewsTone(item, t)}</EventTag>
                  )}
                  {item.link ? (
                    <i
                      className="ti ti-external-link text-sm text-ink-faint"
                      aria-hidden="true"
                    />
                  ) : null}
                </>
              }
            />
          </a>
        );
      })}
    </EventPanel>
  );
}
