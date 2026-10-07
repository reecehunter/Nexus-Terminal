import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import type { Backend } from '../backend';
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
import type { Hotkeys } from '../hotkeys';

/** Tauri is an implementation detail of the desktop adapter, not the UI. */
export function createTauriBackend(): Backend {
  return {
    available: isTauri(),
    startTerminal(tabId, sourceSessionId, onEvent): Promise<TerminalInfo> {
      const output = new Channel<TerminalEvent>();
      output.onmessage = onEvent;
      return invoke('terminal_start', { tabId, sourceSessionId, output });
    },
    writeTerminal: (sessionId, data) => invoke<void>('terminal_input', { sessionId, data }),
    resizeTerminal: (sessionId, columns, rows) =>
      invoke<void>('terminal_resize', { sessionId, columns, rows }),
    acknowledgeTerminal: (sessionId, sequence) =>
      invoke<void>('terminal_ack', { sessionId, sequence }),
    publishTerminalSnapshot: (snapshot) => invoke<void>('terminal_publish_snapshot', { snapshot }),
    terminalRevision: (sessionId) => invoke<number>('terminal_revision', { sessionId }),
    interruptTerminal: (sessionId) => invoke<void>('terminal_interrupt', { sessionId }),
    stopTerminal: (sessionId) => invoke<void>('terminal_stop', { sessionId }),
    prepareContext: (sessionId, directoryOverride): Promise<ContextSnapshot> =>
      invoke('prepare_context', { sessionId, directoryOverride }),
    getSettings: () => invoke<Settings>('settings_get'),
    listModels: (apiKey = null) => invoke<ModelOption[]>('models_list', { apiKey }),
    saveModel: (model, reasoningEffort) =>
      invoke<Settings>('model_save', { model, reasoningEffort }),
    saveSettings: (
      model,
      apiKey,
      hotkeys,
      reasoningEffort = 'medium',
      testConnection = false,
      redactSensitiveInfo = true,
      showStatusBar = true,
      spoofUserHost = null,
      spoofSshUserHost = null,
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
    setHotkeysEditing: (editing) =>
      isTauri() ? invoke<void>('hotkeys_editing', { editing }) : Promise.resolve(),
    deleteKey: () => invoke<Settings>('settings_delete_key'),
    startChat(input, onEvent): Promise<void> {
      const events = new Channel<ChatEvent>();
      events.onmessage = onEvent;
      return invoke('chat_start', { input, events });
    },
    cancelChat: (requestId) => invoke<void>('chat_cancel', { requestId }),
    waitingForUserInput: (sessionId) =>
      invoke<boolean>('chat_waiting_for_user_input', { sessionId }),
    decide: (requestId, approvalId, approved, reason) =>
      invoke<void>('chat_decide', { requestId, approvalId, approved, reason }),
    setChatMode: (mode: AgentMode) => invoke<void>('chat_set_mode', { mode }),
    clearChat: () => invoke<void>('chat_clear'),
    newWindow: (sourceSessionId) => invoke<void>('window_new', { sourceSessionId }),
    closeWorkspace: (tabId, confirmed, frontendBusy) =>
      invoke<boolean>('workspace_close', { tabId, tabIds: null, confirmed, frontendBusy }),
    closeWorkspaces: (tabIds, confirmed, frontendBusy) =>
      invoke<boolean>('workspace_close', { tabId: null, tabIds, confirmed, frontendBusy }),
    async listen<T>(event: string, callback: (payload: T) => void): Promise<UnlistenFn> {
      if (!isTauri()) return () => {};
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
}
