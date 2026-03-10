interface WhisperTarget {
  username: string;
  platinum: number;
}

export function formatWhisperMessage(target: WhisperTarget, itemName: string): string {
  return `/w ${target.username} Hey there! I would like to buy ${itemName} for ${target.platinum} :platinum: (WarStonks - by py)`;
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
