import { describe, expect, it, vi } from 'vitest';
import { boundedTerminalText, chatReducer, initialChat, shortcutAction } from './chat-state';
import type { ChatEvent, ChatState } from './types';

function started(): ChatState {
  return chatReducer(initialChat('conversation'), {
    type: 'begin',
    requestId: 'request',
    sessionId: 'session',
    text: 'Explain this',
  });
}
function event(payload: Record<string, unknown>): ChatEvent {
  return {
    requestId: 'request',
    sessionId: 'session',
    conversationId: 'conversation',
    ...payload,
  } as ChatEvent;
}

describe('chat request isolation', () => {
  it('ignores late events from canceled requests and previous conversations or terminals', () => {
    const state = started();
    const text = event({
      type: 'textDelta',
      messageId: 'answer',
      delta: 'late',
    });
    for (const update of [
      { ...text, requestId: 'old' },
      { ...text, sessionId: 'old' },
      { ...text, conversationId: 'old' },
    ]) {
      expect(chatReducer(state, { type: 'event', event: update })).toBe(state);
    }
    const stopped = chatReducer(state, { type: 'stop' });
    expect(chatReducer(stopped, { type: 'event', event: text })).toBe(stopped);
  });
  it('preserves stream order and invalidates approval cards on stop', () => {
    let state = started();
    for (const delta of ['hello ', 'λ'])
      state = chatReducer(state, {
        type: 'event',
        event: event({ type: 'textDelta', messageId: 'answer', delta }),
      });
    expect(state.items[1]).toMatchObject({ text: 'hello λ' });
    state = chatReducer(state, {
      type: 'event',
      event: event({
        type: 'tool',
        toolId: 'tool',
        name: 'run_command',
        arguments: { command: 'pwd' },
        status: 'approval',
        approvalId: 'approval',
        directory: '/tmp',
        result: null,
      }),
    });
    state = chatReducer(state, { type: 'stop' });
    expect(state.items[2]).toMatchObject({
      status: 'canceled',
      approvalId: null,
    });
  });
});

describe('context and keyboard behavior', () => {
  it('captures only the last 200 lines and keeps a valid Unicode byte boundary', () => {
    const text = boundedTerminalText(Array.from({ length: 250 }, (_, index) => `line ${index}`));
    expect(text.startsWith('line 50')).toBe(true);
    expect(text.endsWith('line 249')).toBe(true);
    const bounded = boundedTerminalText(['🙂'.repeat(10000) + 'λ'], 17);
    expect(new TextEncoder().encode(bounded).length).toBeLessThanOrEqual(17);
    expect(bounded.endsWith('λ')).toBe(true);
    expect(bounded).not.toContain('�');
  });
  it('reserves Cmd+J and Escape without swallowing Ctrl+C or other terminal keys', () => {
    const key = {
      key: 'j',
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    };
    expect(shortcutAction(key, false)).toBe('toggle');
    expect(shortcutAction({ ...key, key: 'Escape', metaKey: false }, true)).toBe('close');
    expect(shortcutAction({ ...key, key: 'Escape', metaKey: false }, false)).toBeNull();
    expect(shortcutAction({ ...key, key: 'c', metaKey: false, ctrlKey: true }, true)).toBeNull();
    expect(shortcutAction({ ...key, shiftKey: true }, true)).toBeNull();
  });
});

it('classifies progress and final responses without changing streamed text', () => {
  let state = started();
  for (const [messageId, channel] of [
    ['progress', 'commentary'],
    ['answer', 'final'],
  ] as const) {
    state = chatReducer(state, {
      type: 'event',
      event: event({ type: 'textDelta', messageId, delta: 'Visible explanation' }),
    });
    state = chatReducer(state, {
      type: 'event',
      event: event({ type: 'messageComplete', messageId, channel }),
    });
    expect(state.items.find((item) => item.id === messageId)).toMatchObject({
      text: 'Visible explanation',
      channel,
    });
  }
  const stopped = chatReducer(state, { type: 'stop' });
  expect(
    chatReducer(stopped, {
      type: 'event',
      event: event({ type: 'messageComplete', messageId: 'progress', channel: 'final' }),
    }),
  ).toBe(stopped);
});

it('resumes internal requests without adding the continuation instruction to the transcript', () => {
  const state = chatReducer(started(), { type: 'pause', label: 'Manual input' });
  const resumed = chatReducer(state, {
    type: 'begin',
    requestId: 'resume',
    sessionId: 'session',
    text: 'Continue the previous task using fresh terminal observations.',
    internal: true,
  });
  expect(resumed.items).toEqual(state.items);
  expect(resumed.activeRequestId).toBe('resume');
  expect(resumed.pausedReason).toBeUndefined();
});

it('records completed work duration and retains the original turn boundary through resume', () => {
  const time = vi.spyOn(Date, 'now').mockReturnValue(1000);
  try {
    let state = started();
    state = chatReducer(state, {
      type: 'event',
      event: event({ type: 'textDelta', messageId: 'progress', delta: 'Inspecting' }),
    });
    state = chatReducer(state, {
      type: 'event',
      event: event({ type: 'messageComplete', messageId: 'progress', channel: 'commentary' }),
    });
    state = chatReducer(state, { type: 'pause', label: 'Manual input' });
    time.mockReturnValue(2000);
    state = chatReducer(state, {
      type: 'begin',
      requestId: 'request',
      sessionId: 'session',
      text: 'Continue',
      internal: true,
    });
    expect(state.completedTurns).toBeUndefined();
    state = chatReducer(state, {
      type: 'event',
      event: event({ type: 'textDelta', messageId: 'summary', delta: 'Done' }),
    });
    state = chatReducer(state, {
      type: 'event',
      event: event({ type: 'messageComplete', messageId: 'summary', channel: 'final' }),
    });
    time.mockReturnValue(144000);
    state = chatReducer(state, { type: 'event', event: event({ type: 'done' }) });
    expect(state.completedTurns).toEqual([
      { id: 'request', startIndex: 1, endIndex: 3, summaryId: 'summary', durationMs: 143000 },
    ]);
    expect(state.currentTurn).toBeUndefined();
  } finally {
    time.mockRestore();
  }
});
