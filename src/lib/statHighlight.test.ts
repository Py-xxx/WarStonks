import test from 'node:test';
import assert from 'node:assert/strict';

import { splitStatHighlightRange, statHighlightPlainText } from './statHighlight.ts';

/**
 * These exist because the bug shipped twice. The fragments used to sit in a `flex gap-2` row,
 * which supplied spacing of its own and hid the fact that both the markup parser (which trims
 * every fragment) and the range regex (whose character class includes a space) were eating the
 * separators. The moment the line flowed as text it read `Gain 1 -> 6%weapon`.
 */

test('the separator survives on both sides of the range', () => {
  const line = 'Gain 1 -> 6% weapon Critical Chance for 10s, when using abilities.';
  assert.equal(
    statHighlightPlainText(line),
    'Gain 1 -> 6% weapon Critical Chance for 10s, when using abilities.',
  );
});

test('a trailing range keeps its leading space and adds none after', () => {
  assert.equal(statHighlightPlainText('Damage 60 -> 120%'), 'Damage 60 -> 120%');
  const parts = splitStatHighlightRange('Damage 60 -> 120%');
  assert.equal(parts?.spaceAfter, false);
});

test('the space eaten by the match itself is still restored', () => {
  // `[\d.,%+\-xX ]*` is greedy and includes a space, so "6% weapon" matches as "6% " and the
  // trim then drops it — `suffix` starts at "weapon" with nothing in front of it.
  const parts = splitStatHighlightRange('Gain 1 -> 6% weapon');
  assert.equal(parts?.value, '1 -> 6%');
  assert.equal(parts?.suffix, 'weapon');
  assert.equal(parts?.spaceAfter, true);
});

test('a line with no range is left alone', () => {
  assert.equal(splitStatHighlightRange('+1 Arcane Revive'), null);
  assert.equal(statHighlightPlainText('+1 Arcane Revive'), '+1 Arcane Revive');
});

test('a range at the very start has no label and no leading space', () => {
  const parts = splitStatHighlightRange('10 -> 20% chance');
  assert.equal(parts?.label, '');
  assert.equal(parts?.spaceBefore, false);
  assert.equal(statHighlightPlainText('10 -> 20% chance'), '10 -> 20% chance');
});
