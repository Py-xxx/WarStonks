import { AlertsPanel } from '../../components/AlertsPanel';
import { useAppStore } from '../../stores/useAppStore';

export function AlertsTab() {
  const alerts = useAppStore((state) => state.alerts);

  return (
    <div className="wl-fullscreen">
      <div className="panel-title-row">
        <span className="panel-title-eyebrow">Alerts</span>
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-label">Active Alerts</span>
          <span className={`badge ${alerts.length > 0 ? 'badge-blue' : 'badge-muted'}`}>
            {alerts.length} active
          </span>
        </div>
        <div className="card-body">
          <AlertsPanel />
        </div>
      </div>
    </div>
  );
}
