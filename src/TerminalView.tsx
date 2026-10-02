import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { RotateCcw, TerminalSquare, Square } from 'lucide-react';
import { terminalSnapshot } from './terminal-snapshot';
import { bridge, desktopAvailable, errorMessage } from './bridge';
import { boundedTerminalText } from './chat-state';
import type { TerminalInfo } from './types';
import '@xterm/xterm/css/xterm.css';
import { terminalTheme, useTheme } from './theme';

export interface TerminalHandle {
  focus(): void;
  capture(): string;
  restart(): void;
  publishSnapshot(): Promise<void>;
}
interface Props {
  tabId: string;
  sourceSessionId: string | null;
  active: boolean;
  focusOnReady: boolean;
  onSession(session: TerminalInfo | null): void;
  onError(message: string): void;
  onManualInput(sessionId: string, reason: 'typed' | 'interrupt'): void | Promise<void>;
}

export const TerminalView = forwardRef<TerminalHandle, Props>(function TerminalView(
  { onSession, onError, onManualInput, tabId, sourceSessionId, active, focusOnReady },
  ref,
) {
  const { theme } = useTheme();
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const container = useRef<HTMLDivElement>(null);
  const focusOnReadyRef = useRef(focusOnReady);
  focusOnReadyRef.current = focusOnReady;
  const resizeRef = useRef<(() => void) | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const publishRef = useRef<(() => Promise<void>) | null>(null);
  const sessionRef = useRef<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const [exited, setExited] = useState<number | null>(null);
  const callbacks = useRef({ onSession, onError, onManualInput });
  callbacks.current = { onSession, onError, onManualInput };

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.theme = terminalTheme(theme);
    terminal.options.fontFamily = theme.fontFamily;
    terminal.options.fontSize = theme.fontSize;
    terminal.options.lineHeight = theme.lineHeight;
    terminal.options.cursorStyle = theme.cursorStyle;
    terminal.options.cursorBlink = theme.cursorBlink;
    resizeRef.current?.();
  }, [theme]);

  useImperativeHandle(ref, () => ({
    focus: () => terminalRef.current?.focus(),
    restart: () => setGeneration((value) => value + 1),
    publishSnapshot: () =>
      publishRef.current?.() ?? Promise.reject(new Error('Terminal is not ready.')),
    capture: () => {
      const terminal = terminalRef.current;
      if (!terminal) return '';
      const lines: string[] = [];
      const buffer = terminal.buffer.active;
      for (let index = Math.max(0, buffer.length - 200); index < buffer.length; index++) {
        lines.push(buffer.getLine(index)?.translateToString(true) ?? '');
      }
      return boundedTerminalText(lines);
    },
  }));

  useEffect(() => {
    if (!container.current || !desktopAvailable()) return;
    let disposed = false;
    let sessionId: string | null = null;
    let inputQueue = Promise.resolve();
    let publishQueue = Promise.resolve();
    let parsedSequence = 0;
    let parsedRevision = 0;
    const pendingFlushes = new Set<(error: Error) => void>();
    setExited(null);
    const terminal = new Terminal({
      fontFamily: themeRef.current.fontFamily,
      fontSize: themeRef.current.fontSize,
      lineHeight: themeRef.current.lineHeight,
      cursorBlink: themeRef.current.cursorBlink,
      cursorStyle: themeRef.current.cursorStyle,
      scrollback: 5000,
      allowProposedApi: false,
      theme: terminalTheme(themeRef.current),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container.current);
    terminalRef.current = terminal;
    const publish = () => {
      if (disposed || !sessionId || !parsedSequence) return Promise.resolve();
      let snapshot;
      try {
        snapshot = terminalSnapshot(terminal, sessionId, parsedSequence, parsedRevision);
      } catch (error) {
        return Promise.reject(error);
      }
      publishQueue = publishQueue
        .catch(() => {})
        .then(() => {
          if (!disposed) return bridge.publishTerminalSnapshot(snapshot);
        });
      return publishQueue;
    };
    const refreshSnapshot = async () => {
      await inputQueue;
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; ++attempt) {
        if (disposed || !sessionId) throw new Error('Terminal is no longer available.');
        // An empty write callback is a barrier behind every currently queued xterm parse.
        await new Promise<void>((resolve, reject) => {
          pendingFlushes.add(reject);
          terminal.write('', () => {
            pendingFlushes.delete(reject);
            resolve();
          });
        });
        if (!parsedSequence) throw new Error('Waiting for the terminal’s first rendered output.');
        parsedRevision = Math.max(parsedRevision, await bridge.terminalRevision(sessionId));
        if (disposed) throw new Error('Terminal is no longer available.');
        try {
          await publish();
          return;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    };
    publishRef.current = refreshSnapshot;
    const resize = () => {
      if (disposed || !container.current?.clientWidth || !container.current.clientHeight) return;
      try {
        fit.fit();
        if (sessionId)
          void bridge
            .resizeTerminal(sessionId, terminal.cols, terminal.rows)
            .then(() => (parsedSequence ? refreshSnapshot() : undefined))
            .catch((error) => callbacks.current.onError(errorMessage(error)));
      } catch (error) {
        callbacks.current.onError(errorMessage(error));
      }
    };
    resizeRef.current = resize;
    const observer = new ResizeObserver(resize);
    observer.observe(container.current);
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.metaKey && event.key.toLowerCase() === 'c' && terminal.hasSelection()) {
        if (event.type === 'keydown')
          void navigator.clipboard
            .writeText(terminal.getSelection())
            .catch((error) => callbacks.current.onError(errorMessage(error)));
        return false;
      }
      return true;
    });
    const subscription = terminal.onData((data) => {
      if (!sessionId) return;
      const id = sessionId;
      const manualInput = Promise.resolve(callbacks.current.onManualInput(id, 'typed'));
      // Serialize writes so rapid typing and paste cannot arrive out of order.
      inputQueue = inputQueue
        .then(async () => {
          if (disposed) return;
          await manualInput;
          await bridge.writeTerminal(id, data);
        })
        .catch((error) => callbacks.current.onError(errorMessage(error)));
      void inputQueue.then(() => refreshSnapshot()).catch(() => {});
    });
    void bridge
      .startTerminal(tabId, sourceSessionId, (event) => {
        if (disposed) return;
        if (sessionId && event.sessionId !== sessionId) return;
        if (event.type === 'output') {
          terminal.write(new Uint8Array(event.data), () => {
            if (disposed) return;
            parsedSequence = event.sequence;
            parsedRevision = Math.max(parsedRevision, event.revision);
            // Earlier snapshots may be rejected while a newer output is awaiting parsing.
            void publish().catch(() => {});
            void bridge.acknowledgeTerminal(event.sessionId, event.sequence).catch(() => {});
          });
        } else if (event.type === 'revision') {
          parsedRevision = Math.max(parsedRevision, event.revision);
          void refreshSnapshot().catch(() => {});
        } else if (event.type === 'exit') {
          setExited(event.code);
          sessionRef.current = null;
          callbacks.current.onSession(null);
        } else callbacks.current.onError(event.message);
      })
      .then((info) => {
        sessionId = info.sessionId;
        sessionRef.current = info.sessionId;
        if (disposed) {
          void bridge.stopTerminal(info.sessionId).catch(() => {});
          return;
        }
        callbacks.current.onSession(info);
        resize();
        void publish().catch(() => {});
        if (focusOnReadyRef.current) terminal.focus();
      })
      .catch((error) => {
        if (!disposed) callbacks.current.onError(errorMessage(error));
      });
    resize();
    return () => {
      disposed = true;
      pendingFlushes.forEach((reject) => reject(new Error('Terminal is no longer available.')));
      pendingFlushes.clear();
      subscription.dispose();
      observer.disconnect();
      terminal.dispose();
      terminalRef.current = null;
      resizeRef.current = null;
      publishRef.current = null;
      sessionRef.current = null;
      callbacks.current.onSession(null);
      if (sessionId) void bridge.stopTerminal(sessionId).catch(() => {});
    };
  }, [generation, tabId, sourceSessionId]);

  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => resizeRef.current?.());
    return () => cancelAnimationFrame(frame);
  }, [active]);

  return (
    <section className="terminal-pane" aria-label="Terminal">
      <div className="terminal-container" ref={container} />
      {desktopAvailable() && exited === null && (
        <button
          className="terminal-interrupt icon-button"
          aria-label="Interrupt terminal"
          title="Interrupt terminal (Ctrl+C)"
          onClick={() => {
            const sessionId = sessionRef.current;
            if (!sessionId) return;
            callbacks.current.onManualInput(sessionId, 'interrupt');
            void bridge
              .interruptTerminal(sessionId)
              .then(() => publishRef.current?.())
              .catch((error) => callbacks.current.onError(errorMessage(error)));
          }}
        >
          <Square size={12} />
        </button>
      )}
      {!desktopAvailable() && (
        <div className="terminal-placeholder">
          <TerminalSquare size={32} strokeWidth={1.3} />
          <h2>Ready for your shell</h2>
          <p>Launch the desktop app to connect a real zsh terminal.</p>
          <code>npm run app:dev</code>
        </div>
      )}
      {exited !== null && (
        <div className="terminal-exited">
          <span>Shell exited · {exited}</span>
          <button onClick={() => setGeneration((value) => value + 1)}>
            <RotateCcw size={13} /> Restart terminal
          </button>
        </div>
      )}
    </section>
  );
});
