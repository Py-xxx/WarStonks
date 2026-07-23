import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANCHOR_GAP,
  VIEWPORT_MARGIN,
  computeAnchoredPosition,
} from './anchoredPosition.ts';

const VIEWPORT = { width: 1280, height: 800 };
const POPOVER = { width: 260, height: 300 };

function anchor(top: number, right: number, height = 20, width = 60): {
  top: number;
  bottom: number;
  left: number;
  right: number;
} {
  return { top, bottom: top + height, left: right - width, right };
}

test('sits below the anchor and right-aligns to it when there is room', () => {
  const { top, left } = computeAnchoredPosition(anchor(100, 600), POPOVER, VIEWPORT);
  assert.equal(top, 120 + ANCHOR_GAP);
  assert.equal(left, 600 - POPOVER.width);
});

test('flips above the anchor when there is not enough room below', () => {
  // Anchor near the bottom: below would end at ~1086, well past the 800px viewport.
  const a = anchor(760, 600);
  const { top } = computeAnchoredPosition(a, POPOVER, VIEWPORT);
  assert.equal(top, a.top - ANCHOR_GAP - POPOVER.height);
  assert.ok(top >= VIEWPORT_MARGIN);
});

test('rests against the bottom edge when it fits neither below nor above', () => {
  // Short viewport: no room under the anchor, and not enough above it either.
  const shortViewport = { width: 1280, height: 360 };
  const { top, maxHeight } = computeAnchoredPosition(anchor(200, 600), POPOVER, shortViewport);
  assert.equal(top, shortViewport.height - VIEWPORT_MARGIN - POPOVER.height);
  assert.ok(top >= VIEWPORT_MARGIN, `top ${top} escaped the top edge`);
  assert.equal(maxHeight, shortViewport.height - VIEWPORT_MARGIN * 2);
});

test('never lets a popover taller than the viewport escape the top edge', () => {
  const tinyViewport = { width: 600, height: 200 };
  const { top, maxHeight } = computeAnchoredPosition(anchor(50, 300), POPOVER, tinyViewport);
  assert.equal(top, VIEWPORT_MARGIN);
  // It cannot shrink itself, so maxHeight is what keeps it scrollable inside the viewport.
  assert.equal(maxHeight, tinyViewport.height - VIEWPORT_MARGIN * 2);
});

test('clamps to the left edge when right-aligning would overflow it', () => {
  // Anchor close to the left edge: right-aligned placement would land at a negative left.
  const { left } = computeAnchoredPosition(anchor(100, 120), POPOVER, VIEWPORT);
  assert.equal(left, VIEWPORT_MARGIN);
});

test('clamps to the right edge when the anchor sits past it', () => {
  const { left } = computeAnchoredPosition(anchor(100, 1400), POPOVER, VIEWPORT);
  assert.equal(left, VIEWPORT.width - POPOVER.width - VIEWPORT_MARGIN);
});

test('keeps a popover wider than the viewport pinned to the left margin', () => {
  const narrowViewport = { width: 200, height: 800 };
  const { left } = computeAnchoredPosition(anchor(100, 150), POPOVER, narrowViewport);
  assert.equal(left, VIEWPORT_MARGIN);
});
