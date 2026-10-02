import { beforeEach, describe, expect, it } from 'vitest';
import { loadChatHistory, saveChatHistory } from './chat-history';
import { initialChat } from './chat-state';

beforeEach(() => localStorage.clear());
describe('saved chat history', () => {
  it('persists messages, updates one conversation, and retains earlier chats after reset', () => {
    const state = {
      ...initialChat('first'),
      items: [
        {
          kind: 'message' as const,
          id: 'question',
          role: 'user' as const,
          text: 'Explain this error',
        },
      ],
    };
    saveChatHistory(state);
    saveChatHistory({
      ...state,
      items: [
        ...state.items,
        { kind: 'message', id: 'answer', role: 'assistant', text: 'Details' },
      ],
    });
    saveChatHistory(initialChat('second'));
    expect(loadChatHistory()).toHaveLength(1);
    expect(loadChatHistory()[0].items).toHaveLength(2);
    expect(loadChatHistory()[0].title).toBe('Explain this error');
  });
  it('removes live approvals from saved tools', () => {
    saveChatHistory({
      ...initialChat('first'),
      items: [
        {
          kind: 'tool',
          id: 'tool',
          requestId: 'request',
          name: 'run_command',
          arguments: { command: 'ls' },
          status: 'approval',
          approvalId: 'approval',
          directory: null,
          result: null,
          stdout: '',
          stderr: '',
        },
      ],
    });
    expect(loadChatHistory()[0].items[0]).toMatchObject({ status: 'canceled', approvalId: null });
  });
  it('reports corrupt storage without overwriting it', () => {
    localStorage.setItem('nexus.chat-history.v1', '{broken');
    expect(() =>
      saveChatHistory({
        ...initialChat('first'),
        items: [{ kind: 'message', id: 'question', role: 'user', text: 'Hello' }],
      }),
    ).toThrow();
    expect(localStorage.getItem('nexus.chat-history.v1')).toBe('{broken');
  });
});
