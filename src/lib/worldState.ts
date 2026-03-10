import type {
  WfstatEventInterimStep,
  WfstatEventReward,
  WfstatEventRewardCountedItem,
  WfstatWorldStateEvent,
} from '../types';

const WFSTAT_EVENTS_URL = 'https://api.warframestat.us/pc/events?language=en';
const INVALID_WORLDSTATE_EXPIRY = '1970-01-01T00:00:00.000Z';
export const WORLDSTATE_RETRY_DELAY_MS = 60_000;

function parseOptionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function parseCountedItems(value: unknown): WfstatEventRewardCountedItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry) => {
    const record = entry as Record<string, unknown>;
    return {
      count: parseOptionalNumber(record.count) ?? 0,
      type: parseOptionalString(record.type) ?? 'Unknown',
      key: parseOptionalString(record.key),
    };
  });
}

function parseReward(value: unknown): WfstatEventReward | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  return {
    items: parseStringArray(record.items),
    countedItems: parseCountedItems(record.countedItems),
    credits: parseOptionalNumber(record.credits),
    thumbnail: parseOptionalString(record.thumbnail),
    color: parseOptionalNumber(record.color),
  };
}

function parseInterimSteps(value: unknown): WfstatEventInterimStep[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry) => {
    const record = entry as Record<string, unknown>;
    return {
      goal: parseOptionalNumber(record.goal),
      reward: parseReward(record.reward),
      message:
        record.message && typeof record.message === 'object'
          ? (record.message as Record<string, unknown>)
          : {},
    };
  });
}

function normalizeWorldStateEvent(entry: unknown): WfstatWorldStateEvent {
  const record = entry as Record<string, unknown>;

  return {
    id: parseOptionalString(record.id) ?? crypto.randomUUID(),
    activation: parseOptionalString(record.activation),
    expiry: parseOptionalString(record.expiry),
    description: parseOptionalString(record.description) ?? 'Unnamed event',
    tooltip: parseOptionalString(record.tooltip),
    node: parseOptionalString(record.node),
    rewards: Array.isArray(record.rewards)
      ? record.rewards
          .map((reward) => parseReward(reward))
          .filter((reward): reward is WfstatEventReward => reward !== null)
      : [],
    interimSteps: parseInterimSteps(record.interimSteps),
    jobs: Array.isArray(record.jobs)
      ? record.jobs.filter((job): job is Record<string, unknown> => Boolean(job) && typeof job === 'object')
      : [],
    previousJobs: Array.isArray(record.previousJobs)
      ? record.previousJobs.filter(
          (job): job is Record<string, unknown> => Boolean(job) && typeof job === 'object',
        )
      : [],
    concurrentNodes: parseStringArray(record.concurrentNodes),
    progressSteps: Array.isArray(record.progressSteps)
      ? record.progressSteps.filter((step): step is number => typeof step === 'number')
      : [],
    regionDrops: parseStringArray(record.regionDrops),
    archwingDrops: parseStringArray(record.archwingDrops),
    maximumScore: parseOptionalNumber(record.maximumScore),
    currentScore: parseOptionalNumber(record.currentScore),
    health: parseOptionalNumber(record.health),
    scoreLocTag: parseOptionalString(record.scoreLocTag),
    scoreVar: parseOptionalString(record.scoreVar),
    tag: parseOptionalString(record.tag),
    altExpiry: parseOptionalString(record.altExpiry),
    altActivation: parseOptionalString(record.altActivation),
    isPersonal: Boolean(record.isPersonal),
    isCommunity: Boolean(record.isCommunity),
    showTotalAtEndOfMission: Boolean(record.showTotalAtEndOfMission),
    expired: typeof record.expired === 'boolean' ? record.expired : undefined,
  };
}

function isValidFutureExpiry(expiry: string | null, nowMs: number): boolean {
  if (!expiry || expiry === INVALID_WORLDSTATE_EXPIRY) {
    return false;
  }

  const parsed = Date.parse(expiry);
  return Number.isFinite(parsed) && parsed > nowMs;
}

export function selectWorldStateEventsRefreshAt(
  events: WfstatWorldStateEvent[],
  nowMs: number = Date.now(),
): string | null {
  const validExpiries = events
    .filter((event) => !event.expired)
    .map((event) => event.expiry)
    .filter((expiry): expiry is string => isValidFutureExpiry(expiry, nowMs))
    .sort((left, right) => Date.parse(left) - Date.parse(right));

  return validExpiries[0] ?? null;
}

export async function fetchWorldStateEventsSnapshot(): Promise<{
  events: WfstatWorldStateEvent[];
  nextRefreshAt: string | null;
  fetchedAt: string;
}> {
  const response = await fetch(WFSTAT_EVENTS_URL, {
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`WFStat events request failed with ${response.status}`);
  }

  const payload = (await response.json()) as unknown;
  if (!Array.isArray(payload)) {
    throw new Error('WFStat events response was not an array.');
  }

  const events = payload.map((entry) => normalizeWorldStateEvent(entry));

  return {
    events,
    nextRefreshAt: selectWorldStateEventsRefreshAt(events),
    fetchedAt: new Date().toISOString(),
  };
}

export function formatWorldStateDateTime(value: string | null): string {
  if (!value) {
    return 'Unavailable';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(parsed);
}

export function formatWorldStateCountdown(expiry: string | null, nowMs: number): string {
  if (!expiry) {
    return 'No expiry';
  }

  const diffMs = Date.parse(expiry) - nowMs;
  if (!Number.isFinite(diffMs)) {
    return 'No expiry';
  }

  if (diffMs <= 0) {
    return 'Expired';
  }

  const totalSeconds = Math.floor(diffMs / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`;
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  return `${minutes}m ${seconds}s`;
}

export function getWorldStateEventProgressPercent(
  event: WfstatWorldStateEvent,
  nowMs: number,
): number | null {
  if (
    typeof event.currentScore === 'number' &&
    typeof event.maximumScore === 'number' &&
    event.maximumScore > 0
  ) {
    return Math.max(0, Math.min(100, (event.currentScore / event.maximumScore) * 100));
  }

  if (!event.activation || !event.expiry) {
    return null;
  }

  const activationMs = Date.parse(event.activation);
  const expiryMs = Date.parse(event.expiry);
  if (!Number.isFinite(activationMs) || !Number.isFinite(expiryMs) || expiryMs <= activationMs) {
    return null;
  }

  const elapsed = nowMs - activationMs;
  const total = expiryMs - activationMs;
  return Math.max(0, Math.min(100, (elapsed / total) * 100));
}
