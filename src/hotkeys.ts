import definitions from './hotkeys.json';
export type Hotkeys = Record<string, string | null>;
export const HOTKEY_ACTIONS = definitions.actions;
export const defaultHotkeys = (): Hotkeys =>
  Object.fromEntries(HOTKEY_ACTIONS.map(({ id, binding }) => [id, binding]));
const namedKeys: Record<string, string> = {
  '[': 'BracketLeft',
  '{': 'BracketLeft',
  ']': 'BracketRight',
  '}': 'BracketRight',
  ',': 'Comma',
  '<': 'Comma',
  '.': 'Period',
  '>': 'Period',
  '/': 'Slash',
  '?': 'Slash',
  '\\': 'Backslash',
  '|': 'Backslash',
  ';': 'Semicolon',
  ':': 'Semicolon',
  "'": 'Quote',
  '"': 'Quote',
  '`': 'Backquote',
  '~': 'Backquote',
  '-': 'Minus',
  _: 'Minus',
  '=': 'Equal',
  '+': 'Equal',
  ' ': 'Space',
};
const specialCodes = [
  'BracketLeft',
  'BracketRight',
  'Comma',
  'Period',
  'Slash',
  'Backslash',
  'Semicolon',
  'Quote',
  'Backquote',
  'Minus',
  'Equal',
  'Space',
  'Tab',
  'Enter',
  'Backspace',
  'Delete',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
];
export function validCode(code: string): boolean {
  return /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4]))$/.test(code) || specialCodes.includes(code);
}
export function eventBinding(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'> & {
    code?: string;
    isComposing?: boolean;
  },
): string | null {
  if (event.isComposing || (!event.metaKey && !event.ctrlKey)) return null;
  // Physical codes are stable when Shift/Option changes the printable key, including brackets.
  const code =
    event.code ||
    namedKeys[event.key] ||
    (/^[a-z]$/i.test(event.key)
      ? `Key${event.key.toUpperCase()}`
      : /^\d$/.test(event.key)
        ? `Digit${event.key}`
        : event.key);
  if (!validCode(code)) return null;
  return [
    event.metaKey && 'Cmd',
    event.ctrlKey && 'Ctrl',
    event.altKey && 'Alt',
    event.shiftKey && 'Shift',
    code,
  ]
    .filter(Boolean)
    .join('+');
}
export function hotkeyAction(
  event: Parameters<typeof eventBinding>[0],
  hotkeys: Hotkeys,
): string | null {
  const binding = eventBinding(event);
  return binding ? (HOTKEY_ACTIONS.find(({ id }) => hotkeys[id] === binding)?.id ?? null) : null;
}
export function validateHotkeys(hotkeys: Hotkeys): string | null {
  const used = new Map<string, string>();
  for (const { id, title } of HOTKEY_ACTIONS) {
    const binding = hotkeys[id];
    if (binding == null) continue;
    const tokens = binding.split('+');
    const code = tokens.pop()!;
    const canonical = ['Cmd', 'Ctrl', 'Alt', 'Shift'].filter((modifier) =>
      tokens.includes(modifier),
    );
    if (
      !validCode(code) ||
      !tokens.some((modifier) => modifier === 'Cmd' || modifier === 'Ctrl') ||
      [...canonical, code].join('+') !== binding
    )
      return `Use Command or Control plus a key for ${title}.`;
    if (definitions.reserved.includes(binding))
      return `${formatHotkey(binding)} is reserved by macOS or standard editing commands.`;
    const other = used.get(binding);
    if (other) return `${title} and ${other} use the same shortcut.`;
    used.set(binding, title);
  }
  return null;
}
export function formatHotkey(binding: string | null | undefined): string {
  if (!binding) return 'Unassigned';
  const labels: Record<string, string> = {
    Cmd: '⌘',
    Ctrl: '⌃',
    Alt: '⌥',
    Shift: '⇧',
    BracketLeft: '[',
    BracketRight: ']',
    ArrowLeft: '←',
    ArrowRight: '→',
    ArrowUp: '↑',
    ArrowDown: '↓',
    Comma: ',',
    Period: '.',
    Slash: '/',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Backquote: '`',
    Minus: '-',
    Equal: '=',
    Space: 'Space',
    Enter: '↵',
    Tab: '⇥',
    Backspace: '⌫',
    Delete: '⌦',
  };
  return binding
    .split('+')
    .map((token) => labels[token] ?? token.replace(/^Key|^Digit/, ''))
    .join('');
}
