import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getTradeDetectionRequestPriority,
  TRADE_DETECTION_LOW_PRIORITY_MAX_AGE_MS,
  TRADE_DETECTION_MEDIUM_PRIORITY_MAX_AGE_MS,
} from './tradeDetectionPriority.ts';

test('trade detection priority starts high before any successful refresh', () => {
  assert.equal(getTradeDetectionRequestPriority(0, 20_000), 'high');
});

test('trade detection priority remains low while refresh is fresh', () => {
  assert.equal(
    getTradeDetectionRequestPriority(
      20_000 - (TRADE_DETECTION_LOW_PRIORITY_MAX_AGE_MS - 1),
      20_000,
    ),
    'low',
  );
});

test('trade detection priority escalates to medium after one missed interval', () => {
  assert.equal(
    getTradeDetectionRequestPriority(
      20_000 - TRADE_DETECTION_LOW_PRIORITY_MAX_AGE_MS,
      20_000,
    ),
    'medium',
  );
});

test('trade detection priority escalates to high after two missed intervals', () => {
  assert.equal(
    getTradeDetectionRequestPriority(
      20_000 - TRADE_DETECTION_MEDIUM_PRIORITY_MAX_AGE_MS,
      20_000,
    ),
    'high',
  );
});
