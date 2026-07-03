import { useState } from 'react';
import { useTranslation } from '../../i18n';
import { formatHomeErrorMessage } from '../../lib/homeErrorHandling';
import { copyWhisperMessage } from '../../lib/marketMessages';
import { WORLDSTATE_ENDPOINT_LABELS } from '../../lib/worldState';
import { resolveWfmAssetUrl } from '../../lib/wfmAssets';
import { useAppStore } from '../../stores/useAppStore';
import { WatchlistPurchaseModal } from '../WatchlistPurchaseModal';

interface AlertsPanelProps {
  compact?: boolean;
}

function formatAlertTimestamp(isoTimestamp: string): string {
  const createdAt = new Date(isoTimestamp).getTime();
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - createdAt) / 1000));

  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s ago`;
  }

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m ago`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  return `${elapsedHours}h ago`;
}

export function AlertsPanel({ compact = false }: AlertsPanelProps) {
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
  } | null>(null);
  const [purchaseLoading, setPurchaseLoading] = useState(false);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);
  const [purchaseSuccess, setPurchaseSuccess] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const totalAlerts = alerts.length + systemAlerts.length + (underpricedAlert ? 1 : 0);

  if (totalAlerts === 0) {
    return (
      <div>
        {purchaseSuccess ? <div className="settings-inline-success">{purchaseSuccess}</div> : null}
        {actionError ? <div className="settings-inline-error">{actionError}</div> : null}
        <div className="empty-state">
          <span className="empty-primary">{t('al.noActiveAlerts')}</span>
          <span className="empty-sub">
            Alerts appear when a watchlist item reaches your target price or a worldstate feed fails.
          </span>
        </div>
      </div>
    );
  }

  const visibleAlerts = compact ? alerts.slice(0, 3) : alerts;
  const visibleSystemAlerts = compact ? systemAlerts.slice(0, 3) : systemAlerts;

  return (
    <div className={`alerts-panel${compact ? ' compact' : ''}`}>
      {purchaseSuccess ? <div className="settings-inline-success">{purchaseSuccess}</div> : null}
      {actionError ? <div className="settings-inline-error">{actionError}</div> : null}

      {underpricedAlert ? (
        <div className="alerts-section alerts-section-card">
          <div className="alerts-section-header">
            <div className="alerts-section-title-wrap">
              <span className="alerts-section-title">{t('al.underpricedRadar')}</span>
              <span className={`badge badge-${underpricedAlert.listing.tier === 'red' ? 'red' : underpricedAlert.listing.tier === 'yellow' ? 'amber' : 'green'}`}>
                {Math.round(underpricedAlert.listing.pctBelow)}% below
              </span>
            </div>
            <button className="text-btn" type="button" onClick={dismissUnderpricedAlert}>
              Dismiss
            </button>
          </div>
          <div className="alerts-list">
            <div className="alert-item">
              <div className="alert-main">
                <span className="alert-item-thumb">
                  <span>{underpricedAlert.listing.itemName.slice(0, 1)}</span>
                </span>
                <div className="alert-copy">
                  <div className="alert-topline">
                    <span className="alert-item-name">{underpricedAlert.listing.itemName}</span>
                    <span className="badge badge-green">{underpricedAlert.listing.listedPrice} pt</span>
                  </div>
                  <div className="alert-meta">
                    <span>{underpricedAlert.listing.username}</span>
                    <span>{t('wl.qty')} {underpricedAlert.listing.quantity}</span>
                    <span>{t('al.rec')} {underpricedAlert.listing.recommendedPrice} pt</span>
                    {underpricedAlert.listing.rank !== null && underpricedAlert.listing.rank !== undefined ? (
                      <span>{t('wl.rank')} {underpricedAlert.listing.rank}</span>
                    ) : null}
                  </div>
                </div>
              </div>
              <div className="alert-actions">
                <button
                  className="act-btn"
                  type="button"
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
                  Copy Message
                </button>
              </div>
            </div>
          </div>
          {underpricedAlert.otherCount > 0 ? (
            <div className="alerts-underpriced-more">
              {underpricedAlert.otherCount} other underpriced listing
              {underpricedAlert.otherCount === 1 ? '' : 's'} found
            </div>
          ) : null}
        </div>
      ) : null}

      {visibleSystemAlerts.length > 0 ? (
        <div className="alerts-section alerts-section-card">
          <div className="alerts-section-header">
            <div className="alerts-section-title-wrap">
              <span className="alerts-section-title">{t('al.system')}</span>
              <span className="badge badge-amber">{visibleSystemAlerts.length}</span>
            </div>
            {!compact ? (
              <div className="alert-header-actions">
                <button className="text-btn" type="button" onClick={clearAllSystemAlerts}>
                  Clear System
                </button>
              </div>
            ) : null}
          </div>
          <div className="alerts-list">
            {visibleSystemAlerts.map((alert) => (
              <div key={alert.id} className="alert-item alert-item-system">
                {alert.kind !== 'app-update' ? (
                  <button
                    className="alert-clear-btn alert-clear-btn-floating"
                    type="button"
                    aria-label={t('al.clearSystemAria', { title: alert.title })}
                    onClick={() => dismissSystemAlert(alert.id)}
                  >
                    ×
                  </button>
                ) : null}
                <div className="alert-main">
                  <span className="alert-item-thumb alert-item-thumb-system">!</span>
                  <div className="alert-copy">
                    <div className="alert-topline">
                      <span className="alert-item-name">{alert.title}</span>
                      {alert.kind === 'worldstate-offline' ? (
                        <span className="badge badge-amber">{t('al.feeds', { count: alert.sourceKeys?.length ?? 0 })}</span>
                      ) : alert.kind === 'app-update' ? (
                        <span className={`badge ${
                          alert.installState === 'error'
                            ? 'badge-amber'
                            : alert.installState === 'available'
                              ? 'badge-blue'
                              : 'badge-green'
                        }`}>
                          {alert.updateVersion ?? t('al.update')}
                        </span>
                      ) : (
                        <span className="badge badge-amber">{t('al.stale')}</span>
                      )}
                    </div>
                    <div className="alert-meta">
                      <span>{alert.message}</span>
                      {alert.kind === 'worldstate-offline' && alert.sourceKeys?.length ? (
                        <span>
                          {alert.sourceKeys
                            .map((sourceKey) => WORLDSTATE_ENDPOINT_LABELS[sourceKey])
                            .join(', ')}
                        </span>
                      ) : null}
                      <span>{formatAlertTimestamp(alert.createdAt)}</span>
                    </div>
                    {alert.kind === 'app-update' && alert.releaseNotes ? (
                      <div className="alert-system-notes">
                        {alert.releaseNotes.split('\n').find((line) => line.trim().length > 0) ?? alert.releaseNotes}
                      </div>
                    ) : null}
                  </div>
                </div>

                {alert.kind === 'worldstate-offline' && alert.sourceKeys?.length ? (
                  <div className="alert-actions">
                    <button
                      className="act-btn"
                      type="button"
                      onClick={() => {
                        void retryWorldStateSystemAlert(alert.sourceKeys ?? []);
                      }}
                    >
                      Retry
                    </button>
                  </div>
                ) : null}

                {alert.kind === 'app-update' ? (
                  <div className="alert-actions">
                    <button
                      className="act-btn"
                      type="button"
                      disabled={alert.installState === 'downloading' || alert.installState === 'installing'}
                      onClick={() => {
                        void installAppUpdate().catch((error) => {
                          console.error('[updater] failed to install app update', error);
                        });
                      }}
                    >
                      {alert.installState === 'downloading'
                        ? `${t('al.downloading')}${alert.progressPercent !== null && alert.progressPercent !== undefined ? ` ${alert.progressPercent}%` : ''}`
                        : alert.installState === 'installing'
                          ? t('al.installing')
                          : t('al.updateNow')}
                    </button>
                    <button
                      className="act-btn"
                      type="button"
                      disabled={alert.installState === 'downloading' || alert.installState === 'installing'}
                      onClick={() => dismissSystemAlert(alert.id)}
                    >
                      Later
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {visibleAlerts.length > 0 ? (
        <div className="alerts-section alerts-section-card">
          <div className="alerts-section-header">
            <div className="alerts-section-title-wrap">
              <span className="alerts-section-title">{t('nav.market')}</span>
              <span className="badge badge-green">{visibleAlerts.length}</span>
            </div>
            {!compact ? (
              <div className="alert-header-actions">
                <button className="text-btn" type="button" onClick={clearAllAlerts}>
                  Clear Market
                </button>
              </div>
            ) : null}
          </div>
          <div className="alerts-list">
            {visibleAlerts.map((alert) => {
              const imageUrl = resolveWfmAssetUrl(alert.itemImagePath);

              return (
                <div key={alert.id} className="alert-item">
                  <button
                    className="alert-clear-btn alert-clear-btn-floating"
                    type="button"
                    aria-label={t('al.clearAria', { name: alert.itemName })}
                    onClick={() => dismissAlert(alert.id)}
                  >
                    ×
                  </button>
                  <div className="alert-main">
                    <span className="alert-item-thumb">
                      {imageUrl ? (
                        <img src={imageUrl} alt="" loading="lazy" />
                      ) : (
                        <span>{alert.itemName.slice(0, 1)}</span>
                      )}
                    </span>

                    <div className="alert-copy">
                      <div className="alert-topline">
                        <span className="alert-item-name">{alert.itemName}</span>
                        <span className="badge badge-green">{alert.price} pt</span>
                      </div>
                      <div className="alert-meta">
                        <span>{alert.username}</span>
                        <span>Qty {alert.quantity}</span>
                        {alert.rank !== null && alert.rank !== undefined ? (
                          <span>Rank {alert.rank}</span>
                        ) : null}
                        <span>{formatAlertTimestamp(alert.createdAt)}</span>
                      </div>
                    </div>
                  </div>

                  <div className="alert-actions">
                    <button
                      className="act-btn"
                      type="button"
                      onClick={() => {
                        setActionError(null);
                        const watchlistItem = watchlist.find(
                          (item) => item.id === alert.watchlistId,
                        );
                        setPurchaseError(null);
                        setPurchaseSuccess(null);
                        setPurchaseModal({
                          watchlistId: alert.watchlistId,
                          itemName: alert.itemName,
                          defaultPrice: watchlistItem?.targetPrice ?? alert.price,
                        });
                      }}
                    >
                      Mark as bought
                    </button>
                    <button className="act-btn" type="button" onClick={() => markAlertNoResponse(alert.id)}>
                      No Response
                    </button>
                    <button
                      className="act-btn"
                      type="button"
                      onClick={() =>
                        void copyWhisperMessage(
                          { username: alert.username, platinum: alert.price, rank: alert.rank },
                          alert.itemName,
                        )
                          .then(() => {
                            setActionError(null);
                          })
                          .catch(() => {
                            setActionError(
                              formatHomeErrorMessage(
                                'alerts-copy',
                                new Error('copy failed'),
                              ),
                            );
                          })
                      }
                    >
                      Copy Message
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {purchaseModal ? (
        <WatchlistPurchaseModal
          itemName={purchaseModal.itemName}
          defaultPrice={purchaseModal.defaultPrice}
          loading={purchaseLoading}
          errorMessage={purchaseError}
          onClose={() => {
            if (purchaseLoading) {
              return;
            }
            setPurchaseModal(null);
            setPurchaseError(null);
          }}
          onSubmit={(price) => {
            setPurchaseLoading(true);
            setPurchaseError(null);
            setActionError(null);
            void markWatchlistItemBought(purchaseModal.watchlistId, price)
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
