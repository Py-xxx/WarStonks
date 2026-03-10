import { useEffect, useRef, useState } from 'react';
import {
  initializeAppCatalogOnce,
  isTauriRuntime,
  listenToStartupProgress,
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

const INITIAL_PROGRESS: StartupProgress = {
  stageKey: 'startup',
  stageLabel: 'Starting WarStonks',
  statusText: 'Preparing startup checks.',
  progressValue: 0,
};

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
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
  const refreshWorldStateInvasions = useAppStore((state) => state.refreshWorldStateInvasions);
  const refreshWorldStateSyndicateMissions = useAppStore(
    (state) => state.refreshWorldStateSyndicateMissions,
  );
  const refreshWorldStateVoidTrader = useAppStore((state) => state.refreshWorldStateVoidTrader);

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
          stageLabel: 'Starting catalog sync',
          statusText: 'Connecting startup progress and invoking the desktop initializer.',
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
                'Running startup initialization. Live progress is unavailable in this session.',
            }));
          });

        const nextSummary = await initializeAppCatalogOnce();
        if (!isMounted || activeAttemptRef.current !== currentAttempt) {
          return;
        }

        setSummary(nextSummary);
        const startupWorldStateTasks = [
          {
            stageKey: 'worldstate-events',
            statusText:
              'Catalog initialization is complete. Loading active events before entering the app.',
            run: refreshWorldStateEvents,
          },
          {
            stageKey: 'worldstate-void-trader',
            statusText: 'Active Events are loaded. Fetching Void Trader data.',
            run: refreshWorldStateVoidTrader,
          },
          {
            stageKey: 'worldstate-fissures',
            statusText: 'Void Trader data is loaded. Fetching fissure data.',
            run: refreshWorldStateFissures,
          },
          {
            stageKey: 'worldstate-alerts',
            statusText: 'Fissure data is loaded. Fetching alert activities.',
            run: refreshWorldStateAlerts,
          },
          {
            stageKey: 'worldstate-sortie',
            statusText: 'Alerts are loaded. Fetching sortie data.',
            run: refreshWorldStateSortie,
          },
          {
            stageKey: 'worldstate-arbitration',
            statusText: 'Sortie data is loaded. Fetching arbitration data.',
            run: refreshWorldStateArbitration,
          },
          {
            stageKey: 'worldstate-archon-hunt',
            statusText: 'Arbitration data is loaded. Fetching archon hunt data.',
            run: refreshWorldStateArchonHunt,
          },
          {
            stageKey: 'worldstate-invasions',
            statusText: 'Archon Hunt data is loaded. Fetching invasions.',
            run: refreshWorldStateInvasions,
          },
          {
            stageKey: 'worldstate-syndicate-missions',
            statusText: 'Invasions are loaded. Fetching syndicate missions.',
            run: refreshWorldStateSyndicateMissions,
          },
        ] as const;

        for (const [index, task] of startupWorldStateTasks.entries()) {
          const progressBase = 0.86;
          const progressRange = 0.13;
          const progressValue =
            progressBase + (index / startupWorldStateTasks.length) * progressRange;

          setProgress((current) => ({
            ...current,
            stageKey: task.stageKey,
            stageLabel: 'Fetching event data',
            statusText: task.statusText,
            progressValue: Math.max(current.progressValue, progressValue),
          }));

          await task.run();
          if (!isMounted || activeAttemptRef.current !== currentAttempt) {
            return;
          }
        }

        const {
          worldStateEvents,
          worldStateEventsError,
          worldStateAlerts,
          worldStateAlertsError,
          worldStateSortie,
          worldStateSortieError,
          worldStateArbitration,
          worldStateArbitrationError,
          worldStateArchonHunt,
          worldStateArchonHuntError,
          worldStateFissures,
          worldStateFissuresError,
          worldStateInvasions,
          worldStateInvasionsError,
          worldStateSyndicateMissions,
          worldStateSyndicateMissionsError,
          worldStateVoidTrader,
          worldStateVoidTraderError,
        } = useAppStore.getState();
        const worldStateFailed =
          (worldStateEventsError && worldStateEvents.length === 0) ||
          (worldStateAlertsError && worldStateAlerts.length === 0) ||
          (worldStateSortieError && worldStateSortie === null) ||
          (worldStateArbitrationError && worldStateArbitration === null) ||
          (worldStateArchonHuntError && worldStateArchonHunt === null) ||
          (worldStateFissuresError && worldStateFissures.length === 0) ||
          (worldStateInvasionsError && worldStateInvasions.length === 0) ||
          (worldStateSyndicateMissionsError && worldStateSyndicateMissions.length === 0) ||
          (worldStateVoidTraderError && worldStateVoidTrader === null);

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
    refreshWorldStateInvasions,
    refreshWorldStateSortie,
    refreshWorldStateSyndicateMissions,
    refreshWorldStateVoidTrader,
  ]);

  return {
    phase,
    progress,
    summary,
    errorMessage,
    retry: () => setAttempt((value) => value + 1),
  };
}
