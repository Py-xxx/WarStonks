#!/usr/bin/env node
// Refreshes the bundled WFStat seed payload.
//
// The seed is the fallback of last resort for a TRUE first launch with no network: no catalog on
// disk, no runtime cache yet, and warframestat.us unreachable. Without it that launch pays ~1,048
// rate-limited per-item WFM fetches (~6 minutes) and produces a catalog with zero enrichment.
//
// This does NOT run as part of `npm run build` or `npm run tauri dev`, and it is NOT updated by
// anything the app does at runtime. It is deliberate, manual, and committed to git — a build must
// never depend on warframestat.us being up, or two builds of the same commit could differ.
//
//   npm run seed:wfstat
//
// Refresh it when DE ships a content update you want covered out of the box (see docs below on
// why staleness is cheap), then commit the result.

import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const seedPath = resolve(here, '../src-tauri/resources/wfstat_items_seed.json.gz');
const metaPath = resolve(here, '../src-tauri/resources/wfstat_items_seed.meta.json');
const SOURCE = 'https://api.warframestat.us/items/';

console.log(`Fetching ${SOURCE} ...`);
const response = await fetch(SOURCE, { headers: { 'User-Agent': 'WarStonks-seed-refresh' } });
if (!response.ok) {
  console.error(`WFStat returned HTTP ${response.status}. Seed NOT updated.`);
  process.exit(1);
}
const body = await response.text();

// Parse before writing: a truncated or error-page response must never be committed as a seed.
let parsed;
try {
  parsed = JSON.parse(body);
} catch (error) {
  console.error(`Response was not valid JSON (${error.message}). Seed NOT updated.`);
  process.exit(1);
}
if (!Array.isArray(parsed) || parsed.length === 0) {
  console.error('Response was not a non-empty array. Seed NOT updated.');
  process.exit(1);
}
const withComponents = parsed.filter((item) => item?.components?.length).length;
// The seed exists for set-composition derivation; a payload without component data is useless
// for that even if it parses, so refuse it rather than silently regressing the fallback.
if (withComponents === 0) {
  console.error('Response carried no items with components. Seed NOT updated.');
  process.exit(1);
}

const gz = gzipSync(Buffer.from(body), { level: 9 });
mkdirSync(dirname(seedPath), { recursive: true });

const previousSha = existsSync(seedPath)
  ? createHash('sha256').update(readFileSync(seedPath)).digest('hex')
  : null;

writeFileSync(seedPath, gz);
const meta = {
  source: SOURCE,
  refreshedAt: new Date().toISOString(),
  items: parsed.length,
  itemsWithComponents: withComponents,
  rawBytes: Buffer.byteLength(body),
  gzipBytes: gz.length,
  sha256: createHash('sha256').update(gz).digest('hex'),
};
writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);

console.log(`  items:            ${meta.items} (${meta.itemsWithComponents} with components)`);
console.log(`  raw:              ${(meta.rawBytes / 1e6).toFixed(1)} MB`);
console.log(`  gzipped:          ${(meta.gzipBytes / 1e6).toFixed(1)} MB`);
console.log(`  changed:          ${previousSha === meta.sha256 ? 'no (identical to committed seed)' : 'yes'}`);
console.log(`\nWrote ${seedPath}`);
console.log('Commit both the .json.gz and the .meta.json.');
