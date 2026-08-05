import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWarframeMarkupLines, splitWarframeMarkupLines } from './warframeMarkup.ts';

test('parseWarframeMarkupLines colors a known damage-type tag and strips the markup', () => {
  const lines = parseWarframeMarkupLines(
    'Gain 1% weapon Critical Chance for 10s, when using abilities to inflict <DT_FIRE_COLOR>Heat Status effect</DT_FIRE_COLOR> on enemies.',
  );
  assert.equal(lines.length, 1);
  const segments = lines[0];
  const colored = segments.find((segment) => segment.text === 'Heat Status effect');
  assert.ok(colored, 'colored segment survives with its text intact');
  assert.equal(colored?.color, '#ff7518');
  // No segment should still contain the raw tag text.
  assert.ok(segments.every((segment) => !segment.text.includes('DT_FIRE_COLOR')));
  // The surrounding plain text is preserved.
  const joined = segments.map((segment) => segment.text).join('');
  assert.equal(
    joined,
    'Gain 1% weapon Critical Chance for 10s, when using abilities to inflict Heat Status effect on enemies.',
  );
});

test('parseWarframeMarkupLines strips unrecognized tags without leaving markup or a color', () => {
  const lines = parseWarframeMarkupLines('Some <UNKNOWN_TAG>effect</UNKNOWN_TAG> here.');
  const segments = lines[0];
  assert.ok(segments.every((segment) => !segment.text.includes('UNKNOWN_TAG')));
  assert.ok(segments.every((segment) => segment.color === null));
  assert.equal(segments.map((segment) => segment.text).join(''), 'Some effect here.');
});

test('parseWarframeMarkupLines only breaks lines on real line breaks, not tags alone', () => {
  const lines = parseWarframeMarkupLines(
    'Gain 1 -> 6% weapon Critical Chance for 10s, when using abilities to inflict <DT_FIRE_COLOR>Heat Status effect</DT_FIRE_COLOR> on enemies. Maximum 50x stacks.',
  );
  // A single logical line in, a single logical line out — the color tag must not fragment it.
  assert.equal(lines.length, 1);
});

test('splitWarframeMarkupLines splits on literal newlines, escaped \\n, and <BR> tags', () => {
  assert.deepEqual(splitWarframeMarkupLines('line one\nline two'), ['line one', 'line two']);
  assert.deepEqual(splitWarframeMarkupLines('line one\\nline two'), ['line one', 'line two']);
  assert.deepEqual(splitWarframeMarkupLines('line one<br/>line two'), ['line one', 'line two']);
  assert.deepEqual(splitWarframeMarkupLines('line one<BR>line two'), ['line one', 'line two']);
});
