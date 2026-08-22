import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';

import { ItemThumb } from '../ListRow';
import { WatchlistPurchaseModal } from '../WatchlistPurchaseModal';
import { useTranslation } from '../../i18n';
import { formatElapsedTime } from '../../lib/dateTime';
import { formatHomeErrorMessage } from '../../lib/homeErrorHandling';
import { copyWhisperMessage } from '../../lib/marketMessages';
import { WORLDSTATE_ENDPOINT_LABELS } from '../../lib/worldState';
import { resolveWfmAssetUrl } from '../../lib/wfmAssets';
import { useAppStore } from '../../stores/useAppStore';

/**
 * The bell popup: everything waiting for the user, in one list.
 *
 * Three kinds of alert live here — a live underpriced listing, system notices (stale scanner,
 * offline worldstate feeds, an app update) and watchlist hits — and they used to be three
 * near-identical blocks of markup that had drifted apart in spacing, badge colour and button
 * treatment. They are one `AlertRow` now; only the badge, the meta facts and the actions differ,
 * which is the only thing that actually differs about them.
 *
 * The panel is rendered inside the TopBar's `Popover`, which supplies the surface, the heading and
 * the count — so this file draws no chrome of its own.
 */

type Tone = 'green' | 'amber' | 'red' | 'blue' | 'neutral';

const BADGE_CLASS: Record<Tone, string> = {
  green: 'bg-accent-green/15 text-accent-green',
  amber: 'bg-accent-amber/15 text-accent-amber',
  red: 'bg-accent-red/15 text-accent-red',
  blue: 'bg-accent-blue/15 text-accent-blue',
  neutral: 'bg-bg-elevated text-ink-dim',
};

/** A section of alerts: a label, how many, and the control that clears them all. */
function AlertSection({
  title,
  count,
  onClear,
  clearLabel,
  children,
}: {
  title: string;
  count: number;
  onClear?: () => void;
  clearLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5 border-b border-line px-3 py-2.5 last:border-b-0">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[9px] font-bold tracking-[0.07em] text-ink-dim uppercase">
          {title}
        </span>
        <span className="font-mono text-[10px] text-ink-faint tabular-nums">{count}</span>
        {onClear && clearLabel ? (
          <Button
            variant="ghost"
            size="sm"
            static
            onClick={onClear}
            className="ml-auto h-6 px-1.5 text-[11px] text-ink-dim hover:text-ink"
          >
            {clearLabel}
          </Button>
        ) : null}
      </div>
      <div className="flex flex-col gap-1">{children}</div>
    </section>
  );
}

/**
 * One alert. Art, what happened, the facts behind it, and what you can do about it.
 *
 * `onDismiss` is optional because an app update deliberately has no `×`: its two buttons are
 * "Update now" and "Later", and a third way to make it disappear made "Later" ambiguous.
 */
function AlertRow({
  imageUrl,
  fallback,
  title,
  badge,
  meta,
  detail,
  actions,
  onDismiss,
  dismissLabel,
}: {
  imageUrl?: string | null;
  fallback: string;
  title: string;
  badge?: { text: string; tone: Tone };
  meta: (string | null | undefined)[];
  detail?: string | null;
  actions?: React.ReactNode;
  onDismiss?: () => void;
  dismissLabel?: string;
}) {
  return (
    <div className="flex gap-2.5 rounded-md border border-line-subtle bg-bg-panel p-2">
      <ItemThumb src={imageUrl ?? null} fallback={fallback} size="size-8" />

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">{title}</span>
          {badge ? (
            <span
              className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums ${BADGE_CLASS[badge.tone]}`}
            >
              {badge.text}
            </span>
          ) : null}
          {onDismiss && dismissLabel ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={dismissLabel}
              onClick={onDismiss}
              className="-my-1 -mr-1 size-7 shrink-0 text-ink-faint hover:text-ink"
            >
              <i className="ti ti-x text-[13px]" aria-hidden="true" />
            </Button>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-x-2 font-mono text-[10px] text-ink-faint tabular-nums">
          {meta
            .filter((entry): entry is string => Boolean(entry))
            .map((entry, index) => (
              <span key={index}>{entry}</span>
            ))}
        </div>

        {detail ? <p className="text-[11px] text-ink-dim">{detail}</p> : null}

        {actions ? <div className="mt-0.5 flex flex-wrap items-center gap-1">{actions}</div> : null}
      </div>
    </div>
  );
}

/** Actions inside an alert are all the same weight — none of them is the obvious one. */
function AlertAction({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant="secondary"
      size="sm"
      disabled={disabled}
      onClick={onClick}
      className="h-6 border-line px-2 text-[11px]"
    >
      {children}
    </Button>
  );
}

export function AlertsPanel() {
  const { t } = useTranslation();
  const alerts = useAppStore((state) => state.alerts);
  const watchlist = useAppStore((state) => state.watchlist);
  const systemAlerts = useAppStore((state) => state.systemAlerts);
  const clearAllAlerts = useAppStore((state) => state.clearAllAlerts);
  const clearAllSystemAlerts = useAppStore((state) => state.clearAllSystemAlerts);
  const dismissAlert = useAppStore((state) => state.dismissAlert);
  const dismissSystemAlert = useAppStore((state) => state.dismissSystemAlert);
  const installAppUpdate = useAppStore((state) => state.installAppUpdate);
  const markAlertNoResponse = useAppStore((state) => state.markAlertNoResponse);
  const markWatchlistItemBought = useAppStore((state) => state.markWatchlistItemBought);
  const retryWorldStateSystemAlert = useAppStore((state) => state.retryWorldStateSystemAlert);
  const underpricedAlert = useAppStore((state) => state.underpricedAlert);
  const dismissUnderpricedAlert = useAppStore((state) => state.dismissUnderpricedAlert);

  const [purchaseModal, setPurchaseModal] = useState<{
    watchlistId: string;
    itemName: string;
    defaultPrice: number;
    maxQuantity: number;
  } | null>(null);
  const [purchaseLoading, setPurchaseLoading] = useState(false);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);
  const [purchaseSuccess, setPurchaseSuccess] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const totalAlerts = alerts.length + systemAlerts.length + (underpricedAlert ? 1 : 0);

  const notices = (
    <>
      {purchaseSuccess ? (
        <div className="border-b border-line bg-accent-green/[0.08] px-3 py-2 text-[11px] text-accent-green">
          {purchaseSuccess}
        </div>
      ) : null}
      {actionError ? (
        <div className="border-b border-line bg-accent-red/[0.06] px-3 py-2 text-[11px] text-accent-red">
          {actionError}
        </div>
      ) : null}
    </>
  );

  if (totalAlerts === 0) {
    return (
      <div>
        {notices}
        {/* Positive tone: an empty bell means nothing needs you, not that something is missing. */}
        <EmptyState
          icon="ti-bell-check"
          tone="positive"
          title={t('al.noActiveAlerts')}
          detail={t('al.emptyHint')}
        />
      </div>
    );
  }

  return (
    <div className="max-h-[min(70vh,32rem)] overflow-y-auto overscroll-contain">
      {notices}

      {underpricedAlert ? (
        <AlertSection title={t('al.underpricedRadar')} count={1}>
          <AlertRow
            fallback={underpricedAlert.listing.itemName.charAt(0)}
            title={underpricedAlert.listing.itemName}
            badge={{
              text: t('al.pctBelow', { pct: Math.round(underpricedAlert.listing.pctBelow) }),
              tone:
                underpricedAlert.listing.tier === 'red'
                  ? 'red'
                  : underpricedAlert.listing.tier === 'yellow'
                    ? 'amber'
                    : 'green',
            }}
            meta={[
              `${underpricedAlert.listing.listedPrice}p`,
              underpricedAlert.listing.username,
              t('wl.qty') + ' ' + underpricedAlert.listing.quantity,
              `${t('al.rec')} ${underpricedAlert.listing.recommendedPrice}p`,
              underpricedAlert.listing.rank !== null && underpricedAlert.listing.rank !== undefined
                ? `${t('wl.rank')} ${underpricedAlert.listing.rank}`
                : null,
            ]}
            onDismiss={dismissUnderpricedAlert}
            dismissLabel={t('al.dismiss')}
            actions={
              <AlertAction
                onClick={() => {
                  void copyWhisperMessage(
                    {
                      username: underpricedAlert.listing.username,
                      platinum: underpricedAlert.listing.listedPrice,
                      rank: underpricedAlert.listing.rank,
                    },
                    underpricedAlert.listing.itemName,
                  ).catch(() => undefined);
                }}
              >
                <i className="ti ti-copy" aria-hidden="true" />
                {t('al.copyMessage')}
              </AlertAction>
            }
          />
        </AlertSection>
      ) : null}

      {systemAlerts.length > 0 ? (
        <AlertSection
          title={t('al.system')}
          count={systemAlerts.length}
          onClear={clearAllSystemAlerts}
          clearLabel={t('al.clearAll')}
        >
          {systemAlerts.map((alert) => {
            const isUpdate = alert.kind === 'app-update';
            const busy = alert.installState === 'downloading' || alert.installState === 'installing';

            return (
              <AlertRow
                key={alert.id}
                fallback={isUpdate ? '↑' : '!'}
                title={alert.title}
                badge={
                  alert.kind === 'worldstate-offline'
                    ? { text: t('al.feeds', { count: alert.sourceKeys?.length ?? 0 }), tone: 'amber' }
                    : isUpdate
                      ? {
                          text: alert.updateVersion ?? t('al.update'),
                          tone:
                            alert.installState === 'error'
                              ? 'amber'
                              : alert.installState === 'available'
                                ? 'blue'
                                : 'green',
                        }
                      : { text: t('al.stale'), tone: 'amber' }
                }
                meta={[
                  formatElapsedTime(alert.createdAt),
                  alert.kind === 'worldstate-offline' && alert.sourceKeys?.length
                    ? alert.sourceKeys
                        .map((sourceKey) => WORLDSTATE_ENDPOINT_LABELS[sourceKey])
                        .join(', ')
                    : null,
                ]}
                detail={
                  isUpdate && alert.releaseNotes
                    ? // First non-empty line only: the full notes belong in the release, not a popup.
                      (alert.releaseNotes.split('\n').find((line) => line.trim().length > 0) ??
                      alert.message)
                    : alert.message
                }
                // An app update has "Later"; a second dismissal would make that ambiguous.
                onDismiss={isUpdate ? undefined : () => dismissSystemAlert(alert.id)}
                dismissLabel={t('al.clearSystemAria', { title: alert.title })}
                actions={
                  alert.kind === 'worldstate-offline' && alert.sourceKeys?.length ? (
                    <AlertAction onClick={() => void retryWorldStateSystemAlert(alert.sourceKeys ?? [])}>
                      <i className="ti ti-refresh" aria-hidden="true" />
                      {t('al.retry')}
                    </AlertAction>
                  ) : isUpdate ? (
                    <>
                      <AlertAction
                        disabled={busy}
                        onClick={() => {
                          void installAppUpdate().catch((error) => {
                            console.error('[updater] failed to install app update', error);
                          });
                        }}
                      >
                        {alert.installState === 'downloading'
                          ? `${t('al.downloading')}${
                              alert.progressPercent !== null && alert.progressPercent !== undefined
                                ? ` ${alert.progressPercent}%`
                                : ''
                            }`
                          : alert.installState === 'installing'
                            ? t('al.installing')
                            : t('al.updateNow')}
                      </AlertAction>
                      <AlertAction disabled={busy} onClick={() => dismissSystemAlert(alert.id)}>
                        {t('al.later')}
                      </AlertAction>
                    </>
                  ) : null
                }
              />
            );
          })}
        </AlertSection>
      ) : null}

      {alerts.length > 0 ? (
        <AlertSection
          title={t('al.watchlistHits')}
          count={alerts.length}
          onClear={clearAllAlerts}
          clearLabel={t('al.clearAll')}
        >
          {alerts.map((alert) => (
            <AlertRow
              key={alert.id}
              imageUrl={resolveWfmAssetUrl(alert.itemImagePath, alert.itemSlug)}
              fallback={alert.itemName.charAt(0)}
              title={alert.itemName}
              badge={{ text: `${alert.price}p`, tone: 'green' }}
              meta={[
                alert.username,
                t('pf.qtyValue', { n: alert.quantity }),
                alert.rank !== null && alert.rank !== undefined
                  ? `${t('pf.rank')} ${alert.rank}`
                  : null,
                formatElapsedTime(alert.createdAt),
              ]}
              onDismiss={() => dismissAlert(alert.id)}
              dismissLabel={t('al.clearAria', { name: alert.itemName })}
              actions={
                <>
                  <AlertAction
                    onClick={() => {
                      setActionError(null);
                      const watchlistItem = watchlist.find((item) => item.id === alert.watchlistId);
                      setPurchaseError(null);
                      setPurchaseSuccess(null);
                      setPurchaseModal({
                        watchlistId: alert.watchlistId,
                        itemName: alert.itemName,
                        defaultPrice: watchlistItem?.targetPrice ?? alert.price,
                        maxQuantity: watchlistItem?.quantity ?? 1,
                      });
                    }}
                  >
                    <i className="ti ti-check" aria-hidden="true" />
                    {t('wl.markAsBought')}
                  </AlertAction>
                  <AlertAction
                    onClick={() =>
                      void copyWhisperMessage(
                        { username: alert.username, platinum: alert.price, rank: alert.rank },
                        alert.itemName,
                      )
                        .then(() => setActionError(null))
                        .catch(() =>
                          setActionError(
                            formatHomeErrorMessage('alerts-copy', new Error('copy failed')),
                          ),
                        )
                    }
                  >
                    <i className="ti ti-copy" aria-hidden="true" />
                    {t('al.copyMessage')}
                  </AlertAction>
                  <AlertAction onClick={() => markAlertNoResponse(alert.id)}>
                    {t('al.noResponse')}
                  </AlertAction>
                </>
              }
            />
          ))}
        </AlertSection>
      ) : null}

      {purchaseModal ? (
        <WatchlistPurchaseModal
          itemName={purchaseModal.itemName}
          defaultPrice={purchaseModal.defaultPrice}
          maxQuantity={purchaseModal.maxQuantity}
          loading={purchaseLoading}
          errorMessage={purchaseError}
          onClose={() => {
            if (purchaseLoading) {
              return;
            }
            setPurchaseModal(null);
            setPurchaseError(null);
          }}
          onSubmit={(price, quantity) => {
            setPurchaseLoading(true);
            setPurchaseError(null);
            setActionError(null);
            void markWatchlistItemBought(purchaseModal.watchlistId, price, quantity)
              .then((result) => {
                setPurchaseSuccess(result.confirmationMessage);
                setPurchaseModal(null);
              })
              .catch((error) => {
                setPurchaseError(formatHomeErrorMessage('alerts-mark-bought', error));
              })
              .finally(() => {
                setPurchaseLoading(false);
              });
          }}
        />
      ) : null}
    </div>
  );
}
