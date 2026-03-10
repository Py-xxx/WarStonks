import { AlertsPanel } from '../../components/AlertsPanel';
import { useAppStore } from '../../stores/useAppStore';

export function AlertsTab() {
  const alerts = useAppStore((state) => state.alerts);

  return (
    <div className="wl-fullscreen">
      <div className="panel-title-row">
        <span className="panel-title-eyebrow">Alerts</span>
        <span className="badge badge-blue">{alerts.length} active</span>
      </div>

      <div className="card">
        <div className="card-body">
          <AlertsPanel />
        </div>
      </div>
    </div>
  );
}
