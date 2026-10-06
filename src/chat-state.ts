import type { ChatEvent, ChatItem, ChatState, CompletedTurn } from './types';

export type ChatAction =
  | { type: 'begin'; requestId: string; sessionId: string; text: string; internal?: boolean }
  | { type: 'event'; event: ChatEvent; decodedOutput?: string }
  | { type: 'stop' }
  | { type: 'pause'; label: string }
  | { type: 'reset'; conversationId: string }
  | {
      type: 'restore';
      conversationId: string;
      items: ChatItem[];
      completedTurns?: CompletedTurn[];
    }
  | { type: 'failure'; requestId: string; message: string };

export function initialChat(conversationId: string): ChatState {
  return {
    items: [],
    activeRequestId: null,
    conversationId,
    sessionId: null,
    phase: '',
  };
}

function cancelTools(items: ChatItem[]): ChatItem[] {
  return items.map((item) =>
    item.kind === 'tool' && ['approval', 'running'].includes(item.status)
      ? { ...item, status: 'canceled', approvalId: null }
      : item,
  );
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  if (action.type === 'reset') return initialChat(action.conversationId);
  if (action.type === 'restore')
    return {
      ...initialChat(action.conversationId),
      items: action.items,
      completedTurns: action.completedTurns,
    };
  if (action.type === 'begin')
    return {
      ...state,
      activeRequestId: action.requestId,
      sessionId: action.sessionId,
      phase: 'Thinking',
      currentTurn:
        action.internal && state.currentTurn
          ? state.currentTurn
          : { startIndex: state.items.length + (action.internal ? 0 : 1), startedAt: Date.now() },
      pausedReason: undefined,
      items: [
        ...state.items,
        ...(action.internal
          ? []
          : [
              {
                kind: 'message' as const,
                id: action.requestId,
                role: 'user' as const,
                text: action.text,
              },
            ]),
      ],
    };
  if (action.type === 'stop' || action.type === 'pause')
    return {
      ...state,
      activeRequestId: null,
      phase: '',
      pausedReason: action.type === 'pause' ? action.label : undefined,
      items: cancelTools(state.items),
    };
  if (action.type === 'failure') {
    if (action.requestId !== state.activeRequestId) return state;
    return {
      ...state,
      activeRequestId: null,
      phase: '',
      items: [
        ...cancelTools(state.items),
        {
          kind: 'notice',
          id: action.requestId + '-error',
          text: action.message,
          error: true,
        },
      ],
    };
  }
  const event = action.event;
  // A canceled request, replaced terminal, or old conversation can never update the current UI.
  if (
    event.requestId !== state.activeRequestId ||
    event.conversationId !== state.conversationId ||
    event.sessionId !== state.sessionId
  )
    return state;
  switch (event.type) {
    case 'phase':
      return { ...state, phase: event.label };
    case 'paused':
      return {
        ...state,
        activeRequestId: null,
        phase: '',
        pausedReason: event.label,
        items: cancelTools(state.items),
      };
    case 'textDelta': {
      const existing = state.items.find((item) => item.id === event.messageId);
      const items: ChatItem[] = existing
        ? state.items.map((item) =>
            item.kind === 'message' && item.id === event.messageId
              ? { ...item, text: item.text + event.delta }
              : item,
          )
        : [
            ...state.items,
            {
              kind: 'message',
              id: event.messageId,
              role: 'assistant',
              text: event.delta,
            },
          ];
      return { ...state, items };
    }
    case 'messageComplete':
      return {
        ...state,
        items: state.items.map((item) =>
          item.kind === 'message' && item.id === event.messageId
            ? { ...item, channel: event.channel }
            : item,
        ),
      };
    case 'tool': {
      const previous = state.items.find((item) => item.kind === 'tool' && item.id === event.toolId);
      const item: ChatItem = {
        kind: 'tool',
        id: event.toolId,
        requestId: event.requestId,
        name: event.name,
        arguments: event.arguments,
        status: event.status,
        approvalId: event.approvalId,
        directory: event.directory,
        result: event.result,
        stdout: previous?.kind === 'tool' ? previous.stdout : '',
        stderr: previous?.kind === 'tool' ? previous.stderr : '',
      };
      return {
        ...state,
        items: previous
          ? state.items.map((old) => (old.id === item.id ? item : old))
          : [...state.items, item],
      };
    }
    case 'toolOutput':
      return {
        ...state,
        items: state.items.map((item) => {
          if (item.kind !== 'tool' || item.id !== event.toolId) return item;
          const output = event.stream === 'stderr' ? 'stderr' : 'stdout';
          return {
            ...item,
            [output]: item[output] + (action.decodedOutput ?? ''),
          };
        }),
      };
    case 'done': {
      const turn = state.currentTurn;
      const summary = state.items
        .slice(turn?.startIndex ?? state.items.length)
        .filter(
          (item) =>
            item.kind === 'message' && item.role === 'assistant' && item.channel !== 'commentary',
        )
        .at(-1);
      return {
        ...state,
        activeRequestId: null,
        phase: '',
        currentTurn: undefined,
        completedTurns:
          turn && summary
            ? [
                ...(state.completedTurns ?? []),
                {
                  id: event.requestId,
                  startIndex: turn.startIndex,
                  endIndex: state.items.length,
                  summaryId: summary.id,
                  durationMs: Math.max(0, Date.now() - turn.startedAt),
                },
              ]
            : state.completedTurns,
      };
    }
    case 'canceled':
      return {
        ...state,
        activeRequestId: null,
        phase: '',
        items: cancelTools(state.items),
      };
    case 'error':
      return {
        ...state,
        activeRequestId: null,
        phase: '',
        items: [
          ...cancelTools(state.items),
          {
            kind: 'notice',
            id: event.requestId + '-error',
            text: event.message,
            error: true,
          },
        ],
      };
  }
}

export function boundedTerminalText(lines: string[], maximumBytes = 16 * 1024): string {
  const encoder = new TextEncoder();
  let result = lines.slice(-200).join('\n').trimEnd();
  if (encoder.encode(result).length <= maximumBytes) return result;
  // Keep the newest complete Unicode characters, even when the snapshot exceeds its byte limit.
  const characters = Array.from(result);
  let used = 0;
  let start = characters.length;
  while (start > 0) {
    const size = encoder.encode(characters[start - 1]).length;
    if (used + size > maximumBytes) break;
    used += size;
    start -= 1;
  }
  result = characters.slice(start).join('');
  return result;
}

export function shortcutAction(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  chatOpen: boolean,
): 'toggle' | 'close' | null {
  if (
    event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === 'j'
  )
    return 'toggle';
  if (event.key === 'Escape' && chatOpen) return 'close';
  return null;
}
