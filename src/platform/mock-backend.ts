import { defaultHotkeys, type Hotkeys } from '../hotkeys';
import type { Backend, Unsubscribe } from '../backend';
import type {
  AgentMode,
  ChatEvent,
  ChatInput,
  ContextSnapshot,
  ModelOption,
  ReasoningEffort,
  Settings,
  TerminalEvent,
  TerminalInfo,
  TerminalSnapshot,
} from '../types';

interface MockSession {
  info: TerminalInfo;
  onEvent: (event: TerminalEvent) => void;
  input: string;
  sequence: number;
  revision: number;
}

const encoder = new TextEncoder();

function bytes(text: string): number[] {
  return Array.from(encoder.encode(text));
}

/**
 * Browser development backend. It exercises the same frontend contract as the
 * desktop adapter without starting a local shell or requiring Tauri.
 */
export function createMockBackend(): Backend {
  const sessions = new Map<string, MockSession>();
  const canceledRequests = new Set<string>();
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  let settings: Settings = {
    model: 'mock-model',
    hasApiKey: false,
    hotkeys: defaultHotkeys(),
    reasoningEffort: 'medium',
    redactSensitiveInfo: true,
    showStatusBar: true,
    connectionVerified: false,
  };

  function emit(session: MockSession, text: string): void {
    if (!text) return;
    session.sequence += 1;
    session.onEvent({
      type: 'output',
      sessionId: session.info.sessionId,
      sequence: session.sequence,
      revision: session.revision,
      data: bytes(text),
    });
  }

  function prompt(session: MockSession): void {
    emit(session, '\u001b[36muser@mock\u001b[0m:\u001b[34m~/project\u001b[0m$ ');
  }

  function runCommand(session: MockSession, command: string): void {
    const trimmed = command.trim();
    const output = new Map<string, string>([
      ['pwd', '/Users/demo/project\r\n'],
      ['ls', 'src  package.json  README.md\r\n'],
      ['whoami', 'demo\r\n'],
      ['clear', '\u001b[2J\u001b[H'],
      ['help', 'Available commands: clear, help, ls, pwd, whoami\r\n'],
    ]);
    emit(session, '\r\n');
    emit(session, output.get(trimmed) ?? `zsh: command not found: ${trimmed}\r\n`);
    prompt(session);
  }

  return {
    available: true,
    async startTerminal(tabId, _sourceSessionId, onEvent): Promise<TerminalInfo> {
      const info: TerminalInfo = {
        sessionId: `mock-${crypto.randomUUID()}`,
        home: '/Users/demo',
        shell: '/bin/zsh (mock preview)',
      };
      const session: MockSession = { info, onEvent, input: '', sequence: 0, revision: 0 };
      sessions.set(info.sessionId, session);
      await Promise.resolve();
      emit(session, 'Nexus browser preview\r\n');
      prompt(session);
      return info;
    },
    async writeTerminal(sessionId, data): Promise<void> {
      const session = sessions.get(sessionId);
      if (!session) return;
      if (data.includes('\u0003')) {
        session.input = '';
        emit(session, '^C\r\n');
        prompt(session);
        return;
      }
      for (const character of data) {
        if (character === '\r' || character === '\n') {
          runCommand(session, session.input);
          session.input = '';
        } else if (character === '\u007f') {
          if (session.input) {
            session.input = session.input.slice(0, -1);
            emit(session, '\b \b');
          }
        } else if (character >= ' ') {
          session.input += character;
          emit(session, character);
        }
      }
    },
    async resizeTerminal(): Promise<void> {},
    async acknowledgeTerminal(): Promise<void> {},
    async publishTerminalSnapshot(_snapshot: TerminalSnapshot): Promise<void> {},
    async terminalRevision(sessionId): Promise<number> {
      return sessions.get(sessionId)?.revision ?? 0;
    },
    async interruptTerminal(sessionId): Promise<void> {
      await this.writeTerminal(sessionId, '\u0003');
    },
    async stopTerminal(sessionId): Promise<void> {
      const session = sessions.get(sessionId);
      if (!session) return;
      session.onEvent({ type: 'exit', sessionId, code: 0 });
      sessions.delete(sessionId);
    },
    async prepareContext(_sessionId, directoryOverride): Promise<ContextSnapshot> {
      const directory = directoryOverride ?? '/Users/demo/project';
      return {
        directory,
        listing: {
          path: directory,
          entries: [
            { name: 'src', kind: 'directory' },
            { name: 'README.md', kind: 'file' },
            { name: 'package.json', kind: 'file' },
          ],
          truncated: false,
        },
      };
    },
    async getSettings(): Promise<Settings> {
      return { ...settings, hotkeys: settings.hotkeys ? { ...settings.hotkeys } : undefined };
    },
    async listModels(_apiKey = null): Promise<ModelOption[]> {
      return [{ id: 'mock-model', ownedBy: 'local-preview' }];
    },
    async saveModel(model: string, reasoningEffort: ReasoningEffort): Promise<Settings> {
      settings = { ...settings, model, reasoningEffort };
      return this.getSettings();
    },
    async saveSettings(
      model: string,
      apiKey: string | null,
      hotkeys: Hotkeys,
      reasoningEffort = 'medium',
      _testConnection = false,
      redactSensitiveInfo = true,
      showStatusBar = true,
      spoofUserHost = null,
      spoofSshUserHost = null,
    ): Promise<Settings> {
      settings = {
        ...settings,
        model,
        hasApiKey: Boolean(apiKey),
        hotkeys,
        reasoningEffort,
        redactSensitiveInfo,
        showStatusBar,
        spoofUserHost: spoofUserHost ?? undefined,
        spoofSshUserHost: spoofSshUserHost ?? undefined,
      };
      return this.getSettings();
    },
    async setHotkeysEditing(_editing: boolean): Promise<void> {},
    async deleteKey(): Promise<Settings> {
      settings = { ...settings, hasApiKey: false, connectionVerified: false };
      return this.getSettings();
    },
    async startChat(input: ChatInput, onEvent: (event: ChatEvent) => void): Promise<void> {
      if (canceledRequests.has(input.requestId)) return;
      const emitChat = (event: ChatEvent) => {
        if (!canceledRequests.has(input.requestId)) onEvent(event);
      };
      const messageId = crypto.randomUUID();
      emitChat({
        requestId: input.requestId,
        sessionId: input.sessionId,
        conversationId: input.conversationId,
        type: 'textDelta',
        messageId,
        delta: 'Browser preview mode: the terminal backend is simulated outside the desktop app.',
      });
      emitChat({
        requestId: input.requestId,
        sessionId: input.sessionId,
        conversationId: input.conversationId,
        type: 'messageComplete',
        messageId,
        channel: 'final',
      });
      emitChat({
        requestId: input.requestId,
        sessionId: input.sessionId,
        conversationId: input.conversationId,
        type: 'done',
      });
    },
    async cancelChat(requestId): Promise<void> {
      canceledRequests.add(requestId);
    },
    async waitingForUserInput(_sessionId): Promise<boolean> {
      return false;
    },
    async decide(): Promise<void> {},
    async setChatMode(_mode: AgentMode): Promise<void> {},
    async clearChat(): Promise<void> {},
    async newWindow(): Promise<void> {},
    async closeWorkspace(): Promise<boolean> {
      return true;
    },
    async closeWorkspaces(): Promise<boolean> {
      return true;
    },
    async listen<T>(event: string, callback: (payload: T) => void): Promise<Unsubscribe> {
      const eventListeners = listeners.get(event) ?? new Set();
      eventListeners.add(callback as (payload: unknown) => void);
      listeners.set(event, eventListeners);
      return () => eventListeners.delete(callback as (payload: unknown) => void);
    },
    async chooseDirectory(): Promise<string | null> {
      return null;
    },
  };
}
