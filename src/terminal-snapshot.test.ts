import { describe, expect, it } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { terminalSnapshot } from './terminal-snapshot';

function renderedTerminal(lines: string[], baseY: number, type: 'normal' | 'alternate' = 'normal') {
  return {
    cols: 80,
    rows: 2,
    buffer: {
      active: {
        baseY,
        cursorX: 3,
        cursorY: 1,
        type,
        getLine: (row: number) => ({ translateToString: () => lines[row] ?? '' }),
      },
    },
  } as Pick<Terminal, 'buffer' | 'cols' | 'rows'>;
}
describe('terminal screen capture', () => {
  it('reports the visible cursor cell while xterm has a pending line wrap', () => {
    const terminal = renderedTerminal(['full line', ''], 0);
    Object.assign(terminal.buffer.active, { cursorX: 80 });
    expect(terminalSnapshot(terminal, 'ssh', 1, 1).cursorX).toBe(79);
  });
  it('keeps the active screen separate from scrollback with cursor and buffer metadata', () => {
    const snapshot = terminalSnapshot(
      renderedTerminal(['old', '  prompt', 'menu'], 1),
      'ssh',
      3,
      4,
    );
    expect(snapshot).toEqual({
      sessionId: 'ssh',
      sequence: 3,
      revision: 4,
      screen: '  prompt\nmenu',
      scrollback: 'old',
      cursorX: 3,
      cursorY: 1,
      columns: 80,
      rows: 2,
      alternate: false,
      truncated: false,
    });
    const alternate = terminalSnapshot(
      renderedTerminal(['vim row 1', 'vim row 2'], 0, 'alternate'),
      'ssh',
      4,
      5,
    );
    expect(alternate.screen).toBe('vim row 1\nvim row 2');
    expect(alternate.scrollback).toBe('');
    expect(alternate.alternate).toBe(true);
  });
  it('bounds UTF-8 scrollback without truncating the screen or splitting Unicode', () => {
    const snapshot = terminalSnapshot(
      renderedTerminal(['old', '🙂'.repeat(10), 'λ', 'screen', 'row'], 3),
      'ssh',
      1,
      1,
      16,
    );
    expect(snapshot.screen).toBe('screen\nrow');
    expect(snapshot.scrollback).toBe('λ');
    expect(snapshot.truncated).toBe(true);
    expect(
      new TextEncoder().encode(snapshot.screen + snapshot.scrollback).length,
    ).toBeLessThanOrEqual(16);
    expect(snapshot.scrollback).not.toContain('�');
  });
});
