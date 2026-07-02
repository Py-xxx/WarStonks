import { AlertsPanel } from '../../components/AlertsPanel';
import { useAppStore } from '../../stores/useAppStore';
import { useTranslation } from '../../i18n';

export function AlertsTab() {
  const { t } = useTranslation();
  const alerts = useAppStore((state) => state.alerts);

  return (
    <div className="wl-fullscreen">
      <div className="panel-title-row">
        <span className="panel-title-eyebrow">{t('wl.alerts')}</span>
      </div>

      <div className="card accent-amber">
        <div className="card-header">
          <span className="card-label">{t('wl.activeAlerts')}</span>
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
