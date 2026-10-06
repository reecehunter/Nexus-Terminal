import { beforeEach, describe, expect, it } from 'vitest';
import { loadAppState, saveAppState, type PersistedAppState } from './app-state';

const state: PersistedAppState = {
  tabs: [
    {
      id: 'tab-1',
      number: 1,
      panes: [{ id: 'pane-1', number: 1 }],
      layout: { kind: 'pane', id: 'pane-1' },
      focusedId: 'pane-1',
    },
  ],
  activeId: 'tab-1',
  chatOpen: true,
  chatWidth: 420,
  settingsOpen: false,
  settingsTabVisible: false,
  chat: null,
};

describe('app state persistence', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips the workspace shell', () => {
    saveAppState(state);
    expect(loadAppState()).toEqual(state);
  });

  it('rejects malformed layouts instead of breaking startup', () => {
    localStorage.setItem(
      'nexus.app-state.v1',
      JSON.stringify({ ...state, tabs: [{ ...state.tabs[0], focusedId: 'missing' }] }),
    );
    expect(loadAppState()).toBeNull();
  });

  it('clamps a restored chat width to the supported range', () => {
    saveAppState({ ...state, chatWidth: 2000 });
    expect(loadAppState()?.chatWidth).toBe(800);
  });
});
