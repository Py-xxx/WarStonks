/**
 * Shared helpers for the "light pricing" layer on the Events surface — the one the overhaul
 * memo called Phase 3: Baro's stock and invasion rewards are the two places a worldstate reward
 * is worth real platinum, so they are the two that carry a price.
 *
 * Everything here is name-based, because that is all warframestat.us gives us. It hands back
 * display names ("Prisma Gorgon", "Orokin Catalyst Blueprint") with no id of any kind, so both
 * the price scan and the watchlist match have to go through the item's name.
 */

/**
 * Names as they appear on two different sources will not match on case, spacing or a stray
 * possessive. Comparing them raw is what makes a marker silently never appear.
 *
 * The character class is `\p{L}\p{N}`, not `a-z0-9`: the ASCII version deletes every CJK
 * character, so a localized `displayName` normalized to the empty string and every watchlist
 * marker silently vanished for a user on Chinese. `worldStatePricing.test.ts` pins that case.
 */
export function normalizeRewardName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u2019']/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * The set of watchlist names to test a reward against.
 *
 * Both `name` and `displayName` go in: `displayName` is what the user sees (and what a localized
 * catalog resolves to), `name` is the English catalog name — and a worldstate payload is always
 * English, so matching only on `displayName` would drop every marker for a user on another
 * language.
 */
export function buildWatchedNameSet(
  watchlist: Array<{ name: string; displayName: string }>,
): Set<string> {
  const names = new Set<string>();
  for (const item of watchlist) {
    names.add(normalizeRewardName(item.name));
    names.add(normalizeRewardName(item.displayName));
  }
  names.delete('');
  return names;
}

/**
 * A stable signature for a set of reward names.
 *
 * This is what stops a price scan re-running on every worldstate poll. Invasions refresh on a
 * timer and their reward set barely changes between polls, so the scan keys off *what is being
 * priced* rather than off the payload's identity — the same discipline `voidTraderPricesScannedFor`
 * applies to Baro, which is a single id because his whole inventory changes at once.
 */
export function buildRewardScanSignature(names: string[]): string {
  return [...new Set(names.map(normalizeRewardName))].filter(Boolean).sort().join('|');
}
