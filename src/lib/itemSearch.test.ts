import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MATCH_NONE,
  MATCH_PREFIX,
  MATCH_SUBSTRING,
  matchesItemQuery,
  normalizeSearchText,
  scoreItemQuery,
} from './itemSearch.ts';

const mesa = {
  name: '虐星 Prime 一套',
  nameEn: 'Mesa Prime Set',
  slug: 'mesa_prime_set',
};

test('finds an item by the localized name the user can actually see', () => {
  // The bug this whole module exists for: the row rendered Chinese, the filter compared English.
  assert.ok(matchesItemQuery('虐星', mesa));
  assert.equal(scoreItemQuery('虐星', mesa), MATCH_PREFIX);
});

test('still finds the same item by its English name', () => {
  // A bilingual player must not lose English search just because the UI is localized.
  assert.ok(matchesItemQuery('Mesa Prime', mesa));
  assert.ok(matchesItemQuery('mesa', mesa));
});

test('finds an item by slug, including spaced queries', () => {
  assert.ok(matchesItemQuery('mesa_prime', mesa));
  // "mesa prime" must reach `mesa_prime_set` — the slug joins words with underscores.
  assert.equal(scoreItemQuery('mesa prime', mesa), MATCH_PREFIX);
});

test('prefix matches outrank substring matches', () => {
  const target = { name: 'Prime Mesa Blueprint', nameEn: 'Prime Mesa Blueprint', slug: 'x' };
  assert.equal(scoreItemQuery('prime', target), MATCH_PREFIX);
  assert.equal(scoreItemQuery('mesa', target), MATCH_SUBSTRING);
});

test('ignores diacritics in both directions', () => {
  const target = { name: 'Épée Élan', nameEn: 'Epee Elan', slug: 'epee_elan' };
  assert.ok(matchesItemQuery('epee', target), 'unaccented query must find accented name');
  assert.ok(matchesItemQuery('Épée', target), 'accented query must find the item');
});

test('folds letters that Unicode decomposition leaves alone', () => {
  // NFD splits `é` but not `ß` — without an explicit folding, "grosse" never finds "Größe".
  const target = { name: 'Größe Prime', nameEn: 'Grosse Prime', slug: 'grosse_prime' };
  assert.ok(matchesItemQuery('grosse', target));
  assert.ok(matchesItemQuery('größe', target));
});

test('is case insensitive and tolerates untidy whitespace', () => {
  assert.ok(matchesItemQuery('  MESA   prime  ', mesa));
});

test('an empty or whitespace-only query never matches', () => {
  assert.equal(scoreItemQuery('', mesa), MATCH_NONE);
  assert.equal(scoreItemQuery('   ', mesa), MATCH_NONE);
});

test('a query that matches nothing scores none', () => {
  assert.equal(scoreItemQuery('rhino', mesa), MATCH_NONE);
});

test('handles targets with no English name or slug', () => {
  const localizedOnly = { name: '虚空遗物' };
  assert.ok(matchesItemQuery('虚空', localizedOnly));
  assert.equal(scoreItemQuery('void', localizedOnly), MATCH_NONE);
});

test('separators are ignored so a pasted name still matches', () => {
  // Names are stripped for display, but a user may paste "Perigale Prime: Cano" from WFM.
  const target = { name: 'Perigale Prime Cano', nameEn: 'Perigale Prime Barrel', slug: 'perigale_prime_barrel' };
  assert.ok(matchesItemQuery('Perigale Prime: Cano', target));
  assert.ok(matchesItemQuery('Perigale Prime - Cano', target));
  assert.ok(matchesItemQuery('Perigale Prime Cano', target));
});

test('a hyphen inside a word is not treated as a separator', () => {
  // "Eye-Eye" is a real item; collapsing its dash would make the name unsearchable as typed.
  const target = { name: '目—目', nameEn: 'Eye-Eye', slug: 'eye_eye' };
  assert.ok(matchesItemQuery('Eye-Eye', target));
  assert.equal(normalizeSearchText('Eye-Eye'), 'eye-eye');
});

test('normalizeSearchText leaves CJK untouched', () => {
  // toLowerCase and the diacritic strip must be no-ops here, or Chinese would never match.
  assert.equal(normalizeSearchText('虐星 Prime'), '虐星 prime');
  assert.equal(normalizeSearchText('　'), '');
});
