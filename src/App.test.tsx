import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { bridge } from './bridge';
import type { ChatEvent, ChatInput } from './types';

const mocks = vi.hoisted(() => ({
  focusTerminal: vi.fn(),
  capture: vi.fn(() => 'Last command failed'),
  observe: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./bridge', () => ({
  desktopAvailable: () => true,
  errorMessage: String,
  bridge: {
    setHotkeysEditing: vi.fn().mockResolvedValue(undefined),
    listen: vi.fn().mockResolvedValue(() => {}),
    newWindow: vi.fn().mockResolvedValue(undefined),
    closeWorkspace: vi.fn().mockResolvedValue(true),
    closeWorkspaces: vi.fn().mockResolvedValue(true),
    listModels: vi.fn().mockResolvedValue([{ id: 'test-model', ownedBy: 'openai' }]),
    saveModel: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({ model: 'test-model', hasApiKey: true }),
    prepareContext: vi.fn().mockResolvedValue({
      directory: '/tmp/project',
      listing: { path: '/tmp/project', entries: [], truncated: false },
    }),
    startChat: vi.fn().mockResolvedValue(undefined),
    cancelChat: vi.fn().mockResolvedValue(undefined),
    waitingForUserInput: vi.fn().mockResolvedValue(false),
    clearChat: vi.fn().mockResolvedValue(undefined),
    setChatMode: vi.fn().mockResolvedValue(undefined),
    chooseDirectory: vi.fn(),
  },
}));
vi.mock('./TerminalView', async () => {
  const { forwardRef, useEffect, useImperativeHandle } = await import('react');
  return {
    TerminalView: forwardRef(function MockTerminal(
      {
        onSession,
        tabId,
        sourceSessionId,
        onManualInput,
      }: {
        onSession(session: unknown): void;
        tabId: string;
        sourceSessionId: string | null;
        onManualInput(sessionId: string, reason: 'typed' | 'interrupt'): void;
      },
      ref,
    ) {
      useImperativeHandle(ref, () => ({
        focus: mocks.focusTerminal,
        capture: mocks.capture,
        publishSnapshot: mocks.observe,
      }));
      useEffect(() => {
        onSession({ sessionId: tabId, home: '/tmp', shell: '/bin/zsh' });
      }, [onSession]);
      return (
        <div aria-label="Mock terminal" data-session={tabId} data-source={sourceSessionId}>
          <button aria-label={`Type in ${tabId}`} onClick={() => onManualInput(tabId, 'typed')}>
            Type
          </button>
          <button
            aria-label={`Restart ${tabId}`}
            onClick={() => {
              onSession(null);
              onSession({ sessionId: `${tabId}-restarted`, home: '/tmp', shell: '/bin/zsh' });
            }}
          >
            Restart
          </button>
        </div>
      );
    }),
  };
});
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.observe.mockResolvedValue(undefined);
  vi.mocked(bridge.setChatMode).mockResolvedValue(undefined);
  vi.mocked(bridge.closeWorkspaces).mockImplementation(
    async (_ids, confirmed, busy) => confirmed || !busy,
  );
  vi.mocked(bridge.prepareContext).mockResolvedValue({
    directory: '/tmp/project',
    listing: { path: '/tmp/project', entries: [], truncated: false },
  });
  vi.mocked(bridge.startChat).mockResolvedValue(undefined);
  vi.mocked(bridge.closeWorkspace).mockImplementation(
    async (_id, confirmed, busy) => confirmed || !busy,
  );
});
afterEach(cleanup);

async function openChat() {
  render(<App />);
  expect(screen.queryByRole('complementary', { name: 'AI chat' })).toBeNull();
  await act(async () => {
    fireEvent.keyDown(window, { key: 'j', metaKey: true });
  });
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Select terminals/ })).toBeTruthy(),
  );
  await waitFor(() => expect(screen.queryByText('Updating permissions…')).toBeNull());
}

describe('desktop chat integration', () => {
  it('reverses a closing slide without resetting or unmounting the chat', async () => {
    await openChat();
    const panel = screen.getByRole('complementary', { name: 'AI chat' });
    await waitFor(() => expect(panel.classList.contains('chat-panel-open')).toBe(true));
    vi.useFakeTimers();
    try {
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(panel.classList.contains('chat-panel-closing')).toBe(true);
      expect(panel.parentElement?.hasAttribute('inert')).toBe(true);

      fireEvent.keyDown(window, { key: 'j', metaKey: true });
      expect(panel.classList.contains('chat-panel-open')).toBe(true);
      expect(panel.parentElement?.hasAttribute('inert')).toBe(false);
      act(() => vi.advanceTimersByTime(200));
      expect(screen.getByRole('complementary', { name: 'AI chat' })).toBe(panel);

      fireEvent.keyDown(window, { key: 'Escape' });
      act(() => vi.advanceTimersByTime(200));
      expect(panel.isConnected).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  async function submit(text = 'Inspect the attached terminal') {
    const input = screen.getByRole('textbox', { name: 'Ask the assistant' });
    fireEvent.change(input, { target: { value: text } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(bridge.startChat).toHaveBeenCalledOnce());
    return vi.mocked(bridge.startChat).mock.calls[0];
  }
  it('uses the requested permission labels and waits for mode confirmation before sending', async () => {
    await openChat();
    for (const name of ['Ask for approval', 'Approve for me', 'Full access'])
      expect(screen.getByRole('option', { name })).toBeTruthy();
    let resolveMode!: () => void;
    vi.mocked(bridge.setChatMode).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveMode = resolve;
        }),
    );
    fireEvent.change(screen.getByRole('combobox', { name: 'Assistant mode' }), {
      target: { value: 'full' },
    });
    const input = screen.getByRole('textbox', { name: 'Ask the assistant' });
    fireEvent.change(input, { target: { value: 'Do work' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(bridge.setChatMode).toHaveBeenLastCalledWith('full'));
    expect(bridge.startChat).not.toHaveBeenCalled();
    await act(async () => resolveMode());
    await waitFor(() => expect(bridge.startChat).toHaveBeenCalledOnce());
  });
  it('pauses for manual input and resumes with a fresh request and fresh observations', async () => {
    await openChat();
    const [first, receive] = await submit();
    fireEvent.click(
      screen.getByRole('button', { name: `Type in ${first.attachments[0].sessionId}` }),
    );
    await waitFor(() => expect(bridge.cancelChat).toHaveBeenCalledWith(first.requestId));
    expect(screen.getByText(/Paused because you typed/)).toBeTruthy();
    act(() => receive({ ...first, type: 'textDelta', messageId: 'late', delta: 'Stale output' }));
    expect(screen.queryByText('Stale output')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Resume / Continue' }));
    await waitFor(() => expect(bridge.startChat).toHaveBeenCalledTimes(2));
    const second = vi.mocked(bridge.startChat).mock.calls[1][0];
    expect(second.requestId).not.toBe(first.requestId);
    expect(second.conversationId).toBe(first.conversationId);
    expect(mocks.observe).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Paused because you typed/)).toBeNull();
  });
  it('enables Resume for a backend pause and invalidates pending approvals', async () => {
    await openChat();
    const [request, receive] = await submit();
    act(() => {
      receive({
        ...request,
        type: 'tool',
        toolId: 'approval',
        name: 'execute_terminal',
        arguments: {
          sessionId: request.attachments[0].sessionId,
          targetLabel: 'SSH session',
          purpose: 'Check remote status',
          approvalReason: 'Writes to a remote shell',
          command: 'pwd',
        },
        status: 'approval',
        approvalId: 'approve',
        directory: null,
        result: null,
      });
    });
    expect(screen.getByText('Execute terminal · SSH session')).toBeTruthy();
    expect(screen.getByText('Check remote status')).toBeTruthy();
    expect(screen.getByText('Writes to a remote shell')).toBeTruthy();
    act(() => receive({ ...request, type: 'paused', label: 'You interrupted the session.' }));
    expect(screen.queryByRole('button', { name: 'Approve input' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Resume / Continue' })).toBeTruthy();
  });
  it.each([false, true])(
    'requires explicit reattachment after restart (custom selection: %s)',
    async (custom) => {
      await openChat();
      if (custom) {
        fireEvent.click(screen.getByRole('button', { name: /Select terminals/ }));
        fireEvent.click(screen.getByRole('checkbox', { name: 'T1S1' }));
        fireEvent.click(screen.getByRole('checkbox', { name: 'T1S1' }));
      }
      const [request] = await submit();
      fireEvent.click(
        screen.getByRole('button', { name: `Restart ${request.attachments[0].sessionId}` }),
      );
      await waitFor(() => expect(bridge.cancelChat).toHaveBeenCalledWith(request.requestId));
      expect(screen.getByText('ATTACHED TERMINALS')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Send question' }).hasAttribute('disabled')).toBe(
        true,
      );
      if (!custom) fireEvent.click(screen.getByRole('button', { name: /Select terminals/ }));
      const checkbox = screen.getByRole('checkbox', {
        name: 'T1S1',
      }) as HTMLInputElement;
      expect(checkbox.checked).toBe(false);
      fireEvent.click(checkbox);
      const input = screen.getByRole('textbox', { name: 'Ask the assistant' });
      fireEvent.change(input, { target: { value: 'Use the replacement session' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(bridge.startChat).toHaveBeenCalledTimes(2));
      expect(vi.mocked(bridge.startChat).mock.calls[1][0].attachments[0].sessionId).toBe(
        `${request.attachments[0].sessionId}-restarted`,
      );
    },
  );
  it('attaches an explicit LOCAL directory and allows local-only requests', async () => {
    await openChat();
    vi.mocked(bridge.chooseDirectory).mockResolvedValueOnce('/tmp/project');
    fireEvent.click(screen.getByRole('button', { name: 'Attach LOCAL directory' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'LOCAL: /tmp/project' })).toBeTruthy(),
    );
    expect(bridge.prepareContext).toHaveBeenCalledWith(expect.any(String), '/tmp/project');
    fireEvent.click(screen.getByRole('button', { name: /Select terminals/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'T1S1' }));
    const [request] = await submit('Run a LOCAL command');
    expect(request.directory).toBe('/tmp/project');
    expect(request.attachments).toEqual([]);
    expect(mocks.observe).not.toHaveBeenCalled();
  });
  it('keeps active work running while applying backend permissions', async () => {
    await openChat();
    const [request] = await submit();
    fireEvent.change(screen.getByRole('combobox', { name: 'Assistant mode' }), {
      target: { value: 'auto' },
    });
    await waitFor(() => expect(bridge.setChatMode).toHaveBeenLastCalledWith('auto'));
    expect(bridge.cancelChat).not.toHaveBeenCalledWith(request.requestId);
  });
  it('new chat restores follow focus after an empty custom selection', async () => {
    await openChat();
    fireEvent.click(screen.getByRole('button', { name: /Select terminals/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'T1S1' }));
    expect(screen.getByText('ATTACHED TERMINALS')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    await waitFor(() => expect(bridge.clearChat).toHaveBeenCalledWith());
    expect(screen.getByText('FOLLOWING FOCUSED TERMINAL')).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: 'T1S1' }) as HTMLInputElement).checked).toBe(true);
  });
  it('toggles with Cmd+J and Escape and streams only the active request', async () => {
    await openChat();
    const input = screen.getByRole('textbox', { name: 'Ask the assistant' });
    fireEvent.change(input, { target: { value: 'Explain this failure' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(bridge.startChat).toHaveBeenCalledOnce());
    const [request, receive] = vi.mocked(bridge.startChat).mock.calls[0] as [
      ChatInput,
      (event: ChatEvent) => void,
    ];
    expect(request.directory).toBeNull();
    expect(request.terminalText).toBeNull();
    expect(request.sessionId).toBe('window');
    expect(request.attachments).toHaveLength(1);
    const metadata = {
      requestId: request.requestId,
      sessionId: request.sessionId,
      conversationId: request.conversationId,
    };
    act(() =>
      receive({
        ...metadata,
        type: 'textDelta',
        messageId: 'answer',
        delta: 'The command failed.',
      }),
    );
    expect(screen.getByText('The command failed.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stop response' }));
    await waitFor(() => expect(bridge.cancelChat).toHaveBeenCalledWith(request.requestId));
    act(() =>
      receive({ ...metadata, type: 'textDelta', messageId: 'answer', delta: ' Late output' }),
    );
    expect(screen.queryByText(/Late output/)).toBeNull();
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(screen.queryByRole('complementary', { name: 'AI chat' })).toBeNull();
  });

  it('lets custom selection include sessions across tabs and persists it across focus changes', async () => {
    await openChat();
    const firstSession = within(screen.getByRole('tabpanel'))
      .getByLabelText('Mock terminal')
      .getAttribute('data-session');
    shortcut('t');
    const secondSession = within(screen.getByRole('tabpanel'))
      .getByLabelText('Mock terminal')
      .getAttribute('data-session');
    fireEvent.click(screen.getByRole('button', { name: /Select terminals/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'T1S1' }));
    shortcut('1');
    const input = screen.getByRole('textbox', { name: 'Ask the assistant' });
    fireEvent.change(input, { target: { value: 'Compare these sessions' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(bridge.startChat).toHaveBeenCalledOnce());
    expect(
      vi.mocked(bridge.startChat).mock.calls[0][0].attachments.map((item) => item.sessionId),
    ).toEqual([firstSession, secondSession]);
    expect(mocks.observe).toHaveBeenCalledTimes(2);
  });

  it('stopping during snapshot capture prevents a question from starting later', async () => {
    await openChat();
    let resolve!: () => void;
    mocks.observe.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const input = screen.getByRole('textbox', { name: 'Ask the assistant' });
    fireEvent.change(input, { target: { value: 'Inspect terminal' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(mocks.observe).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: 'Stop response' }));
    await act(async () => resolve());
    expect(bridge.startChat).not.toHaveBeenCalled();
  });
});

function selectedPanel() {
  return within(document.body);
}
function shortcut(key: string, shiftKey = false) {
  fireEvent.keyDown(window, { key, metaKey: true, shiftKey });
}

describe('terminal tabs and windows', () => {
  it('reveals configurable macro tips after holding Command for one second', async () => {
    vi.useFakeTimers();
    render(<App />);
    fireEvent.keyDown(window, { key: 'Meta', metaKey: true });
    expect(screen.queryByText('⌘+1')).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText('⌘+1')).toBeTruthy();

    fireEvent.keyUp(window, { key: 'Meta' });
    expect(screen.queryByText('⌘+1')).toBeNull();
    vi.useRealTimers();
  });

  it('preserves drafts and terminal instances and inherits the source session', async () => {
    await openChat();
    const firstPanel = screen.getByRole('tabpanel');
    const firstSession = selectedPanel()
      .getByLabelText('Mock terminal')
      .getAttribute('data-session');
    fireEvent.change(selectedPanel().getByRole('textbox', { name: 'Ask the assistant' }), {
      target: { value: 'Unsent question' },
    });
    shortcut('t');
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(
      within(screen.getByRole('tabpanel'))
        .getByLabelText('Mock terminal')
        .getAttribute('data-source'),
    ).toBe(firstSession);
    expect(screen.getByRole('tabpanel')).not.toBe(firstPanel);
    shortcut('1');
    expect(screen.getByRole('tabpanel')).toBe(firstPanel);
    expect(
      (selectedPanel().getByRole('textbox', { name: 'Ask the assistant' }) as HTMLTextAreaElement)
        .value,
    ).toBe('Unsent question');
    shortcut('2');
    expect(screen.getByRole('tabpanel')).not.toBe(firstPanel);
  });

  it('keeps one conversation across tabs and cancels when follow-focus attachments change', async () => {
    await openChat();
    const input = screen.getByRole('textbox', { name: 'Ask the assistant' });
    fireEvent.change(input, { target: { value: 'First question' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(bridge.startChat).toHaveBeenCalledOnce());
    const [first, receiveFirst] = vi.mocked(bridge.startChat).mock.calls[0];
    shortcut('t');
    await waitFor(() => expect(bridge.cancelChat).toHaveBeenCalledWith(first.requestId));
    expect(screen.getAllByRole('complementary', { name: 'AI chat' })).toHaveLength(1);
    expect(screen.getByText('First question')).toBeTruthy();
    act(() =>
      receiveFirst({ ...first, type: 'textDelta', messageId: 'old', delta: 'Late old response' }),
    );
    expect(screen.queryByText('Late old response')).toBeNull();
    fireEvent.change(input, { target: { value: 'Second question' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(bridge.startChat).toHaveBeenCalledTimes(2));
    const second = vi.mocked(bridge.startChat).mock.calls[1][0];
    expect(second.conversationId).toBe(first.conversationId);
    expect(second.sessionId).toBe('window');
    expect(second.attachments).not.toEqual(first.attachments);
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    await waitFor(() => expect(bridge.clearChat).toHaveBeenCalledWith());
    expect(screen.getByText('FOLLOWING FOCUSED TERMINAL')).toBeTruthy();
  });

  it('closes an idle tab, selects its neighbor, and closes the window for the last tab', async () => {
    render(<App />);
    shortcut('t');
    shortcut('w');
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(1));
    expect(screen.getByRole('tab', { selected: true }).textContent).toBe('Terminal 1');
    expect(vi.mocked(bridge.closeWorkspace).mock.calls[0][0]).not.toBeNull();
    shortcut('w');
    await waitFor(() => expect(bridge.closeWorkspace).toHaveBeenLastCalledWith(null, false, false));
  });

  it('confirms attached active work and Cancel preserves the ongoing request', async () => {
    await openChat();
    shortcut('t');
    fireEvent.click(screen.getByRole('button', { name: /Select terminals/ }));
    // Removing the focused terminal and attaching Terminal 1 pins selection across tabs.
    fireEvent.click(screen.getByRole('checkbox', { name: 'T2S2' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'T1S1' }));
    const input = screen.getByRole('textbox', { name: 'Ask the assistant' });
    fireEvent.change(input, { target: { value: 'Inspect first terminal' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(bridge.startChat).toHaveBeenCalledOnce());
    const first = vi.mocked(bridge.startChat).mock.calls[0][0];
    fireEvent.click(screen.getByRole('button', { name: 'Close Terminal 1' }));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(bridge.cancelChat).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close Terminal 1' }));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Close and stop work' }));
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(1));
    expect(bridge.closeWorkspace).toHaveBeenLastCalledWith(
      first.attachments[0].sessionId,
      true,
      true,
    );
    expect(bridge.cancelChat).toHaveBeenCalledWith(first.requestId);
  });

  it('a failed mode update prevents terminal requests', async () => {
    await openChat();
    vi.mocked(bridge.setChatMode).mockRejectedValueOnce(new Error('Mode update failed'));
    fireEvent.change(screen.getByRole('combobox', { name: 'Assistant mode' }), {
      target: { value: 'full' },
    });
    await waitFor(() => expect(screen.getByText(/Mode update failed/)).toBeTruthy());
    expect(
      (screen.getByRole('combobox', { name: 'Assistant mode' }) as HTMLSelectElement).value,
    ).toBe('ask');
    const input = screen.getByRole('textbox', { name: 'Ask the assistant' });
    fireEvent.change(input, { target: { value: 'Do work' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await act(async () => {});
    expect(bridge.startChat).not.toHaveBeenCalled();
  });

  it('creates windows with the active session and routes native close requests', async () => {
    render(<App />);
    const session = selectedPanel().getByLabelText('Mock terminal').getAttribute('data-session');
    const nativeAction = vi
      .mocked(bridge.listen)
      .mock.calls.find(([event]) => event === 'workspace-action')![1];
    await act(async () => nativeAction('new-window'));
    await waitFor(() => expect(bridge.newWindow).toHaveBeenCalledWith(session));
    shortcut('n');
    await waitFor(() => expect(bridge.newWindow).toHaveBeenCalledTimes(2));
    const listener = vi
      .mocked(bridge.listen)
      .mock.calls.find(([event]) => event === 'workspace-action')![1];
    await act(async () => listener('close-window'));
    expect(bridge.closeWorkspace).toHaveBeenCalledWith(null, false, false);
    shortcut('w', true);
    await waitFor(() => expect(bridge.closeWorkspace).toHaveBeenCalledTimes(2));
  });

  it('broadcasts settings to existing tabs', async () => {
    await openChat();
    shortcut('t');
    const callbacks = vi
      .mocked(bridge.listen)
      .mock.calls.filter(([event]) => event === 'settings-changed');
    act(() =>
      callbacks.forEach(([, callback]) => callback({ model: 'updated-model', hasApiKey: true })),
    );
    expect((selectedPanel().getByLabelText('Assistant model') as HTMLSelectElement).value).toBe(
      'updated-model',
    );
    shortcut('1');
    expect((selectedPanel().getByLabelText('Assistant model') as HTMLSelectElement).value).toBe(
      'updated-model',
    );
  });
});

function pane(number: number) {
  return screen.getByRole('region', { name: `Session ${number}` });
}
function pointer(target: Element | Window, type: string, clientX = 0, clientY = 0) {
  const event = new Event(type, { bubbles: true });
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    button: { value: 0 },
    clientX: { value: clientX },
    clientY: { value: clientY },
  });
  fireEvent(target, event);
}

describe('split sessions', () => {
  it('hides the workspace outline when a tab has only one pane', () => {
    render(<App />);
    expect(pane(1).classList.contains('single-pane')).toBe(true);
    expect(pane(1).querySelector('.tab-workspace')).toBeTruthy();

    shortcut('d');
    expect(pane(1).classList.contains('single-pane')).toBe(false);
    expect(pane(2).classList.contains('single-pane')).toBe(false);
  });

  it('keeps sessions visible and preserves the original terminal and draft while nesting splits', async () => {
    await openChat();
    const firstTerminal = within(pane(1)).getByLabelText('Mock terminal');
    const input = screen.getByRole('textbox', { name: 'Ask the assistant' });
    fireEvent.change(input, { target: { value: 'Preserved pane draft' } });
    shortcut('d');
    expect(screen.getAllByRole('region', { name: /Session/ })).toHaveLength(2);
    expect(pane(1).style.width).toBe('50%');
    expect(pane(2).style.left).toBe('50%');
    expect(within(pane(2)).getByLabelText('Mock terminal').getAttribute('data-source')).toBe(
      firstTerminal.getAttribute('data-session'),
    );
    shortcut('d', true);
    expect(screen.getAllByRole('region', { name: /Session/ })).toHaveLength(3);
    expect(pane(3).style.top).toBe('50%');
    expect(pane(3).style.left).toBe('50%');
    expect(within(pane(1)).getByLabelText('Mock terminal')).toBe(firstTerminal);
    expect(
      (screen.getByRole('textbox', { name: 'Ask the assistant' }) as HTMLTextAreaElement).value,
    ).toBe('Preserved pane draft');
    shortcut('t');
    expect(screen.getAllByRole('region', { name: /Session/ })).toHaveLength(1);
    shortcut('1');
    expect(screen.getAllByRole('region', { name: /Session/ })).toHaveLength(3);
    expect(within(pane(1)).getByLabelText('Mock terminal')).toBe(firstTerminal);
  });
  it('focuses clicked panes and routes assistant shortcuts and closure to that session', async () => {
    render(<App />);
    shortcut('d');
    pointer(pane(1), 'pointerdown');
    expect(pane(1).getAttribute('data-focused')).toBe('true');
    expect(pane(2).getAttribute('data-focused')).toBe('false');
    await act(async () => shortcut('j'));
    expect(screen.getByRole('complementary', { name: 'AI chat' })).toBeTruthy();
    expect(within(pane(2)).queryByRole('complementary', { name: 'AI chat' })).toBeNull();
    const secondTerminal = within(pane(2)).getByLabelText('Mock terminal');
    const firstId = within(pane(1)).getByLabelText('Mock terminal').getAttribute('data-session');
    shortcut('w');
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Session 1' })).toBeNull());
    expect(bridge.closeWorkspace).toHaveBeenLastCalledWith(firstId, false, false);
    expect(pane(2).style.width).toBe('100%');
    expect(pane(2).getAttribute('data-focused')).toBe('true');
    expect(within(pane(2)).getByLabelText('Mock terminal')).toBe(secondTerminal);
  });
  it('resizes nested panes by dragging and keyboard without restarting sessions', () => {
    render(<App />);
    shortcut('d');
    shortcut('d', true);
    const firstTerminal = within(pane(1)).getByLabelText('Mock terminal');
    const vertical = screen.getByRole('separator', { name: 'Resize side-by-side panes' });
    fireEvent.keyDown(vertical, { key: 'ArrowRight' });
    expect(parseFloat(pane(1).style.width)).toBeCloseTo(55);
    fireEvent.doubleClick(vertical);
    expect(pane(1).style.width).toBe('50%');
    vi.spyOn(screen.getByRole('tabpanel'), 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 1000,
      height: 600,
      right: 1000,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const horizontal = screen.getByRole('separator', { name: 'Resize stacked panes' });
    pointer(horizontal, 'pointerdown', 750, 300);
    pointer(window, 'pointermove', 750, 420);
    pointer(window, 'pointerup', 750, 420);
    expect(pane(2).style.height).toBe('70%');
    expect(pane(3).style.top).toBe('70%');
    expect(document.body.classList.contains('resizing-panes')).toBe(false);
    expect(within(pane(1)).getByLabelText('Mock terminal')).toBe(firstTerminal);
  });
  it('closes an entire split tab atomically and preserves it on Cancel', async () => {
    await openChat();
    shortcut('d');
    fireEvent.click(screen.getByRole('button', { name: /Select terminals/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'T1S1' }));
    shortcut('t');
    const input = screen.getByRole('textbox', { name: 'Ask the assistant' });
    fireEvent.change(input, { target: { value: 'Keep working in first tab' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(bridge.startChat).toHaveBeenCalledOnce());
    const request = vi.mocked(bridge.startChat).mock.calls[0][0];
    const ids = request.attachments.map((item) => item.sessionId);
    fireEvent.click(screen.getByRole('button', { name: 'Close Terminal 1' }));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    expect(bridge.closeWorkspaces).toHaveBeenLastCalledWith(ids, false, true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(bridge.cancelChat).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close Terminal 1' }));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Close and stop work' }));
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(1));
    expect(bridge.closeWorkspaces).toHaveBeenLastCalledWith(ids, true, true);
    expect(bridge.cancelChat).toHaveBeenCalledWith(request.requestId);
  });
});

describe('navigation shortcuts', () => {
  it('selects tab positions after closure and leaves retired Shift-bracket shortcuts unhandled', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'New tab' }));
    fireEvent.click(screen.getByRole('button', { name: 'New tab' }));
    fireEvent.keyDown(window, { key: '1', code: 'Digit1', metaKey: true });
    expect(screen.getByRole('tab', { name: 'Terminal 1' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    const event = new KeyboardEvent('keydown', {
      key: '{',
      code: 'BracketLeft',
      metaKey: true,
      shiftKey: true,
      cancelable: true,
    });
    fireEvent(window, event);
    expect(event.defaultPrevented).toBe(false);
    fireEvent.keyDown(window, { key: '}', code: 'BracketRight', metaKey: true, shiftKey: true });
    expect(screen.getByRole('tab', { name: 'Terminal 1' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    fireEvent.keyDown(window, { key: '3', code: 'Digit3', metaKey: true });
    fireEvent.keyDown(window, { key: '9', code: 'Digit9', metaKey: true });
    expect(screen.getByRole('tab', { name: 'Terminal 3' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close Terminal 1' }));
    await waitFor(() => expect(screen.queryByRole('tab', { name: 'Terminal 1' })).toBeNull());
    fireEvent.keyDown(window, { key: '1', code: 'Digit1', metaKey: true });
    expect(screen.getByRole('tab', { name: 'Terminal 2' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    const receive = vi
      .mocked(bridge.listen)
      .mock.calls.find(([event]) => event === 'workspace-action')![1];
    act(() => receive('next-tab'));
    expect(screen.getByRole('tab', { name: 'Terminal 3' }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });
  it('cycles panes, moves directionally, and applies broadcast settings', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Split right' }));
    fireEvent.click(screen.getByRole('button', { name: 'Split down' }));
    const focused = () =>
      document.querySelector('.session-pane[data-focused="true"]')?.getAttribute('aria-label');
    expect(focused()).toBe('Session 3');
    fireEvent.keyDown(window, { key: 'ArrowUp', code: 'ArrowUp', metaKey: true, altKey: true });
    expect(focused()).toBe('Session 2');
    fireEvent.keyDown(window, { key: 'ArrowLeft', code: 'ArrowLeft', metaKey: true, altKey: true });
    expect(focused()).toBe('Session 1');
    fireEvent.keyDown(window, { key: ']', code: 'BracketRight', metaKey: true, altKey: true });
    expect(focused()).toBe('Session 2');
    act(() => {
      for (const [event, receive] of vi.mocked(bridge.listen).mock.calls)
        if (event === 'settings-changed')
          receive({ model: 'test', hasApiKey: true, hotkeys: { 'next-pane': 'Ctrl+KeyL' } });
    });
    fireEvent.keyDown(window, { key: ']', code: 'BracketRight', metaKey: true, altKey: true });
    expect(focused()).toBe('Session 2');
    fireEvent.keyDown(window, { key: 'l', code: 'KeyL', ctrlKey: true });
    expect(focused()).toBe('Session 3');
  });
});

it('cycles visible panes with Cmd+Option+/ and wraps without changing tabs', async () => {
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: 'New tab' }));
  fireEvent.click(screen.getByRole('button', { name: 'Split right' }));
  fireEvent.click(screen.getByRole('button', { name: 'Split down' }));
  // Hidden tabs retain focus metadata, so inspect only the selected panel.
  const selectedFocus = () =>
    screen.getByRole('tabpanel').querySelector('[data-focused="true"]')?.getAttribute('aria-label');
  expect(selectedFocus()).toBe('Session 4');
  for (const expected of ['Session 2', 'Session 3', 'Session 4']) {
    fireEvent.keyDown(window, { key: '÷', code: 'Slash', metaKey: true, altKey: true });
    expect(selectedFocus()).toBe(expected);
    expect(screen.getByRole('tab', { name: 'Terminal 2' }).getAttribute('aria-selected')).toBe(
      'true',
    );
  }
  const nativeAction = vi
    .mocked(bridge.listen)
    .mock.calls.find(([event]) => event === 'workspace-action')![1];
  act(() => nativeAction('cycle-panes'));
  expect(selectedFocus()).toBe('Session 2');
});

describe('tab renaming', () => {
  it('renames a background tab without replacing its terminal or switching tabs', () => {
    render(<App />);
    const firstPanel = screen.getByRole('tabpanel');
    const terminal = within(firstPanel).getByLabelText('Mock terminal');
    fireEvent.click(screen.getByRole('button', { name: 'New tab' }));
    fireEvent.contextMenu(screen.getByRole('tab', { name: 'Terminal 1' }), {
      clientX: 100,
      clientY: 20,
    });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename tab' }));
    const input = screen.getByRole('textbox', { name: 'Tab name' });
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: '  Project shell  ' } });
    fireEvent.submit(screen.getByRole('dialog'));
    expect(screen.getByRole('tab', { name: 'Project shell' }).getAttribute('aria-selected')).toBe(
      'false',
    );
    expect(screen.getByRole('tab', { selected: true }).textContent).toBe('Terminal 2');
    expect(screen.getByRole('button', { name: 'Close Project shell' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Project shell' }));
    expect(screen.getByRole('tabpanel')).toBe(firstPanel);
    expect(within(firstPanel).getByLabelText('Mock terminal')).toBe(terminal);
  });

  it('rejects blank names, cancels editing, and dismisses the menu', () => {
    render(<App />);
    const tab = screen.getByRole('tab', { name: 'Terminal 1' });
    const openRename = () => {
      fireEvent.contextMenu(tab);
      fireEvent.click(screen.getByRole('menuitem', { name: 'Rename tab' }));
    };
    openRename();
    const input = screen.getByRole('textbox', { name: 'Tab name' });
    fireEvent.change(input, { target: { value: '   ' } });
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(screen.getByRole('dialog'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    openRename();
    fireEvent.change(screen.getByRole('textbox', { name: 'Tab name' }), {
      target: { value: 'Canceled' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(tab.textContent).toBe('Terminal 1');
    fireEvent.contextMenu(tab);
    fireEvent.keyDown(screen.getByRole('menuitem'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.contextMenu(tab);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

it('includes the persistent Settings tab in numbered tab shortcuts', () => {
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  const settingsTab = screen.getByRole('tab', { name: 'Settings' });
  expect(settingsTab.getAttribute('aria-selected')).toBe('true');

  fireEvent.keyDown(window, { key: '1', code: 'Digit1', metaKey: true });
  expect(screen.getByRole('tab', { name: 'Terminal 1' }).getAttribute('aria-selected')).toBe(
    'true',
  );
  expect(settingsTab.getAttribute('aria-selected')).toBe('false');

  fireEvent.keyDown(window, { key: '2', code: 'Digit2', metaKey: true });
  expect(settingsTab.getAttribute('aria-selected')).toBe('true');
});

it('suppresses browser context menus across the document while retaining the tab menu', () => {
  const { unmount } = render(<App />);
  for (const target of [document.body, screen.getByLabelText('Mock terminal')]) {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    fireEvent(target, event);
    expect(event.defaultPrevented).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
  }
  const tabEvent = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  fireEvent(screen.getByRole('tab'), tabEvent);
  expect(tabEvent.defaultPrevented).toBe(true);
  expect(screen.getByRole('menuitem', { name: 'Rename tab' })).toBeTruthy();
  fireEvent.click(screen.getByRole('menuitem'));
  const inputEvent = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  fireEvent(screen.getByRole('textbox', { name: 'Tab name' }), inputEvent);
  expect(inputEvent.defaultPrevented).toBe(true);
  unmount();
  const eventAfterUnmount = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  fireEvent(document.body, eventAfterUnmount);
  expect(eventAfterUnmount.defaultPrevented).toBe(false);
});

it('starts in the terminal without onboarding and prompts for a key in the assistant', async () => {
  vi.mocked(bridge.getSettings).mockResolvedValueOnce({
    model: 'test-model',
    hasApiKey: false,
    connectionVerified: false,
  });
  render(<App />);
  await waitFor(() => expect(bridge.getSettings).toHaveBeenCalled());
  expect(screen.queryByRole('heading', { name: 'Settings' })).toBeNull();
  fireEvent.keyDown(window, { key: 'j', metaKey: true });
  await waitFor(() =>
    expect(screen.getByLabelText('Ask the assistant').hasAttribute('disabled')).toBe(true),
  );
  fireEvent.click(screen.getByRole('button', { name: /Add your OpenAI key/ }));
  expect(screen.getByRole('heading', { name: 'Settings' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Use terminal without AI' })).toBeNull();
  expect(bridge.startChat).not.toHaveBeenCalled();
});
it('retains the current model when validation fails and validates reasoning changes before applying them', async () => {
  vi.mocked(bridge.listModels).mockResolvedValueOnce([{ id: 'account-model', ownedBy: 'openai' }]);
  vi.mocked(bridge.saveModel).mockRejectedValueOnce(
    new Error('This model does not support the selected request options.'),
  );
  render(<App />);
  await waitFor(() => expect(bridge.listModels).toHaveBeenCalled());
  fireEvent.keyDown(window, { key: 'j', metaKey: true });
  const selector = screen.getByLabelText('Assistant model') as HTMLSelectElement;
  await waitFor(() => expect(selector.querySelector('option[value="account-model"]')).toBeTruthy());
  fireEvent.change(selector, { target: { value: 'account-model' } });
  await waitFor(() => expect(bridge.saveModel).toHaveBeenCalledWith('account-model', 'medium'));
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toContain('selected request options'),
  );
  expect(selector.value).toBe('test-model');
  vi.mocked(bridge.saveModel).mockResolvedValueOnce({
    model: 'test-model',
    hasApiKey: true,
    reasoningEffort: 'off',
    connectionVerified: true,
  });
  fireEvent.change(screen.getByLabelText('Reasoning effort'), { target: { value: 'low' } });
  await waitFor(() => expect(bridge.saveModel).toHaveBeenLastCalledWith('test-model', 'low'));
  await waitFor(() =>
    expect((screen.getByLabelText('Reasoning effort') as HTMLSelectElement).value).toBe('off'),
  );
});

it('attempts reasoning again when switching away from a model without reasoning support', async () => {
  vi.mocked(bridge.getSettings).mockResolvedValueOnce({
    model: 'test-model',
    hasApiKey: true,
    reasoningEffort: 'off',
  });
  vi.mocked(bridge.listModels).mockResolvedValueOnce([{ id: 'gpt-6.1', ownedBy: 'openai' }]);
  vi.mocked(bridge.saveModel).mockResolvedValueOnce({
    model: 'gpt-6.1',
    hasApiKey: true,
    reasoningEffort: 'medium',
  });
  render(<App />);
  fireEvent.keyDown(window, { key: 'j', metaKey: true });
  const selector = await screen.findByLabelText('Assistant model');
  await waitFor(() => expect(selector.querySelector('option[value="gpt-6.1"]')).toBeTruthy());
  fireEvent.change(selector, { target: { value: 'gpt-6.1' } });
  await waitFor(() => expect(bridge.saveModel).toHaveBeenCalledWith('gpt-6.1', 'medium'));
  await waitFor(() =>
    expect(screen.getByLabelText('Reasoning effort').hasAttribute('disabled')).toBe(false),
  );
});
