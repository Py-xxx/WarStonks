import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  confidenceTone,
  formatPlatinumDelta,
  opportunityTone,
  valueBasisKey,
} from './opportunityView.ts';

/**
 * These guard a class of bug that review caught late and only by accident: Home's "Act now"
 * queue is a VIEW of the Opportunities board, but it derived its own category colours, and got
 * four of five wrong — `sellInventory` was blue on Home and amber on the board, while `flip`
 * (blue on the board) fell through to green. The same play was a different colour depending on
 * which screen you were looking at.
 *
 * Nothing about that is visible in a type error or a rendering test, so it was pinned against the
 * shipped stylesheet itself. Opportunities has since migrated off `legacy.css`, so — as that
 * version of this file instructed — the guard is **repointed, not deleted**: it now reads the tone
 * maps out of `components/OpportunityCard`, which is where `.opp-card-*` and `.opp-conf-*` went.
 *
 * Read as text rather than imported, because the component pulls in React and the store and these
 * tests run on bare `node --test`. Parsing is the price of keeping the guard.
 */

const CARD_SOURCE = 'src/components/OpportunityCard/index.tsx';

/** Extracts a `Record<..., string>` map literal's keys and the accent each value names. */
function accentMap(name: string, prefix: string): Record<string, string> {
  const source = readFileSync(CARD_SOURCE, 'utf8');
  const block = new RegExp(`${name}[^=]*=\\s*\\{([^}]*)\\}`).exec(source);
  assert.ok(block, `Could not find ${name} in ${CARD_SOURCE} — the guard would pass vacuously.`);
  const out: Record<string, string> = {};
  for (const line of block[1].split('\n')) {
    const entry = /^\s*'?([A-Za-z]+)'?:\s*'(.+)',?\s*$/.exec(line);
    if (!entry) continue;
    const accent = new RegExp(`${prefix}(accent-[a-z]+|ink-faint)`).exec(entry[2]);
    if (accent) {
      out[entry[1]] = accent[1].replace('accent-', '');
    }
  }
  return out;
}

test('every tone opportunityView can return has a class, and they agree', () => {
  // `TONE_CLASS` is what the board and Home actually paint with; `opportunityTone` is what
  // decides which one. A tone with no class renders untinted — the failure is invisible.
  const painted = accentMap('const TONE_CLASS', 'border-l-');
  assert.deepEqual(
    Object.keys(painted).sort(),
    ['amber', 'blue', 'green', 'purple', 'red'],
    'TONE_CLASS no longer covers every OpportunityTone.',
  );
  for (const [tone, accent] of Object.entries(painted)) {
    assert.equal(accent, tone, `TONE_CLASS.${tone} paints --accent-${accent}.`);
  }

  // And every category the board knows about still lands on one of them.
  for (const category of ['setCompletion', 'sellInventory', 'flip', 'snipe', 'reprice']) {
    assert.ok(opportunityTone(category) in painted, `${category} has no class.`);
  }
});

test('category tones are the ones the shipped board used', () => {
  // Ported from `.opp-card-*` and frozen here now that the stylesheet is gone. Changing one of
  // these is a deliberate design decision, not something to do while editing a component.
  assert.equal(opportunityTone('setCompletion'), 'purple');
  assert.equal(opportunityTone('sellInventory'), 'amber');
  assert.equal(opportunityTone('flip'), 'blue');
  assert.equal(opportunityTone('snipe'), 'amber');
  assert.equal(opportunityTone('reprice'), 'red');
});

test('an unrecognised category falls back to the board default, not to a new colour', () => {
  // `.opp-card` with no category suffix is purple; anything the backend adds later must land
  // there rather than silently picking up an accent that already means something else.
  assert.equal(opportunityTone('somethingNew'), 'purple');
  assert.equal(opportunityTone(''), 'purple');
});

test('value basis maps to a real translation key for every basis the backend emits', () => {
  const en = readFileSync('src/i18n/en.ts', 'utf8');
  for (const basis of ['profit', 'liquidation', 'savings', 'unlock', 'unrecognised']) {
    const key = valueBasisKey(basis);
    assert.ok(
      en.includes(`'${key}'`),
      `valueBasisKey('${basis}') returned "${key}", which is not defined in en.ts — it would ` +
        `render as the raw key.`,
    );
  }
});

test('platinum deltas carry an explicit sign and no thousands separator', () => {
  assert.equal(formatPlatinumDelta(53), '+53p');
  assert.equal(formatPlatinumDelta(0), '+0p');
  // A true minus sign, not a hyphen: the column is mono and tabular, and the hyphen sits low.
  assert.equal(formatPlatinumDelta(-12), '−12p');
  // Grouping belongs to formatPlatinumValue (P&L totals), not to a narrow row column.
  assert.equal(formatPlatinumDelta(1240), '+1240p');
  assert.equal(formatPlatinumDelta(Number.NaN), '—');
});

/**
 * Same guard, one level down: the confidence label's colour. Home rendered it flat in `ink-faint`
 * while the board coloured it green/amber/muted, so the single fact that says whether a number is
 * safe to act on was invisible on the surface you scan fastest.
 */
test('every confidence tone has a class, matching the shipped .opp-conf-* colours', () => {
  const painted = accentMap('const CONFIDENCE_CLASS', 'text-');
  assert.deepEqual(Object.keys(painted).sort(), ['amber', 'green', 'muted']);
  assert.equal(painted.green, 'green');
  assert.equal(painted.amber, 'amber');
  assert.equal(painted.muted, 'ink-faint');

  // The mapping itself, ported from `.opp-conf-high/medium/low`.
  assert.equal(confidenceTone('High'), 'green');
  assert.equal(confidenceTone('Medium'), 'amber');
  assert.equal(confidenceTone('Low'), 'muted');
});

test('an unknown confidence label falls back to muted, never to a confident colour', () => {
  assert.equal(confidenceTone('Unrated'), 'muted');
});
