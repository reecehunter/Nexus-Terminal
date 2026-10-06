import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { FolderOpen, TerminalSquare, X } from 'lucide-react';
import { TerminalView, type TerminalHandle } from './TerminalView';
import { MacroTip } from './MacroTip';
import { defaultHotkeys, formatHotkey, type Hotkeys } from './hotkeys';
import type { TerminalInfo } from './types';

export interface WorkspaceHandle {
  sessionId(): string | null;
  dispose(): void;
  focus(): void;
  observe(): Promise<void>;
}
interface Props {
  tabId: string;
  sourceSessionId: string | null;
  active: boolean;
  focusOnReady: boolean;
  visible: boolean;
  paneTitle?: string;
  macroTipsVisible: boolean;
  closing: boolean;
  hotkeys: Hotkeys;
  showStatusBar: boolean;
  onClosePane(): void;
  onSessionChange(paneId: string, session: TerminalInfo | null): void;
  onManualInput(sessionId: string, reason: 'typed' | 'interrupt'): void | Promise<void>;
}
export const TabWorkspace = forwardRef<WorkspaceHandle, Props>(function TabWorkspace(
  {
    tabId,
    sourceSessionId,
    active,
    focusOnReady,
    visible,
    paneTitle,
    macroTipsVisible,
    closing,
    hotkeys,
    showStatusBar,
    onClosePane,
    onSessionChange,
    onManualInput,
  },
  ref,
) {
  const terminal = useRef<TerminalHandle>(null);
  const [session, setSession] = useState<TerminalInfo | null>(null);
  const [error, setError] = useState('');
  const onSession = useCallback(
    (next: TerminalInfo | null) => {
      setSession(next);
      onSessionChange(tabId, next);
    },
    [tabId, onSessionChange],
  );
  useEffect(() => {
    if (active) terminal.current?.focus();
  }, [active]);
  useImperativeHandle(ref, () => ({
    sessionId: () => session?.sessionId ?? null,
    dispose: () => onSession(null),
    focus: () => terminal.current?.focus(),
    observe: () => terminal.current?.publishSnapshot() ?? Promise.resolve(),
  }));
  const closeBinding = hotkeys['close-pane'] ?? defaultHotkeys()['close-pane'];
  return (
    <div className="app-shell tab-workspace" hidden={!visible}>
      {paneTitle && (
        <header className="app-header app-header-actions">
          <button
            className="icon-button"
            aria-label={`Close ${paneTitle}`}
            title={`Close session · ${formatHotkey(closeBinding)}`}
            disabled={closing}
            onClick={onClosePane}
          >
            <X size={14} />
            {macroTipsVisible && closeBinding && (
              <MacroTip>{formatHotkey(closeBinding).replace(/^⌘/, '⌘+')}</MacroTip>
            )}
          </button>
        </header>
      )}
      <main className="workspace">
        <TerminalView
          ref={terminal}
          tabId={tabId}
          sourceSessionId={sourceSessionId}
          active={visible}
          focusOnReady={active && focusOnReady}
          onSession={onSession}
          onError={setError}
          onManualInput={onManualInput}
        />
      </main>
      {error && (
        <div className="error-toast" role="alert">
          <span>{error}</span>
          <button
            className="icon-button"
            aria-label="Dismiss terminal error"
            onClick={() => setError('')}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {showStatusBar && (
        <footer className="app-status" aria-label="Nexus status">
          <div className="app-status-identity">
            <TerminalSquare size={11} />
            <span>Nexus</span>
            <span className="app-version">0.1</span>
          </div>
          <div className="app-status-directory">
            <FolderOpen size={11} />
            <span title={session?.home ?? 'Local shell'}>{session?.home ?? 'Local shell'}</span>
          </div>
        </footer>
      )}
    </div>
  );
});
