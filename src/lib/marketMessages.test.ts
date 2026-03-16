import test from 'node:test';
import assert from 'node:assert/strict';
import { formatWhisperItemName, formatWhisperMessage } from './marketMessages.ts';

test('formatWhisperItemName wraps normal item names in brackets', () => {
  assert.equal(formatWhisperItemName('Blind Rage'), '[Blind Rage]');
});

test('formatWhisperItemName keeps set outside the brackets', () => {
  assert.equal(formatWhisperItemName('Wisp Prime Set'), '[Wisp Prime] set');
});

test('formatWhisperItemName keeps blueprint outside the brackets', () => {
  assert.equal(formatWhisperItemName('Acceltra Blueprint'), '[Acceltra] Blueprint');
});

test('formatWhisperMessage uses the new item-name formatting and please text', () => {
  assert.equal(
    formatWhisperMessage({ username: 'seller', platinum: 42 }, 'Wisp Prime Set'),
    '/w seller Hey there! I would like to buy [Wisp Prime] set for 42 :platinum: please (WarStonks - by py)',
  );
});
