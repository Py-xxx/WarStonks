import test from 'node:test';
import assert from 'node:assert/strict';
import { formatWhisperItemName, formatWhisperMessage } from './marketMessages.ts';

test('formatWhisperItemName wraps the full item name in pipes', () => {
  assert.equal(formatWhisperItemName('Blind Rage'), '| Blind Rage |');
});

test('formatWhisperItemName keeps the set suffix inside the pipes', () => {
  assert.equal(formatWhisperItemName('Wisp Prime Set'), '| Wisp Prime Set |');
});

test('formatWhisperItemName keeps the blueprint suffix inside the pipes', () => {
  assert.equal(
    formatWhisperItemName('Wisp Prime Chassis Blueprint'),
    '| Wisp Prime Chassis Blueprint |',
  );
});

test('formatWhisperMessage uses the pipe item-name formatting and please text', () => {
  assert.equal(
    formatWhisperMessage({ username: 'seller', platinum: 42 }, 'Wisp Prime Set'),
    '/w "seller" Hey there! I would like to buy | Wisp Prime Set | for 42 :platinum: please (WarStonks - by py)',
  );
});
