import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  defaultTheme,
  deleteCustomTheme,
  loadCustomThemes,
  parseTheme,
  saveCustomTheme,
  terminalTheme,
  themePresets,
  ThemeProvider,
} from './theme';
import { ThemeEditor } from './ThemeEditor';

beforeEach(() => localStorage.clear());
afterEach(cleanup);
it('round trips the complete theme and rejects malformed imported values', () => {
  expect(parseTheme(JSON.parse(JSON.stringify(defaultTheme)))).toEqual(defaultTheme);
  for (const patch of [
    { version: 2 },
    { fontSize: 9 },
    { lineHeight: 3 },
    { cursorStyle: 'invalid' },
    { fontFamily: 'monospace; color: red' },
    { name: '' },
    { colors: { ...defaultTheme.colors, brightCyan: 'red' } },
  ]) {
    expect(() => parseTheme({ ...defaultTheme, ...patch })).toThrow();
  }
  expect(() => parseTheme(null)).toThrow();
});
it('applies colors live and restores the saved theme after remounting', () => {
  const view = render(
    <ThemeProvider>
      <ThemeEditor />
    </ThemeProvider>,
  );
  fireEvent.change(screen.getByLabelText('Accent'), { target: { value: '#123456' } });
  expect(document.documentElement.style.getPropertyValue('--theme-accent')).toBe('#123456');
  view.unmount();
  render(
    <ThemeProvider>
      <ThemeEditor />
    </ThemeProvider>,
  );
  expect((screen.getByLabelText('Accent') as HTMLInputElement).value).toBe('#123456');
});
it('recovers from corrupt storage and keeps the active theme after invalid imports', () => {
  localStorage.setItem('nexus.theme.v1', '{broken');
  render(
    <ThemeProvider>
      <ThemeEditor />
    </ThemeProvider>,
  );
  expect((screen.getByLabelText('Accent') as HTMLInputElement).value).toBe(
    defaultTheme.colors.accent,
  );
  fireEvent.change(screen.getByLabelText('Theme JSON'), { target: { value: '{"version":2}' } });
  fireEvent.click(screen.getByRole('button', { name: 'Import JSON' }));
  expect(screen.getByRole('alert').textContent).toContain('Unsupported theme version');
  expect(document.documentElement.style.getPropertyValue('--theme-accent')).toBe(
    defaultTheme.colors.accent,
  );
});
it('exports all settings and resets customized typography', () => {
  render(
    <ThemeProvider>
      <ThemeEditor />
    </ThemeProvider>,
  );
  fireEvent.change(screen.getByLabelText('Font size'), { target: { value: '20' } });
  fireEvent.click(screen.getByRole('button', { name: 'Export JSON' }));
  expect(
    JSON.parse((screen.getByLabelText('Theme JSON') as HTMLTextAreaElement).value).fontSize,
  ).toBe(20);
  fireEvent.click(screen.getByRole('button', { name: 'Reset theme' }));
  expect((screen.getByLabelText('Font size') as HTMLInputElement).value).toBe('13');
});

it('migrates older themes and rejects malformed prompt colors', () => {
  const colors = { ...defaultTheme.colors } as Record<string, string>;
  for (const key of ['promptUser', 'promptHost', 'promptDirectory', 'promptSymbol'])
    delete colors[key];
  const migrated = parseTheme({ ...defaultTheme, colors });
  expect(migrated.colors.promptUser).toBe(colors.green);
  expect(migrated.colors.promptHost).toBe(colors.muted);
  expect(() =>
    parseTheme({ ...defaultTheme, colors: { ...colors, promptUser: 'invalid' } }),
  ).toThrow();
});
it('maps prompt colors to dedicated slots while preserving other extended colors', () => {
  const palette = terminalTheme(defaultTheme).extendedAnsi;
  expect(palette).toHaveLength(240);
  expect(palette[0]).toBe('#000000');
  expect(palette[215]).toBe('#ffffff');
  expect(palette[216]).toBe('#080808');
  expect(palette.slice(236)).toEqual([
    defaultTheme.colors.promptUser,
    defaultTheme.colors.promptHost,
    defaultTheme.colors.promptDirectory,
    defaultTheme.colors.promptSymbol,
  ]);
});
it('keeps all built-in presets valid and uniquely named', () => {
  const names = themePresets.map((preset) => preset.name);

  expect(new Set(names).size).toBe(names.length);
  expect(names).toEqual(
    expect.arrayContaining([
      'Dracula',
      'Nord',
      'Gruvbox Dark',
      'Tokyo Night',
      'Catppuccin Mocha',
      'One Dark',
      'Solarized Dark',
    ]),
  );
  for (const preset of themePresets) expect(parseTheme(preset)).toEqual(preset);
});
it('updates the prompt palette from the appearance controls', () => {
  render(
    <ThemeProvider>
      <ThemeEditor />
    </ThemeProvider>,
  );
  fireEvent.change(screen.getByLabelText('Prompt username'), { target: { value: '#ff8800' } });
  expect(document.documentElement.style.getPropertyValue('--theme-promptUser')).toBe('#ff8800');
  const saved = parseTheme(JSON.parse(localStorage.getItem('nexus.theme.v1')!));
  expect(terminalTheme(saved).extendedAnsi[236]).toBe('#ff8800');
});

it('saves, replaces, reloads, and deletes custom themes', () => {
  const saved = saveCustomTheme({ ...defaultTheme, name: 'My Theme' });
  expect(saved.map((theme) => theme.name)).toContain('My Theme');
  expect(loadCustomThemes()).toEqual(saved);

  const updated = saveCustomTheme({
    ...defaultTheme,
    name: 'My Theme',
    colors: { ...defaultTheme.colors, accent: '#123456' },
  });
  expect(updated.filter((theme) => theme.name === 'My Theme')).toHaveLength(1);
  expect(loadCustomThemes().find((theme) => theme.name === 'My Theme')?.colors.accent).toBe(
    '#123456',
  );

  expect(deleteCustomTheme('My Theme')).toEqual([]);
  expect(loadCustomThemes()).toEqual([]);
});

it('does not allow custom saves to overwrite built-in theme names', () => {
  expect(() => saveCustomTheme(defaultTheme)).toThrow(
    'Choose a different name before saving a built-in theme as custom.',
  );
  expect(loadCustomThemes()).toEqual([]);
});

it('shows custom themes and removes them from the picker', () => {
  saveCustomTheme({ ...defaultTheme, name: 'Saved Theme' });
  render(
    <ThemeProvider>
      <ThemeEditor />
    </ThemeProvider>,
  );

  expect(screen.getByRole('button', { name: 'Apply custom theme Saved Theme' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Delete custom theme Saved Theme' }));
  expect(screen.queryByRole('button', { name: 'Apply custom theme Saved Theme' })).toBeNull();
});

it('lets a selected theme name be edited without rejecting intermediate input', () => {
  render(
    <ThemeProvider>
      <ThemeEditor />
    </ThemeProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: /Aa Midnight/ }));
  const nameInput = screen.getByLabelText('Theme name') as HTMLInputElement;

  fireEvent.change(nameInput, { target: { value: '' } });
  expect(nameInput.value).toBe('');
  fireEvent.change(nameInput, { target: { value: 'Work Theme' } });
  expect(nameInput.value).toBe('Work Theme');
  fireEvent.blur(nameInput);

  expect(nameInput.value).toBe('Work Theme');
  expect(JSON.parse(localStorage.getItem('nexus.theme.v1')!).name).toBe('Work Theme');
});
