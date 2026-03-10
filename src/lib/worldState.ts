import type {
  VoidTraderInventoryItem,
  WorldStateEndpointKey,
  WfstatAlert,
  WfstatAlertMission,
  WfstatArchonHunt,
  WfstatArchonMission,
  WfstatArbitration,
  WfstatEventInterimStep,
  WfstatEventReward,
  WfstatEventRewardCountedItem,
  WfstatFissure,
  WfstatInvasion,
  WfstatInvasionSide,
  WfstatSortie,
  WfstatSortieVariant,
  WfstatSyndicateJob,
  WfstatSyndicateJobDrop,
  WfstatSyndicateMission,
  WfstatVoidTrader,
  WfstatWorldStateEvent,
} from '../types';
import {
  getWorldStateAlerts,
  getWorldStateArchonHunt,
  getWorldStateArbitration,
  getWorldStateEvents,
  getWorldStateFissures,
  getWorldStateInvasions,
  getWorldStateSortie,
  getWorldStateSyndicateMissions,
  getWorldStateVoidTrader,
  isTauriRuntime,
} from './tauriClient';

const WFSTAT_EVENTS_URL = 'https://api.warframestat.us/pc/events?language=en';
const WFSTAT_ALERTS_URL = 'https://api.warframestat.us/pc/alerts?language=en';
const WFSTAT_SORTIE_URL = 'https://api.warframestat.us/pc/sortie?language=en';
const WFSTAT_ARBITRATION_URL = 'https://api.warframestat.us/pc/arbitration?language=en';
const WFSTAT_ARCHON_HUNT_URL = 'https://api.warframestat.us/pc/archonHunt?language=en';
const WFSTAT_FISSURES_URL = 'https://api.warframestat.us/pc/fissures?language=en';
const WFSTAT_INVASIONS_URL = 'https://api.warframestat.us/pc/invasions?language=en';
const WFSTAT_SYNDICATE_MISSIONS_URL =
  'https://api.warframestat.us/pc/syndicateMissions?language=en';
const WFSTAT_VOID_TRADER_URL = 'https://api.warframestat.us/pc/voidTrader?language=en';
const INVALID_WORLDSTATE_EXPIRY = '1970-01-01T00:00:00.000Z';
const NO_EXPIRY_WORLDSTATE_REFRESH_MS = 5 * 60_000;
export const WORLDSTATE_RETRY_DELAY_MS = 60_000;
export const WORLDSTATE_ENDPOINT_KEYS = {
  events: 'events',
  alerts: 'alerts',
  sortie: 'sortie',
  arbitration: 'arbitration',
  archonHunt: 'archon-hunt',
  fissures: 'fissures',
  invasions: 'invasions',
  syndicateMissions: 'syndicate-missions',
  voidTrader: 'void-trader',
} as const satisfies Record<string, WorldStateEndpointKey>;
export const WORLDSTATE_ENDPOINT_LABELS: Record<WorldStateEndpointKey, string> = {
  events: 'Active Events',
  alerts: 'Alerts',
  sortie: 'Sorties',
  arbitration: 'Arbitrations',
  'archon-hunt': 'Archon Hunts',
  fissures: 'Fissures',
  invasions: 'Invasions',
  'syndicate-missions': 'Syndicate Missions',
  'void-trader': 'Void Trader',
};

function parseOptionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function hasExpired(expiry: string | null, explicitExpired: boolean | undefined): boolean {
  if (explicitExpired) {
    return true;
  }

  if (!expiry || expiry === INVALID_WORLDSTATE_EXPIRY) {
    return false;
  }

  const expiryMs = Date.parse(expiry);
  return Number.isFinite(expiryMs) && expiryMs <= Date.now();
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function parseNumberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is number => typeof entry === 'number' && Number.isFinite(entry))
    : [];
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

function parseAlertMission(value: unknown): WfstatAlertMission | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  return {
    description: parseOptionalString(record.description),
    node: parseOptionalString(record.node),
    nodeKey: parseOptionalString(record.nodeKey),
    type: parseOptionalString(record.type),
    typeKey: parseOptionalString(record.typeKey),
    faction: parseOptionalString(record.faction),
    factionKey: parseOptionalString(record.factionKey),
    reward: parseReward(record.reward),
    minEnemyLevel: parseOptionalNumber(record.minEnemyLevel),
    maxEnemyLevel: parseOptionalNumber(record.maxEnemyLevel),
    maxWaveNum: parseOptionalNumber(record.maxWaveNum),
    nightmare: Boolean(record.nightmare),
    archwingRequired: Boolean(record.archwingRequired),
    isSharkwing: Boolean(record.isSharkwing),
  };
}

function parseSortieVariant(value: unknown): WfstatSortieVariant | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  return {
    missionType: parseOptionalString(record.missionType),
    missionTypeKey: parseOptionalString(record.missionTypeKey),
    modifier: parseOptionalString(record.modifier),
    modifierDescription: parseOptionalString(record.modifierDescription),
    node: parseOptionalString(record.node),
    nodeKey: parseOptionalString(record.nodeKey),
  };
}

function parseArchonMission(value: unknown): WfstatArchonMission | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  return {
    node: parseOptionalString(record.node),
    nodeKey: parseOptionalString(record.nodeKey),
    type: parseOptionalString(record.type),
    typeKey: parseOptionalString(record.typeKey),
    nightmare: Boolean(record.nightmare),
    archwingRequired: Boolean(record.archwingRequired),
    isSharkwing: Boolean(record.isSharkwing),
  };
}

function parseInvasionSide(value: unknown): WfstatInvasionSide {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

  return {
    reward: parseReward(record.reward),
    faction: parseOptionalString(record.faction),
    factionKey: parseOptionalString(record.factionKey),
  };
}

function parseSyndicateJobDrop(value: unknown): WfstatSyndicateJobDrop | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  const item = parseOptionalString(record.item);
  if (!item) {
    return null;
  }

  return {
    item,
    rarity: parseOptionalString(record.rarity),
    chance: parseOptionalNumber(record.chance),
    count: parseOptionalNumber(record.count),
  };
}

function parseSyndicateJob(value: unknown): WfstatSyndicateJob | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  const id = parseOptionalString(record.id);
  if (!id) {
    return null;
  }

  return {
    id,
    expiry: parseOptionalString(record.expiry),
    uniqueName: parseOptionalString(record.uniqueName),
    rewardPool: parseStringArray(record.rewardPool),
    rewardPoolDrops: Array.isArray(record.rewardPoolDrops)
      ? record.rewardPoolDrops
          .map((drop) => parseSyndicateJobDrop(drop))
          .filter((drop): drop is WfstatSyndicateJobDrop => drop !== null)
      : [],
    type: parseOptionalString(record.type),
    enemyLevels: parseNumberArray(record.enemyLevels),
    standingStages: parseNumberArray(record.standingStages),
    minMR: parseOptionalNumber(record.minMR),
  };
}

function normalizeWorldStateEvent(entry: unknown): WfstatWorldStateEvent {
  const record = entry as Record<string, unknown>;
  const expiry = parseOptionalString(record.expiry);

  return {
    id: parseOptionalString(record.id) ?? crypto.randomUUID(),
    activation: parseOptionalString(record.activation),
    expiry,
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
    progressSteps: parseNumberArray(record.progressSteps),
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
    expired: hasExpired(expiry, typeof record.expired === 'boolean' ? record.expired : undefined),
  };
}

function normalizeAlert(entry: unknown): WfstatAlert {
  const record = entry as Record<string, unknown>;
  const expiry = parseOptionalString(record.expiry);

  return {
    id: parseOptionalString(record.id) ?? crypto.randomUUID(),
    activation: parseOptionalString(record.activation),
    expiry,
    mission: parseAlertMission(record.mission),
    rewardTypes: parseStringArray(record.rewardTypes),
    tag: parseOptionalString(record.tag),
    expired: hasExpired(expiry, typeof record.expired === 'boolean' ? record.expired : undefined),
  };
}

function normalizeSortie(entry: unknown): WfstatSortie {
  const record = entry as Record<string, unknown>;
  const expiry = parseOptionalString(record.expiry);

  return {
    id: parseOptionalString(record.id) ?? 'sortie',
    activation: parseOptionalString(record.activation),
    expiry,
    rewardPool: parseOptionalString(record.rewardPool),
    variants: Array.isArray(record.variants)
      ? record.variants
          .map((variant) => parseSortieVariant(variant))
          .filter((variant): variant is WfstatSortieVariant => variant !== null)
      : [],
    boss: parseOptionalString(record.boss),
    faction: parseOptionalString(record.faction),
    factionKey: parseOptionalString(record.factionKey),
    expired: hasExpired(expiry, typeof record.expired === 'boolean' ? record.expired : undefined),
  };
}

function normalizeArbitration(entry: unknown): WfstatArbitration {
  const record = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
  const expiry = parseOptionalString(record.expiry);

  return {
    id: parseOptionalString(record.id) ?? 'arbitration',
    node: parseOptionalString(record.node),
    nodeKey: parseOptionalString(record.nodeKey),
    activation: parseOptionalString(record.activation),
    expiry,
    enemy: parseOptionalString(record.enemy),
    type: parseOptionalString(record.type),
    typeKey: parseOptionalString(record.typeKey),
    archwing: Boolean(record.archwing),
    sharkwing: Boolean(record.sharkwing),
    expired: hasExpired(expiry, typeof record.expired === 'boolean' ? record.expired : undefined),
  };
}

function normalizeArchonHunt(entry: unknown): WfstatArchonHunt {
  const record = entry as Record<string, unknown>;
  const expiry = parseOptionalString(record.expiry);

  return {
    id: parseOptionalString(record.id) ?? 'archon-hunt',
    activation: parseOptionalString(record.activation),
    expiry,
    rewardPool: parseOptionalString(record.rewardPool),
    missions: Array.isArray(record.missions)
      ? record.missions
          .map((mission) => parseArchonMission(mission))
          .filter((mission): mission is WfstatArchonMission => mission !== null)
      : [],
    boss: parseOptionalString(record.boss),
    faction: parseOptionalString(record.faction),
    factionKey: parseOptionalString(record.factionKey),
    expired: hasExpired(expiry, typeof record.expired === 'boolean' ? record.expired : undefined),
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
  const expiry = parseOptionalString(record.expiry);

  return {
    id: parseOptionalString(record.id) ?? 'void-trader',
    activation: parseOptionalString(record.activation),
    expiry,
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
    expired: hasExpired(expiry, typeof record.expired === 'boolean' ? record.expired : undefined),
  };
}

function normalizeFissure(entry: unknown): WfstatFissure {
  const record = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
  const expiry = parseOptionalString(record.expiry);

  return {
    id: parseOptionalString(record.id) ?? crypto.randomUUID(),
    activation: parseOptionalString(record.activation),
    expiry,
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
    expired: hasExpired(expiry, typeof record.expired === 'boolean' ? record.expired : undefined),
  };
}

function normalizeInvasion(entry: unknown): WfstatInvasion {
  const record = entry as Record<string, unknown>;

  return {
    id: parseOptionalString(record.id) ?? crypto.randomUUID(),
    activation: parseOptionalString(record.activation),
    node: parseOptionalString(record.node),
    nodeKey: parseOptionalString(record.nodeKey),
    desc: parseOptionalString(record.desc),
    attacker: parseInvasionSide(record.attacker),
    defender: parseInvasionSide(record.defender),
    vsInfestation: Boolean(record.vsInfestation),
    count: parseOptionalNumber(record.count),
    requiredRuns: parseOptionalNumber(record.requiredRuns),
    completion: parseOptionalNumber(record.completion),
    completed: Boolean(record.completed),
    rewardTypes: parseStringArray(record.rewardTypes),
  };
}

function normalizeSyndicateMission(entry: unknown): WfstatSyndicateMission {
  const record = entry as Record<string, unknown>;
  const expiry = parseOptionalString(record.expiry);

  return {
    id: parseOptionalString(record.id) ?? crypto.randomUUID(),
    activation: parseOptionalString(record.activation),
    expiry,
    syndicate: parseOptionalString(record.syndicate),
    syndicateKey: parseOptionalString(record.syndicateKey),
    nodes: parseStringArray(record.nodes),
    jobs: Array.isArray(record.jobs)
      ? record.jobs
          .map((job) => parseSyndicateJob(job))
          .filter((job): job is WfstatSyndicateJob => job !== null)
      : [],
    expired: hasExpired(expiry, typeof record.expired === 'boolean' ? record.expired : undefined),
  };
}

function isValidFutureExpiry(expiry: string | null, nowMs: number): boolean {
  if (!expiry || expiry === INVALID_WORLDSTATE_EXPIRY) {
    return false;
  }

  const parsed = Date.parse(expiry);
  return Number.isFinite(parsed) && parsed > nowMs;
}

function selectArrayExpiryRefreshAt(
  entries: Array<{ expiry: string | null; expired?: boolean }>,
  nowMs: number,
): string | null {
  if (entries.some((entry) => entry.expired)) {
    return new Date(nowMs + WORLDSTATE_RETRY_DELAY_MS).toISOString();
  }

  const validExpiries = entries
    .map((entry) => entry.expiry)
    .filter((expiry): expiry is string => isValidFutureExpiry(expiry, nowMs))
    .sort((left, right) => Date.parse(left) - Date.parse(right));

  if (validExpiries.length > 0) {
    return validExpiries[0];
  }

  return new Date(nowMs + WORLDSTATE_RETRY_DELAY_MS).toISOString();
}

function selectSingleExpiryRefreshAt(
  entry: { activation: string | null; expiry: string | null; expired?: boolean },
  nowMs: number,
): string | null {
  if (entry.expired) {
    return new Date(nowMs + WORLDSTATE_RETRY_DELAY_MS).toISOString();
  }

  const activationMs = entry.activation ? Date.parse(entry.activation) : Number.NaN;
  if (Number.isFinite(activationMs) && activationMs > nowMs) {
    return entry.activation;
  }

  if (isValidFutureExpiry(entry.expiry, nowMs)) {
    return entry.expiry;
  }

  return new Date(nowMs + WORLDSTATE_RETRY_DELAY_MS).toISOString();
}

export function selectWorldStateEventsRefreshAt(
  events: WfstatWorldStateEvent[],
  nowMs: number = Date.now(),
): string | null {
  return selectArrayExpiryRefreshAt(events, nowMs);
}

export function selectWorldStateAlertsRefreshAt(
  alerts: WfstatAlert[],
  nowMs: number = Date.now(),
): string | null {
  return selectArrayExpiryRefreshAt(alerts, nowMs);
}

export function selectWorldStateSortieRefreshAt(
  sortie: WfstatSortie,
  nowMs: number = Date.now(),
): string | null {
  return selectSingleExpiryRefreshAt(sortie, nowMs);
}

export function selectWorldStateArbitrationRefreshAt(
  arbitration: WfstatArbitration,
  nowMs: number = Date.now(),
): string | null {
  return selectSingleExpiryRefreshAt(arbitration, nowMs);
}

export function selectWorldStateArchonHuntRefreshAt(
  archonHunt: WfstatArchonHunt,
  nowMs: number = Date.now(),
): string | null {
  return selectSingleExpiryRefreshAt(archonHunt, nowMs);
}

export function selectWorldStateFissuresRefreshAt(
  fissures: WfstatFissure[],
  nowMs: number = Date.now(),
): string | null {
  return selectArrayExpiryRefreshAt(fissures, nowMs);
}

export function selectWorldStateSyndicateMissionsRefreshAt(
  missions: WfstatSyndicateMission[],
  nowMs: number = Date.now(),
): string | null {
  const missionEntries = missions.flatMap((mission) => [
    { expiry: mission.expiry, expired: mission.expired },
    ...mission.jobs.map((job) => ({ expiry: job.expiry, expired: mission.expired })),
  ]);

  return selectArrayExpiryRefreshAt(missionEntries, nowMs);
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

  if (Number.isFinite(activationMs) && activationMs > nowMs) {
    return voidTrader.activation;
  }

  if (Number.isFinite(expiryMs) && expiryMs > nowMs && voidTrader.expiry !== INVALID_WORLDSTATE_EXPIRY) {
    return voidTrader.expiry;
  }

  return new Date(nowMs + WORLDSTATE_RETRY_DELAY_MS).toISOString();
}

export function selectWorldStateInvasionsRefreshAt(nowMs: number = Date.now()): string {
  // WFStat invasion payloads do not expose an expiry, so the app falls back to a fixed poll window.
  return new Date(nowMs + NO_EXPIRY_WORLDSTATE_REFRESH_MS).toISOString();
}

export function restoreCachedWorldStateEvents(payload: unknown): WfstatWorldStateEvent[] {
  return Array.isArray(payload) ? payload.map((entry) => normalizeWorldStateEvent(entry)) : [];
}

export function restoreCachedWorldStateAlerts(payload: unknown): WfstatAlert[] {
  return Array.isArray(payload) ? payload.map((entry) => normalizeAlert(entry)) : [];
}

export function restoreCachedWorldStateSortie(payload: unknown): WfstatSortie | null {
  return payload && typeof payload === 'object' ? normalizeSortie(payload) : null;
}

export function restoreCachedWorldStateArbitration(payload: unknown): WfstatArbitration | null {
  return payload && typeof payload === 'object' ? normalizeArbitration(payload) : null;
}

export function restoreCachedWorldStateArchonHunt(payload: unknown): WfstatArchonHunt | null {
  return payload && typeof payload === 'object' ? normalizeArchonHunt(payload) : null;
}

export function restoreCachedWorldStateFissures(payload: unknown): WfstatFissure[] {
  return Array.isArray(payload) ? payload.map((entry) => normalizeFissure(entry)) : [];
}

export function restoreCachedWorldStateInvasions(payload: unknown): WfstatInvasion[] {
  return Array.isArray(payload) ? payload.map((entry) => normalizeInvasion(entry)) : [];
}

export function restoreCachedWorldStateSyndicateMissions(
  payload: unknown,
): WfstatSyndicateMission[] {
  return Array.isArray(payload) ? payload.map((entry) => normalizeSyndicateMission(entry)) : [];
}

export function restoreCachedWorldStateVoidTrader(payload: unknown): WfstatVoidTrader | null {
  return payload && typeof payload === 'object' ? normalizeVoidTrader(payload) : null;
}

async function fetchJsonArray(url: string, label: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`WFStat ${label} request failed with ${response.status}`);
  }

  return response.json();
}

async function fetchJsonObject(url: string, label: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`WFStat ${label} request failed with ${response.status}`);
  }

  return response.json();
}

export async function fetchWorldStateEventsSnapshot(): Promise<{
  events: WfstatWorldStateEvent[];
  nextRefreshAt: string | null;
  fetchedAt: string;
}> {
  const payload = isTauriRuntime()
    ? await getWorldStateEvents()
    : await fetchJsonArray(WFSTAT_EVENTS_URL, 'events');

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

export async function fetchWorldStateAlertsSnapshot(): Promise<{
  alerts: WfstatAlert[];
  nextRefreshAt: string | null;
  fetchedAt: string;
}> {
  const payload = isTauriRuntime()
    ? await getWorldStateAlerts()
    : await fetchJsonArray(WFSTAT_ALERTS_URL, 'alerts');

  if (!Array.isArray(payload)) {
    throw new Error('WFStat alerts response was not an array.');
  }

  const alerts = payload.map((entry) => normalizeAlert(entry));

  return {
    alerts,
    nextRefreshAt: selectWorldStateAlertsRefreshAt(alerts),
    fetchedAt: new Date().toISOString(),
  };
}

export async function fetchWorldStateSortieSnapshot(): Promise<{
  sortie: WfstatSortie;
  nextRefreshAt: string | null;
  fetchedAt: string;
}> {
  const payload = isTauriRuntime()
    ? await getWorldStateSortie()
    : await fetchJsonObject(WFSTAT_SORTIE_URL, 'sortie');

  if (!payload || typeof payload !== 'object') {
    throw new Error('WFStat sortie response was not an object.');
  }

  const sortie = normalizeSortie(payload);

  return {
    sortie,
    nextRefreshAt: selectWorldStateSortieRefreshAt(sortie),
    fetchedAt: new Date().toISOString(),
  };
}

export async function fetchWorldStateArbitrationSnapshot(): Promise<{
  arbitration: WfstatArbitration;
  nextRefreshAt: string | null;
  fetchedAt: string;
}> {
  const payload = isTauriRuntime()
    ? await getWorldStateArbitration()
    : await fetchJsonObject(WFSTAT_ARBITRATION_URL, 'arbitration');

  if (!payload || typeof payload !== 'object') {
    throw new Error('WFStat arbitration response was not an object.');
  }

  const arbitration = normalizeArbitration(payload);

  return {
    arbitration,
    nextRefreshAt: selectWorldStateArbitrationRefreshAt(arbitration),
    fetchedAt: new Date().toISOString(),
  };
}

export async function fetchWorldStateArchonHuntSnapshot(): Promise<{
  archonHunt: WfstatArchonHunt;
  nextRefreshAt: string | null;
  fetchedAt: string;
}> {
  const payload = isTauriRuntime()
    ? await getWorldStateArchonHunt()
    : await fetchJsonObject(WFSTAT_ARCHON_HUNT_URL, 'archon hunt');

  if (!payload || typeof payload !== 'object') {
    throw new Error('WFStat archon hunt response was not an object.');
  }

  const archonHunt = normalizeArchonHunt(payload);

  return {
    archonHunt,
    nextRefreshAt: selectWorldStateArchonHuntRefreshAt(archonHunt),
    fetchedAt: new Date().toISOString(),
  };
}

export async function fetchWorldStateFissuresSnapshot(): Promise<{
  fissures: WfstatFissure[];
  nextRefreshAt: string | null;
  fetchedAt: string;
}> {
  const payload = isTauriRuntime()
    ? await getWorldStateFissures()
    : await fetchJsonArray(WFSTAT_FISSURES_URL, 'fissures');

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

export async function fetchWorldStateInvasionsSnapshot(): Promise<{
  invasions: WfstatInvasion[];
  nextRefreshAt: string;
  fetchedAt: string;
}> {
  const payload = isTauriRuntime()
    ? await getWorldStateInvasions()
    : await fetchJsonArray(WFSTAT_INVASIONS_URL, 'invasions');

  if (!Array.isArray(payload)) {
    throw new Error('WFStat invasions response was not an array.');
  }

  const invasions = payload.map((entry) => normalizeInvasion(entry));

  return {
    invasions,
    nextRefreshAt: selectWorldStateInvasionsRefreshAt(),
    fetchedAt: new Date().toISOString(),
  };
}

export async function fetchWorldStateSyndicateMissionsSnapshot(): Promise<{
  syndicateMissions: WfstatSyndicateMission[];
  nextRefreshAt: string | null;
  fetchedAt: string;
}> {
  const payload = isTauriRuntime()
    ? await getWorldStateSyndicateMissions()
    : await fetchJsonArray(WFSTAT_SYNDICATE_MISSIONS_URL, 'syndicate missions');

  if (!Array.isArray(payload)) {
    throw new Error('WFStat syndicate missions response was not an array.');
  }

  const syndicateMissions = payload.map((entry) => normalizeSyndicateMission(entry));

  return {
    syndicateMissions,
    nextRefreshAt: selectWorldStateSyndicateMissionsRefreshAt(syndicateMissions),
    fetchedAt: new Date().toISOString(),
  };
}

export async function fetchWorldStateVoidTraderSnapshot(): Promise<{
  voidTrader: WfstatVoidTrader;
  nextRefreshAt: string | null;
  fetchedAt: string;
}> {
  const payload = isTauriRuntime()
    ? await getWorldStateVoidTrader()
    : await fetchJsonObject(WFSTAT_VOID_TRADER_URL, 'void trader');

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
