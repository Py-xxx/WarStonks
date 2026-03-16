import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

export const WATCHLIST_ADD_SUCCESS_MESSAGE = 'Added to watchlist';
export const WATCHLIST_ADD_SUCCESS_RESET_MS = 2000;

export type WatchlistAddFeedbackState = Record<string, boolean>;
export type WatchlistAddFeedbackTimeoutMap = MutableRefObject<Map<string, number>>;

export function markWatchlistAddFeedback(
  key: string,
  setState: Dispatch<SetStateAction<WatchlistAddFeedbackState>>,
  timeoutsRef: WatchlistAddFeedbackTimeoutMap,
): void {
  const existingTimeout = timeoutsRef.current.get(key);
  if (existingTimeout !== undefined) {
    window.clearTimeout(existingTimeout);
  }

  setState((current) => ({ ...current, [key]: true }));

  const timeoutId = window.setTimeout(() => {
    timeoutsRef.current.delete(key);
    setState((current) => {
      if (!current[key]) {
        return current;
      }

      const nextState = { ...current };
      delete nextState[key];
      return nextState;
    });
  }, WATCHLIST_ADD_SUCCESS_RESET_MS);

  timeoutsRef.current.set(key, timeoutId);
}

export function clearWatchlistAddFeedbackTimeouts(
  timeoutsRef: WatchlistAddFeedbackTimeoutMap,
): void {
  for (const timeoutId of timeoutsRef.current.values()) {
    window.clearTimeout(timeoutId);
  }
  timeoutsRef.current.clear();
}
