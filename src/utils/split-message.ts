// ============================================
// Split long messages for Telegram (max 4096 chars)
// Handles natural boundaries (newline, space)
// ============================================

const MAX_LENGTH = 4000; // Leave margin for chunk indicators

/**
 * Split message into chunks for Telegram API limit.
 * Tries to split at newlines or spaces when possible.
 */
export function splitMessage(text: string): string[] {
  if (text.length <= MAX_LENGTH) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let splitAt = MAX_LENGTH;

    const lastNewline = remaining.lastIndexOf('\n', MAX_LENGTH);
    if (lastNewline > MAX_LENGTH * 0.5) {
      splitAt = lastNewline + 1;
    } else {
      const lastSpace = remaining.lastIndexOf(' ', MAX_LENGTH);
      if (lastSpace > MAX_LENGTH * 0.5) {
        splitAt = lastSpace + 1;
      }
    }

    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt);
  }

  return chunks;
}
