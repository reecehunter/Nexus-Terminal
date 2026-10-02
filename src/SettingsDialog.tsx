import { useEffect, useRef, useState } from 'react';
import { Check, KeyRound, X } from 'lucide-react';
import { bridge, errorMessage } from './bridge';
import {
  defaultHotkeys,
  HOTKEY_ACTIONS,
  eventBinding,
  formatHotkey,
  validateHotkeys,
} from './hotkeys';
import { ThemeEditor } from './ThemeEditor';
import type { ModelOption, ReasoningEffort, Settings } from './types';

export function SettingsDialog({
  settings,
  onClose,
  onSave,
}: {
  settings: Settings;
  onClose(): void;
  onSave(settings: Settings): void;
}) {
  const [hotkeys, setHotkeys] = useState(() => ({ ...defaultHotkeys(), ...settings.hotkeys }));
  const [recording, setRecording] = useState<string | null>(null);
  const [shortcutsReady, setShortcutsReady] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [model, setModel] = useState(settings.model);
  const [effort, setEffort] = useState<ReasoningEffort>(settings.reasoningEffort ?? 'medium');
  const [redactSensitiveInfo, setRedactSensitiveInfo] = useState(
    settings.redactSensitiveInfo ?? true,
  );
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [connected, setConnected] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const previousFocus = useRef(document.activeElement as HTMLElement | null);
  useEffect(() => {
    dialog.current?.querySelector<HTMLInputElement>('input')?.focus();
    let disposed = false;
    void bridge
      .setHotkeysEditing(true)
      .then(() => {
        if (!disposed) setShortcutsReady(true);
      })
      .catch((error) => {
        if (!disposed) setError(errorMessage(error));
      });
    return () => {
      disposed = true;
      void bridge.setHotkeysEditing(false).catch(() => {});
      previousFocus.current?.focus();
    };
  }, []);
  async function loadModels() {
    setLoadingModels(true);
    setError('');
    try {
      setModels(await bridge.listModels(apiKey || null));
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setLoadingModels(false);
    }
  }
  async function save(testConnection = false) {
    setSaving(true);
    setError('');
    try {
      const validationError = validateHotkeys(hotkeys);
      if (validationError) throw new Error(validationError);
      const next = await bridge.saveSettings(
        model,
        apiKey || null,
        hotkeys,
        effort,
        testConnection,
        redactSensitiveInfo,
      );
      onSave(next);
      setApiKey('');
      setEffort(next.reasoningEffort ?? effort);
      if (
        testConnection ||
        apiKey ||
        model !== settings.model ||
        effort !== (settings.reasoningEffort ?? 'medium') ||
        redactSensitiveInfo !== (settings.redactSensitiveInfo ?? true)
      ) {
        setConnected(true);
      } else onClose();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="settings-page" aria-labelledby="settings-title">
      <div
        ref={dialog}
        className="settings-content"
        onKeyDown={(event) => {
          if (recording) {
            event.preventDefault();
            event.stopPropagation();
            if (event.key === 'Escape') {
              setRecording(null);
              return;
            }
            if (['Meta', 'Control', 'Alt', 'Shift'].includes(event.key)) return;
            const binding = eventBinding(event.nativeEvent);
            if (!binding) {
              setError('Use Command or Control plus a key.');
              return;
            }
            const next = { ...hotkeys, [recording]: binding };
            const validationError = validateHotkeys(next);
            if (validationError) {
              setError(validationError);
              return;
            }
            setHotkeys(next);
            setRecording(null);
            setError('');
            return;
          }
          if (event.key === 'Escape' && !saving) {
            event.stopPropagation();
            onClose();
          }
          if (event.key === 'Tab') {
            const elements = Array.from(
              dialog.current?.querySelectorAll<HTMLElement>(
                'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary',
              ) ?? [],
            );
            const first = elements[0];
            const last = elements[elements.length - 1];
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
        <div className="modal-heading">
          <div>
            <span className="eyebrow">PREFERENCES</span>
            <h2 id="settings-title">Settings</h2>
          </div>
          <button
            className="icon-button"
            aria-label="Close settings"
            onClick={onClose}
            disabled={saving}
          >
            <X size={18} />
          </button>
        </div>
        <label htmlFor="api-key">
          OpenAI API key{' '}
          <span>{settings.hasApiKey ? 'Saved in Keychain' : 'Required for chat'}</span>
        </label>
        <div className="key-input">
          <KeyRound size={15} />
          <input
            id="api-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={settings.hasApiKey ? 'Leave blank to keep your saved key' : 'sk-…'}
            value={apiKey}
            onChange={(event) => {
              setApiKey(event.target.value);
              setModels([]);
              setConnected(false);
            }}
            disabled={saving || loadingModels}
          />
        </div>
        <p className="field-help">
          Your key stays in macOS Keychain. Requests go directly to OpenAI.
        </p>
        <div className="connection-settings">
          <label htmlFor="setup-model">Assistant model</label>
          <input
            id="setup-model"
            list="available-models"
            value={model}
            onChange={(event) => {
              setModel(event.target.value);
              if (effort === 'off') setEffort('medium');
              setConnected(false);
            }}
            disabled={saving || loadingModels}
            spellCheck={false}
          />
          <datalist id="available-models">
            {models.map((option) => (
              <option key={option.id} value={option.id} />
            ))}
          </datalist>
          <button
            className="quiet-button"
            onClick={loadModels}
            disabled={saving || loadingModels || (!apiKey && !settings.hasApiKey)}
          >
            {loadingModels ? 'Loading models…' : 'Load available models'}
          </button>
          <label htmlFor="setup-effort">Reasoning effort</label>
          <select
            id="setup-effort"
            value={effort}
            disabled={saving || loadingModels || effort === 'off'}
            onChange={(event) => {
              setEffort(event.target.value as ReasoningEffort);
              setConnected(false);
            }}
          >
            {effort === 'off' && <option value="off">Not supported by this model</option>}
            <option value="none">None</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
          <p className="field-help">
            Model and reasoning changes are validated before saving. Testing makes a small billed
            API request with synthetic text; it sends no terminal or file content. Reasoning options
            are automatically omitted when the model does not support them.
          </p>
          <button
            className="primary-button"
            onClick={() => save(true)}
            disabled={saving || loadingModels || !!recording || (!apiKey && !settings.hasApiKey)}
          >
            {saving ? 'Testing connection…' : 'Test & save connection'}
          </button>
          {connected && (
            <div className="setup-success" role="status" aria-label="Connection status">
              <p>Connection verified. Your assistant is ready.</p>
            </div>
          )}
        </div>
        <div className="settings-note">
          <Check size={14} />
          <span>
            Windows start in Ask for approval. Auto and Full access change what needs approval.
            Transcripts save on this device; live tasks and attachments last for this app session.
          </span>
        </div>
        <p className="field-help">
          When you send a question, attached terminal screens and recent output, your messages, and
          requested local file/tool results are sent to OpenAI. Attach only sessions you intend to
          share. Requests use store: false; provider retention still depends on your OpenAI data
          controls.
        </p>
        <label className="privacy-toggle" htmlFor="redact-sensitive-info">
          <input
            id="redact-sensitive-info"
            aria-label="Automatically redact sensitive information"
            type="checkbox"
            checked={redactSensitiveInfo}
            disabled={saving}
            onChange={(event) => {
              setRedactSensitiveInfo(event.target.checked);
              setConnected(false);
            }}
          />
          <span>
            <strong>Automatically redact sensitive information</strong>
            <small>
              Removes detected credentials and common personal identifiers before sending.
            </small>
          </span>
        </label>
        <ThemeEditor />
        <section className="hotkey-settings" aria-label="Keyboard shortcuts">
          <div className="hotkey-heading">
            <h3>Keyboard shortcuts</h3>
            <button
              className="quiet-button"
              disabled={saving}
              onClick={() => {
                setHotkeys(defaultHotkeys());
                setRecording(null);
                setError('');
              }}
            >
              Reset defaults
            </button>
          </div>
          <p className="field-help">
            Click a shortcut, then press Command or Control plus a key. Escape cancels recording.
          </p>
          {['Tabs', 'Panes', 'App'].map((group) => (
            <fieldset key={group} disabled={saving || !shortcutsReady}>
              <legend>{group}</legend>
              {HOTKEY_ACTIONS.filter((action) => action.group === group).map((action) => (
                <div className="hotkey-row" key={action.id}>
                  <span>{action.title}</span>
                  <button
                    className="hotkey-binding"
                    aria-label={`Shortcut for ${action.title}`}
                    aria-pressed={recording === action.id}
                    onClick={() => {
                      setRecording(action.id);
                      setError('');
                    }}
                  >
                    {recording === action.id ? 'Press shortcut…' : formatHotkey(hotkeys[action.id])}
                  </button>
                  <button
                    className="quiet-button"
                    aria-label={`Clear shortcut for ${action.title}`}
                    onClick={() => {
                      setHotkeys((current) => ({ ...current, [action.id]: null }));
                      setRecording(null);
                      setError('');
                    }}
                  >
                    Clear
                  </button>
                </div>
              ))}
            </fieldset>
          ))}
        </section>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-footer">
          {settings.hasApiKey && (
            <button
              className="quiet-button danger"
              disabled={saving}
              onClick={async () => {
                setSaving(true);
                setError('');
                try {
                  onSave(await bridge.deleteKey());
                } catch (error) {
                  setError(errorMessage(error));
                } finally {
                  setSaving(false);
                }
              }}
            >
              Remove key
            </button>
          )}
          <button
            className="primary-button"
            onClick={() => save()}
            disabled={saving || loadingModels || !!recording}
          >
            {saving ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      </div>
    </main>
  );
}
