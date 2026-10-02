import type { Terminal } from '@xterm/xterm';
import type { TerminalSnapshot } from './types';

export function terminalSnapshot(
  terminal: Pick<Terminal, 'buffer' | 'cols' | 'rows'>,
  sessionId: string,
  sequence: number,
  revision: number,
  maximumBytes = 64 * 1024,
): TerminalSnapshot {
  const buffer = terminal.buffer.active;
  const screen = Array.from(
    { length: terminal.rows },
    (_, row) => buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? '',
  ).join('\n');
  const encoder = new TextEncoder();
  const screenBytes = encoder.encode(screen).length;
  if (screenBytes > maximumBytes)
    throw new Error('The rendered terminal screen exceeds the snapshot size limit.');
  // Keep the complete visible screen; use remaining space for the newest scrollback lines.
  const lines: string[] = [];
  let bytes = screenBytes;
  let firstLine = buffer.baseY;
  for (let row = buffer.baseY - 1; row >= 0; --row) {
    const line = buffer.getLine(row)?.translateToString(true) ?? '';
    const size = encoder.encode(line).length + (lines.length ? 1 : 0);
    if (bytes + size > maximumBytes) break;
    lines.push(line);
    bytes += size;
    firstLine = row;
  }
  return {
    sessionId,
    sequence,
    revision,
    screen,
    scrollback: lines.reverse().join('\n'),
    // xterm can leave cursorX at columns while a line wrap is pending; the visible cursor is in the last cell.
    cursorX: Math.min(buffer.cursorX, terminal.cols - 1),
    cursorY: Math.min(buffer.cursorY, terminal.rows - 1),
    columns: terminal.cols,
    rows: terminal.rows,
    alternate: buffer.type === 'alternate',
    truncated: firstLine > 0 || buffer.baseY >= 5000,
  };
}
