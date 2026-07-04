import { useAppStore } from '../../stores/useAppStore';
import { useTranslation } from '../../i18n';
import { formatShortLocalDateTime } from '../../lib/dateTime';

type VaultItem = { name: string; ducats: number | null; credits: number | null };

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseInventory(value: unknown): VaultItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((raw) => {
      const record = (raw ?? {}) as Record<string, unknown>;
      const name = asString(record.item) ?? asString(record.name);
      if (!name) {
        return null;
      }
      return { name, ducats: asNumber(record.ducats), credits: asNumber(record.credits) };
    })
    .filter((item): item is VaultItem => item !== null);
}

export function VaultTraderPanel() {
  const { t } = useTranslation();
  const entry = useAppStore((state) => state.worldStateExtra['vault-trader']);
  const payload = (entry.payload ?? null) as Record<string, unknown> | null;

  if (!payload && entry.loading) {
    return <div className="opportunities-placeholder">{t('evt.loadingVaultTrader')}</div>;
  }
  if (!payload) {
    return (
      <div className="opportunities-placeholder">{t('evt.vaultTraderUnavailable')}</div>
    );
  }

  const active = payload.active === true;
  const location = asString(payload.location);
  const expiry = asString(payload.expiry);
  const activation = asString(payload.activation);
  const inventory = parseInventory(payload.inventory);

  return (
    <div className="market-panel">
      <div className="events-section-header">
        <span className="panel-title-eyebrow">
          <span className="panel-dot panel-dot-purple" aria-hidden="true" />
          {t('evt.primeResurgenceVarziaLabel')}
        </span>
        <h3>
          {active ? t('evt.vaultedRelicsAvailable') : t('evt.away')}
          {location ? ` · ${location}` : ''}
        </h3>
        <p className="text-dim">
          {active
            ? expiry
              ? t('evt.leavesAt', { date: formatShortLocalDateTime(expiry) })
              : t('evt.currentlyInBazaar')
            : activation
              ? t('evt.returnsAt', { date: formatShortLocalDateTime(activation) })
              : t('evt.rotationBetweenCycles')}
        </p>
      </div>

      {active && inventory.length > 0 ? (
        <div className="vault-trader-grid">
          {inventory.map((item, index) => (
            <div key={index} className="vault-trader-card">
              <span className="vault-trader-name">{item.name}</span>
              <div className="vault-trader-cost">
                {item.ducats !== null ? <span>{t('evt.ducatsSuffix', { n: item.ducats })}</span> : null}
                {item.credits !== null ? (
                  <span className="text-dim">{item.credits.toLocaleString()} cr</span>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : active ? (
        <div className="opportunities-placeholder">{t('evt.inventoryNotListed')}</div>
      ) : (
        <div className="opportunities-placeholder">
          {t('ws.varziaHint')}
        </div>
      )}
    </div>
  );
}
