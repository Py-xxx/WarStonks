import { useAppStore } from '../../stores/useAppStore';
import { walletIcons } from '../../assets/wallet';
import { useTranslation } from '../../i18n';
import { formatShortLocalDateTime } from '../../lib/dateTime';
import { parseVaultTraderPayload } from '../../lib/worldState';
import { resolveWfmAssetUrl } from '../../lib/wfmAssets';
import type { VaultTraderTradeableItem } from '../../lib/tauriClient';

const FAMILY_ORDER = ['warframe', 'weapon'] as const;

function groupByFamily(
  items: VaultTraderTradeableItem[],
): Array<{ family: string; items: VaultTraderTradeableItem[] }> {
  const groups = new Map<string, VaultTraderTradeableItem[]>();
  for (const item of items) {
    const bucket = groups.get(item.family);
    if (bucket) {
      bucket.push(item);
    } else {
      groups.set(item.family, [item]);
    }
  }
  const ordered: Array<{ family: string; items: VaultTraderTradeableItem[] }> = FAMILY_ORDER.filter(
    (family) => groups.has(family),
  ).map((family) => ({
    family,
    items: groups.get(family)!,
  }));
  // Any family the fixed order doesn't know about (shouldn't happen — the backend only ever
  // emits "warframe"/"weapon" — still shown rather than silently dropped).
  for (const [family, familyItems] of groups) {
    if (!FAMILY_ORDER.includes(family as (typeof FAMILY_ORDER)[number])) {
      ordered.push({ family, items: familyItems });
    }
  }
  return ordered;
}

export function VaultTraderPanel() {
  const { t } = useTranslation();
  const entry = useAppStore((state) => state.worldStateExtra['vault-trader']);
  const regalAya = useAppStore((state) => state.walletSnapshot.balances.regalAya);
  const parsed = parseVaultTraderPayload(entry.payload);

  if (!parsed && entry.loading) {
    return <div className="opportunities-placeholder">{t('evt.loadingVaultTrader')}</div>;
  }
  if (!parsed) {
    return (
      <div className="opportunities-placeholder">{t('evt.vaultTraderUnavailable')}</div>
    );
  }

  const { active, location, expiry, activation, tradeableItems } = parsed;
  const familyGroups = groupByFamily(tradeableItems);

  return (
    <div className="market-panel">
      <div className="events-section-header">
        <span className="panel-title-eyebrow">
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

      {/* Regal Aya sits here rather than in the currency strip: it buys nothing outside Prime
          Resurgence, so it is only worth knowing while looking at Varzia's stock. Hidden when
          absent — a dash would imply a reading was attempted and failed, when in fact most
          accounts simply hold none of a currency that costs real money. */}
      {regalAya !== null ? (
        <div className="vault-trader-balance">
          <span className="vault-trader-balance-icon">
            <img src={walletIcons.regalAya} alt="" />
          </span>
          <span className="vault-trader-balance-value">
            {new Intl.NumberFormat().format(regalAya)}
          </span>
          <span className="vault-trader-balance-label">{t('evt.regalAyaBalance')}</span>
        </div>
      ) : null}

      {active && tradeableItems.length > 0 ? (
        <div className="vault-trader-family-list">
          {familyGroups.map((group) => (
            <div key={group.family} className="vault-trader-family-group">
              <span className="vault-trader-family-label">
                {group.family === 'warframe'
                  ? t('evt.vaultTraderFamilyWarframes')
                  : group.family === 'weapon'
                    ? t('evt.vaultTraderFamilyWeapons')
                    : group.family}
              </span>
              <div className="vault-trader-grid">
                {group.items.map((item, index) => {
                  const imageUrl = resolveWfmAssetUrl(item.imagePath, item.slug);
                  return (
                    <div key={`${item.slug ?? item.name}-${index}`} className="vault-trader-card">
                      {imageUrl ? (
                        <img src={imageUrl} alt="" className="vault-trader-icon" />
                      ) : null}
                      <span className="vault-trader-name">{item.name}</span>
                      <div className="vault-trader-cost">
                        {item.regalAyaCost !== null ? (
                          <span>{t('evt.regalAyaSuffix', { n: item.regalAyaCost })}</span>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
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
