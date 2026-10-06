import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import type {
  ChatEvent,
  ChatInput,
  ContextSnapshot,
  Settings,
  ModelOption,
  TerminalEvent,
  TerminalInfo,
  TerminalSnapshot,
  AgentMode,
} from './types';

export const desktopAvailable = () => isTauri();
export const bridge = {
  startTerminal(
    tabId: string,
    sourceSessionId: string | null,
    onEvent: (event: TerminalEvent) => void,
  ): Promise<TerminalInfo> {
    const output = new Channel<TerminalEvent>();
    output.onmessage = onEvent;
    return invoke('terminal_start', { tabId, sourceSessionId, output });
  },
  writeTerminal: (sessionId: string, data: string) =>
    invoke<void>('terminal_input', { sessionId, data }),
  resizeTerminal: (sessionId: string, columns: number, rows: number) =>
    invoke<void>('terminal_resize', { sessionId, columns, rows }),
  acknowledgeTerminal: (sessionId: string, sequence: number) =>
    invoke<void>('terminal_ack', { sessionId, sequence }),
  publishTerminalSnapshot: (snapshot: TerminalSnapshot) =>
    invoke<void>('terminal_publish_snapshot', { snapshot }),
  terminalRevision: (sessionId: string) => invoke<number>('terminal_revision', { sessionId }),
  interruptTerminal: (sessionId: string) => invoke<void>('terminal_interrupt', { sessionId }),
  stopTerminal: (sessionId: string) => invoke<void>('terminal_stop', { sessionId }),
  prepareContext: (sessionId: string, directoryOverride: string | null) =>
    invoke<ContextSnapshot>('prepare_context', {
      sessionId,
      directoryOverride,
    }),
  getSettings: () => invoke<Settings>('settings_get'),
  listModels: (apiKey: string | null = null) => invoke<ModelOption[]>('models_list', { apiKey }),
  saveModel: (model: string, reasoningEffort: import('./types').ReasoningEffort) =>
    invoke<Settings>('model_save', { model, reasoningEffort }),
  saveSettings: (
    model: string,
    apiKey: string | null,
    hotkeys: import('./hotkeys').Hotkeys,
    reasoningEffort: import('./types').ReasoningEffort = 'medium',
    testConnection = false,
    redactSensitiveInfo = true,
    showStatusBar = true,
    spoofUserHost: string | null = null,
    spoofSshUserHost: string | null = null,
  ) =>
    invoke<Settings>('settings_save', {
      model,
      apiKey,
      hotkeys,
      reasoningEffort,
      testConnection,
      redactSensitiveInfo,
      showStatusBar,
      spoofUserHost,
      spoofSshUserHost,
    }),
  setHotkeysEditing: (editing: boolean) =>
    desktopAvailable() ? invoke<void>('hotkeys_editing', { editing }) : Promise.resolve(),
  deleteKey: () => invoke<Settings>('settings_delete_key'),
  startChat(input: ChatInput, onEvent: (event: ChatEvent) => void): Promise<void> {
    const events = new Channel<ChatEvent>();
    events.onmessage = onEvent;
    return invoke('chat_start', { input, events });
  },
  cancelChat: (requestId: string) => invoke<void>('chat_cancel', { requestId }),
  waitingForUserInput: (sessionId: string) =>
    invoke<boolean>('chat_waiting_for_user_input', { sessionId }),
  decide: (requestId: string, approvalId: string, approved: boolean, reason?: string) =>
    invoke<void>('chat_decide', { requestId, approvalId, approved, reason }),
  setChatMode: (mode: AgentMode) => invoke<void>('chat_set_mode', { mode }),
  clearChat: () => invoke<void>('chat_clear'),
  newWindow: (sourceSessionId: string | null) => invoke<void>('window_new', { sourceSessionId }),
  closeWorkspace: (tabId: string | null, confirmed: boolean, frontendBusy: boolean) =>
    invoke<boolean>('workspace_close', { tabId, tabIds: null, confirmed, frontendBusy }),
  closeWorkspaces: (tabIds: string[], confirmed: boolean, frontendBusy: boolean) =>
    invoke<boolean>('workspace_close', { tabId: null, tabIds, confirmed, frontendBusy }),
  async listen<T>(event: string, callback: (payload: T) => void): Promise<UnlistenFn> {
    if (!desktopAvailable()) return () => {};
    return listen<T>(event, (message) => callback(message.payload));
  },
  async chooseDirectory(): Promise<string | null> {
    const selected = await open({
      directory: true,
      multiple: false,
      title: 'Choose context directory',
    });
    return typeof selected === 'string' ? selected : null;
  },
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
