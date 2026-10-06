const USER_HOST_PATTERN = /[A-Za-z0-9._-]+@[A-Za-z0-9._-]+/g;

interface PromptColors {
  user: string;
  host: string;
}

function foregroundColor(hex: string): string {
  const normalized = hex.replace('#', '');
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);
  return `\x1b[38;2;${red};${green};${blue}m`;
}

/** Replace visible user@host tokens before terminal output reaches xterm. */
export function maskUserHostOutput(
  output: string,
  replacement: string | null,
  colors?: PromptColors,
): string {
  if (!replacement) return output;
  if (!colors) return output.replace(USER_HOST_PATTERN, replacement);

  const atIndex = replacement.indexOf('@');
  if (atIndex < 1 || atIndex === replacement.length - 1) return output;
  const username = replacement.slice(0, atIndex);
  const hostname = replacement.slice(atIndex + 1);
  const styledReplacement = [
    foregroundColor(colors.user),
    username,
    '\x1b[39m@',
    foregroundColor(colors.host),
    hostname,
    '\x1b[39m',
  ].join('');
  return output.replace(USER_HOST_PATTERN, styledReplacement);
}
