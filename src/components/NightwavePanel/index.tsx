import { useAppStore } from '../../stores/useAppStore';
import { useTranslation } from '../../i18n';
import { formatShortLocalDateTime } from '../../lib/dateTime';

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

  if (!payload && entry.loading) {
    return <div className="opportunities-placeholder">{t('evt.loadingNightwave')}</div>;
  }
  if (!payload) {
    return <div className="opportunities-placeholder">{t('evt.noNightwaveSeason')}</div>;
  }

  return (
    <div className="market-panel">
      <div className="events-section-header">
        <span className="panel-title-eyebrow">
          Nightwave
        </span>
        <h3>
          {season !== null ? t('evt.nightwaveSeason', { n: season }) : 'Nightwave'}
          {phase !== null ? t('evt.nightwavePhase', { n: phase }) : ''}
        </h3>
        {expiry ? (
          <p className="text-dim">{t('evt.nightwaveSeasonEnds', { date: formatShortLocalDateTime(expiry) })}</p>
        ) : null}
      </div>

      {challenges.length === 0 ? (
        <div className="opportunities-placeholder">{t('evt.noActiveChallenges')}</div>
      ) : (
        <div className="nightwave-grid">
          {challenges.map((challenge, index) => {
            const tier = challengeTier(challenge, tierLabels);
            return (
              <div key={index} className="nightwave-card">
                <div className="nightwave-card-head">
                  <span className={`market-panel-badge tone-${tier.tone}`}>{tier.label}</span>
                  {challenge.reputation !== null ? (
                    <span className="nightwave-standing">
                      {t('evt.standingGain', { n: challenge.reputation.toLocaleString() })}
                    </span>
                  ) : null}
                </div>
                <strong className="nightwave-title">{challenge.title}</strong>
                {challenge.desc ? <p className="nightwave-desc">{challenge.desc}</p> : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
