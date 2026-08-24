import { useAppStore } from '../../stores/useAppStore';
import { useTranslation } from '../../i18n';
import { formatShortLocalDateTime } from '../../lib/dateTime';
import { Skeleton } from '@/components/ui/skeleton';
import { EventEmpty, EventPanel, EventRow, EventTag, RowFigure } from '../Events/parts';

type NightwaveChallenge = {
  title: string;
  desc: string;
  reputation: number | null;
  isDaily: boolean;
  isElite: boolean;
};

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseChallenges(payload: unknown, unknownTitle: string): NightwaveChallenge[] {
  if (!payload || typeof payload !== 'object') {
    return [];
  }
  const list = (payload as Record<string, unknown>).activeChallenges;
  if (!Array.isArray(list)) {
    return [];
  }
  return list.map((raw) => {
    const record = (raw ?? {}) as Record<string, unknown>;
    return {
      title: asString(record.title) ?? unknownTitle,
      desc: asString(record.desc) ?? '',
      reputation: asNumber(record.reputation),
      isDaily: record.isDaily === true,
      isElite: record.isElite === true,
    };
  });
}

function challengeTier(
  challenge: NightwaveChallenge,
  labels: { elite: string; daily: string; weekly: string },
): { label: string; tone: string; order: number } {
  if (challenge.isElite) {
    return { label: labels.elite, tone: 'purple', order: 0 };
  }
  if (challenge.isDaily) {
    return { label: labels.daily, tone: 'blue', order: 2 };
  }
  return { label: labels.weekly, tone: 'green', order: 1 };
}

export function NightwavePanel() {
  const { t } = useTranslation();
  const entry = useAppStore((state) => state.worldStateExtra.nightwave);
  const payload = (entry.payload ?? null) as Record<string, unknown> | null;

  const tierLabels = { elite: t('evt.nightwaveElite'), daily: t('evt.nightwaveDaily'), weekly: t('evt.nightwaveWeekly') };
  const season = asNumber(payload?.season);
  const phase = asNumber(payload?.phase);
  const expiry = asString(payload?.expiry);
  const challenges = parseChallenges(payload, tierLabels.weekly).sort(
    (left, right) => challengeTier(left, tierLabels).order - challengeTier(right, tierLabels).order,
  );

  if (!payload) {
    return (
      <EventPanel title="Nightwave" bodyClassName="p-2">
        {entry.loading ? (
          <Skeleton type="table-row@3" leafClassName="h-5" />
        ) : (
          <EventEmpty icon="ti-flame" title={t('evt.noNightwaveSeason')} />
        )}
      </EventPanel>
    );
  }

  return (
    <EventPanel
      title="Nightwave"
      count={challenges.length}
      countTone="info"
      aside={
        expiry ? (
          <span className="font-mono text-[10px] text-ink-dim">
            {t('evt.nightwaveSeasonEnds', { date: formatShortLocalDateTime(expiry) })}
          </span>
        ) : null
      }
      bodyClassName="flex flex-col gap-1 p-2"
    >
      <span className="px-1 text-[11px] text-ink-dim">
        {season !== null ? t('evt.nightwaveSeason', { n: season }) : 'Nightwave'}
        {phase !== null ? t('evt.nightwavePhase', { n: phase }) : ''}
      </span>

      {challenges.length === 0 ? (
        <EventEmpty icon="ti-checks" title={t('evt.noActiveChallenges')} />
      ) : (
        /* Rows, not cards. A challenge is a title, a tier and a standing figure — three facts
           that line up into columns, where a card per challenge was three lines of box. */
        challenges.map((challenge, index) => {
          const tier = challengeTier(challenge, tierLabels);
          return (
            <EventRow
              key={index}
              lead={<EventTag tone={tier.tone as never}>{tier.label}</EventTag>}
              title={challenge.title}
              meta={challenge.desc || undefined}
              trailing={
                challenge.reputation !== null ? (
                  <RowFigure
                    label={t('evt.standing')}
                    value={challenge.reputation.toLocaleString()}
                    tone="positive"
                    width="w-16"
                  />
                ) : null
              }
            />
          );
        })
      )}
    </EventPanel>
  );
}
