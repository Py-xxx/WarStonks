// Warframe's own item/ability description text uses simple markup for damage-type coloring and
// line breaks (e.g. `<DT_FIRE_COLOR>Heat</DT_FIRE_COLOR>`, literal `<BR>`). WFStat passes this
// through verbatim from the game's own localization data — it is not something WarStonks
// generates, and neither WFM nor WFStat renders it for us, so it has to be parsed here or it
// leaks onto the screen as raw markup (e.g. "<DT_FIRE_COLOR>Heat Status effect").

const DAMAGE_TYPE_COLORS: Record<string, string> = {
  FIRE: '#ff7518',
  HEAT: '#ff7518',
  COLD: '#6ec6ff',
  ELECTRICITY: '#ffe066',
  ELECTRIC: '#ffe066',
  TOXIN: '#7ed957',
  BLAST: '#ff9d4d',
  RADIATION: '#c9c93e',
  GAS: '#8bc34a',
  MAGNETIC: '#4d9fff',
  VIRAL: '#e066c9',
  CORROSIVE: '#b5cc33',
  IMPACT: '#b0b0b0',
  PUNCTURE: '#c9a86a',
  SLASH: '#e05c5c',
  EXPLOSION: '#ff9d4d',
  VOID: '#c9b3ff',
  TRUE: '#ffffff',
};

export interface WarframeMarkupSegment {
  text: string;
  color: string | null;
}

/**
 * Splits raw Warframe description/stat text into lines, then into colored/plain segments per
 * line. Splits on real line breaks first (both literal `\n` and Warframe's `<BR>` tag) so a color
 * tag alone never introduces an unintended line break — only an actual break in the source does.
 */
export function parseWarframeMarkupLines(raw: string): WarframeMarkupSegment[][] {
  return splitWarframeMarkupLines(raw).map(parseWarframeMarkupSegments);
}

/** Just the line-splitting half of `parseWarframeMarkupLines`, for callers that parse each raw
 * line's segments themselves (e.g. after further text manipulation per line). */
export function splitWarframeMarkupLines(raw: string): string[] {
  return raw
    .replace(/\\n/g, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Matches a paired `<DT_X_COLOR>...</DT_X_COLOR>` tag (colored) first; otherwise matches any
 * other bare Warframe-style tag (`<TAG>`, `</TAG>`) and strips it with no color applied — a
 * fallback net so an unrecognized future tag disappears cleanly instead of leaking its markup
 * onto the screen the way `<DT_FIRE_COLOR>` used to.
 */
const TAG_PATTERN = /<DT_([A-Z_]+)_COLOR>([\s\S]*?)<\/DT_\1_COLOR>|<\/?[A-Z][A-Z0-9_]*\/?>/gi;

function parseWarframeMarkupSegments(line: string): WarframeMarkupSegment[] {
  const segments: WarframeMarkupSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  TAG_PATTERN.lastIndex = 0;

  while ((match = TAG_PATTERN.exec(line)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: line.slice(lastIndex, match.index), color: null });
    }
    const [, damageType, coloredText] = match;
    if (damageType !== undefined && coloredText !== undefined) {
      segments.push({ text: coloredText, color: DAMAGE_TYPE_COLORS[damageType.toUpperCase()] ?? null });
    }
    // Else: a bare/unpaired tag — stripped entirely, contributes no text segment.
    lastIndex = TAG_PATTERN.lastIndex;
  }
  if (lastIndex < line.length) {
    segments.push({ text: line.slice(lastIndex), color: null });
  }
  return segments.filter((segment) => segment.text.length > 0);
}
