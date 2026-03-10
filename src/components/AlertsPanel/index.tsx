import { copyWhisperMessage } from '../../lib/marketMessages';
import { WORLDSTATE_ENDPOINT_LABELS } from '../../lib/worldState';
import { resolveWfmAssetUrl } from '../../lib/wfmAssets';
import { useAppStore } from '../../stores/useAppStore';
import type { WorldStateEndpointKey } from '../../types';

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
  const systemAlerts = useAppStore((state) => state.systemAlerts);
  const clearAllAlerts = useAppStore((state) => state.clearAllAlerts);
  const clearAllSystemAlerts = useAppStore((state) => state.clearAllSystemAlerts);
  const dismissAlert = useAppStore((state) => state.dismissAlert);
  const dismissSystemAlert = useAppStore((state) => state.dismissSystemAlert);
  const markAlertBought = useAppStore((state) => state.markAlertBought);
  const markAlertNoResponse = useAppStore((state) => state.markAlertNoResponse);
  const refreshWorldStateEvents = useAppStore((state) => state.refreshWorldStateEvents);
  const refreshWorldStateAlerts = useAppStore((state) => state.refreshWorldStateAlerts);
  const refreshWorldStateSortie = useAppStore((state) => state.refreshWorldStateSortie);
  const refreshWorldStateArbitration = useAppStore((state) => state.refreshWorldStateArbitration);
  const refreshWorldStateArchonHunt = useAppStore((state) => state.refreshWorldStateArchonHunt);
  const refreshWorldStateFissures = useAppStore((state) => state.refreshWorldStateFissures);
  const refreshWorldStateInvasions = useAppStore((state) => state.refreshWorldStateInvasions);
  const refreshWorldStateSyndicateMissions = useAppStore(
    (state) => state.refreshWorldStateSyndicateMissions,
  );
  const refreshWorldStateVoidTrader = useAppStore((state) => state.refreshWorldStateVoidTrader);

  const totalAlerts = alerts.length + systemAlerts.length;

  function retrySystemAlert(sourceKey: WorldStateEndpointKey) {
    switch (sourceKey) {
      case 'events':
        void refreshWorldStateEvents();
        break;
      case 'alerts':
        void refreshWorldStateAlerts();
        break;
      case 'sortie':
        void refreshWorldStateSortie();
        break;
      case 'arbitration':
        void refreshWorldStateArbitration();
        break;
      case 'archon-hunt':
        void refreshWorldStateArchonHunt();
        break;
      case 'fissures':
        void refreshWorldStateFissures();
        break;
      case 'invasions':
        void refreshWorldStateInvasions();
        break;
      case 'syndicate-missions':
        void refreshWorldStateSyndicateMissions();
        break;
      case 'void-trader':
        void refreshWorldStateVoidTrader();
        break;
    }
  }

  if (totalAlerts === 0) {
    return (
      <div className="empty-state">
        <span className="empty-primary">No active alerts</span>
        <span className="empty-sub">
          Alerts appear when a watchlist item reaches your target price or a worldstate feed fails.
        </span>
      </div>
    );
  }

  const visibleAlerts = compact ? alerts.slice(0, 3) : alerts;
  const visibleSystemAlerts = compact ? systemAlerts.slice(0, 3) : systemAlerts;

  return (
    <div className={`alerts-panel${compact ? ' compact' : ''}`}>
      {!compact ? (
        <div className="alerts-panel-header">
          <span className="card-label">Active Alerts</span>
          <div className="alert-header-actions">
            {systemAlerts.length > 0 ? (
              <button className="text-btn" type="button" onClick={clearAllSystemAlerts}>
                Clear System
              </button>
            ) : null}
            {alerts.length > 0 ? (
              <button className="text-btn" type="button" onClick={clearAllAlerts}>
                Clear Market
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {visibleSystemAlerts.length > 0 ? (
        <div className="alerts-section">
          <div className="alerts-section-title">System</div>
          <div className="alerts-list">
            {visibleSystemAlerts.map((alert) => (
              <div key={alert.id} className="alert-item alert-item-system">
                <div className="alert-main">
                  <span className="alert-item-thumb alert-item-thumb-system">!</span>
                  <div className="alert-copy">
                    <div className="alert-topline">
                      <span className="alert-item-name">{alert.title}</span>
                      <span className="badge badge-amber">
                        {WORLDSTATE_ENDPOINT_LABELS[alert.sourceKey]}
                      </span>
                    </div>
                    <div className="alert-meta">
                      <span>{alert.message}</span>
                      <span>{formatAlertTimestamp(alert.createdAt)}</span>
                    </div>
                  </div>
                </div>

                <div className="alert-actions">
                  <button
                    className="act-btn"
                    type="button"
                    onClick={() => retrySystemAlert(alert.sourceKey)}
                  >
                    Retry
                  </button>
                  <button
                    className="alert-clear-btn"
                    type="button"
                    aria-label={`Clear system alert for ${alert.title}`}
                    onClick={() => dismissSystemAlert(alert.id)}
                  >
                    ×
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {visibleAlerts.length > 0 ? (
        <div className="alerts-section">
          {visibleSystemAlerts.length > 0 ? (
            <div className="alerts-section-title">Market</div>
          ) : null}
          <div className="alerts-list">
            {visibleAlerts.map((alert) => {
              const imageUrl = resolveWfmAssetUrl(alert.itemImagePath);

              return (
                <div key={alert.id} className="alert-item">
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
      ) : null}
    </div>
  );
}
