export interface TerminalInfo {
  sessionId: string;
  home: string;
  shell: string;
}
export type TerminalEvent =
  | { type: 'output'; sessionId: string; sequence: number; revision: number; data: number[] }
  | { type: 'revision'; sessionId: string; revision: number }
  | { type: 'exit'; sessionId: string; code: number }
  | { type: 'error'; sessionId: string; message: string };
export interface DirectoryEntry {
  name: string;
  kind: 'directory' | 'file' | 'symlink';
}
export interface ContextSnapshot {
  directory: string;
  listing: { path: string; entries: DirectoryEntry[]; truncated: boolean };
}
export interface Settings {
  model: string;
  hasApiKey: boolean;
  hotkeys?: import('./hotkeys').Hotkeys;
  reasoningEffort?: ReasoningEffort;
  connectionVerified?: boolean;
  redactSensitiveInfo?: boolean;
}
export interface ModelOption {
  id: string;
  ownedBy: string;
}
export type ReasoningEffort = 'off' | 'none' | 'low' | 'medium' | 'high';
export interface ChatInput {
  requestId: string;
  sessionId: string;
  conversationId: string;
  text: string;
  directory: string | null;
  terminalText: string | null;
  attachments: TerminalAttachment[];
  reasoningEffort: ReasoningEffort;
}
export type AgentMode = 'ask' | 'auto' | 'full';
export const MAX_TERMINAL_ATTACHMENTS = 16;
export interface TerminalAttachment {
  sessionId: string;
  label: string;
}
export interface TerminalSnapshot {
  sessionId: string;
  sequence: number;
  revision: number;
  screen: string;
  scrollback: string;
  cursorX: number;
  cursorY: number;
  columns: number;
  rows: number;
  alternate: boolean;
  truncated: boolean;
}
export type ToolStatus = 'approval' | 'running' | 'done' | 'error' | 'rejected' | 'canceled';
export interface ToolArguments {
  sessionId?: string;
  targetLabel?: string;
  purpose?: string;
  approvalReason?: string;
  command?: string;
  path?: string;
  text?: string;
  keys?: string[];
  revision?: number;
  afterSequence?: number;
  timeoutMs?: number;
}
export type ChatPayload =
  | { type: 'textDelta'; messageId: string; delta: string }
  | { type: 'messageComplete'; messageId: string; channel: 'commentary' | 'final' }
  | { type: 'phase'; label: string }
  | { type: 'paused'; label: string }
  | {
      type: 'tool';
      toolId: string;
      name: string;
      arguments: ToolArguments;
      status: ToolStatus;
      approvalId: string | null;
      directory: string | null;
      result: Record<string, unknown> | null;
    }
  | { type: 'toolOutput'; toolId: string; stream: string; data: number[] }
  | { type: 'done' | 'canceled' }
  | { type: 'error'; message: string };
export type ChatEvent = ChatPayload & {
  requestId: string;
  sessionId: string;
  conversationId: string;
};
export type ChatItem =
  | {
      kind: 'message';
      id: string;
      role: 'user' | 'assistant';
      text: string;
      channel?: 'commentary' | 'final';
    }
  | {
      kind: 'tool';
      id: string;
      requestId: string;
      name: string;
      arguments: ToolArguments;
      status: ToolStatus;
      approvalId: string | null;
      directory: string | null;
      result: Record<string, unknown> | null;
      stdout: string;
      stderr: string;
    }
  | { kind: 'notice'; id: string; text: string; error: boolean };
export interface CompletedTurn {
  id: string;
  startIndex: number;
  endIndex: number;
  summaryId: string;
  durationMs: number;
}
export interface ChatState {
  currentTurn?: { startIndex: number; startedAt: number };
  completedTurns?: CompletedTurn[];
  items: ChatItem[];
  activeRequestId: string | null;
  conversationId: string;
  sessionId: string | null;
  phase: string;
  pausedReason?: string;
}
