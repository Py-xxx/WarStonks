interface WhisperTarget {
  username: string;
  platinum: number;
  rank?: number | null;
  maxRank?: number | null;
}

/** Renders the " (Rank x/y)" suffix for ranked items, or "" for unranked ones. */
export function formatWhisperRankSuffix(
  rank: number | null | undefined,
  maxRank: number | null | undefined,
): string {
  if (rank === null || rank === undefined) {
    return '';
  }
  if (maxRank !== null && maxRank !== undefined && maxRank > 0) {
    return ` (Rank ${rank}/${maxRank})`;
  }
  return ` (Rank ${rank})`;
}

/** Wraps the full item name in pipe delimiters, e.g. "| Wisp Prime Chassis Blueprint |". */
export function formatWhisperItemName(itemName: string): string {
  const trimmedName = itemName.trim();
  if (!trimmedName) {
    return '| |';
  }

  return `| ${trimmedName} |`;
}

export function formatWhisperMessage(target: WhisperTarget, itemName: string): string {
  const rankSuffix = formatWhisperRankSuffix(target.rank, target.maxRank);
  return `/w ${target.username} Hey there! I would like to buy ${formatWhisperItemName(itemName)}${rankSuffix} for ${target.platinum} :platinum: please (WarStonks - by py)`;
}

export async function copyWhisperMessage(
  target: WhisperTarget,
  itemName: string,
): Promise<void> {
  const message = formatWhisperMessage(target, itemName);

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(message);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = message;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}
