import { useState } from 'react';
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
  const [purchaseModal, setPurchaseModal] = useState<{
    watchlistId: string;
    itemName: string;
    defaultPrice: number;
  } | null>(null);
  const [purchaseLoading, setPurchaseLoading] = useState(false);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);
  const [purchaseSuccess, setPurchaseSuccess] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const totalAlerts = alerts.length + systemAlerts.length;

  if (totalAlerts === 0) {
    return (
      <div>
        {purchaseSuccess ? <div className="settings-inline-success">{purchaseSuccess}</div> : null}
        {actionError ? <div className="settings-inline-error">{actionError}</div> : null}
        <div className="empty-state">
          <span className="empty-primary">No active alerts</span>
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
      {visibleSystemAlerts.length > 0 ? (
        <div className="alerts-section alerts-section-card">
          <div className="alerts-section-header">
            <div className="alerts-section-title-wrap">
              <span className="alerts-section-title">System</span>
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
                    aria-label={`Clear system alert for ${alert.title}`}
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
                        <span className="badge badge-amber">{alert.sourceKeys?.length ?? 0} feeds</span>
                      ) : alert.kind === 'app-update' ? (
                        <span className={`badge ${
                          alert.installState === 'error'
                            ? 'badge-amber'
                            : alert.installState === 'available'
                              ? 'badge-blue'
                              : 'badge-green'
                        }`}>
                          {alert.updateVersion ?? 'Update'}
                        </span>
                      ) : (
                        <span className="badge badge-amber">Stale</span>
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
                        ? `Downloading${alert.progressPercent !== null && alert.progressPercent !== undefined ? ` ${alert.progressPercent}%` : ''}`
                        : alert.installState === 'installing'
                          ? 'Installing…'
                          : 'Update Now'}
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
              <span className="alerts-section-title">Market</span>
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
                    aria-label={`Clear alert for ${alert.itemName}`}
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
                          { username: alert.username, platinum: alert.price },
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
