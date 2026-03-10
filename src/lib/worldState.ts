import type {
  VoidTraderInventoryItem,
  WfstatEventInterimStep,
  WfstatEventReward,
  WfstatEventRewardCountedItem,
  WfstatFissure,
  WfstatVoidTrader,
  WfstatWorldStateEvent,
} from '../types';
import {
  getWorldStateEvents,
  getWorldStateFissures,
  getWorldStateVoidTrader,
  isTauriRuntime,
} from './tauriClient';

const WFSTAT_EVENTS_URL = 'https://api.warframestat.us/pc/events?language=en';
const WFSTAT_FISSURES_URL = 'https://api.warframestat.us/pc/fissures?language=en';
const WFSTAT_VOID_TRADER_URL = 'https://api.warframestat.us/pc/voidTrader?language=en';
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

function normalizeVoidTraderInventoryItem(entry: unknown): VoidTraderInventoryItem | null {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const record = entry as Record<string, unknown>;
  const item = parseOptionalString(record.item);
  if (!item) {
    return null;
  }

  return {
    item,
    ducats: parseOptionalNumber(record.ducats),
    credits: parseOptionalNumber(record.credits),
    category: parseOptionalString(record.category) ?? 'Other',
    imagePath: parseOptionalString(record.imagePath),
  };
}

function normalizeVoidTrader(entry: unknown): WfstatVoidTrader {
  const record = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;

  return {
    id: parseOptionalString(record.id) ?? 'void-trader',
    activation: parseOptionalString(record.activation),
    expiry: parseOptionalString(record.expiry),
    character: parseOptionalString(record.character) ?? "Baro Ki'Teer",
    location: parseOptionalString(record.location),
    inventory: Array.isArray(record.inventory)
      ? record.inventory
          .map((inventoryItem) => normalizeVoidTraderInventoryItem(inventoryItem))
          .filter((inventoryItem): inventoryItem is VoidTraderInventoryItem => inventoryItem !== null)
      : [],
    psId: parseOptionalString(record.psId),
    initialStart: parseOptionalString(record.initialStart),
    schedule: Array.isArray(record.schedule)
      ? record.schedule.filter(
          (item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object',
        )
      : [],
    expired: typeof record.expired === 'boolean' ? record.expired : undefined,
  };
}

function normalizeFissure(entry: unknown): WfstatFissure {
  const record = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;

  return {
    id: parseOptionalString(record.id) ?? crypto.randomUUID(),
    activation: parseOptionalString(record.activation),
    expiry: parseOptionalString(record.expiry),
    node: parseOptionalString(record.node),
    missionType: parseOptionalString(record.missionType),
    missionTypeKey: parseOptionalString(record.missionTypeKey),
    enemy: parseOptionalString(record.enemy),
    enemyKey: parseOptionalString(record.enemyKey),
    nodeKey: parseOptionalString(record.nodeKey),
    tier: parseOptionalString(record.tier),
    tierNum: parseOptionalNumber(record.tierNum),
    isStorm: Boolean(record.isStorm),
    isHard: Boolean(record.isHard),
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

export function selectWorldStateFissuresRefreshAt(
  fissures: WfstatFissure[],
  nowMs: number = Date.now(),
): string | null {
  const validExpiries = fissures
    .filter((fissure) => !fissure.expired)
    .map((fissure) => fissure.expiry)
    .filter((expiry): expiry is string => isValidFutureExpiry(expiry, nowMs))
    .sort((left, right) => Date.parse(left) - Date.parse(right));

  return validExpiries[0] ?? null;
}

export function isWorldStateWindowActive(
  activation: string | null,
  expiry: string | null,
  nowMs: number = Date.now(),
): boolean {
  const activationMs = activation ? Date.parse(activation) : Number.NaN;
  const expiryMs = expiry ? Date.parse(expiry) : Number.NaN;

  if (!Number.isFinite(expiryMs) || expiryMs <= nowMs) {
    return false;
  }

  if (!Number.isFinite(activationMs)) {
    return true;
  }

  return activationMs <= nowMs;
}

export function selectVoidTraderRefreshAt(
  voidTrader: WfstatVoidTrader,
  nowMs: number = Date.now(),
): string | null {
  if (voidTrader.expired) {
    return new Date(nowMs + WORLDSTATE_RETRY_DELAY_MS).toISOString();
  }

  const activationMs = voidTrader.activation ? Date.parse(voidTrader.activation) : Number.NaN;
  const expiryMs = voidTrader.expiry ? Date.parse(voidTrader.expiry) : Number.NaN;

  // The view becomes stale at activation when Baro arrives, then again at expiry when he leaves.
  if (Number.isFinite(activationMs) && activationMs > nowMs) {
    return voidTrader.activation;
  }

  if (Number.isFinite(expiryMs) && expiryMs > nowMs && voidTrader.expiry !== INVALID_WORLDSTATE_EXPIRY) {
    return voidTrader.expiry;
  }

  return null;
}

export async function fetchWorldStateEventsSnapshot(): Promise<{
  events: WfstatWorldStateEvent[];
  nextRefreshAt: string | null;
  fetchedAt: string;
}> {
  let payload: unknown;

  if (isTauriRuntime()) {
    payload = await getWorldStateEvents();
  } else {
    const response = await fetch(WFSTAT_EVENTS_URL, {
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`WFStat events request failed with ${response.status}`);
    }

    payload = (await response.json()) as unknown;
  }

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

export async function fetchWorldStateFissuresSnapshot(): Promise<{
  fissures: WfstatFissure[];
  nextRefreshAt: string | null;
  fetchedAt: string;
}> {
  let payload: unknown;

  if (isTauriRuntime()) {
    payload = await getWorldStateFissures();
  } else {
    const response = await fetch(WFSTAT_FISSURES_URL, {
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`WFStat fissures request failed with ${response.status}`);
    }

    payload = (await response.json()) as unknown;
  }

  if (!Array.isArray(payload)) {
    throw new Error('WFStat fissures response was not an array.');
  }

  const fissures = payload.map((entry) => normalizeFissure(entry));

  return {
    fissures,
    nextRefreshAt: selectWorldStateFissuresRefreshAt(fissures),
    fetchedAt: new Date().toISOString(),
  };
}

export async function fetchWorldStateVoidTraderSnapshot(): Promise<{
  voidTrader: WfstatVoidTrader;
  nextRefreshAt: string | null;
  fetchedAt: string;
}> {
  let payload: unknown;

  if (isTauriRuntime()) {
    payload = await getWorldStateVoidTrader();
  } else {
    const response = await fetch(WFSTAT_VOID_TRADER_URL, {
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`WFStat void trader request failed with ${response.status}`);
    }

    payload = (await response.json()) as unknown;
  }

  if (!payload || typeof payload !== 'object') {
    throw new Error('WFStat void trader response was not an object.');
  }

  const voidTrader = normalizeVoidTrader(payload);

  return {
    voidTrader,
    nextRefreshAt: selectVoidTraderRefreshAt(voidTrader),
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
