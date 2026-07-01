import { useTranslation } from '../../i18n';

export function StrategyPage() {
  const { t } = useTranslation();
  return (
    <>
      <div className="subnav">
        <div className="subnav-left">
          <span className="page-title">{t('strategy.title')}</span>
        </div>
      </div>
      <div className="page-content">
        <div className="empty-state" style={{ marginTop: 40, minHeight: 220 }}>
          <span className="empty-primary">{t('strategy.empty.title')}</span>
          <span className="empty-sub">
            {t('strategy.empty.sub')}
          </span>
        </div>
      </div>
    </>
  );
}
