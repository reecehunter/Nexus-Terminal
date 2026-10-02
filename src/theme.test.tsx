import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { defaultTheme, parseTheme, terminalTheme, ThemeProvider } from './theme';
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
