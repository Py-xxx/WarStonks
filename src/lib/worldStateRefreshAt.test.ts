import test from 'node:test';
import assert from 'node:assert/strict';

import { clampRefreshAt, MAX_WORLDSTATE_REFRESH_MS } from './worldStateRefreshWindow.ts';

/**
 * The ceiling is the whole point. Every `selectWorldState*RefreshAt` derives the next poll from
 * what is on screen now — an entity's expiry, or the earliest expiry in an array — which says
 * nothing about when the NEXT thing arrives. Unclamped, the archon hunt refreshed weekly and Baro
 * when he left, so a new alert, a new fissure or a completed invasion stayed invisible for days.
 */

const NOW = Date.parse('2026-08-20T12:00:00.000Z');
const at = (ms: number) => new Date(NOW + ms).toISOString();
const msOut = (iso: string) => Date.parse(iso) - NOW;

test('a far-future expiry is clamped to the ceiling', () => {
  // An archon hunt runs a week; Baro parks for two days.
  assert.equal(msOut(clampRefreshAt(at(7 * 24 * 3_600_000), NOW)), MAX_WORLDSTATE_REFRESH_MS);
  assert.equal(msOut(clampRefreshAt(at(2 * 24 * 3_600_000), NOW)), MAX_WORLDSTATE_REFRESH_MS);
});

test('an expiry sooner than the ceiling is returned untouched', () => {
  // A ceiling, not a fixed interval — a panel must still refresh the moment its content lapses.
  const soon = at(120_000);
  assert.equal(clampRefreshAt(soon, NOW), soon);
});

test('an expiry exactly at the ceiling is kept', () => {
  const edge = at(MAX_WORLDSTATE_REFRESH_MS);
  assert.equal(clampRefreshAt(edge, NOW), edge);
});

test('an unparseable timestamp falls back to the ceiling rather than propagating NaN', () => {
  // Date.parse('') is NaN; without the guard that became an Invalid Date and the timer never
  // armed at all — silence, which is the failure mode hardest to notice.
  assert.equal(msOut(clampRefreshAt('not a date', NOW)), MAX_WORLDSTATE_REFRESH_MS);
});

test('an expiry already in the past is left alone for the caller to handle', () => {
  const past = at(-60_000);
  assert.equal(clampRefreshAt(past, NOW), past);
});
