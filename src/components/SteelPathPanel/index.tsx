import { useAppStore } from '../../stores/useAppStore';
import { useTranslation } from '../../i18n';
import { formatShortLocalDateTime } from '../../lib/dateTime';
import { Skeleton } from '@/components/ui/skeleton';
import { EventEmpty, EventPanel, EventRow } from '../Events/parts';

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

  if (!payload) {
    return (
      <EventPanel title={t('evt.steelPathTeshinLabel')} bodyClassName="p-2">
        {entry.loading ? (
          <Skeleton type="table-row@3" leafClassName="h-5" />
        ) : (
          <EventEmpty icon="ti-plug-connected-x" title={t('evt.steelPathUnavailable')} />
        )}
      </EventPanel>
    );
  }

  const current = parseOffering(payload.currentReward);
  const expiry = asString(payload.expiry);
  const rotation = parseOfferings(payload.rotation);
  const evergreens = parseOfferings(payload.evergreens);

  return (
    <EventPanel
      title={t('evt.steelPathTeshinLabel')}
      aside={
        expiry ? (
          <span className="font-mono text-[10px] text-ink-dim">
            {t('evt.rotates', { date: formatShortLocalDateTime(expiry) })}
          </span>
        ) : null
      }
      bodyClassName="flex flex-col gap-2 p-2"
    >
      {/* The weekly Limited item is the only thing in Teshin's shop that rotates, so it is the
          one thing given emphasis. The evergreen list has not changed in years. */}
      {current ? (
        <div className="flex items-center gap-2 rounded-md border border-accent-amber/25 bg-accent-amber/8 px-2.5 py-2">
          <i className="ti ti-star shrink-0 text-sm text-accent-amber" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">
            {current.name}
          </span>
          {current.cost !== null ? (
            <span className="shrink-0 font-mono text-[11px] font-semibold tabular-nums text-accent-amber">
              {t('evt.steelEssenceSuffix', { n: current.cost })}
            </span>
          ) : null}
        </div>
      ) : null}

      {(
        [
          [t('ws.upcomingRotation'), rotation],
          [t('evt.teshinShopAlwaysAvailable'), evergreens],
        ] as const
      )
        .filter(([, list]) => list.length > 0)
        .map(([label, list]) => (
          <div key={label} className="flex min-w-0 flex-col">
            <span className="px-1 py-1 font-mono text-[9px] font-semibold tracking-[0.1em] text-ink-dim uppercase">
              {label}
            </span>
            {list.map((offer, index) => (
              <EventRow
                key={`${label}-${index}`}
                title={offer.name}
                trailing={
                  offer.cost !== null ? (
                    <span className="font-mono text-[11px] tabular-nums text-ink-soft">
                      {t('evt.seSuffix', { n: offer.cost })}
                    </span>
                  ) : null
                }
              />
            ))}
          </div>
        ))}
    </EventPanel>
  );
}
