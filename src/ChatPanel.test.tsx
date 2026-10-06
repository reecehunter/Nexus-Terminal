import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPanel } from './ChatPanel';
import { initialChat } from './chat-state';
import { bridge } from './bridge';
import type { ChatState } from './types';

vi.mock('./bridge', () => ({
  bridge: { decide: vi.fn().mockResolvedValue(undefined) },
  errorMessage: String,
}));
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

function mount(
  state: ChatState = initialChat('conversation'),
  attachedCount = 1,
  overrides: Partial<React.ComponentProps<typeof ChatPanel>> = {},
) {
  const onSend = vi.fn().mockResolvedValue(true);
  const onStop = vi.fn();
  const inputRef = { current: null };
  render(
    <ChatPanel
      state={state}
      settings={{ model: 'test-model', hasApiKey: true }}
      inputRef={inputRef}
      mode="ask"
      modeUpdating={false}
      onModeChange={vi.fn()}
      attachments={Array.from({ length: attachedCount }, (_, index) => ({
        sessionId: `session-${index}`,
        label: `Terminal ${index + 1}`,
      }))}
      availableAttachments={Array.from({ length: attachedCount + 1 }, (_, index) => ({
        paneId: `pane-${index}`,
        sessionId: `session-${index}`,
        label: `Terminal ${index + 1}`,
      }))}
      followFocus
      localContext={null}
      localContextLoading={false}
      onChooseLocalDirectory={vi.fn()}
      onRemoveLocalDirectory={vi.fn()}
      onAttachmentsChange={vi.fn()}
      onResume={vi.fn()}
      onSend={onSend}
      onStop={onStop}
      onNewChat={vi.fn()}
      onClose={vi.fn()}
      onSettings={vi.fn()}
      {...overrides}
    />,
  );
  return { onSend, onStop };
}

describe('chat controls', () => {
  it('limits selection to sixteen terminals while allowing attached terminals to be removed', () => {
    mount(initialChat('conversation'), 16);
    fireEvent.click(screen.getByRole('button', { name: /Select terminals/ }));
    expect(screen.getByRole('checkbox', { name: 'Terminal 17' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(screen.getByRole('checkbox', { name: 'Terminal 1' }).hasAttribute('disabled')).toBe(
      false,
    );
  });
  it('removes an attached terminal from assistant context with its chip action', () => {
    const onAttachmentsChange = vi.fn();
    render(
      <ChatPanel
        state={initialChat('conversation')}
        settings={{ model: 'test-model', hasApiKey: true }}
        inputRef={{ current: null }}
        mode="ask"
        modeUpdating={false}
        onModeChange={vi.fn()}
        attachments={[{ sessionId: 'session-0', label: 'Terminal 1' }]}
        availableAttachments={[{ paneId: 'pane-0', sessionId: 'session-0', label: 'Terminal 1' }]}
        followFocus
        localContext={null}
        localContextLoading={false}
        onChooseLocalDirectory={vi.fn()}
        onRemoveLocalDirectory={vi.fn()}
        onAttachmentsChange={onAttachmentsChange}
        onResume={vi.fn()}
        onSend={vi.fn().mockResolvedValue(true)}
        onStop={vi.fn()}
        onNewChat={vi.fn()}
        onClose={vi.fn()}
        onSettings={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Remove Terminal 1 from assistant context' }),
    );

    expect(onAttachmentsChange).toHaveBeenCalledWith([]);
  });
  it('sends on Enter, keeps Shift+Enter for newlines, and supports canceling streams', async () => {
    const { onSend } = mount();
    const input = screen.getByRole('textbox', { name: 'Ask the assistant' });
    fireEvent.change(input, { target: { value: 'Explain this file' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('Explain this file'));
    cleanup();
    const state = {
      ...initialChat('conversation'),
      activeRequestId: 'request',
    };
    const { onStop } = mount(state);
    fireEvent.click(screen.getByRole('button', { name: 'Stop response' }));
    expect(onStop).toHaveBeenCalledOnce();
  });
  it('opens persisted history and returns to the current conversation', () => {
    mount({
      ...initialChat('old'),
      items: [
        { kind: 'message', id: 'question', role: 'user', text: 'Earlier question' },
        { kind: 'message', id: 'answer', role: 'assistant', text: 'Earlier answer' },
      ],
    });
    cleanup();
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Chat history' }));
    fireEvent.click(screen.getByRole('button', { name: /Earlier question/ }));
    expect(screen.getByText('Earlier answer')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /Earlier question/ }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(screen.queryByRole('textbox', { name: 'Ask the assistant' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back to current chat' }));
    expect(screen.getByRole('textbox', { name: 'Ask the assistant' })).toBeTruthy();
    expect(screen.queryByText('Earlier answer')).toBeNull();
  });
  it('loads a saved conversation into the active composer when a loader is provided', () => {
    const onLoadChat = vi.fn();
    const saved = {
      conversationId: 'saved-conversation',
      title: 'Earlier question',
      updatedAt: new Date().toISOString(),
      items: [
        {
          kind: 'message' as const,
          id: 'question',
          role: 'user' as const,
          text: 'Earlier question',
        },
        {
          kind: 'message' as const,
          id: 'answer',
          role: 'assistant' as const,
          text: 'Earlier answer',
        },
      ],
    };
    localStorage.setItem('nexus.chat-history.v1', JSON.stringify([saved]));
    mount(undefined, 1, { onLoadChat });

    fireEvent.click(screen.getByRole('button', { name: 'Chat history' }));
    fireEvent.click(screen.getByRole('button', { name: /Earlier question/ }));

    expect(onLoadChat).toHaveBeenCalledWith(saved);
    expect(screen.getByRole('textbox', { name: 'Ask the assistant' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Back to current chat' })).toBeNull();
  });
  it('grows the composer with multiline input up to its height limit', () => {
    mount();
    const input = screen.getByRole('textbox', { name: 'Ask the assistant' }) as HTMLTextAreaElement;
    let measuredHeight = 32;
    Object.defineProperty(input, 'scrollHeight', {
      configurable: true,
      get: () => measuredHeight,
    });

    fireEvent.change(input, { target: { value: 'A short question' } });
    expect(input.style.height).toBe('34px');
    expect(input.style.overflowY).toBe('hidden');

    measuredHeight = 96;
    fireEvent.change(input, { target: { value: 'A question\nwith another line' } });
    expect(input.style.height).toBe('96px');

    measuredHeight = 220;
    fireEvent.change(input, { target: { value: 'A very long question' } });
    expect(input.style.height).toBe('140px');
    expect(input.style.overflowY).toBe('auto');
  });
  it('shows the full command and directory and cannot send duplicate approvals', async () => {
    const state: ChatState = {
      ...initialChat('conversation'),
      activeRequestId: 'request',
      items: [
        {
          kind: 'tool',
          id: 'tool',
          requestId: 'request',
          name: 'run_command',
          arguments: { command: 'find . -name "*.txt"' },
          directory: '/tmp/project with spaces',
          status: 'approval',
          approvalId: 'approval',
          result: null,
          stdout: '',
          stderr: '',
        },
      ],
    };
    mount(state);
    expect(document.querySelector('.command-preview code')?.textContent).toBe(
      'find . -name "*.txt"',
    );
    expect(screen.getByText('/tmp/project with spaces')).toBeTruthy();
    const approve = screen.getByRole('button', { name: 'Approve & run' });
    fireEvent.click(approve);
    fireEvent.click(approve);
    await waitFor(() =>
      expect(bridge.decide).toHaveBeenCalledExactlyOnceWith('request', 'approval', true),
    );
  });
  it('renders Markdown without HTML or remote images', () => {
    const state: ChatState = {
      ...initialChat('conversation'),
      items: [
        {
          kind: 'message',
          id: 'answer',
          role: 'assistant',
          text: 'Use `ls`.\n\n<img src="https://example.com/track">\n\n![image](https://example.com/other)\n\n<script>bad()</script>',
        },
      ],
    };
    mount(state);
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getByText('ls')).toBeTruthy();
  });
});

it('disables AI inputs without a key and links to settings', () => {
  const onSettings = vi.fn();
  const { onSend } = mount(undefined, 1, {
    settings: { model: 'test-model', hasApiKey: false },
    onSettings,
  });
  const input = screen.getByLabelText('Ask the assistant');
  expect(input.hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('button', { name: 'Send question' }).hasAttribute('disabled')).toBe(true);
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(onSend).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: /Add your OpenAI key/ }));
  expect(onSettings).toHaveBeenCalledOnce();
});
it('shows compact recent models and searches the full list under More options', () => {
  mount(undefined, 1, {
    onModelChange: vi.fn(),
    models: ['gpt-6.1', 'gpt-5.10', 'gpt-5.9', 'gpt-5.8', 'gpt-5.7', 'gpt-5.6', 'gpt-audio'].map(
      (id) => ({ id, ownedBy: 'openai' }),
    ),
  });
  fireEvent.click(screen.getByRole('button', { name: 'Model and reasoning settings' }));
  expect(
    within(screen.getByRole('dialog')).queryByRole('option', { name: 'GPT-audio' }),
  ).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'More options…' }));
  fireEvent.change(screen.getByLabelText('Search models'), { target: { value: 'audio' } });
  expect(
    within(screen.getByRole('dialog')).getByRole('option', { name: 'GPT-audio' }),
  ).toBeTruthy();
  fireEvent.keyDown(screen.getByLabelText('Search models'), { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
});
it('disables reasoning selection after automatic compatibility detection', () => {
  mount(undefined, 1, { onModelChange: vi.fn(), reasoningEffort: 'off' });
  expect(screen.getByLabelText('Reasoning effort').hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Model and reasoning settings' }));
  expect(screen.getByText('Reasoning options are not supported by this model.')).toBeTruthy();
  expect(
    within(screen.getByRole('dialog')).queryByRole('option', { name: 'Low effort' }),
  ).toBeNull();
});

it('bounds the picker to the available height and updates it on window resize', () => {
  let triggerTop = 300;
  const measure = vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(() => ({
      top: triggerTop,
      bottom: triggerTop + 24,
      left: 100,
      right: 300,
      width: 200,
      height: 24,
      x: 100,
      y: triggerTop,
      toJSON: () => ({}),
    }));
  try {
    mount(undefined, 1, { onModelChange: vi.fn() });
    const trigger = screen.getByRole('button', { name: 'Model and reasoning settings' });
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog').style.maxHeight).toBe('284px');
    triggerTop = 150;
    fireEvent(window, new Event('resize'));
    expect(screen.getByRole('dialog').style.maxHeight).toBe('134px');
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  } finally {
    measure.mockRestore();
  }
});

it('separates tool activity from responses and keeps pending approvals visible', () => {
  const tool = {
    kind: 'tool' as const,
    id: 'read',
    requestId: 'request',
    name: 'read_file',
    arguments: { path: 'README.md' },
    directory: '/project',
    status: 'done' as const,
    approvalId: null,
    result: { text: 'File contents' },
    stdout: '',
    stderr: '',
  };
  mount({
    ...initialChat('conversation'),
    items: [
      { kind: 'message', id: 'question', role: 'user', text: 'Inspect the project' },
      tool,
      { ...tool, id: 'list', name: 'list_directory' },
      { kind: 'message', id: 'answer', role: 'assistant', text: 'Here is the result' },
      {
        ...tool,
        id: 'approve',
        name: 'run_command',
        arguments: { command: 'npm test', purpose: 'Verify the change' },
        status: 'approval',
        approvalId: 'approval',
        result: null,
      },
    ],
  });
  const group = screen.getByText('Read files, listed files').closest('details')!;
  expect(group.open).toBe(false);
  expect(within(group).getByText('Read README.md')).toBeTruthy();
  expect(group.contains(screen.getByText('Here is the result'))).toBe(false);
  expect(screen.getByRole('button', { name: 'Approve & run' })).toBeTruthy();
  expect(screen.queryByText(/60-second limit/)).toBeNull();
  expect(screen.getAllByText('Verify the change')).toHaveLength(1);
});

it('shows approval errors and allows retrying the decision', async () => {
  vi.mocked(bridge.decide).mockRejectedValueOnce(new Error('Connection lost'));
  mount({
    ...initialChat('conversation'),
    items: [
      {
        kind: 'tool',
        id: 'tool',
        requestId: 'request',
        name: 'run_command',
        arguments: { command: 'pwd' },
        directory: '/project',
        status: 'approval',
        approvalId: 'approval',
        result: null,
        stdout: '',
        stderr: '',
      },
    ],
  });
  fireEvent.click(screen.getByRole('button', { name: 'Approve & run' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Connection lost'));
  fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
  await waitFor(() => expect(bridge.decide).toHaveBeenLastCalledWith('request', 'approval', false));
});

it('keeps current thinking collapsed with readable actions and separate progress text', () => {
  mount({
    ...initialChat('conversation'),
    activeRequestId: 'request',
    items: [
      {
        kind: 'message',
        id: 'progress',
        role: 'assistant',
        channel: 'commentary',
        text: 'I will inspect the configuration before changing it.',
      },
      {
        kind: 'tool',
        id: 'read',
        requestId: 'request',
        name: 'read_file',
        arguments: { path: 'config.json' },
        directory: '/project',
        status: 'done',
        approvalId: null,
        result: null,
        stdout: '',
        stderr: '',
      },
      {
        kind: 'message',
        id: 'final',
        role: 'assistant',
        channel: 'final',
        text: 'The configuration is updated and verified.',
      },
    ],
  });
  expect(
    screen.getByText('Read config.json').closest('.thinking-group')?.hasAttribute('open'),
  ).toBe(false);
  expect(
    screen
      .getByText('I will inspect the configuration before changing it.')
      .closest('article')
      ?.classList.contains('commentary'),
  ).toBe(true);
  expect(screen.getAllByRole('button', { name: 'Copy answer' })).toHaveLength(1);
});

it('keeps terminal approvals compact and sends steering feedback as a rejection', async () => {
  mount({
    ...initialChat('conversation'),
    activeRequestId: 'request',
    phase: 'Waiting for approval',
    items: [
      {
        kind: 'tool',
        id: 'input',
        requestId: 'request',
        name: 'terminal_input',
        arguments: {
          sessionId: 'session',
          targetLabel: 'Terminal 1 · Session 1',
          text: 'echo "hello"',
          keys: ['Enter'],
          purpose: 'Check the shell',
          approvalReason: 'Ask for approval',
        },
        directory: null,
        status: 'approval',
        approvalId: 'approval',
        result: null,
        stdout: '',
        stderr: '',
      },
    ],
  });
  expect(screen.getByText('Terminal input · T1S1')).toBeTruthy();
  expect(document.querySelector('.command-preview code')?.textContent).toBe('echo "hello"');
  expect(document.querySelector('.shell-string')?.textContent).toBe('"hello"');
  expect(document.querySelector('.pulse-dot')).toBeNull();
  expect(screen.getByText('Waiting for approval').classList.contains('running-shimmer')).toBe(true);
  expect(document.querySelector('.approval-description')?.textContent).toBe('Check the shell');
  expect(document.querySelector('.tool-card')?.textContent).not.toContain('Ask for approval');
  fireEvent.click(screen.getByRole('button', { name: 'Steer' }));
  expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Approve input' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Steer' })).toBeNull();
  expect(screen.getByText('Steering')).toBeTruthy();
  expect(
    screen.getByRole('button', { name: 'Send steering feedback' }).hasAttribute('disabled'),
  ).toBe(true);
  fireEvent.change(screen.getByRole('textbox', { name: 'Steering feedback' }), {
    target: { value: 'Inspect the file first' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send steering feedback' }));
  await waitFor(() =>
    expect(bridge.decide).toHaveBeenCalledExactlyOnceWith(
      'request',
      'approval',
      false,
      'Inspect the file first',
    ),
  );
});

it('shimmers running actions and omits lingering failure badges and action counters', () => {
  const tool = {
    kind: 'tool' as const,
    id: 'run',
    requestId: 'request',
    name: 'run_command',
    arguments: { command: 'pwd' },
    directory: '/project',
    approvalId: null,
    result: null,
    stdout: '',
    stderr: '',
  };
  mount({
    ...initialChat('conversation'),
    activeRequestId: 'request',
    phase: 'Reading results · 1/100 actions',
    items: [
      { ...tool, status: 'running' },
      { ...tool, id: 'failed', status: 'error' },
    ],
  });
  expect(document.querySelector('.activity-label.running-shimmer')).toBeTruthy();
  expect(screen.queryByText('running')).toBeNull();
  expect(screen.queryByText('error')).toBeNull();
  expect(screen.queryByText(/action needs attention/)).toBeNull();
  expect(screen.queryByText(/1\/100/)).toBeNull();
});

it('folds completed work behind its duration while keeping the summary visible and saves that view', () => {
  const state: ChatState = {
    ...initialChat('completed'),
    items: [
      { kind: 'message', id: 'question', role: 'user', text: 'Fix the configuration' },
      {
        kind: 'message',
        id: 'progress',
        role: 'assistant',
        text: 'I will inspect the configuration.',
        channel: 'commentary',
      },
      {
        kind: 'tool',
        id: 'read',
        requestId: 'request',
        name: 'read_file',
        arguments: { path: 'config.json' },
        directory: '/project',
        status: 'done',
        approvalId: null,
        result: null,
        stdout: '',
        stderr: '',
      },
      {
        kind: 'message',
        id: 'summary',
        role: 'assistant',
        text: 'Updated and verified.',
        channel: 'final',
      },
    ],
    completedTurns: [
      { id: 'request', startIndex: 1, endIndex: 4, summaryId: 'summary', durationMs: 143000 },
    ],
  };
  mount(state);
  const details = screen.getByText('Worked for 2m 23s').closest('details')!;
  expect(details.open).toBe(false);
  expect(details.contains(screen.getByText('I will inspect the configuration.'))).toBe(true);
  expect(details.contains(screen.getByText('Read config.json'))).toBe(true);
  expect(details.contains(screen.getByText('Updated and verified.'))).toBe(false);
  expect(screen.getAllByText('Updated and verified.')).toHaveLength(1);
  fireEvent.click(screen.getByText('Worked for 2m 23s'));
  expect(details.open).toBe(true);
  expect(document.querySelector('.running-shimmer')).toBeNull();
  cleanup();
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Chat history' }));
  fireEvent.click(screen.getByRole('button', { name: /Fix the configuration/ }));
  expect(screen.getByText('Worked for 2m 23s').closest('details')?.open).toBe(false);
});

it('stops shimmering completed thinking while later work in the same task is running', () => {
  const tool = {
    kind: 'tool' as const,
    id: 'read',
    requestId: 'request',
    name: 'read_file',
    arguments: { path: 'config.json' },
    directory: '/project',
    approvalId: null,
    result: null,
    stdout: '',
    stderr: '',
  };
  mount({
    ...initialChat('conversation'),
    activeRequestId: 'request',
    items: [
      { ...tool, status: 'done' },
      {
        kind: 'message',
        id: 'progress',
        role: 'assistant',
        text: 'The file is valid. Checking the build.',
        channel: 'commentary',
      },
      {
        ...tool,
        id: 'build',
        name: 'run_command',
        arguments: { command: 'npm test' },
        status: 'running',
      },
    ],
  });
  const groups = document.querySelectorAll('.thinking-group');
  expect(groups[0].querySelector('.running-shimmer')).toBeNull();
  expect(groups[1].querySelector('.running-shimmer')).toBeTruthy();
});
