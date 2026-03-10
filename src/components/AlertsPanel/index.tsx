import { copyWhisperMessage } from '../../lib/marketMessages';
import { resolveWfmAssetUrl } from '../../lib/wfmAssets';
import { useAppStore } from '../../stores/useAppStore';

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
  const clearAllAlerts = useAppStore((state) => state.clearAllAlerts);
  const dismissAlert = useAppStore((state) => state.dismissAlert);
  const markAlertBought = useAppStore((state) => state.markAlertBought);
  const markAlertNoResponse = useAppStore((state) => state.markAlertNoResponse);

  if (alerts.length === 0) {
    return (
      <div className="empty-state">
        <span className="empty-primary">No active alerts</span>
        <span className="empty-sub">
          Alerts appear when a watchlist item reaches or drops below your desired price.
        </span>
      </div>
    );
  }

  const visibleAlerts = compact ? alerts.slice(0, 3) : alerts;

  return (
    <div className={`alerts-panel${compact ? ' compact' : ''}`}>
      {!compact ? (
        <div className="alerts-panel-header">
          <span className="card-label">Active Alerts</span>
          <button className="text-btn" type="button" onClick={clearAllAlerts}>
            Clear All
          </button>
        </div>
      ) : null}

      <div className="alerts-list">
        {visibleAlerts.map((alert) => {
          const imageUrl = resolveWfmAssetUrl(alert.itemImagePath);

          return (
            <div key={alert.id} className="alert-item">
              <div className="alert-main">
                <span className="alert-item-thumb">
                  {imageUrl ? <img src={imageUrl} alt="" loading="lazy" /> : <span>{alert.itemName.slice(0, 1)}</span>}
                </span>

                <div className="alert-copy">
                  <div className="alert-topline">
                    <span className="alert-item-name">{alert.itemName}</span>
                    <span className="badge badge-green">{alert.price} pt</span>
                  </div>
                  <div className="alert-meta">
                    <span>{alert.username}</span>
                    <span>Qty {alert.quantity}</span>
                    {alert.rank !== null && alert.rank !== undefined ? <span>Rank {alert.rank}</span> : null}
                    <span>{formatAlertTimestamp(alert.createdAt)}</span>
                  </div>
                </div>
              </div>

              <div className="alert-actions">
                <button className="act-btn" type="button" onClick={() => markAlertBought(alert.id)}>
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
                  }
                >
                  Copy Message
                </button>
                <button
                  className="alert-clear-btn"
                  type="button"
                  aria-label={`Clear alert for ${alert.itemName}`}
                  onClick={() => dismissAlert(alert.id)}
                >
                  ×
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
