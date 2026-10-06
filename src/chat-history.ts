import type { ChatItem, ChatState, CompletedTurn } from './types';

export interface SavedChat {
  conversationId: string;
  title: string;
  updatedAt: string;
  items: ChatItem[];
  completedTurns?: CompletedTurn[];
}
const storageKey = 'nexus.chat-history.v1';

export function loadChatHistory(): SavedChat[] {
  const parsed: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
  if (!Array.isArray(parsed)) throw new Error('Saved chat history is invalid.');
  return parsed.filter(
    (chat): chat is SavedChat =>
      chat &&
      typeof chat.conversationId === 'string' &&
      typeof chat.title === 'string' &&
      typeof chat.updatedAt === 'string' &&
      Array.isArray(chat.items) &&
      chat.items.every(
        (item: ChatItem) =>
          item &&
          typeof item.id === 'string' &&
          ((item.kind === 'message' &&
            ['user', 'assistant'].includes(item.role) &&
            typeof item.text === 'string') ||
            (item.kind === 'notice' && typeof item.text === 'string') ||
            (item.kind === 'tool' &&
              typeof item.name === 'string' &&
              item.arguments &&
              typeof item.stdout === 'string' &&
              typeof item.stderr === 'string')),
      ),
  );
}

export function saveChatHistory(state: ChatState): void {
  if (!state.items.length) return;
  const chat = savedChatFromState(state);
  const history = loadChatHistory().filter(
    (entry) => entry.conversationId !== state.conversationId,
  );
  // Bound local storage growth while retaining the most recent conversations.
  localStorage.setItem(storageKey, JSON.stringify([chat, ...history].slice(0, 50)));
}

export function savedChatFromState(state: ChatState): SavedChat {
  const firstQuestion = state.items.find((item) => item.kind === 'message' && item.role === 'user');
  return {
    conversationId: state.conversationId,
    title: firstQuestion?.kind === 'message' ? firstQuestion.text.slice(0, 100) : 'Conversation',
    updatedAt: new Date().toISOString(),
    completedTurns: state.completedTurns,
    // Saved tool cards must never expose live approval controls.
    items: state.items.map((item) =>
      item.kind === 'tool'
        ? {
            ...item,
            approvalId: null,
            status: ['approval', 'running'].includes(item.status) ? 'canceled' : item.status,
          }
        : item,
    ),
  };
}
