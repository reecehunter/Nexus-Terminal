import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { bridge, desktopAvailable, errorMessage } from './bridge';
import { chatReducer, initialChat } from './chat-state';
import type { SavedChat } from './chat-history';
import type { AgentMode, ChatEvent, ReasoningEffort, TerminalAttachment } from './types';

// Mounted once by App: terminal panes never own a conversation or permission mode.
export function useWindowAgent() {
  const [state, dispatch] = useReducer(chatReducer, undefined, () =>
    initialChat(crypto.randomUUID()),
  );
  const [mode, setMode] = useState<AgentMode>('ask');
  const [error, setError] = useState('');
  const [transitioning, setTransitioning] = useState(false);
  const conversation = useRef(state.conversationId);
  const request = useRef<string | null>(null);
  const generation = useRef(0);
  const submitting = useRef(false);
  const configuration = useRef(Promise.resolve());
  const cancellation = useRef(Promise.resolve());
  const decoders = useRef(new Map<string, TextDecoder>());
  const restoredHistory = useRef<{ role: 'user' | 'assistant'; content: string }[]>([]);

  const stop = useCallback((reason?: string) => {
    ++generation.current;
    submitting.current = false;
    const requestId = request.current;
    request.current = null;
    decoders.current.clear();
    dispatch(reason ? { type: 'pause', label: reason } : { type: 'stop' });
    if (requestId) {
      cancellation.current = cancellation.current
        .catch(() => {})
        .then(() => bridge.cancelChat(requestId));
      void cancellation.current.catch((error) => setError(errorMessage(error)));
    }
    return cancellation.current;
  }, []);

  const changeMode = useCallback(
    (next: AgentMode) => {
      setTransitioning(true);
      const operation = configuration.current
        .catch(() => {})
        .then(async () => {
          await bridge.setChatMode(next);
          // Display granted permissions only after the backend has accepted the change.
          setMode(next);
          setError('');
        });
      configuration.current = operation;
      void operation
        .catch((error) => setError(errorMessage(error)))
        .finally(() => {
          if (configuration.current === operation) setTransitioning(false);
        });
    },
    [stop],
  );

  useEffect(() => {
    if (desktopAvailable()) changeMode('ask');
    return () => {
      void stop();
    };
  }, [changeMode, stop]);

  function receive(event: ChatEvent) {
    if (
      event.sessionId !== 'window' ||
      event.requestId !== request.current ||
      event.conversationId !== conversation.current
    )
      return;
    let decodedOutput: string | undefined;
    if (event.type === 'toolOutput') {
      const key = `${event.toolId}:${event.stream}`;
      let decoder = decoders.current.get(key);
      if (!decoder) {
        decoder = new TextDecoder();
        decoders.current.set(key, decoder);
      }
      decodedOutput = decoder.decode(new Uint8Array(event.data), { stream: true });
    }
    dispatch({ type: 'event', event, decodedOutput });
    if (['done', 'canceled', 'error', 'paused'].includes(event.type)) {
      request.current = null;
      decoders.current.clear();
    }
  }

  async function send(
    text: string,
    attachments: TerminalAttachment[],
    observe: () => Promise<void>,
    reasoningEffort: ReasoningEffort,
    directory: string | null = null,
    internal = false,
  ) {
    if (request.current || submitting.current) return false;
    submitting.current = true;
    const submission = ++generation.current;
    const requestId = crypto.randomUUID();
    try {
      // Await cancellation and permissions before capturing fresh rendered observations.
      await cancellation.current;
      await configuration.current;
      if (submission !== generation.current) return false;
      await observe();
      if (submission !== generation.current) return false;
      request.current = requestId;
      dispatch({ type: 'begin', requestId, sessionId: 'window', text, internal });
      setError('');
      await bridge.startChat(
        {
          requestId,
          conversationId: conversation.current,
          sessionId: 'window',
          text,
          directory,
          terminalText: null,
          attachments,
          reasoningEffort,
          history: restoredHistory.current.length ? restoredHistory.current : undefined,
        },
        receive,
      );
      // The backend now owns this context; only send the saved transcript once.
      restoredHistory.current = [];
      return true;
    } catch (error) {
      if (submission !== generation.current) return false;
      const message = errorMessage(error);
      setError(message);
      if (request.current === requestId) {
        request.current = null;
        dispatch({ type: 'failure', requestId, message });
      }
      return false;
    } finally {
      if (submission === generation.current) submitting.current = false;
    }
  }

  async function newChat() {
    const canceled = stop();
    const operation = configuration.current
      .catch(() => {})
      .then(async () => {
        await canceled;
        await bridge.clearChat();
        conversation.current = crypto.randomUUID();
        restoredHistory.current = [];
        dispatch({ type: 'reset', conversationId: conversation.current });
        setError('');
      });
    configuration.current = operation;
    try {
      await operation;
    } catch (error) {
      setError(errorMessage(error));
    }
  }

  async function restoreChat(saved: SavedChat) {
    const canceled = stop();
    const operation = configuration.current
      .catch(() => {})
      .then(async () => {
        await canceled;
        await bridge.clearChat();
        conversation.current = saved.conversationId;
        restoredHistory.current = saved.items.flatMap((item) =>
          item.kind === 'message' && item.text.trim().length > 0
            ? [{ role: item.role, content: item.text }]
            : [],
        );
        dispatch({
          type: 'restore',
          conversationId: saved.conversationId,
          items: saved.items,
          completedTurns: saved.completedTurns,
        });
        setError('');
      });
    configuration.current = operation;
    try {
      await operation;
    } catch (error) {
      setError(errorMessage(error));
    }
  }

  return {
    state,
    mode,
    error,
    transitioning,
    stop,
    send,
    newChat,
    restoreChat,
    changeMode,
    clearError: () => setError(''),
    busy: () => submitting.current || !!request.current,
  };
}
