export type TradeDetectionRequestPriority = 'low' | 'medium' | 'high';

export const TRADE_DETECTION_LOW_PRIORITY_MAX_AGE_MS = 5_000;
export const TRADE_DETECTION_MEDIUM_PRIORITY_MAX_AGE_MS = 10_000;

export function getTradeDetectionRequestPriority(
  lastStartedAt: number,
  nowMs: number = Date.now(),
): TradeDetectionRequestPriority {
  if (lastStartedAt <= 0) {
    return 'high';
  }

  const ageMs = Math.max(0, nowMs - lastStartedAt);
  if (ageMs < TRADE_DETECTION_LOW_PRIORITY_MAX_AGE_MS) {
    return 'low';
  }
  if (ageMs < TRADE_DETECTION_MEDIUM_PRIORITY_MAX_AGE_MS) {
    return 'medium';
  }
  return 'high';
}
