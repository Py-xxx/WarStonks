/**
 * Splitting a stat-highlight line into `label · changed range · rest`.
 *
 * Pulled out of `pages/Market` because the spacing rules below are the part worth pinning, and
 * nothing in that file can be reached from `node --test`.
 *
 * Warframe writes a rank-scaled stat as prose with the range embedded — "Gain 1 -> 6% weapon
 * Critical Chance for 10s…", "Damage 60 -> 120%". The range is worth pulling out and colouring;
 * the rest is a sentence and has to read as one.
 */

/** The `60 -> 120%` shape. The character class deliberately includes a space, so the match can
 *  swallow the separator on either side — which is exactly why the flags below exist. */
const CHANGED_RANGE = /(\d[\d.,%+\-xX ]*->\s*\d[\d.,%+\-xX ]*)/;

export interface StatHighlightParts {
  label: string;
  /** The range, trimmed — this is what gets coloured. */
  value: string;
  suffix: string;
  /** Whether a space has to be re-inserted around the value when rendering. */
  spaceBefore: boolean;
  spaceAfter: boolean;
}

/**
 * `null` when the line carries no range and should simply be rendered as text.
 *
 * **The spacing flags are the whole point.** The renderer passes `label` and `suffix` through the
 * markup parser, which trims every fragment, and the match itself can eat the separator. Both
 * losses were invisible while these fragments sat in a `flex gap-2` row that supplied its own
 * spacing — and the moment the line was made to flow as text they showed up as `6%weapon`.
 */
export function splitStatHighlightRange(line: string): StatHighlightParts | null {
  const match = line.match(CHANGED_RANGE);
  if (!match || match.index === undefined) {
    return null;
  }

  const raw = match[1];
  const label = line.slice(0, match.index);
  const suffix = line.slice(match.index + raw.length);

  return {
    label,
    value: raw.trim(),
    suffix,
    spaceBefore: /\s$/.test(label) || /^\s/.test(raw),
    spaceAfter: /\s$/.test(raw) || /^\s/.test(suffix),
  };
}

/** What the rendered line reads as, once the pieces are put back together. */
export function statHighlightPlainText(line: string): string {
  const parts = splitStatHighlightRange(line);
  if (!parts) {
    return line.trim();
  }
  return [
    parts.label.trim(),
    parts.spaceBefore ? ' ' : '',
    parts.value,
    parts.spaceAfter ? ' ' : '',
    parts.suffix.trim(),
  ].join('');
}
