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
} from './types';
import type { Hotkeys } from './hotkeys';

export type Unsubscribe = () => void;

/** The UI talks to the desktop through this runtime-independent contract. */
export interface Backend {
  readonly available: boolean;
  startTerminal(
    tabId: string,
    sourceSessionId: string | null,
    onEvent: (event: TerminalEvent) => void,
  ): Promise<TerminalInfo>;
  writeTerminal(sessionId: string, data: string): Promise<void>;
  resizeTerminal(sessionId: string, columns: number, rows: number): Promise<void>;
  acknowledgeTerminal(sessionId: string, sequence: number): Promise<void>;
  publishTerminalSnapshot(snapshot: TerminalSnapshot): Promise<void>;
  terminalRevision(sessionId: string): Promise<number>;
  interruptTerminal(sessionId: string): Promise<void>;
  stopTerminal(sessionId: string): Promise<void>;
  prepareContext(sessionId: string, directoryOverride: string | null): Promise<ContextSnapshot>;
  getSettings(): Promise<Settings>;
  listModels(apiKey?: string | null): Promise<ModelOption[]>;
  saveModel(model: string, reasoningEffort: ReasoningEffort): Promise<Settings>;
  saveSettings(
    model: string,
    apiKey: string | null,
    hotkeys: Hotkeys,
    reasoningEffort?: ReasoningEffort,
    testConnection?: boolean,
    redactSensitiveInfo?: boolean,
    showStatusBar?: boolean,
    spoofUserHost?: string | null,
    spoofSshUserHost?: string | null,
  ): Promise<Settings>;
  setHotkeysEditing(editing: boolean): Promise<void>;
  deleteKey(): Promise<Settings>;
  startChat(input: ChatInput, onEvent: (event: ChatEvent) => void): Promise<void>;
  cancelChat(requestId: string): Promise<void>;
  waitingForUserInput(sessionId: string): Promise<boolean>;
  decide(requestId: string, approvalId: string, approved: boolean, reason?: string): Promise<void>;
  setChatMode(mode: AgentMode): Promise<void>;
  clearChat(): Promise<void>;
  newWindow(sourceSessionId: string | null): Promise<void>;
  closeWorkspace(tabId: string | null, confirmed: boolean, frontendBusy: boolean): Promise<boolean>;
  closeWorkspaces(tabIds: string[], confirmed: boolean, frontendBusy: boolean): Promise<boolean>;
  listen<T>(event: string, callback: (payload: T) => void): Promise<Unsubscribe>;
  chooseDirectory(): Promise<string | null>;
}
