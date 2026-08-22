import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

/**
 * Guards the primitive layer.
 *
 * The whole point of `src/components/ui` is that a control is built once and reused, so the app
 * stays consistent and we stop reinventing the same element with slightly different behaviour.
 * That only holds if migrated code actually reaches for the primitives — and relying on whoever
 * writes the code to remember is exactly how the old UI ended up with four tooltip
 * implementations and twenty-one hand-picked z-index values.
 *
 * These tests make the rule mechanical. They only cover MIGRATED files (Tailwind-styled ones);
 * legacy pages still on `legacy.css` are skipped until their turn, since their raw elements are
 * styled by the global stylesheet and are not the problem this guards against.
 *
 * If one of these fails, the fix is to use the primitive — not to add the file to the skip list.
 */

const UI_DIR = join('src', 'components', 'ui');

/** Files that have been migrated to Tailwind + primitives, and must therefore obey the rules. */
const MIGRATED_GLOBS = [
  join('src', 'pages', 'Home'),
  join('src', 'components', 'Sidebar'),
  join('src', 'components', 'TopBar'),
  join('src', 'components', 'OpportunityCard'),
  join('src', 'components', 'OpportunityBoard'),
  join('src', 'components', 'UnderpricedListingsPanel'),
  join('src', 'components', 'ListRow'),
  join('src', 'components', 'AlecaframeInventory'),
  join('src', 'components', 'AlertsPanel'),
];

function collectTsx(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectTsx(full));
    } else if (entry.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

function migratedFiles(): string[] {
  return MIGRATED_GLOBS.flatMap((dir) => collectTsx(dir));
}

/** Strips comments so a rule name mentioned in a doc block never trips its own check. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('migrated files use the Button primitive instead of raw <button>', () => {
  const offenders: string[] = [];
  for (const file of migratedFiles()) {
    const code = stripComments(readFileSync(file, 'utf8'));
    if (/<button[\s>]/.test(code)) {
      offenders.push(file);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Raw <button> found in migrated files. Use <Button> from ${UI_DIR}/button — without its ` +
      '`appearance-none`, a bare button inherits the browser control face, because Tailwind ' +
      "preflight is deliberately not imported while the legacy CSS migration is in flight.",
  );
});

test('migrated files do not hand-roll a panel surface', () => {
  // The signature of a hand-rolled panel: its own rounded border plus the panel background,
  // rather than composing <Panel>.
  const offenders: string[] = [];
  for (const file of migratedFiles()) {
    if (file.endsWith('HomePanel.tsx')) {
      // The one adapter that is allowed to compose Panel directly.
      continue;
    }
    const code = stripComments(readFileSync(file, 'utf8'));
    for (const cls of code.match(/className="[^"]*"/g) ?? []) {
      if (/\brounded-lg\b/.test(cls) && /\bborder-line\b/.test(cls) && /\bbg-bg-panel\b/.test(cls)) {
        offenders.push(`${file} :: ${cls.slice(0, 80)}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Hand-rolled panel surface found. Compose <Panel>/<PanelHeader>/<PanelTitle> from ${UI_DIR}/panel.`,
  );
});

test('migrated files do not hand-roll a pulsing skeleton', () => {
  const offenders: string[] = [];
  for (const file of migratedFiles()) {
    const code = stripComments(readFileSync(file, 'utf8'));
    if (/animate-pulse/.test(code)) {
      offenders.push(file);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `animate-pulse found outside the primitive. Use <Skeleton> from ${UI_DIR}/skeleton so the ` +
      'app has one pulse implementation.',
  );
});

/**
 * A layering class that names a token but is not written as one generates **nothing** — the
 * element ends up with `z-index: auto` and silently loses to whatever paints after it.
 *
 * `z-dropdown` looks exactly like the rule the other guard asks for, reviews clean, and produced
 * a real bug: Farm Now's search suggestions rendered *under* the panel below them, so a tooltip
 * from that panel covered the list. Tailwind v4's form is `z-(--z-dropdown)`.
 *
 * Checked across ALL of `src`, not just migrated files: the failure is invisible everywhere, and
 * nothing legitimately writes a bare word after `z-`.
 */
test('layering tokens are written in the form Tailwind actually generates', () => {
  const offenders: string[] = [];
  for (const file of collectTsx('src')) {
    const code = stripComments(readFileSync(file, 'utf8'));
    // `z-auto` is real Tailwind; `z-(--x)` and `z-[…]` are the arbitrary forms. A bare word is not.
    // The lookbehind is load-bearing: `z-(--z-dropdown)` contains `z-dropdown` as a substring.
    for (const match of code.match(/(?<![\w-])z-(?!auto\b)[a-z][a-z-]*/g) ?? []) {
      offenders.push(`${file} :: ${match}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'A z-index utility naming a token directly generates no CSS. Write it as z-(--z-dropdown), ' +
      'z-(--z-modal), z-(--z-tooltip)… — see the Layering block in src/index.css.',
  );
});

test('migrated files never hardcode a z-index', () => {
  const offenders: string[] = [];
  for (const file of migratedFiles()) {
    const code = stripComments(readFileSync(file, 'utf8'));
    // `z-(--z-tooltip)` and friends are the token form and are fine; `z-50` is not.
    for (const match of code.match(/\bz-\[?\d+\]?/g) ?? []) {
      offenders.push(`${file} :: ${match}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'Hardcoded z-index found. Use the layering tokens (--z-dropdown, --z-modal, --z-tooltip…). ' +
      'Ad-hoc values are how the legacy CSS ended up with 21 of them spanning 60 to 2210.',
  );
});

test('nothing imports from the git-ignored reference directory', () => {
  const offenders: string[] = [];
  for (const file of collectTsx('src')) {
    const code = readFileSync(file, 'utf8');
    if (/from ['"][^'"]*ui-reference/.test(code)) {
      offenders.push(file);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'ui-reference/ is study material and is not committed — importing from it would ship code ' +
      'that does not exist in a fresh clone.',
  );
});

/**
 * Guard 6: overlay providers must actually be mounted.
 *
 * `TooltipProvider` exports a 250ms delay and the primitive's header documents it, but nothing
 * mounted it — so every tooltip in the app silently used Base UI's own `OPEN_DELAY` of 600ms
 * instead. In this version of Base UI, `Tooltip.Root` takes no `delay` prop, so the provider is
 * the only lever there is. Nothing about a missing provider is a type error or a visual break;
 * it just makes tooltips feel slow, which is exactly the kind of defect that ships.
 */
test('TooltipProvider is mounted once, at the app root', () => {
  const app = stripComments(readFileSync(join('src', 'App.tsx'), 'utf8'));
  assert.ok(
    /<TooltipProvider[\s>]/.test(app),
    'src/App.tsx does not mount <TooltipProvider>. Without it, Base UI falls back to a 600ms ' +
      'open delay and the 250ms documented in components/ui/tooltip.tsx never applies.',
  );
});
