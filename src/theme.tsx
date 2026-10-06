import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export const colorLabels = {
  background: 'Terminal background',
  surface: 'Panel background',
  elevated: 'Raised surfaces',
  foreground: 'Text',
  muted: 'Secondary text',
  border: 'Borders',
  accent: 'Accent',
  accentText: 'Text on accent',
  selectionBackground: 'Selection',
  cursor: 'Cursor',
  promptUser: 'Prompt username',
  promptHost: 'Prompt hostname',
  promptDirectory: 'Prompt directory',
  promptSymbol: 'Prompt symbol',
  black: 'Black',
  red: 'Red',
  green: 'Green',
  yellow: 'Yellow',
  blue: 'Blue',
  magenta: 'Magenta',
  cyan: 'Cyan',
  white: 'White',
  brightBlack: 'Bright black',
  brightRed: 'Bright red',
  brightGreen: 'Bright green',
  brightYellow: 'Bright yellow',
  brightBlue: 'Bright blue',
  brightMagenta: 'Bright magenta',
  brightCyan: 'Bright cyan',
  brightWhite: 'Bright white',
};
export type ThemeColor = keyof typeof colorLabels;
export interface Theme {
  version: 1;
  name: string;
  colors: Record<ThemeColor, string>;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: 'bar' | 'block' | 'underline';
  cursorBlink: boolean;
}
export const defaultTheme: Theme = {
  version: 1,
  name: 'Nexus Dark',
  colors: {
    background: '#151719',
    surface: '#1c1f22',
    elevated: '#272b30',
    foreground: '#e0e3e7',
    muted: '#929aa5',
    border: '#343a42',
    accent: '#86b9b0',
    accentText: '#142421',
    selectionBackground: '#354d51',
    cursor: '#a8d5cd',
    promptUser: '#a2cc97',
    promptHost: '#929aa5',
    promptDirectory: '#80c6cf',
    promptSymbol: '#86b9b0',
    black: '#282c34',
    red: '#e88388',
    green: '#a2cc97',
    yellow: '#e5c890',
    blue: '#8eafe3',
    magenta: '#bf9bde',
    cyan: '#80c6cf',
    white: '#d5d9e0',
    brightBlack: '#697480',
    brightRed: '#f4a2a6',
    brightGreen: '#bde0b3',
    brightYellow: '#f5dda8',
    brightBlue: '#afc9f0',
    brightMagenta: '#d9b9f2',
    brightCyan: '#a1e0e7',
    brightWhite: '#f4f6f8',
  },
  fontFamily: '"SFMono-Regular", Menlo, Monaco, monospace',
  fontSize: 13,
  lineHeight: 1.35,
  cursorStyle: 'bar',
  cursorBlink: true,
};
function makePreset(name: string, colors: Partial<Theme['colors']>): Theme {
  return {
    ...defaultTheme,
    name,
    colors: { ...defaultTheme.colors, ...colors },
  };
}

export const themePresets: Theme[] = [
  defaultTheme,
  {
    ...defaultTheme,
    name: 'Midnight',
    colors: {
      ...defaultTheme.colors,
      background: '#101421',
      surface: '#171d2e',
      elevated: '#242d43',
      accent: '#a6b5f5',
      accentText: '#161e35',
      border: '#34405b',
    },
  },
  {
    ...defaultTheme,
    name: 'Paper',
    colors: {
      ...defaultTheme.colors,
      background: '#f6f4ef',
      surface: '#ebe8e0',
      elevated: '#dedbd2',
      foreground: '#30353c',
      muted: '#626974',
      border: '#c5c4bc',
      accent: '#326e66',
      accentText: '#ffffff',
      cursor: '#326e66',
      promptUser: '#397044',
      promptHost: '#626974',
      promptDirectory: '#267c86',
      promptSymbol: '#326e66',
      selectionBackground: '#c6ddd8',
      black: '#30353c',
      white: '#707783',
      brightWhite: '#555e6a',
      red: '#ac394b',
      green: '#397044',
      yellow: '#8a641c',
      blue: '#3665a0',
      magenta: '#8551a1',
      cyan: '#267c86',
    },
  },
  makePreset('Dracula', {
    background: '#282a36',
    surface: '#21222c',
    elevated: '#44475a',
    foreground: '#f8f8f2',
    muted: '#a4a6b5',
    border: '#6272a4',
    accent: '#bd93f9',
    accentText: '#282a36',
    selectionBackground: '#44475a',
    cursor: '#f8f8f2',
    promptUser: '#50fa7b',
    promptHost: '#8be9fd',
    promptDirectory: '#8be9fd',
    promptSymbol: '#bd93f9',
    black: '#21222c',
    red: '#ff5555',
    green: '#50fa7b',
    yellow: '#f1fa8c',
    blue: '#bd93f9',
    magenta: '#ff79c6',
    cyan: '#8be9fd',
    white: '#f8f8f2',
    brightBlack: '#6272a4',
    brightRed: '#ff6e6e',
    brightGreen: '#69ff94',
    brightYellow: '#ffffa5',
    brightBlue: '#d6acff',
    brightMagenta: '#ff92df',
    brightCyan: '#a4ffff',
    brightWhite: '#ffffff',
  }),
  makePreset('Nord', {
    background: '#2e3440',
    surface: '#3b4252',
    elevated: '#434c5e',
    foreground: '#eceff4',
    muted: '#d8dee9',
    border: '#4c566a',
    accent: '#88c0d0',
    accentText: '#2e3440',
    selectionBackground: '#434c5e',
    cursor: '#d8dee9',
    promptUser: '#a3be8c',
    promptHost: '#81a1c1',
    promptDirectory: '#88c0d0',
    promptSymbol: '#8fbcbb',
    black: '#3b4252',
    red: '#bf616a',
    green: '#a3be8c',
    yellow: '#ebcb8b',
    blue: '#81a1c1',
    magenta: '#b48ead',
    cyan: '#88c0d0',
    white: '#e5e9f0',
    brightBlack: '#4c566a',
    brightRed: '#bf616a',
    brightGreen: '#a3be8c',
    brightYellow: '#ebcb8b',
    brightBlue: '#81a1c1',
    brightMagenta: '#b48ead',
    brightCyan: '#8fbcbb',
    brightWhite: '#eceff4',
  }),
  makePreset('Gruvbox Dark', {
    background: '#282828',
    surface: '#32302f',
    elevated: '#3c3836',
    foreground: '#ebdbb2',
    muted: '#a89984',
    border: '#665c54',
    accent: '#fabd2f',
    accentText: '#282828',
    selectionBackground: '#504945',
    cursor: '#ebdbb2',
    promptUser: '#b8bb26',
    promptHost: '#83a598',
    promptDirectory: '#8ec07c',
    promptSymbol: '#fabd2f',
    black: '#282828',
    red: '#cc241d',
    green: '#98971a',
    yellow: '#d79921',
    blue: '#458588',
    magenta: '#b16286',
    cyan: '#689d6a',
    white: '#a89984',
    brightBlack: '#928374',
    brightRed: '#fb4934',
    brightGreen: '#b8bb26',
    brightYellow: '#fabd2f',
    brightBlue: '#83a598',
    brightMagenta: '#d3869b',
    brightCyan: '#8ec07c',
    brightWhite: '#ebdbb2',
  }),
  makePreset('Tokyo Night', {
    background: '#1a1b26',
    surface: '#16161e',
    elevated: '#24283b',
    foreground: '#c0caf5',
    muted: '#565f89',
    border: '#3b4261',
    accent: '#7aa2f7',
    accentText: '#16161e',
    selectionBackground: '#33467c',
    cursor: '#c0caf5',
    promptUser: '#9ece6a',
    promptHost: '#7dcfff',
    promptDirectory: '#7aa2f7',
    promptSymbol: '#bb9af7',
    black: '#15161e',
    red: '#f7768e',
    green: '#9ece6a',
    yellow: '#e0af68',
    blue: '#7aa2f7',
    magenta: '#bb9af7',
    cyan: '#7dcfff',
    white: '#a9b1d6',
    brightBlack: '#414868',
    brightRed: '#f7768e',
    brightGreen: '#9ece6a',
    brightYellow: '#e0af68',
    brightBlue: '#7aa2f7',
    brightMagenta: '#bb9af7',
    brightCyan: '#7dcfff',
    brightWhite: '#c0caf5',
  }),
  makePreset('Catppuccin Mocha', {
    background: '#1e1e2e',
    surface: '#181825',
    elevated: '#313244',
    foreground: '#cdd6f4',
    muted: '#a6adc8',
    border: '#45475a',
    accent: '#cba6f7',
    accentText: '#1e1e2e',
    selectionBackground: '#45475a',
    cursor: '#f5e0e6',
    promptUser: '#a6e3a1',
    promptHost: '#89dceb',
    promptDirectory: '#89b4fa',
    promptSymbol: '#cba6f7',
    black: '#181825',
    red: '#f38ba8',
    green: '#a6e3a1',
    yellow: '#f9e2af',
    blue: '#89b4fa',
    magenta: '#f5c2e7',
    cyan: '#89dceb',
    white: '#bac2de',
    brightBlack: '#585b70',
    brightRed: '#f38ba8',
    brightGreen: '#a6e3a1',
    brightYellow: '#f9e2af',
    brightBlue: '#89b4fa',
    brightMagenta: '#f5c2e7',
    brightCyan: '#89dceb',
    brightWhite: '#cdd6f4',
  }),
  makePreset('One Dark', {
    background: '#282c34',
    surface: '#21252b',
    elevated: '#2c323c',
    foreground: '#abb2bf',
    muted: '#7f848e',
    border: '#3e4451',
    accent: '#61afef',
    accentText: '#282c34',
    selectionBackground: '#3e4451',
    cursor: '#528bff',
    promptUser: '#98c379',
    promptHost: '#56b6c2',
    promptDirectory: '#61afef',
    promptSymbol: '#c678dd',
    black: '#1e2127',
    red: '#e06c75',
    green: '#98c379',
    yellow: '#e5c07b',
    blue: '#61afef',
    magenta: '#c678dd',
    cyan: '#56b6c2',
    white: '#abb2bf',
    brightBlack: '#5c6370',
    brightRed: '#e06c75',
    brightGreen: '#98c379',
    brightYellow: '#e5c07b',
    brightBlue: '#61afef',
    brightMagenta: '#c678dd',
    brightCyan: '#56b6c2',
    brightWhite: '#ffffff',
  }),
  makePreset('Solarized Dark', {
    background: '#002b36',
    surface: '#073642',
    elevated: '#0a4050',
    foreground: '#839496',
    muted: '#657b83',
    border: '#586e75',
    accent: '#2aa198',
    accentText: '#002b36',
    selectionBackground: '#0a4050',
    cursor: '#93a1a1',
    promptUser: '#859900',
    promptHost: '#268bd2',
    promptDirectory: '#2aa198',
    promptSymbol: '#b58900',
    black: '#073642',
    red: '#dc322f',
    green: '#859900',
    yellow: '#b58900',
    blue: '#268bd2',
    magenta: '#d33682',
    cyan: '#2aa198',
    white: '#eee8d5',
    brightBlack: '#586e75',
    brightRed: '#cb4b16',
    brightGreen: '#586e75',
    brightYellow: '#657b83',
    brightBlue: '#839496',
    brightMagenta: '#6c71c4',
    brightCyan: '#93a1a1',
    brightWhite: '#fdf6e3',
  }),
];
const storageKey = 'nexus.theme.v1';
export function parseTheme(value: unknown): Theme {
  if (!value || typeof value !== 'object') throw new Error('Theme must be a JSON object.');
  const theme = value as Theme;
  if (theme.version !== 1) throw new Error('Unsupported theme version.');
  if (typeof theme.name !== 'string' || !theme.name.trim() || theme.name.length > 80)
    throw new Error('Theme name must be 1–80 characters.');
  // Older saved themes predate prompt colors; derive them from their ANSI palette.
  const colors = { ...theme.colors };
  const promptFallbacks = {
    promptUser: 'green',
    promptHost: 'muted',
    promptDirectory: 'cyan',
    promptSymbol: 'accent',
  } as const;
  for (const [key, fallback] of Object.entries(promptFallbacks)) {
    if (colors[key as ThemeColor] === undefined) colors[key as ThemeColor] = colors[fallback];
  }
  for (const key of Object.keys(colorLabels) as ThemeColor[]) {
    if (!/^#[\da-f]{6}$/i.test(colors[key] ?? ''))
      throw new Error(`${colorLabels[key]} must be a six-digit hex color.`);
  }
  if (
    typeof theme.fontFamily !== 'string' ||
    !theme.fontFamily.trim() ||
    theme.fontFamily.length > 200 ||
    /[;{}<>]/.test(theme.fontFamily)
  )
    throw new Error('Enter a valid font family.');
  if (!Number.isFinite(theme.fontSize) || theme.fontSize < 10 || theme.fontSize > 28)
    throw new Error('Font size must be between 10 and 28.');
  if (!Number.isFinite(theme.lineHeight) || theme.lineHeight < 1 || theme.lineHeight > 2)
    throw new Error('Line height must be between 1 and 2.');
  if (
    !['bar', 'block', 'underline'].includes(theme.cursorStyle) ||
    typeof theme.cursorBlink !== 'boolean'
  )
    throw new Error('Invalid cursor settings.');
  // Copy only supported properties; imported JSON cannot inject arbitrary CSS tokens.
  return {
    version: 1,
    name: theme.name.trim(),
    colors: Object.fromEntries(
      Object.keys(colorLabels).map((key) => [key, colors[key as ThemeColor]]),
    ) as Theme['colors'],
    fontFamily: theme.fontFamily,
    fontSize: theme.fontSize,
    lineHeight: theme.lineHeight,
    cursorStyle: theme.cursorStyle,
    cursorBlink: theme.cursorBlink,
  };
}
const ThemeContext = createContext({ theme: defaultTheme, updateTheme: (_theme: Theme) => {} });
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      return saved ? parseTheme(JSON.parse(saved)) : defaultTheme;
    } catch {
      return defaultTheme;
    }
  });
  useEffect(() => {
    for (const [key, value] of Object.entries(theme.colors))
      document.documentElement.style.setProperty(`--theme-${key}`, value);
    document.documentElement.style.setProperty('--terminal-font', theme.fontFamily);
    document.documentElement.style.colorScheme =
      parseInt(theme.colors.background.slice(1, 3), 16) > 160 ? 'light' : 'dark';
  }, [theme]);
  useEffect(() => {
    const receive = (event: StorageEvent) => {
      if (event.key !== storageKey) return;
      try {
        setTheme(event.newValue ? parseTheme(JSON.parse(event.newValue)) : defaultTheme);
      } catch {
        /* Keep the last valid theme. */
      }
    };
    window.addEventListener('storage', receive);
    return () => window.removeEventListener('storage', receive);
  }, []);
  function updateTheme(value: Theme) {
    const next = parseTheme(value);
    // Persist first so a storage failure is surfaced without losing the previous theme.
    localStorage.setItem(storageKey, JSON.stringify(next));
    setTheme(next);
  }
  return <ThemeContext.Provider value={{ theme, updateTheme }}>{children}</ThemeContext.Provider>;
}
export const useTheme = () => useContext(ThemeContext);

export function terminalTheme(theme: Theme) {
  const extendedAnsi: string[] = [];
  const levels = [0, 95, 135, 175, 215, 255];
  const hex = (value: number) => value.toString(16).padStart(2, '0');
  for (let index = 16; index < 256; index++) {
    if (index < 232) {
      const cube = index - 16;
      extendedAnsi.push(
        `#${hex(levels[Math.floor(cube / 36)])}${hex(levels[Math.floor(cube / 6) % 6])}${hex(levels[cube % 6])}`,
      );
    } else {
      const gray = hex(8 + (index - 232) * 10);
      extendedAnsi.push(`#${gray}${gray}${gray}`);
    }
  }
  extendedAnsi.splice(
    236,
    4,
    theme.colors.promptUser,
    theme.colors.promptHost,
    theme.colors.promptDirectory,
    theme.colors.promptSymbol,
  );
  return { ...theme.colors, extendedAnsi };
}
