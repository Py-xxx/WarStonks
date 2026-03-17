import { useEffect, useRef, useState } from 'react';
import {
  ensureTradeSetMap,
  getArbitrageScannerState,
  initializeAppCatalogOnce,
  isTauriRuntime,
  listenToStartupProgress,
  tryAutoSignInWfmTradeAccount,
  type StartupProgress,
  type StartupSummary,
} from '../lib/tauriClient';
import { useAppStore } from '../stores/useAppStore';

type StartupPhase = 'loading' | 'ready' | 'error';

interface StartupState {
  phase: StartupPhase;
  progress: StartupProgress;
  summary: StartupSummary | null;
  errorMessage: string | null;
  retry: () => void;
}

interface StartupWorldStateTask {
  stageKey: string;
  stageLabel: string;
  run: () => Promise<void>;
}

const INITIAL_PROGRESS: StartupProgress = {
  stageKey: 'startup',
  stageLabel: 'Starting WarStonks',
  statusText: 'Preparing your workspace.',
  progressValue: 0,
};

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function buildWorldStateProgress(
  completedCount: number,
  totalCount: number,
  stageKey: string,
  stageLabel: string,
): StartupProgress {
  const progressBase = 0.86;
  const progressRange = 0.13;
  const completionRatio = totalCount === 0 ? 1 : completedCount / totalCount;

  return {
    stageKey,
    stageLabel: 'Loading live event data',
    statusText:
      completedCount === 0
        ? 'Local setup is ready. Pulling in live event data before launch.'
        : `${stageLabel} is ready. ${completedCount} of ${totalCount} live feeds have loaded.`,
    progressValue: progressBase + completionRatio * progressRange,
  };
}

export function useStartupInitialization(): StartupState {
  const [phase, setPhase] = useState<StartupPhase>('loading');
  const [progress, setProgress] = useState<StartupProgress>(INITIAL_PROGRESS);
  const [summary, setSummary] = useState<StartupSummary | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const activeAttemptRef = useRef(0);
  const refreshWorldStateEvents = useAppStore((state) => state.refreshWorldStateEvents);
  const refreshWorldStateAlerts = useAppStore((state) => state.refreshWorldStateAlerts);
  const refreshWorldStateSortie = useAppStore((state) => state.refreshWorldStateSortie);
  const refreshWorldStateArbitration = useAppStore((state) => state.refreshWorldStateArbitration);
  const refreshWorldStateArchonHunt = useAppStore((state) => state.refreshWorldStateArchonHunt);
  const refreshWorldStateFissures = useAppStore((state) => state.refreshWorldStateFissures);
  const refreshWorldStateMarketNews = useAppStore((state) => state.refreshWorldStateMarketNews);
  const refreshWorldStateInvasions = useAppStore((state) => state.refreshWorldStateInvasions);
  const refreshWorldStateSyndicateMissions = useAppStore(
    (state) => state.refreshWorldStateSyndicateMissions,
  );
  const refreshWorldStateVoidTrader = useAppStore((state) => state.refreshWorldStateVoidTrader);
  const loadTradeAccount = useAppStore((state) => state.loadTradeAccount);
  const syncScannerStaleAlert = useAppStore((state) => state.syncScannerStaleAlert);

  useEffect(() => {
    activeAttemptRef.current += 1;
    const currentAttempt = activeAttemptRef.current;
    let isMounted = true;
    let unlisten: () => void = () => {};

    const runInitialization = async () => {
      setPhase('loading');
      setErrorMessage(null);
      setSummary(null);
      setProgress(INITIAL_PROGRESS);

      if (!isTauriRuntime()) {
        setPhase('ready');
        setProgress({
          stageKey: 'browser-preview',
          stageLabel: 'Browser preview ready',
          statusText: 'Tauri startup is only available inside the desktop shell.',
          progressValue: 1,
        });
        return;
      }

      try {
        setProgress({
          stageKey: 'startup-command',
          stageLabel: 'Loading market data',
          statusText: 'Preparing the local market catalog.',
          progressValue: 0.03,
        });

        void listenToStartupProgress((nextProgress) => {
          if (isMounted && activeAttemptRef.current === currentAttempt) {
            setProgress(nextProgress);
          }
        })
          .then((nextUnlisten) => {
            if (!isMounted || activeAttemptRef.current !== currentAttempt) {
              nextUnlisten();
              return;
            }

            unlisten = nextUnlisten;
          })
          .catch((error) => {
            console.error('[startup] failed to subscribe to startup-progress', error);

            if (!isMounted || activeAttemptRef.current !== currentAttempt) {
              return;
            }

            setProgress((current) => ({
              ...current,
              statusText:
                'Starting up. Live progress updates are temporarily unavailable.',
            }));
          });

        const nextSummary = await initializeAppCatalogOnce();
        if (!isMounted || activeAttemptRef.current !== currentAttempt) {
          return;
        }

        setSummary(nextSummary);

        const setMapProgress: StartupProgress = {
          stageKey: 'trade-set-map',
          stageLabel: 'Preparing planning data',
          statusText: 'Building set and component planning data.',
          progressValue: 0.88,
        };

        setProgress((current) => ({
          ...current,
          ...setMapProgress,
          progressValue: Math.max(current.progressValue, setMapProgress.progressValue),
        }));

        await ensureTradeSetMap(nextSummary.currentWfmApiVersion);
        if (!isMounted || activeAttemptRef.current !== currentAttempt) {
          return;
        }

        const tradeSessionProgress: StartupProgress = {
          stageKey: 'trade-session',
          stageLabel: 'Checking trade session',
          statusText: 'Checking your saved Warframe Market session.',
          progressValue: 0.89,
        };

        setProgress((current) => ({
          ...current,
          ...tradeSessionProgress,
          progressValue: Math.max(current.progressValue, tradeSessionProgress.progressValue),
        }));

        await tryAutoSignInWfmTradeAccount();
        if (!isMounted || activeAttemptRef.current !== currentAttempt) {
          return;
        }

        await loadTradeAccount();
        if (!isMounted || activeAttemptRef.current !== currentAttempt) {
          return;
        }

        try {
          const scannerState = await getArbitrageScannerState();
          if (!isMounted || activeAttemptRef.current !== currentAttempt) {
            return;
          }
          syncScannerStaleAlert(scannerState.latestScan?.scanFinishedAt ?? null);
        } catch (error) {
          console.warn('[startup] scanner stale check failed', error);
        }

        const startupWorldStateTasks = [
          {
            stageKey: 'worldstate-events',
            stageLabel: 'Active Events',
            run: refreshWorldStateEvents,
          },
          {
            stageKey: 'worldstate-void-trader',
            stageLabel: 'Void Trader',
            run: refreshWorldStateVoidTrader,
          },
          {
            stageKey: 'worldstate-fissures',
            stageLabel: 'Fissures',
            run: refreshWorldStateFissures,
          },
          {
            stageKey: 'worldstate-alerts',
            stageLabel: 'Alerts',
            run: refreshWorldStateAlerts,
          },
          {
            stageKey: 'worldstate-market-news',
            stageLabel: 'Market & News',
            run: refreshWorldStateMarketNews,
          },
          {
            stageKey: 'worldstate-sortie',
            stageLabel: 'Sortie',
            run: refreshWorldStateSortie,
          },
          {
            stageKey: 'worldstate-arbitration',
            stageLabel: 'Arbitration',
            run: refreshWorldStateArbitration,
          },
          {
            stageKey: 'worldstate-archon-hunt',
            stageLabel: 'Archon Hunt',
            run: refreshWorldStateArchonHunt,
          },
          {
            stageKey: 'worldstate-invasions',
            stageLabel: 'Invasions',
            run: refreshWorldStateInvasions,
          },
          {
            stageKey: 'worldstate-syndicate-missions',
            stageLabel: 'Syndicate Missions',
            run: refreshWorldStateSyndicateMissions,
          },
        ] satisfies StartupWorldStateTask[];

        const initialWorldStateProgress = buildWorldStateProgress(
          0,
          startupWorldStateTasks.length,
          'worldstate-start',
          'Startup',
        );

        setProgress((current) => ({
          ...current,
          ...initialWorldStateProgress,
          progressValue: Math.max(current.progressValue, initialWorldStateProgress.progressValue),
        }));

        let completedWorldStateTasks = 0;
        for (const task of startupWorldStateTasks) {
          try {
            await task.run();
          } catch (error) {
            console.warn(`[startup] worldstate task '${task.stageKey}' failed`, error);
          } finally {
            if (!isMounted || activeAttemptRef.current !== currentAttempt) {
              return;
            }

            completedWorldStateTasks += 1;
            const nextProgress = buildWorldStateProgress(
              completedWorldStateTasks,
              startupWorldStateTasks.length,
              task.stageKey,
              task.stageLabel,
            );

            setProgress((current) => ({
              ...current,
              ...nextProgress,
              progressValue: Math.max(current.progressValue, nextProgress.progressValue),
            }));
          }
        }

        if (!isMounted || activeAttemptRef.current !== currentAttempt) {
          return;
        }

        const {
          worldStateEvents,
          worldStateEventsError,
          worldStateEventsLastUpdatedAt,
          worldStateAlerts,
          worldStateAlertsError,
          worldStateAlertsLastUpdatedAt,
          worldStateSortie,
          worldStateSortieError,
          worldStateSortieLastUpdatedAt,
          worldStateArbitration,
          worldStateArbitrationError,
          worldStateArbitrationLastUpdatedAt,
          worldStateArchonHunt,
          worldStateArchonHuntError,
          worldStateArchonHuntLastUpdatedAt,
          worldStateFissures,
          worldStateFissuresError,
          worldStateFissuresLastUpdatedAt,
          worldStateNews,
          worldStateFlashSales,
          worldStateMarketNewsError,
          worldStateMarketNewsLastUpdatedAt,
          worldStateInvasions,
          worldStateInvasionsError,
          worldStateInvasionsLastUpdatedAt,
          worldStateSyndicateMissions,
          worldStateSyndicateMissionsError,
          worldStateSyndicateMissionsLastUpdatedAt,
          worldStateVoidTrader,
          worldStateVoidTraderError,
          worldStateVoidTraderLastUpdatedAt,
        } = useAppStore.getState();
        const worldStateFailed =
          (worldStateEventsError &&
            worldStateEvents.length === 0 &&
            worldStateEventsLastUpdatedAt === null) ||
          (worldStateAlertsError &&
            worldStateAlerts.length === 0 &&
            worldStateAlertsLastUpdatedAt === null) ||
          (worldStateSortieError &&
            worldStateSortie === null &&
            worldStateSortieLastUpdatedAt === null) ||
          (worldStateArbitrationError &&
            worldStateArbitration === null &&
            worldStateArbitrationLastUpdatedAt === null) ||
          (worldStateArchonHuntError &&
            worldStateArchonHunt === null &&
            worldStateArchonHuntLastUpdatedAt === null) ||
          (worldStateFissuresError &&
            worldStateFissures.length === 0 &&
            worldStateFissuresLastUpdatedAt === null) ||
          (worldStateMarketNewsError &&
            worldStateNews.length === 0 &&
            worldStateFlashSales.length === 0 &&
            worldStateMarketNewsLastUpdatedAt === null) ||
          (worldStateInvasionsError &&
            worldStateInvasions.length === 0 &&
            worldStateInvasionsLastUpdatedAt === null) ||
          (worldStateSyndicateMissionsError &&
            worldStateSyndicateMissions.length === 0 &&
            worldStateSyndicateMissionsLastUpdatedAt === null) ||
          (worldStateVoidTraderError &&
            worldStateVoidTrader === null &&
            worldStateVoidTraderLastUpdatedAt === null);

        setProgress((current) => ({
          ...current,
          stageKey: 'startup-complete',
          stageLabel: 'Catalog ready',
          statusText:
            worldStateFailed
              ? 'Catalog is ready. One or more worldstate feeds could not be refreshed and will retry in the background.'
              : nextSummary.refreshed
                ? 'Item sources refreshed and startup event data loaded.'
                : 'Cached item catalog and startup event data are current.',
          progressValue: 1,
        }));
        setPhase('ready');
      } catch (error) {
        if (!isMounted || activeAttemptRef.current !== currentAttempt) {
          return;
        }

        setErrorMessage(toErrorMessage(error));
        setPhase('error');
      }
    };

    void runInitialization();

    return () => {
      isMounted = false;
      unlisten();
    };
  }, [
    attempt,
    refreshWorldStateAlerts,
    refreshWorldStateArbitration,
    refreshWorldStateArchonHunt,
    refreshWorldStateEvents,
    refreshWorldStateFissures,
    refreshWorldStateMarketNews,
    refreshWorldStateInvasions,
    refreshWorldStateSortie,
    refreshWorldStateSyndicateMissions,
    refreshWorldStateVoidTrader,
    loadTradeAccount,
  ]);

  return {
    phase,
    progress,
    summary,
    errorMessage,
    retry: () => setAttempt((value) => value + 1),
  };
}
