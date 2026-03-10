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
  const refreshWorldStateFissures = useAppStore((state) => state.refreshWorldStateFissures);
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
        setProgress((current) => ({
          ...current,
          stageKey: 'worldstate-events',
          stageLabel: 'Fetching event data',
          statusText:
            'Catalog initialization is complete. Loading worldstate event data before entering the app.',
          progressValue: Math.max(current.progressValue, 0.86),
        }));

        await refreshWorldStateEvents();
        if (!isMounted || activeAttemptRef.current !== currentAttempt) {
          return;
        }

        setProgress((current) => ({
          ...current,
          stageKey: 'worldstate-void-trader',
          stageLabel: 'Fetching event data',
          statusText:
            'Active Events are loaded. Fetching Void Trader worldstate data before entering the app.',
          progressValue: Math.max(current.progressValue, 0.93),
        }));

        await refreshWorldStateVoidTrader();
        if (!isMounted || activeAttemptRef.current !== currentAttempt) {
          return;
        }

        setProgress((current) => ({
          ...current,
          stageKey: 'worldstate-fissures',
          stageLabel: 'Fetching event data',
          statusText:
            'Void Trader data is loaded. Fetching fissure worldstate data before entering the app.',
          progressValue: Math.max(current.progressValue, 0.97),
        }));

        await refreshWorldStateFissures();
        if (!isMounted || activeAttemptRef.current !== currentAttempt) {
          return;
        }

        const {
          worldStateEvents,
          worldStateEventsError,
          worldStateFissures,
          worldStateFissuresError,
          worldStateVoidTrader,
          worldStateVoidTraderError,
        } = useAppStore.getState();
        const worldStateFailed =
          (worldStateEventsError && worldStateEvents.length === 0) ||
          (worldStateFissuresError && worldStateFissures.length === 0) ||
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
  }, [attempt, refreshWorldStateEvents, refreshWorldStateFissures, refreshWorldStateVoidTrader]);

  return {
    phase,
    progress,
    summary,
    errorMessage,
    retry: () => setAttempt((value) => value + 1),
  };
}
