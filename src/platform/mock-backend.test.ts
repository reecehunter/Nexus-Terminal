import { describe, expect, it } from 'vitest';
import { createMockBackend } from './mock-backend';

function outputText(data: number[]): string {
  return new TextDecoder().decode(new Uint8Array(data));
}

describe('mock backend', () => {
  it('provides a terminal session with browser-safe command emulation', async () => {
    const backend = createMockBackend();
    const events: Parameters<Parameters<typeof backend.startTerminal>[2]>[0][] = [];
    const session = await backend.startTerminal('tab', null, (event) => events.push(event));

    await backend.writeTerminal(session.sessionId, 'pwd\r');

    const output = events
      .filter((event) => event.type === 'output')
      .map((event) => outputText(event.data))
      .join('');
    expect(output).toContain('Nexus browser preview');
    expect(output).toContain('/Users/demo/project');
    expect(events.every((event) => event.sessionId === session.sessionId)).toBe(true);
  });

  it('handles interrupt and session shutdown without native APIs', async () => {
    const backend = createMockBackend();
    const events: { type: string }[] = [];
    const session = await backend.startTerminal('tab', null, (event) => events.push(event));

    await backend.interruptTerminal(session.sessionId);
    await backend.stopTerminal(session.sessionId);

    expect(events.some((event) => event.type === 'exit')).toBe(true);
    await expect(backend.terminalRevision(session.sessionId)).resolves.toBe(0);
  });

  it('keeps an empty Enter as a prompt-only action', async () => {
    const backend = createMockBackend();
    const events: { type: string; data?: number[] }[] = [];
    const session = await backend.startTerminal('tab', null, (event) => events.push(event));

    await backend.writeTerminal(session.sessionId, '\r\n');

    const output = events
      .filter((event) => event.type === 'output')
      .map((event) => outputText(event.data ?? []))
      .join('');
    expect(output).not.toContain('command not found:');
  });
});
