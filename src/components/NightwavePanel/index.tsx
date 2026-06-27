import { useAppStore } from '../../stores/useAppStore';
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

function parseChallenges(payload: unknown): NightwaveChallenge[] {
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
      title: asString(record.title) ?? 'Challenge',
      desc: asString(record.desc) ?? '',
      reputation: asNumber(record.reputation),
      isDaily: record.isDaily === true,
      isElite: record.isElite === true,
    };
  });
}

function challengeTier(challenge: NightwaveChallenge): { label: string; tone: string; order: number } {
  if (challenge.isElite) {
    return { label: 'Elite', tone: 'purple', order: 0 };
  }
  if (challenge.isDaily) {
    return { label: 'Daily', tone: 'blue', order: 2 };
  }
  return { label: 'Weekly', tone: 'green', order: 1 };
}

export function NightwavePanel() {
  const entry = useAppStore((state) => state.worldStateExtra.nightwave);
  const payload = (entry.payload ?? null) as Record<string, unknown> | null;

  const season = asNumber(payload?.season);
  const phase = asNumber(payload?.phase);
  const expiry = asString(payload?.expiry);
  const challenges = parseChallenges(payload).sort(
    (left, right) => challengeTier(left).order - challengeTier(right).order,
  );

  if (!payload && entry.loading) {
    return <div className="opportunities-placeholder">Loading Nightwave…</div>;
  }
  if (!payload) {
    return <div className="opportunities-placeholder">No Nightwave season is active right now.</div>;
  }

  return (
    <div className="market-panel">
      <div className="events-section-header">
        <span className="panel-title-eyebrow">
          <span className="panel-dot panel-dot-purple" aria-hidden="true" />
          Nightwave
        </span>
        <h3>
          {season !== null ? `Season ${season}` : 'Nightwave'}
          {phase !== null ? ` · Phase ${phase}` : ''}
        </h3>
        {expiry ? (
          <p className="text-dim">Season ends {formatShortLocalDateTime(expiry)}</p>
        ) : null}
      </div>

      {challenges.length === 0 ? (
        <div className="opportunities-placeholder">No active challenges listed.</div>
      ) : (
        <div className="nightwave-grid">
          {challenges.map((challenge, index) => {
            const tier = challengeTier(challenge);
            return (
              <div key={index} className="nightwave-card">
                <div className="nightwave-card-head">
                  <span className={`market-panel-badge tone-${tier.tone}`}>{tier.label}</span>
                  {challenge.reputation !== null ? (
                    <span className="nightwave-standing">
                      +{challenge.reputation.toLocaleString()} standing
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
