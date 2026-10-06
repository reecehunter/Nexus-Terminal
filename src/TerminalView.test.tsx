import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalView, type TerminalHandle } from './TerminalView';
import { bridge } from './bridge';
import type { TerminalEvent, TerminalInfo } from './types';

const mocks = vi.hoisted(() => ({
  terminals: [] as {
    focus: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    dataHandler: (data: string) => void;
    flush(): void;
    pending: boolean;
  }[],
}));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    focus = vi.fn();
    dispose = vi.fn();
    write = vi.fn((_data, callback?: () => void) => callback?.());
    dataHandler = (_data: string) => {};
    pending = false;
    callbacks: (() => void)[] = [];
    buffer = {
      active: {
        baseY: 1,
        cursorX: 4,
        cursorY: 1,
        type: 'normal',
        getLine: (row: number) => ({
          translateToString: () => ['previous command', 'screen prompt', 'second row'][row] ?? '',
        }),
      },
    };
    cols = 80;
    rows = 24;
    constructor() {
      this.write.mockImplementation((_data, callback?: () => void) => {
        if (this.pending && callback) this.callbacks.push(callback);
        else callback?.();
      });
      mocks.terminals.push(this);
    }
    flush() {
      this.pending = false;
      this.callbacks.splice(0).forEach((callback) => callback());
    }
    loadAddon() {}
    open() {}
    attachCustomKeyEventHandler() {}
    onData(callback: (data: string) => void) {
      this.dataHandler = callback;
      return { dispose: vi.fn() };
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock('./bridge', () => ({
  desktopAvailable: () => true,
  errorMessage: String,
  bridge: {
    startTerminal: vi.fn(),
    stopTerminal: vi.fn().mockResolvedValue(undefined),
    resizeTerminal: vi.fn().mockResolvedValue(undefined),
    acknowledgeTerminal: vi.fn().mockResolvedValue(undefined),
    publishTerminalSnapshot: vi.fn().mockResolvedValue(undefined),
    terminalRevision: vi.fn().mockResolvedValue(9),
    writeTerminal: vi.fn().mockResolvedValue(undefined),
    interruptTerminal: vi.fn().mockResolvedValue(undefined),
  },
}));
beforeEach(() => {
  mocks.terminals.length = 0;
  vi.clearAllMocks();
  vi.mocked(bridge.publishTerminalSnapshot).mockResolvedValue(undefined);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.mocked(bridge.startTerminal).mockImplementation(async (tabId) => ({
    sessionId: tabId,
    home: '/tmp',
    shell: '/bin/zsh',
  }));
});

describe('rendered terminal snapshots', () => {
  it('publishes and acknowledges only after xterm parses output', async () => {
    render(<TerminalView {...props} />);
    await waitFor(() => expect(props.onSession).toHaveBeenCalledOnce());
    expect(bridge.publishTerminalSnapshot).not.toHaveBeenCalled();
    const receive = vi.mocked(bridge.startTerminal).mock.calls[0][2];
    const terminal = mocks.terminals[0];
    terminal.pending = true;
    act(() =>
      receive({ type: 'output', sessionId: 'first-tab', sequence: 7, revision: 8, data: [65] }),
    );
    expect(bridge.publishTerminalSnapshot).not.toHaveBeenCalled();
    expect(bridge.acknowledgeTerminal).not.toHaveBeenCalled();
    await act(async () => terminal.flush());
    expect(bridge.publishTerminalSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'first-tab',
        sequence: 7,
        revision: 8,
        screen: expect.stringContaining('screen prompt'),
        scrollback: 'previous command',
        cursorX: 4,
        cursorY: 1,
        columns: 80,
        rows: 24,
        alternate: false,
      }),
    );
    expect(bridge.acknowledgeTerminal).toHaveBeenCalledWith('first-tab', 7);
  });
  it('flushes fresh observations and refreshes same-sequence backend revisions', async () => {
    const ref = createRef<TerminalHandle>();
    render(<TerminalView {...props} ref={ref} />);
    await waitFor(() => expect(props.onSession).toHaveBeenCalledOnce());
    const receive = vi.mocked(bridge.startTerminal).mock.calls[0][2];
    await act(async () =>
      receive({ type: 'output', sessionId: 'first-tab', sequence: 1, revision: 1, data: [65] }),
    );
    await act(async () => ref.current!.publishSnapshot());
    expect(bridge.terminalRevision).toHaveBeenCalledWith('first-tab');
    expect(bridge.publishTerminalSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({ sequence: 1, revision: 9 }),
    );
    await act(async () => receive({ type: 'revision', sessionId: 'first-tab', revision: 9 }));
    expect(bridge.publishTerminalSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({ sequence: 1, revision: 9 }),
    );
  });
  it('republishes after resize with backend revision and rendered dimensions', async () => {
    const { container, rerender } = render(<TerminalView {...props} active={false} />);
    await waitFor(() => expect(props.onSession).toHaveBeenCalledOnce());
    await act(async () =>
      vi.mocked(bridge.startTerminal).mock.calls[0][2]({
        type: 'output',
        sessionId: 'first-tab',
        sequence: 1,
        revision: 1,
        data: [65],
      }),
    );
    const viewport = container.querySelector('.terminal-container')!;
    Object.defineProperties(viewport, {
      clientWidth: { value: 1000 },
      clientHeight: { value: 600 },
    });
    rerender(<TerminalView {...props} />);
    await waitFor(() => expect(bridge.resizeTerminal).toHaveBeenCalledWith('first-tab', 80, 24));
    await waitFor(() =>
      expect(bridge.publishTerminalSnapshot).toHaveBeenLastCalledWith(
        expect.objectContaining({ sequence: 1, revision: 9, columns: 80, rows: 24 }),
      ),
    );
  });
  it('notifies manual input before serializing keystrokes', async () => {
    render(<TerminalView {...props} />);
    await waitFor(() => expect(props.onSession).toHaveBeenCalledOnce());
    act(() => {
      mocks.terminals[0].dataHandler('λ');
      mocks.terminals[0].dataHandler('\r');
    });
    expect(props.onManualInput).toHaveBeenCalledWith('first-tab', 'typed');
    expect(bridge.writeTerminal).not.toHaveBeenCalled();
    await waitFor(() => expect(bridge.writeTerminal).toHaveBeenCalledTimes(2));
    expect(vi.mocked(bridge.writeTerminal).mock.calls).toEqual([
      ['first-tab', 'λ'],
      ['first-tab', '\r'],
    ]);
  });
  it('settles an in-flight parser flush when its terminal unmounts', async () => {
    const ref = createRef<TerminalHandle>();
    const { unmount } = render(<TerminalView {...props} ref={ref} />);
    await waitFor(() => expect(props.onSession).toHaveBeenCalledOnce());
    mocks.terminals[0].pending = true;
    const observation = ref.current!.publishSnapshot();
    // Let the snapshot reach the xterm parser barrier before disposing it.
    await act(async () => {});
    unmount();
    await expect(observation).rejects.toThrow('Terminal is no longer available.');
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const props = {
  tabId: 'first-tab',
  sourceSessionId: null,
  active: true,
  focusOnReady: true,
  onSession: vi.fn(),
  onError: vi.fn(),
  onManualInput: vi.fn(),
};

describe('terminal lifecycle', () => {
  it('starts independent terminals without letting the hidden tab steal focus', async () => {
    render(
      <>
        <TerminalView {...props} />
        <TerminalView
          {...props}
          tabId="second-tab"
          sourceSessionId="first-tab"
          active={false}
          focusOnReady={false}
        />
      </>,
    );
    await waitFor(() => expect(props.onSession).toHaveBeenCalledTimes(2));
    expect(bridge.startTerminal).toHaveBeenCalledWith(
      'second-tab',
      'first-tab',
      expect.any(Function),
    );
    expect(mocks.terminals[0].focus).toHaveBeenCalledOnce();
    expect(mocks.terminals[1].focus).not.toHaveBeenCalled();
    expect(bridge.resizeTerminal).not.toHaveBeenCalled(); // Zero-size hidden containers never resize the PTY.
  });
  it('stops a terminal whose startup completes after its view closes', async () => {
    let resolve!: (session: TerminalInfo) => void;
    vi.mocked(bridge.startTerminal).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { unmount } = render(<TerminalView {...props} />);
    const receive = vi.mocked(bridge.startTerminal).mock.calls[0][2];
    unmount();
    await act(async () => resolve({ sessionId: 'late-session', home: '/tmp', shell: '/bin/zsh' }));
    expect(bridge.stopTerminal).toHaveBeenCalledWith('late-session');
    expect(props.onSession).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'late-session' }),
    );
    receive({
      type: 'output',
      sessionId: 'late-session',
      sequence: 1,
      revision: 1,
      data: [65],
    } satisfies TerminalEvent);
    expect(mocks.terminals[0].write).not.toHaveBeenCalled();
    expect(mocks.terminals[0].focus).not.toHaveBeenCalled();
    expect(mocks.terminals[0].dispose).toHaveBeenCalledOnce();
  });
  it('keeps assistant focus when the shell finishes starting', async () => {
    let resolve!: (session: TerminalInfo) => void;
    vi.mocked(bridge.startTerminal).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { rerender } = render(<TerminalView {...props} />);
    rerender(<TerminalView {...props} focusOnReady={false} />);
    await act(async () => resolve({ sessionId: 'first-tab', home: '/tmp', shell: '/bin/zsh' }));
    expect(mocks.terminals[0].focus).not.toHaveBeenCalled();
    expect(bridge.startTerminal).toHaveBeenCalledOnce();
  });
});
