/**
 * tauriClient.ts — typed wrapper around Tauri commands.
 * All functions are stubs when running in a browser (non-Tauri) context.
 */

// Check if running inside Tauri
export const isTauriRuntime = () =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauriRuntime()) {
    const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
    return tauriInvoke<T>(cmd, args);
  }
  // Browser fallback — return mock shapes
  console.warn(`[tauriClient] Not in Tauri context, stubbing: ${cmd}`, args);
  throw new Error(`Command ${cmd} not available outside Tauri`);
}

// ── Typed command wrappers ─────────────────────────────────────────────────

export interface AppShellInfo {
  version: string;
  name: string;
  platform: string;
}

export interface StartupProgress {
  stageKey: string;
  stageLabel: string;
  statusText: string;
  progressValue: number;
}

export interface ImportStats {
  totalWfmItems: number;
  totalWfstatItems: number;
  matchedByDirectRef: number;
  matchedByComponentRef: number;
  matchedByMarketSlug: number;
  matchedByMarketId: number;
  matchedByNormalizedName: number;
  matchedByBlueprintDecomposition: number;
  matchedByManualAlias: number;
  unmatchedWfmItems: number;
  wfmOnlyCanonicalItems: number;
  wfstatOnlyCanonicalItems: number;
}

export interface StartupSummary {
  ready: boolean;
  refreshed: boolean;
  databasePath: string;
  dataDir: string;
  wfmSourceFile: string;
  wfstatSourceFile: string | null;
  stats: ImportStats;
  currentWfmApiVersion: string | null;
}

let startupInitializationPromise: Promise<StartupSummary> | null = null;

export async function getAppShellInfo(): Promise<AppShellInfo> {
  return invoke<AppShellInfo>('get_app_shell_info');
}

export async function getAppVersion(): Promise<string> {
  return invoke<string>('get_app_version');
}

export async function initializeAppCatalog(): Promise<StartupSummary> {
  return invoke<StartupSummary>('initialize_app_catalog');
}

export function initializeAppCatalogOnce(): Promise<StartupSummary> {
  if (!startupInitializationPromise) {
    startupInitializationPromise = initializeAppCatalog().catch((error) => {
      startupInitializationPromise = null;
      throw error;
    });
  }

  return startupInitializationPromise;
}

export async function listenToStartupProgress(
  onProgress: (progress: StartupProgress) => void,
): Promise<() => void> {
  if (!isTauriRuntime()) {
    return () => undefined;
  }

  const { listen } = await import('@tauri-apps/api/event');
  return listen<StartupProgress>('startup-progress', (event) => {
    onProgress(event.payload);
  });
}

// Future commands — add typed stubs here as the backend grows:
// export async function fetchMarketData(itemId: string): Promise<MarketData> { ... }
// export async function syncTradeOrders(): Promise<TradeOrder[]> { ... }
