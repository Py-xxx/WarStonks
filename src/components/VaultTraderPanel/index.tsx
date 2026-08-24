import { useAppStore } from '../../stores/useAppStore';
import { walletIcons } from '../../assets/wallet';
import { useTranslation } from '../../i18n';
import { formatShortLocalDateTime } from '../../lib/dateTime';
import { parseVaultTraderPayload } from '../../lib/worldState';
import { resolveWfmAssetUrl } from '../../lib/wfmAssets';
import type { VaultTraderTradeableItem } from '../../lib/tauriClient';
import { ItemThumb } from '../ListRow';
import { EventEmpty, EventPanel, EventRow, RowFigure } from '../Events/parts';
import { Skeleton } from '@/components/ui/skeleton';

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

  if (!parsed) {
    return (
      <EventPanel title={t('evt.primeResurgenceVarziaLabel')} bodyClassName="p-2">
        {entry.loading ? (
          <Skeleton type="table-row@3" leafClassName="h-5" />
        ) : (
          <EventEmpty icon="ti-plug-connected-x" title={t('evt.vaultTraderUnavailable')} />
        )}
      </EventPanel>
    );
  }

  const { active, location, expiry, activation, tradeableItems } = parsed;
  const familyGroups = groupByFamily(tradeableItems);

  return (
    <EventPanel
      title={t('evt.primeResurgenceVarziaLabel')}
      count={active ? tradeableItems.length : null}
      countTone="info"
      aside={
        <>
          {/* Regal Aya sits here rather than in the currency strip: it buys nothing outside Prime
              Resurgence, so it is only worth knowing while looking at Varzia's stock. Hidden when
              absent — a dash would imply a reading was attempted and failed, when most accounts
              simply hold none of a currency that costs real money. */}
          {regalAya !== null ? (
            <span className="flex items-center gap-1 font-mono text-[11px] tabular-nums text-ink">
              <img src={walletIcons.regalAya} alt="" className="size-3.5" />
              {new Intl.NumberFormat().format(regalAya)}
            </span>
          ) : null}
          <span
            className={`font-mono text-[11px] font-semibold ${
              active ? 'text-accent-green' : 'text-ink-dim'
            }`}
          >
            {active ? t('evt.active') : t('evt.away')}
          </span>
        </>
      }
      bodyClassName="flex flex-col gap-2 p-2"
    >
      <span className="px-1 text-[11px] text-ink-dim">
        {active
          ? [
              location,
              expiry ? t('evt.leavesAt', { date: formatShortLocalDateTime(expiry) }) : t('evt.currentlyInBazaar'),
            ]
              .filter(Boolean)
              .join(' · ')
          : activation
            ? t('evt.returnsAt', { date: formatShortLocalDateTime(activation) })
            : t('evt.rotationBetweenCycles')}
      </span>

      {active && tradeableItems.length > 0 ? (
        <div className="flex flex-col gap-2">
          {familyGroups.map((group) => (
            <div key={group.family} className="flex min-w-0 flex-col">
              <span className="px-1 py-1 font-mono text-[9px] font-semibold tracking-[0.1em] text-ink-dim uppercase">
                {group.family === 'warframe'
                  ? t('evt.vaultTraderFamilyWarframes')
                  : group.family === 'weapon'
                    ? t('evt.vaultTraderFamilyWeapons')
                    : group.family}
                {` · ${group.items.length}`}
              </span>
              {group.items.map((item, index) => (
                <EventRow
                  key={`${item.slug ?? item.name}-${index}`}
                  lead={
                    <ItemThumb
                      src={resolveWfmAssetUrl(item.imagePath, item.slug)}
                      fallback={item.name.slice(0, 1)}
                      size="size-7"
                    />
                  }
                  title={item.name}
                  trailing={
                    item.regalAyaCost !== null ? (
                      <RowFigure label={t('evt.regalAyaBalance')} value={item.regalAyaCost} />
                    ) : null
                  }
                />
              ))}
            </div>
          ))}
        </div>
      ) : active ? (
        <EventEmpty icon="ti-package" title={t('evt.inventoryNotListed')} />
      ) : (
        <EventEmpty icon="ti-clock" title={t('ws.varziaHint')} />
      )}
    </EventPanel>
  );
}
