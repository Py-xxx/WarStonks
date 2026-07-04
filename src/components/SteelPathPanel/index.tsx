import { useAppStore } from '../../stores/useAppStore';
import { useTranslation } from '../../i18n';
import { formatShortLocalDateTime } from '../../lib/dateTime';

type SteelPathOffering = { name: string; cost: number | null };

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseOffering(raw: unknown): SteelPathOffering | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const name = asString(record.name);
  if (!name) {
    return null;
  }
  return { name, cost: asNumber(record.cost) };
}

function parseOfferings(value: unknown): SteelPathOffering[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(parseOffering).filter((item): item is SteelPathOffering => item !== null);
}

export function SteelPathPanel() {
  const { t } = useTranslation();
  const entry = useAppStore((state) => state.worldStateExtra['steel-path']);
  const payload = (entry.payload ?? null) as Record<string, unknown> | null;

  if (!payload && entry.loading) {
    return <div className="opportunities-placeholder">{t('evt.loadingSteelPath')}</div>;
  }
  if (!payload) {
    return <div className="opportunities-placeholder">{t('evt.steelPathUnavailable')}</div>;
  }

  const current = parseOffering(payload.currentReward);
  const expiry = asString(payload.expiry);
  const rotation = parseOfferings(payload.rotation);
  const evergreens = parseOfferings(payload.evergreens);

  return (
    <div className="market-panel">
      <div className="events-section-header">
        <span className="panel-title-eyebrow">
          {t('evt.steelPathTeshinLabel')}
        </span>
        <h3>{t('evt.honorRewardTitle')}</h3>
        {expiry ? <p className="text-dim">{t('evt.rotates', { date: formatShortLocalDateTime(expiry) })}</p> : null}
      </div>

      {current ? (
        <div className="steel-path-current">
          <strong>{current.name}</strong>
          {current.cost !== null ? (
            <span className="steel-path-cost">{t('evt.steelEssenceSuffix', { n: current.cost })}</span>
          ) : null}
        </div>
      ) : null}

      {rotation.length > 0 ? (
        <div className="steel-path-block">
          <span className="farm-now-header-label">{t('ws.upcomingRotation')}</span>
          <div className="steel-path-list">
            {rotation.map((offer, index) => (
              <div key={`rotation-${index}`} className="steel-path-row">
                <span>{offer.name}</span>
                {offer.cost !== null ? (
                  <span className="steel-path-cost">{t('evt.seSuffix', { n: offer.cost })}</span>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {evergreens.length > 0 ? (
        <div className="steel-path-block">
          <span className="farm-now-header-label">{t('evt.teshinShopAlwaysAvailable')}</span>
          <div className="steel-path-list">
            {evergreens.map((offer, index) => (
              <div key={`evergreen-${index}`} className="steel-path-row">
                <span>{offer.name}</span>
                {offer.cost !== null ? (
                  <span className="steel-path-cost">{t('evt.seSuffix', { n: offer.cost })}</span>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
