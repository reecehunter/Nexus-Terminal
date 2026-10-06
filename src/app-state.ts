import type { SavedChat } from './chat-history';
import type { PaneLayout } from './pane-layout';

export interface PersistedPane {
  id: string;
  number: number;
}

export interface PersistedTab {
  id: string;
  number: number;
  name?: string;
  panes: PersistedPane[];
  layout: PaneLayout;
  focusedId: string;
}

export interface PersistedAppState {
  tabs: PersistedTab[];
  activeId: string;
  chatOpen: boolean;
  chatWidth: number;
  settingsOpen: boolean;
  settingsTabVisible: boolean;
  chat: SavedChat | null;
}

const storageKey = 'nexus.app-state.v1';

function validLayout(layout: unknown, paneIds: Set<string>): layout is PaneLayout {
  if (!layout || typeof layout !== 'object') return false;
  const node = layout as Record<string, unknown>;
  if (typeof node.id !== 'string') return false;
  if (node.kind === 'pane') return paneIds.has(node.id);
  if (node.kind !== 'split' || !['columns', 'rows'].includes(String(node.direction))) return false;
  return (
    typeof node.ratio === 'number' &&
    Number.isFinite(node.ratio) &&
    node.ratio >= 0.15 &&
    node.ratio <= 0.85 &&
    validLayout(node.first, paneIds) &&
    validLayout(node.second, paneIds)
  );
}

function validTab(value: unknown): value is PersistedTab {
  if (!value || typeof value !== 'object') return false;
  const tab = value as Record<string, unknown>;
  if (
    typeof tab.id !== 'string' ||
    typeof tab.number !== 'number' ||
    !Array.isArray(tab.panes) ||
    typeof tab.focusedId !== 'string'
  )
    return false;
  const panes = tab.panes as unknown[];
  if (!panes.length || panes.some((pane) => !pane || typeof pane !== 'object')) return false;
  const parsedPanes = panes as Record<string, unknown>[];
  if (parsedPanes.some((pane) => typeof pane.id !== 'string' || typeof pane.number !== 'number'))
    return false;
  const paneIds = new Set(parsedPanes.map((pane) => pane.id as string));
  return paneIds.has(tab.focusedId) && validLayout(tab.layout, paneIds);
}

export function loadAppState(): PersistedAppState | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    if (!value || typeof value !== 'object') return null;
    const state = value as Record<string, unknown>;
    if (
      !Array.isArray(state.tabs) ||
      !state.tabs.length ||
      state.tabs.some((tab) => !validTab(tab)) ||
      typeof state.activeId !== 'string' ||
      !state.tabs.some((tab) => (tab as PersistedTab).id === state.activeId) ||
      typeof state.chatOpen !== 'boolean' ||
      typeof state.chatWidth !== 'number' ||
      !Number.isFinite(state.chatWidth) ||
      typeof state.settingsOpen !== 'boolean' ||
      typeof state.settingsTabVisible !== 'boolean'
    )
      return null;
    return {
      tabs: state.tabs as PersistedTab[],
      activeId: state.activeId,
      chatOpen: state.chatOpen,
      chatWidth: Math.min(800, Math.max(300, state.chatWidth)),
      settingsOpen: state.settingsOpen,
      settingsTabVisible: state.settingsTabVisible,
      chat: state.chat && typeof state.chat === 'object' ? (state.chat as SavedChat) : null,
    };
  } catch {
    return null;
  }
}

export function saveAppState(state: PersistedAppState): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(state));
  } catch {
    // Persistence is best effort; the workspace must remain usable if storage is full/disabled.
  }
}
