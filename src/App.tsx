import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Columns2, Rows2, X, Sparkles, Settings2 } from 'lucide-react';
import { ChatResizeHandle } from './ChatResizeHandle';
import { ChatPanel } from './ChatPanel';
import { SettingsDialog } from './SettingsDialog';
import { useWindowAgent } from './window-agent';
import { TabWorkspace, type WorkspaceHandle } from './TabWorkspace';
import { bridge, desktopAvailable, errorMessage } from './bridge';
import {
  layoutRectangles,
  paneInDirection,
  splitPane,
  removePane,
  resizeSplit,
  type PaneLayout,
  type SplitDirection,
} from './pane-layout';
import { SplitDivider } from './SplitDivider';
import { MacroTip } from './MacroTip';
import { defaultHotkeys, hotkeyAction, formatHotkey } from './hotkeys';
import { loadAppState, saveAppState, type PersistedTab } from './app-state';
import { savedChatFromState } from './chat-history';
import type {
  ContextSnapshot,
  ModelOption,
  ReasoningEffort,
  Settings,
  TerminalAttachment,
  TerminalInfo,
} from './types';
import { MAX_TERMINAL_ATTACHMENTS } from './types';

interface Pane {
  id: string;
  number: number;
  sourceSessionId: string | null;
}
interface Tab {
  id: string;
  number: number;
  name?: string;
  panes: Pane[];
  layout: PaneLayout;
  focusedId: string;
}
const savedAppState = loadAppState();
function createTab(number: number, paneNumber: number, sourceSessionId: string | null): Tab {
  const pane = { id: crypto.randomUUID(), number: paneNumber, sourceSessionId };
  return {
    id: crypto.randomUUID(),
    number,
    panes: [pane],
    layout: { kind: 'pane', id: pane.id },
    focusedId: pane.id,
  };
}
function dialogOpen(): boolean {
  return Array.from(document.querySelectorAll('[role="dialog"]')).some(
    (dialog) => !dialog.closest('[hidden]'),
  );
}
interface CloseTarget {
  tabId: string | null;
  paneId?: string;
}
const SETTINGS_TAB_ID = 'settings-tab';

function macroLabel(binding: string | null | undefined): string | null {
  if (!binding) return null;
  const formatted = formatHotkey(binding);
  return formatted.startsWith('⌘') ? `⌘+${formatted.slice(1)}` : formatted;
}

export default function App() {
  const agent = useWindowAgent(savedAppState?.chat);
  const agentRef = useRef(agent);
  agentRef.current = agent;
  const [chatWidth, setChatWidth] = useState(savedAppState?.chatWidth ?? 368);
  const [chatOpen, setChatOpen] = useState(savedAppState?.chatOpen ?? false);
  const [chatMounted, setChatMounted] = useState(false);
  const [chatAnimation, setChatAnimation] = useState<'opening' | 'open' | 'closing'>('opening');
  const chatAnimationTimer = useRef<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(savedAppState?.settingsOpen ?? false);
  const [settingsTabVisible, setSettingsTabVisible] = useState(
    savedAppState?.settingsTabVisible ?? false,
  );
  const settingsOpenRef = useRef(settingsOpen);
  settingsOpenRef.current = settingsOpen;
  const [settings, setSettings] = useState<Settings>({ model: 'gpt-5.4-mini', hasApiKey: false });
  const [modelsLoading, setModelsLoading] = useState(false);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>('medium');
  const input = useRef<HTMLTextAreaElement>(null);
  const [sessions, setSessions] = useState<Record<string, TerminalInfo>>({});
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const [customAttachments, setCustomAttachments] = useState<string[] | null>(null);
  const customAttachmentsRef = useRef(customAttachments);
  customAttachmentsRef.current = customAttachments;
  const [localContext, setLocalContext] = useState<ContextSnapshot | null>(null);
  const [localContextLoading, setLocalContextLoading] = useState(false);
  const localContextGeneration = useRef(0);
  const [tabs, setTabs] = useState<Tab[]>(
    () =>
      savedAppState?.tabs.map((tab) => ({
        ...tab,
        panes: tab.panes.map((pane) => ({ ...pane, sourceSessionId: null })),
      })) ?? [createTab(1, 1, null)],
  );
  const [activeId, setActiveId] = useState(savedAppState?.activeId ?? tabs[0].id);
  const [confirmation, setConfirmation] = useState<CloseTarget | null>(null);
  const [tabMenu, setTabMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);
  const [renameTab, setRenameTab] = useState<{ tabId: string; name: string } | null>(null);
  const renameInput = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const [hotkeys, setHotkeys] = useState(defaultHotkeys);
  const hotkeysRef = useRef(hotkeys);
  hotkeysRef.current = hotkeys;
  const [closing, setClosing] = useState(false);
  const handles = useRef(new Map<string, WorkspaceHandle>());
  const nextNumber = useRef(Math.max(0, ...tabs.map((tab) => tab.number)) + 1);
  const nextPaneNumber = useRef(
    Math.max(0, ...tabs.flatMap((tab) => tab.panes.map((pane) => pane.number))) + 1,
  );
  const dialogRef = useRef<HTMLDivElement>(null);
  const closingRef = useRef(false);
  const macroTimer = useRef<number | null>(null);
  const [macroTipsVisible, setMacroTipsVisible] = useState(false);
  const stateRef = useRef({ tabs, activeId, confirmation });
  stateRef.current = { tabs, activeId, confirmation };
  useEffect(() => {
    saveAppState({
      tabs: tabs.map((tab): PersistedTab => ({
        id: tab.id,
        number: tab.number,
        name: tab.name,
        panes: tab.panes.map(({ id, number }) => ({ id, number })),
        layout: tab.layout,
        focusedId: tab.focusedId,
      })),
      activeId,
      chatOpen,
      chatWidth,
      settingsOpen,
      settingsTabVisible,
      chat: agent.state.items.length ? savedChatFromState(agent.state) : null,
    });
  }, [tabs, activeId, chatOpen, chatWidth, settingsOpen, settingsTabVisible, agent.state]);
  const focusedId = tabs.find((tab) => tab.id === activeId)!.focusedId;
  const attachmentPaneIds = customAttachments ?? [focusedId];
  const attachments: TerminalAttachment[] = tabs.flatMap((tab) =>
    tab.panes.flatMap((pane) =>
      attachmentPaneIds.includes(pane.id) && sessions[pane.id]
        ? [
            {
              sessionId: sessions[pane.id].sessionId,
              label: `${tab.name ?? `Terminal ${tab.number}`} · Session ${pane.number}`,
            },
          ]
        : [],
    ),
  );
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const attachmentKey = attachments
    .map((item) => item.sessionId)
    .sort()
    .join(',');
  const previousAttachmentKey = useRef(attachmentKey);
  useEffect(() => {
    if (previousAttachmentKey.current !== attachmentKey) {
      void agentRef.current.stop();
      previousAttachmentKey.current = attachmentKey;
    }
  }, [attachmentKey]);
  const onSessionChange = useCallback((paneId: string, session: TerminalInfo | null) => {
    const previous = sessionsRef.current[paneId];
    if (
      previous &&
      previous.sessionId !== session?.sessionId &&
      attachmentsRef.current.some((attachment) => attachment.sessionId === previous.sessionId)
    ) {
      void agentRef.current.stop();
      // A pane identity survives restart, but authority to use its previous PTY does not.
      const remaining = (customAttachmentsRef.current ?? [paneId]).filter((id) => id !== paneId);
      customAttachmentsRef.current = remaining;
      setCustomAttachments(remaining);
    }
    setSessions((current) => {
      if (current[paneId]?.sessionId === session?.sessionId) return current;
      const next = { ...current };
      if (session) next[paneId] = session;
      else delete next[paneId];
      sessionsRef.current = next;
      return next;
    });
  }, []);
  const onManualInput = useCallback(async (sessionId: string, reason: 'typed' | 'interrupt') => {
    if (
      !attachmentsRef.current.some((attachment) => attachment.sessionId === sessionId) ||
      !agentRef.current.busy()
    )
      return;
    // Password prompts are handled by the backend. Keep the request alive so the
    // user can type into the PTY; ordinary manual takeover still pauses the agent.
    const waitingForPassword = reason === 'typed' && (await bridge.waitingForUserInput(sessionId));
    if (!waitingForPassword) {
      await agentRef.current.stop(
        reason === 'interrupt'
          ? 'Paused because you interrupted an attached terminal.'
          : 'Paused because you typed in an attached terminal.',
      );
    }
  }, []);
  function changeAttachments(next: string[] | null) {
    if (next && next.length > MAX_TERMINAL_ATTACHMENTS) {
      setError(`Attach at most ${MAX_TERMINAL_ATTACHMENTS} terminals.`);
      return;
    }
    void agent.stop();
    customAttachmentsRef.current = next;
    setCustomAttachments(next);
  }
  async function chooseLocalDirectory() {
    const generation = ++localContextGeneration.current;
    try {
      const directory = await bridge.chooseDirectory();
      if (!directory || generation !== localContextGeneration.current) return;
      void agent.stop();
      setLocalContextLoading(true);
      const focusedSession = sessionsRef.current[focusedPaneId()];
      if (!focusedSession)
        throw new Error('Wait for an available terminal before attaching LOCAL context.');
      const snapshot = await bridge.prepareContext(focusedSession.sessionId, directory);
      if (generation === localContextGeneration.current) setLocalContext(snapshot);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      if (generation === localContextGeneration.current) setLocalContextLoading(false);
    }
  }
  function removeLocalDirectory() {
    ++localContextGeneration.current;
    setLocalContextLoading(false);
    void agent.stop();
    setLocalContext(null);
  }
  async function send(text: string, internal = false) {
    if (localContextLoading || modelsLoading) return false;
    if (!settings.hasApiKey) return false;
    const selected = attachmentsRef.current;
    if (selected.length > MAX_TERMINAL_ATTACHMENTS) {
      setError(`Attach at most ${MAX_TERMINAL_ATTACHMENTS} terminals.`);
      return false;
    }
    if (!selected.length && !localContext) {
      setError('Attach an available terminal or LOCAL directory before sending.');
      return false;
    }
    return agent.send(
      text,
      selected,
      async () => {
        for (const attachment of selected) {
          const handle = [...handles.current.values()].find(
            (handle) => handle.sessionId() === attachment.sessionId,
          );
          if (!handle) throw new Error('An attached terminal is no longer available.');
          await handle.observe();
        }
      },
      reasoningEffort,
      localContext?.directory ?? null,
      internal,
    );
  }
  async function changeModel(model: string, effort = reasoningEffort) {
    if ((model === settings.model && effort === reasoningEffort) || modelsLoading) return;
    setModelsLoading(true);
    try {
      const requestedEffort = effort === 'off' && model !== settings.model ? 'medium' : effort;
      const next = await bridge.saveModel(model, requestedEffort);
      setSettings(next);
      setReasoningEffort(next.reasoningEffort ?? requestedEffort);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setModelsLoading(false);
    }
  }
  useEffect(() => {
    if (!settings.hasApiKey || !desktopAvailable()) {
      setModels([]);
      return;
    }
    let disposed = false;
    void bridge
      .listModels()
      .then((next) => {
        if (!disposed) setModels(next);
      })
      .catch((error) => {
        if (!disposed) setError(`${errorMessage(error)} Reload models in Settings.`);
      });
    return () => {
      disposed = true;
    };
  }, [settings]);
  function openChat() {
    // Opening the assistant always starts with the currently focused terminal.
    // This also recovers from an explicit selection that was emptied earlier.
    if (customAttachmentsRef.current !== null) {
      void agent.stop();
      customAttachmentsRef.current = null;
      setCustomAttachments(null);
    }
    setChatOpen(true);
  }

  function closeChat() {
    setChatOpen(false);
    handles.current.get(focusedPaneId())?.focus();
  }
  function openSettings() {
    setSettingsTabVisible(true);
    setSettingsOpen(true);
    setChatOpen(false);
  }
  function selectTerminalTab() {
    setSettingsOpen(false);
  }
  function closeSettings() {
    setSettingsOpen(false);
    setSettingsTabVisible(false);
  }
  useEffect(() => {
    let animationFrame: number | null = null;
    if (chatAnimationTimer.current !== null) {
      window.clearTimeout(chatAnimationTimer.current);
      chatAnimationTimer.current = null;
    }

    if (chatOpen) {
      if (chatMounted) {
        // Reverse an in-progress close without jumping back off-screen.
        setChatAnimation('open');
      } else {
        setChatMounted(true);
        setChatAnimation('opening');
        // Paint the collapsed position before starting the slide transition.
        animationFrame = window.requestAnimationFrame(() => {
          animationFrame = window.requestAnimationFrame(() => {
            setChatAnimation('open');
            animationFrame = null;
          });
        });
      }
    } else if (chatMounted) {
      setChatAnimation('closing');
      chatAnimationTimer.current = window.setTimeout(() => {
        setChatMounted(false);
        chatAnimationTimer.current = null;
      }, 180);
    }

    return () => {
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
      if (chatAnimationTimer.current !== null) {
        window.clearTimeout(chatAnimationTimer.current);
        chatAnimationTimer.current = null;
      }
    };
  }, [chatOpen]);

  useEffect(() => {
    if (chatOpen && chatMounted && !settingsOpen) input.current?.focus({ preventScroll: true });
  }, [chatOpen, chatMounted, settingsOpen]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && chatOpen && !dialogOpen()) {
        event.preventDefault();
        event.stopPropagation();
        closeChat();
      }
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [chatOpen]);

  useEffect(() => {
    // Cancel the webview menu without stopping custom tab menu handlers or portal events.
    const preventBrowserMenu = (event: MouseEvent) => event.preventDefault();
    document.addEventListener('contextmenu', preventBrowserMenu, true);
    return () => document.removeEventListener('contextmenu', preventBrowserMenu, true);
  }, []);

  function focusedPaneId() {
    return stateRef.current.tabs.find((tab) => tab.id === stateRef.current.activeId)!.focusedId;
  }
  function newTab() {
    if (stateRef.current.confirmation || closingRef.current || dialogOpen() || settingsOpen) return;
    const tab = createTab(
      nextNumber.current++,
      nextPaneNumber.current++,
      handles.current.get(focusedPaneId())?.sessionId() ?? null,
    );
    setTabs((current) => [...current, tab]);
    setActiveId(tab.id);
  }
  function split(direction: SplitDirection) {
    if (stateRef.current.confirmation || closingRef.current || dialogOpen() || settingsOpen) return;
    const paneId = focusedPaneId();
    // Keep the request's attached terminal focused while creating a pane. A new
    // pane starts without a session, so following focus would briefly produce an
    // empty attachment list and cancel an in-flight approval.
    const keepFocusedPane = agent.busy();
    const pane = {
      id: crypto.randomUUID(),
      number: nextPaneNumber.current++,
      sourceSessionId: handles.current.get(paneId)?.sessionId() ?? null,
    };
    const splitId = crypto.randomUUID();
    setTabs((current) =>
      current.map((tab) =>
        tab.id === stateRef.current.activeId
          ? {
              ...tab,
              panes: [...tab.panes, pane],
              layout: splitPane(tab.layout, paneId, pane.id, direction, splitId),
              focusedId: keepFocusedPane ? paneId : pane.id,
            }
          : tab,
      ),
    );
  }
  function focusPane(tabId: string, paneId: string) {
    setTabs((current) =>
      current.map((tab) =>
        tab.id === tabId && tab.focusedId !== paneId ? { ...tab, focusedId: paneId } : tab,
      ),
    );
  }
  async function newWindow() {
    if (stateRef.current.confirmation || closingRef.current || dialogOpen() || settingsOpen) return;
    try {
      await bridge.newWindow(handles.current.get(focusedPaneId())?.sessionId() ?? null);
    } catch (error) {
      setError(errorMessage(error));
    }
  }
  async function close(target: CloseTarget, confirmed = false) {
    if (closingRef.current || (stateRef.current.confirmation && !confirmed)) return;
    closingRef.current = true;
    setClosing(true);
    try {
      const current = stateRef.current;
      const targetTab = current.tabs.find((tab) => tab.id === target.tabId);
      if (target.tabId && !targetTab) return;
      const affected = targetTab
        ? target.paneId
          ? targetTab.panes.filter((pane) => pane.id === target.paneId).map((pane) => pane.id)
          : targetTab.panes.map((pane) => pane.id)
        : current.tabs.flatMap((tab) => tab.panes.map((pane) => pane.id));
      if (!affected.length) return;
      const closingTab = !!targetTab && affected.length === targetTab.panes.length;
      const closingWindow = !targetTab || (closingTab && current.tabs.length === 1);
      const affectsAgent = closingWindow || affected.some((id) => attachmentPaneIds.includes(id));
      const busy = affectsAgent && agent.busy();
      const closed = closingWindow
        ? await bridge.closeWorkspace(null, confirmed, busy)
        : affected.length === 1
          ? await bridge.closeWorkspace(affected[0], confirmed, busy)
          : await bridge.closeWorkspaces(affected, confirmed, busy);
      if (!closed) {
        setConfirmation(closingWindow ? { tabId: null } : target);
        return;
      }
      if (affectsAgent) await agent.stop();
      affected.forEach((id) => handles.current.get(id)?.dispose());
      if (customAttachments)
        setCustomAttachments(customAttachments.filter((id) => !affected.includes(id)));
      setConfirmation(null);
      if (closingWindow) return;
      if (closingTab) {
        const index = current.tabs.findIndex((tab) => tab.id === target.tabId);
        const remaining = current.tabs.filter((tab) => tab.id !== target.tabId);
        setTabs(remaining);
        if (current.activeId === target.tabId)
          setActiveId(remaining[Math.min(index, remaining.length - 1)].id);
      } else if (targetTab && target.paneId) {
        const remaining = targetTab.panes.filter((pane) => pane.id !== target.paneId);
        const layout = removePane(targetTab.layout, target.paneId);
        if (!layout) throw new Error('Cannot remove the last pane without closing its tab.');
        const index = targetTab.panes.findIndex((pane) => pane.id === target.paneId);
        setTabs((tabs) =>
          tabs.map((tab) =>
            tab.id === targetTab.id
              ? {
                  ...tab,
                  panes: remaining,
                  layout,
                  focusedId:
                    tab.focusedId === target.paneId
                      ? remaining[Math.min(index, remaining.length - 1)].id
                      : tab.focusedId,
                }
              : tab,
          ),
        );
      }
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      closingRef.current = false;
      setClosing(false);
    }
  }
  function runAction(action: string) {
    if (action === 'close-window') {
      void close({ tabId: null });
      return;
    }
    if (
      stateRef.current.confirmation ||
      closingRef.current ||
      dialogOpen() ||
      (settingsOpen && !action.startsWith('select-tab-'))
    )
      return;
    const { tabs, activeId } = stateRef.current;
    const tab = tabs.find((tab) => tab.id === activeId)!;
    if (action === 'new-tab') newTab();
    else if (action === 'new-window') void newWindow();
    else if (action === 'split-right' || action === 'split-down')
      split(action === 'split-right' ? 'columns' : 'rows');
    else if (action === 'close-pane') void close({ tabId: activeId, paneId: tab.focusedId });
    else if (action === 'close-tab') void close({ tabId: activeId });
    else if (action === 'toggle-assistant') {
      if (chatOpen) closeChat();
      else openChat();
    } else if (action === 'open-settings') openSettings();
    else if (action === 'previous-tab' || action === 'next-tab') {
      const index = tabs.findIndex((tab) => tab.id === activeId);
      setActiveId(tabs[(index + (action === 'next-tab' ? 1 : -1) + tabs.length) % tabs.length].id);
    } else if (action.startsWith('select-tab-')) {
      const targetIndex = Number(action.slice('select-tab-'.length)) - 1;
      const target = tabs[targetIndex];
      if (target) {
        selectTerminalTab();
        setActiveId(target.id);
      } else if (settingsTabVisible && targetIndex === tabs.length) {
        openSettings();
      }
    } else if (action === 'previous-pane' || action === 'next-pane' || action === 'cycle-panes') {
      const panes = layoutRectangles(tab.layout).panes;
      const index = panes.findIndex((pane) => pane.id === tab.focusedId);
      focusPane(
        tab.id,
        panes[(index + (action === 'previous-pane' ? -1 : 1) + panes.length) % panes.length].id,
      );
    } else if (action.startsWith('focus-pane-')) {
      const target = paneInDirection(tab.layout, tab.focusedId, action.slice('focus-pane-'.length));
      if (target) focusPane(tab.id, target);
    }
  }
  const actions = useRef(runAction);
  actions.current = runAction;
  useEffect(() => {
    let disposed = false;
    const cleanups: (() => void)[] = [];
    const receiveSettings = (settings: Settings) => {
      if (!disposed) {
        setHotkeys({ ...defaultHotkeys(), ...settings.hotkeys });
        setSettings(settings);
        setReasoningEffort(settings.reasoningEffort ?? 'medium');
      }
    };
    if (desktopAvailable())
      void bridge
        .getSettings()
        .then(receiveSettings)
        .catch((error) => setError(errorMessage(error)));
    for (const subscribe of [
      () => bridge.listen<string>('workspace-action', (action) => actions.current(action)),
      () => bridge.listen<Settings>('settings-changed', receiveSettings),
    ])
      void subscribe()
        .then((cleanup) => (disposed ? cleanup() : cleanups.push(cleanup)))
        .catch((error) => setError(errorMessage(error)));
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Meta') {
        if (
          !event.repeat &&
          !stateRef.current.confirmation &&
          !dialogOpen() &&
          !settingsOpenRef.current
        ) {
          if (macroTimer.current !== null) window.clearTimeout(macroTimer.current);
          // Delay the hint layer so an ordinary Command shortcut remains unobstructed.
          macroTimer.current = window.setTimeout(() => {
            macroTimer.current = null;
            setMacroTipsVisible(true);
          }, 1000);
        }
        return;
      }
      if (stateRef.current.confirmation || dialogOpen()) return;
      const action = hotkeyAction(event, hotkeysRef.current);
      if (!action) return;
      // Numbered tab shortcuts must remain usable while the Settings tab is active.
      if (settingsOpenRef.current && !action.startsWith('select-tab-')) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) actions.current(action);
    };
    const hideMacroTips = () => {
      if (macroTimer.current !== null) {
        window.clearTimeout(macroTimer.current);
        macroTimer.current = null;
      }
      setMacroTipsVisible(false);
    };
    const keyup = (event: KeyboardEvent) => {
      if (event.key === 'Meta') hideMacroTips();
    };
    window.addEventListener('keydown', keydown, true);
    window.addEventListener('keyup', keyup, true);
    window.addEventListener('blur', hideMacroTips);
    return () => {
      disposed = true;
      cleanups.forEach((cleanup) => cleanup());
      window.removeEventListener('keydown', keydown, true);
      window.removeEventListener('keyup', keyup, true);
      window.removeEventListener('blur', hideMacroTips);
      hideMacroTips();
    };
  }, []);

  useEffect(() => {
    if (!confirmation) return;
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      if (previous?.isConnected && previous !== document.body) previous.focus();
      else handles.current.get(focusedPaneId())?.focus();
    };
  }, [confirmation]);

  useEffect(() => {
    if (!tabMenu) return;
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setTabMenu(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      document.getElementById(`tab-${tabMenu.tabId}`)?.focus();
      setTabMenu(null);
    };
    window.addEventListener('pointerdown', dismiss);
    window.addEventListener('keydown', escape, true);
    window.addEventListener('blur', dismissMenu);
    window.addEventListener('resize', dismissMenu);
    function dismissMenu() {
      setTabMenu(null);
    }
    return () => {
      window.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('keydown', escape, true);
      window.removeEventListener('blur', dismissMenu);
      window.removeEventListener('resize', dismissMenu);
    };
  }, [tabMenu]);

  useEffect(() => {
    if (!renameTab) return;
    renameInput.current?.focus();
    renameInput.current?.select();
    return () => {
      document.getElementById(`tab-${renameTab.tabId}`)?.focus();
    };
  }, [renameTab?.tabId]);

  return (
    <div className="window-shell">
      <nav className="tab-bar" aria-label="Workspace tabs">
        <div className="tab-list" role="tablist" aria-label="Workspaces">
          {tabs.map((tab, index) => (
            <div
              className={`tab-entry ${!settingsOpen && activeId === tab.id ? 'selected' : ''}`}
              key={tab.id}
              onContextMenu={(event) => {
                event.preventDefault();
                if (closing || dialogOpen()) return;
                // Keep the menu within the window even near its bottom or right edge.
                setTabMenu({
                  tabId: tab.id,
                  x: Math.max(0, Math.min(event.clientX, window.innerWidth - 160)),
                  y: Math.max(0, Math.min(event.clientY, window.innerHeight - 44)),
                });
              }}
            >
              <button
                role="tab"
                title={formatHotkey(hotkeys[`select-tab-${index + 1}`])}
                id={`tab-${tab.id}`}
                aria-controls={`panel-${tab.id}`}
                aria-selected={!settingsOpen && activeId === tab.id}
                onClick={() => {
                  selectTerminalTab();
                  setActiveId(tab.id);
                }}
              >
                {tab.name ?? `Terminal ${tab.number}`}
                {macroTipsVisible && macroLabel(hotkeys[`select-tab-${index + 1}`]) && (
                  <MacroTip>{macroLabel(hotkeys[`select-tab-${index + 1}`])}</MacroTip>
                )}
              </button>
              <button
                aria-label={`Close ${tab.name ?? `Terminal ${tab.number}`}`}
                className="icon-button"
                disabled={closing}
                onClick={() => void close({ tabId: tab.id })}
              >
                <X size={13} />
              </button>
            </div>
          ))}
          {settingsTabVisible && (
            <div className={`tab-entry ${settingsOpen ? 'selected' : ''}`}>
              <button
                role="tab"
                id={SETTINGS_TAB_ID}
                aria-controls="settings-panel"
                title={formatHotkey(hotkeys[`select-tab-${tabs.length + 1}`])}
                aria-selected={settingsOpen}
                onClick={openSettings}
              >
                Settings
                {macroTipsVisible && macroLabel(hotkeys[`select-tab-${tabs.length + 1}`]) && (
                  <MacroTip>{macroLabel(hotkeys[`select-tab-${tabs.length + 1}`])}</MacroTip>
                )}
              </button>
              <button className="icon-button" aria-label="Close Settings" onClick={closeSettings}>
                <X size={13} />
              </button>
            </div>
          )}
        </div>
        <button
          className="icon-button"
          aria-label="New tab"
          title={`New tab · ${formatHotkey(hotkeys['new-tab'])}`}
          disabled={!!confirmation || closing}
          onClick={newTab}
        >
          <Plus size={17} />
          {macroTipsVisible && macroLabel(hotkeys['new-tab']) && (
            <MacroTip>{macroLabel(hotkeys['new-tab'])}</MacroTip>
          )}
        </button>
        <button
          className="split-button"
          aria-label="Split right"
          title={`Split right · ${formatHotkey(hotkeys['split-right'])}`}
          disabled={!!confirmation || closing}
          onClick={() => split('columns')}
        >
          <Columns2 size={15} />
          {macroTipsVisible && macroLabel(hotkeys['split-right']) && (
            <MacroTip>{macroLabel(hotkeys['split-right'])}</MacroTip>
          )}
        </button>
        <button
          className="split-button"
          aria-label="Split down"
          title={`Split down · ${formatHotkey(hotkeys['split-down'])}`}
          disabled={!!confirmation || closing}
          onClick={() => split('rows')}
        >
          <Rows2 size={15} />
          {macroTipsVisible && macroLabel(hotkeys['split-down']) && (
            <MacroTip>{macroLabel(hotkeys['split-down'])}</MacroTip>
          )}
        </button>
        <button
          className={`chat-toggle ${chatOpen ? 'active' : ''}`}
          aria-label="Toggle AI chat"
          onClick={() => {
            if (chatOpen) closeChat();
            else openChat();
          }}
        >
          <Sparkles size={16} />
          {macroTipsVisible && macroLabel(hotkeys['toggle-assistant']) && (
            <MacroTip>{macroLabel(hotkeys['toggle-assistant'])}</MacroTip>
          )}
        </button>
        <button className="icon-button" aria-label="Settings" onClick={openSettings}>
          <Settings2 size={16} />
          {macroTipsVisible && macroLabel(hotkeys['open-settings']) && (
            <MacroTip>{macroLabel(hotkeys['open-settings'])}</MacroTip>
          )}
        </button>
      </nav>
      <div className="window-workspace">
        <div className="window-terminals" hidden={settingsOpen}>
          {tabs.map((tab) => (
            <SplitTab
              key={tab.id}
              tab={tab}
              selected={activeId === tab.id}
              macroTipsVisible={macroTipsVisible}
              handles={handles.current}
              closing={closing}
              hotkeys={hotkeys}
              showStatusBar={settings.showStatusBar ?? true}
              spoofSshUserHost={settings.spoofSshUserHost}
              onSessionChange={onSessionChange}
              onManualInput={onManualInput}
              focusOnReady={!chatOpen && !settingsOpen && !confirmation}
              onFocus={focusPane}
              onClose={(paneId) => void close({ tabId: tab.id, paneId })}
              onResize={(splitId, ratio) =>
                setTabs((tabs) =>
                  tabs.map((current) =>
                    current.id === tab.id
                      ? { ...current, layout: resizeSplit(current.layout, splitId, ratio) }
                      : current,
                  ),
                )
              }
            />
          ))}
        </div>
        {chatMounted && (
          <div
            className={`chat-container chat-container-${chatAnimation}`}
            style={{ '--chat-width': `${chatWidth}px` } as React.CSSProperties}
            aria-hidden={!chatOpen}
            inert={!chatOpen}
          >
            <ChatResizeHandle width={chatWidth} onResize={setChatWidth} />
            <ChatPanel
              animationState={chatAnimation}
              state={agent.state}
              settings={settings}
              models={models}
              modelsLoading={modelsLoading}
              onModelChange={changeModel}
              reasoningEffort={reasoningEffort}
              onReasoningEffortChange={(effort) => void changeModel(settings.model, effort)}
              inputRef={input}
              mode={agent.mode}
              modeUpdating={agent.transitioning}
              onModeChange={agent.changeMode}
              attachments={attachments}
              followFocus={customAttachments === null}
              localContext={localContext}
              localContextLoading={localContextLoading}
              onChooseLocalDirectory={() => {
                void chooseLocalDirectory();
              }}
              onRemoveLocalDirectory={removeLocalDirectory}
              availableAttachments={tabs.flatMap((tab) =>
                tab.panes.map((pane) => ({
                  paneId: pane.id,
                  sessionId: sessions[pane.id]?.sessionId ?? '',
                  label: `${tab.name ?? `Terminal ${tab.number}`} · Session ${pane.number}`,
                })),
              )}
              onAttachmentsChange={changeAttachments}
              onSend={send}
              onStop={() => {
                void agent.stop();
              }}
              onResume={() => {
                void send('Continue the previous task using fresh terminal observations.', true);
              }}
              onNewChat={() => {
                changeAttachments(null);
                removeLocalDirectory();
                void agent.newChat();
              }}
              onLoadChat={(chat) => {
                changeAttachments(null);
                removeLocalDirectory();
                void agent.restoreChat(chat);
              }}
              onClose={closeChat}
              onSettings={openSettings}
            />
          </div>
        )}
        {settingsTabVisible && (
          <div
            className="settings-panel"
            role="tabpanel"
            id="settings-panel"
            aria-labelledby={SETTINGS_TAB_ID}
            hidden={!settingsOpen}
          >
            <SettingsDialog
              settings={settings}
              onSave={(next) => {
                setSettings(next);
                setReasoningEffort(next.reasoningEffort ?? 'medium');
                setHotkeys({ ...defaultHotkeys(), ...next.hotkeys });
              }}
              onClose={closeSettings}
            />
          </div>
        )}
      </div>
      {tabMenu && (
        <div
          ref={menuRef}
          className="tab-context-menu"
          role="menu"
          aria-label="Tab actions"
          style={{ left: tabMenu.x, top: tabMenu.y }}
        >
          <button
            role="menuitem"
            onClick={() => {
              const tab = tabs.find((tab) => tab.id === tabMenu.tabId);
              if (tab && !closing && !dialogOpen())
                setRenameTab({ tabId: tab.id, name: tab.name ?? `Terminal ${tab.number}` });
              setTabMenu(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Tab') setTabMenu(null);
            }}
          >
            Rename tab
          </button>
        </div>
      )}
      {renameTab && (
        <div className="modal-backdrop">
          <form
            className="settings-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rename-tab-title"
            onSubmit={(event) => {
              event.preventDefault();
              const name = renameTab.name.trim();
              if (!name) return;
              setTabs((current) =>
                current.map((tab) => (tab.id === renameTab.tabId ? { ...tab, name } : tab)),
              );
              setRenameTab(null);
            }}
            onKeyDownCapture={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                event.preventDefault();
                setRenameTab(null);
              }
              if (event.key === 'Tab') {
                const controls = Array.from(
                  event.currentTarget.querySelectorAll<HTMLElement>('input, button:not(:disabled)'),
                );
                const first = controls[0];
                const last = controls[controls.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                  event.preventDefault();
                  last?.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                  event.preventDefault();
                  first?.focus();
                }
              }
            }}
          >
            <h2 id="rename-tab-title">Rename tab</h2>
            <label htmlFor="tab-name">Tab name</label>
            <input
              ref={renameInput}
              id="tab-name"
              value={renameTab.name}
              onChange={(event) => setRenameTab({ ...renameTab, name: event.target.value })}
            />
            <div className="modal-footer">
              <button type="button" className="quiet-button" onClick={() => setRenameTab(null)}>
                Cancel
              </button>
              <button type="submit" className="primary-button" disabled={!renameTab.name.trim()}>
                Save
              </button>
            </div>
          </form>
        </div>
      )}
      {confirmation && (
        <div className="modal-backdrop">
          <div
            ref={dialogRef}
            className="settings-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="close-title"
            onKeyDown={(event) => {
              if (event.key === 'Tab') {
                const buttons = Array.from(
                  dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ??
                    [],
                );
                const first = buttons[0];
                const last = buttons[buttons.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                  event.preventDefault();
                  last?.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                  event.preventDefault();
                  first?.focus();
                }
              }
              if (event.key === 'Escape' && !closing) {
                event.stopPropagation();
                setConfirmation(null);
              }
            }}
          >
            <h2 id="close-title">
              Close {confirmation.paneId ? 'session' : confirmation.tabId ? 'tab' : 'window'}?
            </h2>
            <p>Active shell jobs or assistant work will be stopped.</p>
            <div className="modal-footer">
              <button
                className="quiet-button"
                autoFocus
                disabled={closing}
                onClick={() => setConfirmation(null)}
              >
                Cancel
              </button>
              <button
                className="primary-button"
                disabled={closing}
                onClick={() => void close(confirmation, true)}
              >
                Close and stop work
              </button>
            </div>
          </div>
        </div>
      )}
      {(error || agent.error) && (
        <div className="error-toast" role="alert">
          <span>{error || agent.error}</span>
          <button
            className="icon-button"
            aria-label="Dismiss error"
            onClick={() => {
              setError('');
              agent.clearError();
            }}
          >
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}

interface SplitTabProps {
  tab: Tab;
  selected: boolean;
  macroTipsVisible: boolean;
  closing: boolean;
  handles: Map<string, WorkspaceHandle>;
  hotkeys: import('./hotkeys').Hotkeys;
  showStatusBar: boolean;
  spoofSshUserHost?: string;
  onSessionChange(paneId: string, session: TerminalInfo | null): void;
  onManualInput(sessionId: string, reason: 'typed' | 'interrupt'): void | Promise<void>;
  focusOnReady: boolean;
  onFocus(tabId: string, paneId: string): void;
  onClose(paneId: string): void;
  onResize(splitId: string, ratio: number): void;
}
function SplitTab({
  tab,
  selected,
  macroTipsVisible,
  handles,
  closing,
  onFocus,
  onClose,
  onResize,
  hotkeys,
  showStatusBar,
  spoofSshUserHost,
  onSessionChange,
  onManualInput,
  focusOnReady,
}: SplitTabProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const geometry = layoutRectangles(tab.layout);
  return (
    <div
      ref={containerRef}
      className="tab-panel split-layout"
      role="tabpanel"
      id={`panel-${tab.id}`}
      aria-labelledby={`tab-${tab.id}`}
      hidden={!selected}
    >
      {tab.panes.map((pane) => {
        const rectangle = geometry.panes.find((rectangle) => rectangle.id === pane.id)!;
        return (
          <section
            key={pane.id}
            className={`session-pane ${tab.panes.length === 1 ? 'single-pane' : ''} ${
              tab.focusedId === pane.id ? 'focused' : ''
            }`}
            aria-label={`Session ${pane.number}`}
            data-focused={tab.focusedId === pane.id}
            style={{
              left: `${rectangle.left}%`,
              top: `${rectangle.top}%`,
              width: `${rectangle.width}%`,
              height: `${rectangle.height}%`,
            }}
            onPointerDownCapture={() => onFocus(tab.id, pane.id)}
            onFocusCapture={() => onFocus(tab.id, pane.id)}
          >
            {/* Flat, stable pane elements preserve PTYs and conversations when the split tree changes. */}
            <TabWorkspace
              tabId={pane.id}
              sourceSessionId={pane.sourceSessionId}
              active={selected && tab.focusedId === pane.id}
              macroTipsVisible={macroTipsVisible}
              visible={selected}
              paneTitle={tab.panes.length > 1 ? `Session ${pane.number}` : undefined}
              onClosePane={() => onClose(pane.id)}
              closing={closing}
              hotkeys={hotkeys}
              showStatusBar={showStatusBar}
              spoofSshUserHost={spoofSshUserHost}
              onSessionChange={onSessionChange}
              onManualInput={onManualInput}
              focusOnReady={focusOnReady}
              ref={(handle) => {
                if (handle) handles.set(pane.id, handle);
                else handles.delete(pane.id);
              }}
            />
          </section>
        );
      })}
      {geometry.dividers.map((divider) => (
        <SplitDivider
          key={divider.id}
          divider={divider}
          containerRef={containerRef}
          onResize={onResize}
        />
      ))}
    </div>
  );
}
