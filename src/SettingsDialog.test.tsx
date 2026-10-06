import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SettingsDialog } from './SettingsDialog';
import { bridge } from './bridge';
import { defaultHotkeys } from './hotkeys';
vi.mock('./bridge', () => ({
  errorMessage: String,
  bridge: {
    setHotkeysEditing: vi.fn().mockResolvedValue(undefined),
    saveSettings: vi.fn().mockResolvedValue({ model: 'test', hasApiKey: false, hotkeys: {} }),
    deleteKey: vi.fn(),
    listModels: vi.fn().mockResolvedValue([{ id: 'available-model', ownedBy: 'openai' }]),
  },
}));
afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());
const settings = { model: 'test', hasApiKey: false, redactSensitiveInfo: true };
it('records and automatically saves shortcuts, restoring native shortcuts on dismissal', async () => {
  const onClose = vi.fn();
  const onSave = vi.fn();
  const view = render(<SettingsDialog settings={settings} onClose={onClose} onSave={onSave} />);
  const record = screen.getByRole('button', { name: 'Shortcut for Next Pane' });
  await waitFor(() => expect(record.hasAttribute('disabled')).toBe(false));
  expect(bridge.setHotkeysEditing).toHaveBeenCalledWith(true);
  fireEvent.click(record);
  fireEvent.keyDown(record, { key: 'l', code: 'KeyL', ctrlKey: true });
  expect(record.textContent).toBe('⌃L');
  fireEvent.click(screen.getByRole('button', { name: 'Clear shortcut for Previous Pane' }));
  await waitFor(() => expect(bridge.saveSettings).toHaveBeenCalledWith(
    'test',
    null,
    {
      ...defaultHotkeys(),
      'next-pane': 'Ctrl+KeyL',
      'previous-pane': null,
    },
    'medium',
    false,
    true,
    true,
    null,
    null,
  ));
  expect(screen.queryByRole('button', { name: 'Save settings' })).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  expect(onSave).toHaveBeenCalledOnce();
  view.unmount();
  expect(bridge.setHotkeysEditing).toHaveBeenLastCalledWith(false);
});
it('rejects conflicting and reserved shortcuts, supports Escape and reset', async () => {
  const onClose = vi.fn();
  render(<SettingsDialog settings={settings} onClose={onClose} onSave={vi.fn()} />);
  const record = screen.getByRole('button', { name: 'Shortcut for Next Pane' });
  await waitFor(() => expect(record.hasAttribute('disabled')).toBe(false));
  fireEvent.click(record);
  fireEvent.keyDown(record, { key: 't', code: 'KeyT', metaKey: true });
  expect(screen.getByRole('alert').textContent).toContain('same shortcut');
  fireEvent.keyDown(record, { key: 'c', code: 'KeyC', metaKey: true });
  expect(screen.getByRole('alert').textContent).toContain('reserved');
  fireEvent.keyDown(record, { key: 'Escape' });
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Clear shortcut for Next Pane' }));
  expect(record.textContent).toBe('Unassigned');
  fireEvent.click(screen.getByRole('button', { name: 'Reset defaults' }));
  expect(record.textContent).toBe('⌘⌥]');
});
it('keeps settings open and shows automatic save errors', async () => {
  vi.mocked(bridge.saveSettings).mockRejectedValueOnce(new Error('Cannot save'));
  const onClose = vi.fn();
  render(<SettingsDialog settings={settings} onClose={onClose} onSave={vi.fn()} />);
  fireEvent.click(screen.getByLabelText('Automatically redact sensitive information'));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Cannot save'));
  expect(onClose).not.toHaveBeenCalled();
});

it('loads account-visible models using the unsaved key and shows automatic reasoning compatibility after validation', async () => {
  const onClose = vi.fn();
  const onSave = vi.fn();
  vi.mocked(bridge.saveSettings).mockResolvedValueOnce({
    model: 'available-model',
    hasApiKey: true,
    reasoningEffort: 'off',
    connectionVerified: true,
  });
  render(<SettingsDialog settings={settings} onClose={onClose} onSave={onSave} />);
  expect(
    screen.getByRole('button', { name: 'Test & save connection' }).hasAttribute('disabled'),
  ).toBe(true);
  fireEvent.change(screen.getByLabelText(/OpenAI API key/), { target: { value: 'fixture-key' } });
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Load available models' })),
  );
  expect(bridge.listModels).toHaveBeenCalledWith('fixture-key');
  expect(document.querySelector('datalist option')?.getAttribute('value')).toBe('available-model');
  fireEvent.change(screen.getByLabelText('Assistant model'), {
    target: { value: 'available-model' },
  });
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Test & save connection' })),
  );
  expect(bridge.saveSettings).toHaveBeenCalledWith(
    'available-model',
    'fixture-key',
    defaultHotkeys(),
    'medium',
    true,
    true,
    true,
    null,
    null,
  );
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ connectionVerified: true }));
  expect(onClose).not.toHaveBeenCalled();
  expect((screen.getByLabelText(/OpenAI API key/) as HTMLInputElement).value).toBe('');
  expect(screen.getByRole('status', { name: 'Connection status' }).textContent).toContain(
    'Connection verified',
  );
  expect(screen.getByLabelText('Reasoning effort').hasAttribute('disabled')).toBe(true);
  expect(screen.queryByRole('button', { name: 'Try your first task' })).toBeNull();
});

it('allows automatic redaction to be disabled and persists the choice', async () => {
  render(<SettingsDialog settings={settings} onClose={vi.fn()} onSave={vi.fn()} />);
  fireEvent.click(screen.getByLabelText('Automatically redact sensitive information'));
  await waitFor(() => expect(bridge.saveSettings).toHaveBeenCalledWith(
    'test',
    null,
    defaultHotkeys(),
    'medium',
    false,
    false,
    true,
    null,
    null,
  ));
});
it('preserves the draft key and settings after rejected connection validation', async () => {
  vi.mocked(bridge.saveSettings).mockRejectedValueOnce(
    new Error('API key was rejected. Update it in Settings.'),
  );
  const onSave = vi.fn();
  render(<SettingsDialog settings={settings} onClose={vi.fn()} onSave={onSave} />);
  fireEvent.change(screen.getByLabelText(/OpenAI API key/), {
    target: { value: 'bad-fixture-key' },
  });
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Test & save connection' })),
  );
  expect(screen.getByRole('alert').textContent).toContain('API key was rejected');
  expect(onSave).not.toHaveBeenCalled();
  expect((screen.getByLabelText(/OpenAI API key/) as HTMLInputElement).value).toBe(
    'bad-fixture-key',
  );
  expect(screen.queryByRole('status', { name: 'Connection status' })).toBeNull();
});
it('allows terminal-only use and reports model-list errors without persisting a key', async () => {
  const onClose = vi.fn();
  const onSave = vi.fn();
  vi.mocked(bridge.listModels).mockRejectedValueOnce(new Error('Could not connect'));
  render(<SettingsDialog settings={settings} onClose={onClose} onSave={onSave} />);
  fireEvent.change(screen.getByLabelText(/OpenAI API key/), { target: { value: 'fixture-key' } });
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Load available models' })),
  );
  expect(screen.getByRole('alert').textContent).toContain('Could not connect');
  expect(onSave).not.toHaveBeenCalled();
  expect(bridge.saveSettings).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
  expect(onClose).toHaveBeenCalledOnce();
});
