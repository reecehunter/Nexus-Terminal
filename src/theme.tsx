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
