import {
  isValidElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import ReactMarkdown from 'react-markdown';
import {
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  FileText,
  Terminal,
  Hand,
  Eye,
  FolderOpen,
  History,
  Plus,
  Sparkles,
  Square,
  X,
} from 'lucide-react';
import { bridge, errorMessage } from './bridge';
import { loadChatHistory, saveChatHistory, type SavedChat } from './chat-history';
import type {
  AgentMode,
  ChatItem,
  ChatState,
  CompletedTurn,
  ContextSnapshot,
  ModelOption,
  ReasoningEffort,
  Settings,
  TerminalAttachment,
} from './types';
import { MAX_TERMINAL_ATTACHMENTS } from './types';
import { modelLabel, recentModels, uniqueModels } from './models';

interface MenuOption {
  value: string;
  label: string;
  compactLabel?: string;
  description?: string;
}

function ComposerMenu({
  ariaLabel,
  value,
  options,
  onChange,
  disabled,
  icon,
  className = '',
}: {
  ariaLabel: string;
  value: string;
  options: MenuOption[];
  onChange(value: string): void;
  disabled?: boolean;
  icon?: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  return (
    <div ref={menuRef} className={`composer-menu ${className} ${open ? 'is-open' : ''}`}>
      <select
        className="sr-only legacy-menu-select"
        aria-label={ariaLabel}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="composer-menu-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((visible) => !visible)}
      >
        {icon}
        <span>{selected?.label}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="composer-menu-popover" role="listbox" aria-label={ariaLabel}>
          {options.map((option) => (
            <button
              type="button"
              role="option"
              aria-selected={option.value === value}
              key={option.value}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              <span className="menu-option-label">{option.label}</span>
              {option.description && (
                <span className="menu-option-description">{option.description}</span>
              )}
              {option.value === value && (
                <Check className="menu-option-check" size={14} aria-hidden="true" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AssistantOptionsMenu({
  model,
  modelOptions,
  recentModelOptions,
  effort,
  effortOptions,
  onModelChange,
  onEffortChange,
  disabled,
}: {
  model: string;
  modelOptions: MenuOption[];
  recentModelOptions: MenuOption[];
  effort: ReasoningEffort;
  effortOptions: MenuOption[];
  onModelChange(value: string): void;
  onEffortChange(value: ReasoningEffort): void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [search, setSearch] = useState('');
  const [maxHeight, setMaxHeight] = useState(420);
  const menuRef = useRef<HTMLDivElement>(null);
  const selectedModel = modelOptions.find((option) => option.value === model) ?? modelOptions[0];
  const selectedEffort =
    effortOptions.find((option) => option.value === effort) ?? effortOptions[0];

  const displayedModels = showMore
    ? modelOptions.filter((option) =>
        `${option.value} ${option.label}`.toLowerCase().includes(search.toLowerCase()),
      )
    : recentModelOptions;
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () =>
      setMaxHeight(
        Math.min(420, Math.max(0, (menuRef.current?.getBoundingClientRect().top ?? 0) - 16)),
      );
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  return (
    <div
      ref={menuRef}
      className={`assistant-options-menu ${open ? 'is-open' : ''}`}
      onKeyDown={(event) => {
        if (open && event.key === 'Escape') {
          event.stopPropagation();
          setOpen(false);
          menuRef.current?.querySelector<HTMLButtonElement>('.assistant-options-trigger')?.focus();
        }
      }}
    >
      {/* Keep native controls available to assistive technology and keyboard users. */}
      <select
        className="sr-only legacy-menu-select"
        aria-label="Assistant model"
        value={model}
        disabled={disabled}
        onChange={(event) => onModelChange(event.target.value)}
      >
        {modelOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <select
        className="sr-only legacy-menu-select"
        aria-label="Reasoning effort"
        value={effort}
        disabled={disabled || effort === 'off'}
        onChange={(event) => onEffortChange(event.target.value as ReasoningEffort)}
      >
        {effort === 'off' && <option value="off">Not supported</option>}
        {effortOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="assistant-options-trigger"
        aria-label="Model and reasoning settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          setOpen((visible) => !visible);
          setShowMore(false);
          setSearch('');
        }}
      >
        <span>{selectedModel?.label}</span>
        {effort !== 'off' && <span>{selectedEffort?.compactLabel ?? selectedEffort?.label}</span>}
        <ChevronDown size={13} />
      </button>
      {open && (
        <div
          className="assistant-options-popover"
          style={{ maxHeight }}
          role="dialog"
          aria-label="Model and reasoning settings"
        >
          <div className="assistant-options-group">
            <span className="assistant-options-label">
              {showMore ? 'ALL MODELS' : 'RECENT MODELS'}
            </span>
            {showMore && (
              <input
                autoFocus
                aria-label="Search models"
                placeholder="Search models…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            )}
            <div role="listbox" aria-label="Assistant model">
              {displayedModels.map((option) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={option.value === model}
                  key={option.value}
                  onClick={() => {
                    onModelChange(option.value);
                    setOpen(false);
                  }}
                >
                  <span>{option.label}</span>
                  {option.value === model && <Check size={13} />}
                </button>
              ))}
            </div>
            {displayedModels.length === 0 && <p className="field-help">No matching models.</p>}
            <button
              type="button"
              className="quiet-button more-models"
              onClick={() => {
                setShowMore(!showMore);
                setSearch('');
              }}
            >
              {showMore ? 'Back to recent models' : 'More options…'}
            </button>
          </div>
          <div className="assistant-options-group">
            <span className="assistant-options-label">REASONING</span>
            {effort === 'off' && (
              <p className="field-help">Reasoning options are not supported by this model.</p>
            )}
            <div role="listbox" aria-label="Reasoning effort">
              {effort !== 'off' &&
                effortOptions.map((option) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={option.value === effort}
                    key={option.value}
                    onClick={() => {
                      onEffortChange(option.value as ReasoningEffort);
                      setOpen(false);
                    }}
                  >
                    <span>{option.label}</span>
                    {option.value === effort && <Check size={13} />}
                  </button>
                ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function textContent(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textContent).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textContent(node.props.children);
  return '';
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [state, setState] = useState<'ready' | 'copied' | 'failed'>('ready');
  useEffect(() => {
    if (state === 'ready') return;
    const timer = setTimeout(() => setState('ready'), 1800);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <button
      className="copy-button"
      aria-label={label}
      title={state === 'failed' ? 'Clipboard unavailable' : label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setState('copied');
        } catch {
          setState('failed');
        }
      }}
    >
      {state === 'copied' ? <Check size={12} /> : <Copy size={12} />}
      <span>{state === 'copied' ? 'Copied' : state === 'failed' ? 'Failed' : label}</span>
    </button>
  );
}

function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      skipHtml
      components={{
        pre: ({ children }) => (
          <div className="code-block">
            <div className="code-toolbar">
              <span>COMMAND / CODE</span>
              <CopyButton text={textContent(children).replace(/\n$/, '')} />
            </div>
            <pre>{children}</pre>
          </div>
        ),
        img: () => null,
        a: ({ href, children }) => (
          <span className="markdown-link" title={href}>
            {children}
          </span>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

function withoutAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '');
}

export function compactTerminalLabel(label: string): string {
  return label.replace(/Terminal\s+(\d+)\s*[·–—-]\s*Session\s+(\d+)/gi, 'T$1S$2');
}

function CommandCode({ text }: { text: string }) {
  // A small shell lexer colors strings, options, operators and variables without interpreting input.
  const tokens = text.split(
    /("(?:\\.|[^"\\])*"|'[^']*'|\$[A-Za-z_][\w]*|--?[A-Za-z][\w-]*|[|;&<>]+)/g,
  );
  return (
    <code>
      {tokens.map((token, index) => {
        const kind = /^["']/.test(token)
          ? 'string'
          : token.startsWith('$')
            ? 'variable'
            : /^--?/.test(token)
              ? 'option'
              : /^[|;&<>]+$/.test(token)
                ? 'operator'
                : '';
        return (
          <span key={index} className={kind ? `shell-${kind}` : undefined}>
            {token}
          </span>
        );
      })}
    </code>
  );
}

function ToolCard({
  item,
  animate = true,
}: {
  item: Extract<ChatItem, { kind: 'tool' }>;
  animate?: boolean;
}) {
  const [deciding, setDeciding] = useState(false);
  const [steering, setSteering] = useState(false);
  const [steeringReason, setSteeringReason] = useState('');
  const steeringInputRef = useRef<HTMLTextAreaElement>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setDeciding(false);
  }, [item.status]);
  useLayoutEffect(() => {
    const textarea = steeringInputRef.current;
    if (!textarea) return;

    // Match the main composer: reset before measuring so deleted text shrinks the input.
    textarea.style.height = 'auto';
    const contentHeight = textarea.scrollHeight;
    const nextHeight = Math.min(Math.max(contentHeight, 60), 120);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = contentHeight > 120 ? 'auto' : 'hidden';
  }, [steeringReason]);
  const isCommand = item.name === 'run_command';
  const isTerminal = !!item.arguments.sessionId;
  const result = item.result;
  const stdout = typeof result?.stdout === 'string' ? result.stdout : item.stdout;
  const stderr = typeof result?.stderr === 'string' ? result.stderr : item.stderr;
  const output = withoutAnsi(stdout + (stderr ? '\n' + stderr : ''));
  async function decide(approved: boolean, reason?: string) {
    if (!item.approvalId || deciding) return;
    setDeciding(true);
    setError('');
    try {
      await (reason
        ? bridge.decide(item.requestId, item.approvalId, false, reason)
        : bridge.decide(item.requestId, item.approvalId, approved));
    } catch (error) {
      setError(errorMessage(error));
      setDeciding(false);
    }
  }

  return (
    <article className={`tool-card ${item.status === 'approval' ? 'awaiting-approval' : ''}`}>
      <div className="tool-heading">
        <span className={animate && item.status === 'running' ? 'running-shimmer' : undefined}>
          {item.status === 'approval' ? (
            <Hand size={13} />
          ) : isCommand ? (
            <Terminal size={13} />
          ) : (
            <FileText size={13} />
          )}
          {isTerminal
            ? `${item.name.replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase())} · ${compactTerminalLabel(item.arguments.targetLabel ?? item.arguments.sessionId ?? '')}`
            : isCommand
              ? 'Run command'
              : item.name === 'read_file'
                ? 'Read file'
                : 'List directory'}
        </span>
        <span className={`tool-status status-${item.status}`}>
          {item.status === 'approval' ? (
            'Approval'
          ) : item.status === 'running' ? (
            <span className="sr-only">In progress</span>
          ) : item.status === 'error' ? null : (
            item.status
          )}
        </span>
      </div>
      {(isCommand || item.name === 'terminal_input') && (
        <div className="command-preview">
          <CommandCode
            text={isCommand ? (item.arguments.command ?? '') : (item.arguments.text ?? '')}
          />
          {!!item.arguments.keys?.length && (
            <span className="command-keys">Keys: {item.arguments.keys.join(' → ')}</span>
          )}
          {item.status !== 'approval' && (
            <CopyButton
              text={item.arguments.command ?? item.arguments.text ?? ''}
              label="Copy command"
            />
          )}
        </div>
      )}
      {isCommand && item.directory && <div className="command-directory">{item.directory}</div>}
      {item.arguments.purpose && <p className="approval-description">{item.arguments.purpose}</p>}
      {!isCommand && !isTerminal && <code className="file-path">{item.arguments.path}</code>}
      {item.status === 'approval' && (
        <>
          {item.arguments.approvalReason &&
            item.arguments.approvalReason !== 'Ask for approval' &&
            item.arguments.approvalReason !== item.arguments.purpose && (
              <p className="approval-description">{item.arguments.approvalReason}</p>
            )}
          {steering ? (
            <div className="steering-form">
              <div className="steering-composer">
                <div className="steering-heading">Steering</div>
                <textarea
                  ref={steeringInputRef}
                  autoFocus
                  aria-label="Steering feedback"
                  placeholder="Explain how the assistant should adjust…"
                  value={steeringReason}
                  maxLength={1024}
                  disabled={deciding}
                  onChange={(event) => setSteeringReason(event.target.value)}
                />
                <div className="steering-footer">
                  <button
                    className="quiet-button cancel-steer-button"
                    aria-label="Cancel steer"
                    disabled={deciding}
                    onClick={() => setSteering(false)}
                  >
                    Cancel steer
                  </button>
                  <button
                    className="send-button"
                    aria-label="Send steering feedback"
                    title="Send feedback"
                    disabled={deciding || !steeringReason.trim()}
                    onClick={() => void decide(false, steeringReason.trim())}
                  >
                    <ArrowUp size={17} />
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="approval-actions">
              <button
                className="quiet-button reject-button"
                disabled={deciding}
                onClick={() => void decide(false)}
              >
                Reject
              </button>
              <button
                className="quiet-button"
                disabled={deciding}
                onClick={() => setSteering(true)}
              >
                Steer
              </button>
              <button
                className="approve-button"
                disabled={deciding}
                onClick={() => void decide(true)}
              >
                <Check size={13} />
                {deciding ? 'Sending…' : isTerminal ? 'Approve input' : 'Approve & run'}
              </button>
            </div>
          )}
        </>
      )}
      {output && (
        <details className="tool-details" open={item.status === 'running'}>
          <summary>
            Output <ChevronDown size={12} />
          </summary>
          <pre>{output}</pre>
        </details>
      )}
      {result && !isCommand && (
        <details className="tool-details">
          <summary>
            Source <ChevronDown size={12} />
          </summary>
          <pre>
            {typeof result.text === 'string' ? result.text : JSON.stringify(result, null, 2)}
          </pre>
        </details>
      )}
      {result?.exitCode !== undefined && result.exitCode !== null && (
        <div className="tool-result">
          Exit code {String(result.exitCode)}
          {result.truncated ? ' · Output truncated' : ''}
        </div>
      )}
      {result?.timedOut === true && <div className="tool-result">Stopped after 60 seconds</div>}
      {typeof result?.error === 'string' && <div className="inline-error">{result.error}</div>}
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
    </article>
  );
}

// Group consecutive tool activity without moving it past user-facing responses or approvals.
function conversationEntries(items: ChatItem[]): (ChatItem | ChatItem[])[] {
  const entries: (ChatItem | ChatItem[])[] = [];
  for (const item of items) {
    if (item.kind === 'tool' && item.status !== 'approval') {
      const previous = entries[entries.length - 1];
      if (Array.isArray(previous)) previous.push(item);
      else entries.push([item]);
    } else entries.push(item);
  }
  return entries;
}

function actionLabel(item: Extract<ChatItem, { kind: 'tool' }>): string {
  const target = compactTerminalLabel(item.arguments.targetLabel ?? 'terminal');
  switch (item.name) {
    case 'run_command':
      return `Ran ${item.arguments.command ?? 'a command'}`;
    case 'read_file':
      return `Read ${item.arguments.path ?? 'a file'}`;
    case 'list_directory':
      return `Listed files in ${item.arguments.path ?? item.directory ?? 'directory'}`;
    case 'terminal_snapshot':
      return `Read ${target} screen`;
    case 'terminal_wait':
      return `Waited for output from ${target}`;
    case 'terminal_input':
      return `Sent ${item.arguments.text?.trim() || item.arguments.keys?.join(' → ') || 'input'} to ${target}`;
    default:
      return item.arguments.purpose ?? item.name.replaceAll('_', ' ');
  }
}

function ThinkingGroup({ items, active }: { items: ChatItem[]; active: boolean }) {
  const tools = items.filter(
    (item): item is Extract<ChatItem, { kind: 'tool' }> => item.kind === 'tool',
  );
  const running = active && tools.some((item) => item.status === 'running');
  const descriptions = [
    ...new Set(
      tools.map((item) => {
        if (item.name === 'run_command') return 'ran commands';
        if (item.name === 'read_file') return 'read files';
        if (item.name === 'list_directory') return 'listed files';
        if (item.name === 'terminal_input') return 'sent terminal input';
        return 'read terminal output';
      }),
    ),
  ];
  return (
    <details className="thinking-group">
      <summary>
        <Terminal size={14} />
        <span className={running ? 'running-shimmer' : undefined}>
          {running
            ? 'Thinking'
            : descriptions.join(', ').replace(/^./, (letter) => letter.toUpperCase())}
        </span>
        <ChevronDown size={13} />
      </summary>
      <div className="thinking-actions">
        {tools.map((item) => (
          <details className="activity-item" key={item.id}>
            <summary title={actionLabel(item)}>
              {item.name === 'terminal_snapshot' || item.name === 'terminal_wait' ? (
                <Eye size={13} />
              ) : item.name === 'read_file' || item.name === 'list_directory' ? (
                <FolderOpen size={13} />
              ) : (
                <Terminal size={13} />
              )}
              <span
                className={`activity-label ${active && item.status === 'running' ? 'running-shimmer' : ''}`}
              >
                {actionLabel(item)}
              </span>
            </summary>
            <ToolCard item={item} animate={active} />
          </details>
        ))}
      </div>
    </details>
  );
}

function TranscriptItems({
  items,
  activeRequestId,
}: {
  items: ChatItem[];
  activeRequestId: string | null;
}) {
  return (
    <>
      {conversationEntries(items).map((item) =>
        Array.isArray(item) ? (
          <ThinkingGroup
            key={item[0].id}
            items={item}
            active={item.some(
              (entry) => entry.kind === 'tool' && entry.requestId === activeRequestId,
            )}
          />
        ) : item.kind === 'message' ? (
          <article
            key={item.id}
            className={`chat-message ${item.role} ${item.kind === 'message' ? (item.channel ?? '') : ''}`}
          >
            <div className="message-content">
              {item.role === 'user' ? <p>{item.text}</p> : <Markdown text={item.text} />}
            </div>
            {item.role === 'assistant' && item.channel !== 'commentary' && item.text && (
              <CopyButton text={item.text} label="Copy answer" />
            )}
          </article>
        ) : item.kind === 'tool' ? (
          <ToolCard key={item.id} item={item} />
        ) : (
          <div
            key={item.id}
            className={`chat-notice ${item.error ? 'notice-error' : ''}`}
            role={item.error ? 'alert' : undefined}
          >
            {item.text}
          </div>
        ),
      )}
    </>
  );
}

function WorkedTurn({ turn, items }: { turn: CompletedTurn; items: ChatItem[] }) {
  const seconds = Math.floor(turn.durationMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const duration = minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
  const summary = items.find((item) => item.id === turn.summaryId);
  return (
    <section className="completed-turn">
      <details className="worked-process">
        <summary>
          Worked for {duration}
          <ChevronDown size={13} />
        </summary>
        <TranscriptItems
          items={items.filter((item) => item.id !== turn.summaryId)}
          activeRequestId={null}
        />
      </details>
      {summary && <TranscriptItems items={[summary]} activeRequestId={null} />}
    </section>
  );
}

function Transcript({
  items,
  turns = [],
  activeRequestId,
}: {
  items: ChatItem[];
  turns?: CompletedTurn[];
  activeRequestId: string | null;
}) {
  const sections: ReactNode[] = [];
  let cursor = 0;
  for (const turn of Array.isArray(turns) ? turns : []) {
    // Ignore malformed saved ranges; never hide content when history metadata is invalid.
    if (
      !turn ||
      !Number.isInteger(turn.startIndex) ||
      !Number.isInteger(turn.endIndex) ||
      turn.durationMs < 0 ||
      turn.startIndex < cursor ||
      turn.endIndex > items.length ||
      turn.endIndex <= turn.startIndex ||
      !Number.isFinite(turn.durationMs) ||
      !items.slice(turn.startIndex, turn.endIndex).some((item) => item.id === turn.summaryId)
    )
      continue;
    sections.push(
      <TranscriptItems
        key={`before-${turn.id}`}
        items={items.slice(cursor, turn.startIndex)}
        activeRequestId={null}
      />,
    );
    sections.push(
      <WorkedTurn key={turn.id} turn={turn} items={items.slice(turn.startIndex, turn.endIndex)} />,
    );
    cursor = turn.endIndex;
  }
  sections.push(
    <TranscriptItems key="current" items={items.slice(cursor)} activeRequestId={activeRequestId} />,
  );
  return <>{sections}</>;
}

interface Props {
  animationState?: 'opening' | 'open' | 'closing';
  state: ChatState;
  settings: Settings;
  models?: ModelOption[];
  modelsLoading?: boolean;
  onModelChange?(model: string): void;
  reasoningEffort?: ReasoningEffort;
  onReasoningEffortChange?(effort: ReasoningEffort): void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  mode: AgentMode;
  modeUpdating: boolean;
  onModeChange(mode: AgentMode): void;
  attachments: TerminalAttachment[];
  availableAttachments: (TerminalAttachment & { paneId: string })[];
  followFocus: boolean;
  localContext: ContextSnapshot | null;
  localContextLoading: boolean;
  onChooseLocalDirectory(): void;
  onRemoveLocalDirectory(): void;
  onAttachmentsChange(paneIds: string[] | null): void;
  onResume(): void;
  onSend(text: string): Promise<boolean>;
  onStop(): void;
  onNewChat(): void;
  onClose(): void;
  onSettings(): void;
}

export function ChatPanel(props: Props) {
  const composerMinHeight = 34;
  const composerMaxHeight = 140;
  const [draft, setDraft] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<SavedChat[]>([]);
  const [selectedChat, setSelectedChat] = useState<SavedChat | null>(null);
  const [historyError, setHistoryError] = useState('');
  useEffect(() => {
    try {
      saveChatHistory(props.state);
      setHistoryError('');
    } catch {
      setHistoryError('Chat history could not be saved on this device.');
    }
  }, [props.state]);
  const [submitting, setSubmitting] = useState(false);
  const [showAttachments, setShowAttachments] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const needsKey = !props.settings.hasApiKey;
  const busy = !!props.state.activeRequestId || submitting;
  const availableModels = uniqueModels([
    { id: props.settings.model, ownedBy: 'openai' },
    ...(props.models ?? []),
  ]);
  useEffect(() => {
    if (nearBottom.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [props.state.items, props.state.phase, selectedChat, showHistory]);
  useEffect(() => {
    setDraft('');
  }, [props.state.conversationId]);
  useLayoutEffect(() => {
    const textarea = props.inputRef.current;
    if (!textarea) return;

    // Reset before measuring so the textarea also shrinks when text is deleted.
    textarea.style.height = 'auto';
    const contentHeight = textarea.scrollHeight;
    const nextHeight = Math.min(Math.max(contentHeight, composerMinHeight), composerMaxHeight);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = contentHeight > composerMaxHeight ? 'auto' : 'hidden';
  }, [draft, props.inputRef]);

  async function send() {
    if (needsKey || !draft.trim() || busy) return;
    setSubmitting(true);
    try {
      if (await props.onSend(draft.trim())) setDraft('');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <aside
      className={`chat-panel chat-panel-${props.animationState ?? 'open'}`}
      aria-label="AI chat"
    >
      <header className="chat-header">
        <div className="chat-title">
          <Sparkles size={15} />
          <span>Assistant</span>
        </div>
        <div className="header-actions">
          <button
            className="icon-button"
            title="Chat history"
            aria-label="Chat history"
            aria-expanded={showHistory}
            onClick={() => {
              if (!showHistory) {
                try {
                  setHistory(loadChatHistory());
                } catch {
                  setHistoryError('Chat history could not be loaded on this device.');
                }
              }
              setSelectedChat(null);
              setShowHistory(!showHistory);
            }}
          >
            <History size={17} />
          </button>
          <button
            className="icon-button"
            title="New chat"
            aria-label="New chat"
            onClick={props.onNewChat}
          >
            <Plus size={17} />
          </button>
          <button
            className="icon-button"
            title="Close chat · Esc"
            aria-label="Close chat"
            onClick={props.onClose}
          >
            <X size={17} />
          </button>
        </div>
      </header>
      {historyError && (
        <div className="inline-error" role="alert">
          {historyError}
        </div>
      )}
      {showHistory && (
        <section className="chat-history" aria-label="Saved conversations">
          <div className="context-heading">
            <span>CHAT HISTORY · SAVED ON THIS DEVICE</span>
            <button
              className="quiet-button"
              onClick={() => {
                setShowHistory(false);
                setSelectedChat(null);
              }}
            >
              Back to current chat
            </button>
          </div>
          {!history.length && <p>No saved conversations yet.</p>}
          {history.map((chat) => (
            <button
              className="history-entry"
              key={chat.conversationId}
              aria-pressed={selectedChat?.conversationId === chat.conversationId}
              onClick={() => {
                setSelectedChat(chat);
                nearBottom.current = true;
              }}
            >
              <span>{chat.title}</span>
              <time dateTime={chat.updatedAt}>{new Date(chat.updatedAt).toLocaleString()}</time>
            </button>
          ))}
        </section>
      )}
      <div
        className="chat-scroll"
        ref={scroll}
        onScroll={() => {
          const element = scroll.current;
          if (element)
            nearBottom.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        }}
      >
        {!showHistory && props.state.items.length === 0 && (
          <div className="chat-welcome">
            <div className="welcome-symbol">
              <Sparkles size={23} strokeWidth={1.5} />
            </div>
            <h2>{needsKey ? 'Connect your AI assistant' : 'Ask about your terminal'}</h2>
            <p>
              {needsKey
                ? 'Set your OpenAI API key in Settings to use the assistant.'
                : 'Inspect output, untangle errors, or continue an interactive session.'}
            </p>
            {!needsKey && (
              <div className="suggestions">
                {['Explain the current terminal screen', 'Help me continue this session'].map(
                  (question) => (
                    <button
                      key={question}
                      onClick={() => {
                        setDraft(question);
                        props.inputRef.current?.focus();
                      }}
                    >
                      <span>{question}</span>
                      <ArrowUp size={13} />
                    </button>
                  ),
                )}
              </div>
            )}
            {!props.settings.hasApiKey && (
              <button className="connect-link" onClick={props.onSettings}>
                Add your OpenAI key to get started <span>→</span>
              </button>
            )}
          </div>
        )}
        <Transcript
          items={showHistory ? (selectedChat?.items ?? []) : props.state.items}
          turns={showHistory ? selectedChat?.completedTurns : props.state.completedTurns}
          activeRequestId={showHistory ? null : props.state.activeRequestId}
        />
        {!showHistory && props.state.activeRequestId && (
          <div className="thinking-indicator">
            <span className="running-shimmer">
              {(props.state.phase || 'Thinking')
                .replace(/\s*·?\s*\d+\/\d+ actions/gi, '')
                .replace(/^·\s*/, '')}
            </span>
          </div>
        )}
      </div>
      <div className="chat-composer-area" hidden={showHistory}>
        {needsKey && props.state.items.length > 0 && (
          <button className="connect-link" onClick={props.onSettings}>
            Set your OpenAI API key in Settings →
          </button>
        )}
        {props.state.pausedReason && (
          <div className="agent-paused" role="status">
            <span>{props.state.pausedReason}</span>
            <button
              className="approve-button"
              onClick={props.onResume}
              disabled={
                needsKey ||
                busy ||
                props.modeUpdating ||
                (!props.attachments.length && !props.localContext)
              }
            >
              Resume / Continue
            </button>
          </div>
        )}
        <div className="context-heading">
          <span>{props.followFocus ? 'FOLLOWING FOCUSED TERMINAL' : 'ATTACHED TERMINALS'}</span>
          <button
            className="quiet-button context-expand"
            onClick={() => setShowAttachments((value) => !value)}
            aria-expanded={showAttachments}
          >
            Select terminals <ChevronDown size={11} />
          </button>
        </div>
        <div className="context-chips">
          {props.attachments.map((attachment) => (
            <span className="context-chip included" key={attachment.sessionId}>
              <span>{compactTerminalLabel(attachment.label)}</span>
              <button
                className="context-chip-remove"
                aria-label={`Remove ${compactTerminalLabel(attachment.label)} from assistant context`}
                title="Remove from assistant context"
                onClick={() => {
                  const remaining = props.attachments
                    .filter((selected) => selected.sessionId !== attachment.sessionId)
                    .map(
                      (selected) =>
                        props.availableAttachments.find(
                          (candidate) => candidate.sessionId === selected.sessionId,
                        )?.paneId,
                    )
                    .filter((paneId): paneId is string => Boolean(paneId));
                  props.onAttachmentsChange(remaining);
                }}
              >
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
        {props.localContext && (
          <div className="local-context">
            <button
              className="context-chip"
              disabled={needsKey || props.localContextLoading}
              onClick={
                props.localContext ? props.onRemoveLocalDirectory : props.onChooseLocalDirectory
              }
            >
              <FolderOpen size={12} />
              {props.localContextLoading
                ? 'Loading LOCAL directory…'
                : props.localContext
                  ? `LOCAL: ${props.localContext.directory}`
                  : 'Attach LOCAL directory'}
              {props.localContext ? <X size={10} /> : <Plus size={10} />}
            </button>
            {props.localContext && (
              <details>
                <summary>LOCAL directory preview</summary>
                <pre>
                  {props.localContext.listing.entries
                    .map((entry) => entry.name + (entry.kind === 'directory' ? '/' : ''))
                    .join('\n') || '(No entries)'}
                </pre>
                {props.localContext.listing.truncated && (
                  <span>Listing limited to 200 entries</span>
                )}
              </details>
            )}
          </div>
        )}
        {!props.attachments.length && (
          <p className="context-error">Select an available terminal to continue.</p>
        )}
        {showAttachments && (
          <div className="attachment-selector">
            <button
              className="quiet-button"
              aria-pressed={props.followFocus}
              onClick={() => props.onAttachmentsChange(null)}
            >
              Follow focus
            </button>
            {props.availableAttachments.map((attachment) => (
              <label key={attachment.paneId}>
                <input
                  type="checkbox"
                  disabled={
                    !attachment.sessionId ||
                    (props.attachments.length >= MAX_TERMINAL_ATTACHMENTS &&
                      !props.attachments.some(
                        (selected) => selected.sessionId === attachment.sessionId,
                      ))
                  }
                  checked={props.attachments.some(
                    (selected) => selected.sessionId === attachment.sessionId,
                  )}
                  onChange={(event) => {
                    const selected = props.availableAttachments
                      .filter((item) =>
                        props.attachments.some((current) => current.sessionId === item.sessionId),
                      )
                      .map((item) => item.paneId);
                    props.onAttachmentsChange(
                      event.target.checked
                        ? [...selected, attachment.paneId]
                        : selected.filter((id) => id !== attachment.paneId),
                    );
                  }}
                />
                {compactTerminalLabel(attachment.label)}
                {!attachment.sessionId && ' (unavailable)'}
              </label>
            ))}
          </div>
        )}
        <div className="composer">
          <textarea
            ref={props.inputRef}
            aria-label="Ask the assistant"
            disabled={needsKey}
            placeholder={needsKey ? 'Set your API key in Settings to use AI…' : 'Do anything…'}
            rows={1}
            spellCheck={false}
            value={draft}
            maxLength={8192}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <div className="composer-footer">
            <button
              className="composer-attach-button"
              aria-label="Attach LOCAL directory"
              title={
                props.localContextLoading ? 'Loading local directory…' : 'Attach local directory'
              }
              disabled={needsKey || props.localContextLoading}
              onClick={props.onChooseLocalDirectory}
            >
              <Plus size={17} />
            </button>
            <label className="composer-control permission-control">
              <span className="sr-only">Assistant permissions</span>
              <ComposerMenu
                ariaLabel="Assistant mode"
                className="permission-menu"
                value={props.mode}
                disabled={needsKey || props.modeUpdating || busy}
                options={[
                  {
                    value: 'ask',
                    label: 'Ask for approval',
                    description: 'Confirm every command or input sent to an attached terminal.',
                  },
                  {
                    value: 'auto',
                    label: 'Approve for me',
                    description: 'Automatically approve routine actions; pause for risky ones.',
                  },
                  {
                    value: 'full',
                    label: 'Full access',
                    description: 'Run commands and send terminal input without approval prompts.',
                  },
                ]}
                onChange={(value) => props.onModeChange(value as AgentMode)}
              />
            </label>
            <AssistantOptionsMenu
              model={props.settings.model}
              recentModelOptions={recentModels(availableModels, props.settings.model).map(
                (model) => ({ value: model.id, label: modelLabel(model.id) }),
              )}
              modelOptions={availableModels.map((model) => ({
                value: model.id,
                label: modelLabel(model.id),
              }))}
              effort={props.reasoningEffort ?? 'medium'}
              effortOptions={[
                { value: 'none', label: 'No reasoning', compactLabel: 'None' },
                { value: 'low', label: 'Low effort', compactLabel: 'Low' },
                { value: 'medium', label: 'Medium effort', compactLabel: 'Medium' },
                { value: 'high', label: 'High effort', compactLabel: 'High' },
              ]}
              disabled={needsKey || busy || props.modelsLoading || !props.onModelChange}
              onModelChange={(value) => props.onModelChange?.(value)}
              onEffortChange={(value) => props.onReasoningEffortChange?.(value)}
            />
            {busy ? (
              <button
                className="send-button stop-button"
                aria-label="Stop response"
                onClick={props.onStop}
              >
                <Square size={13} fill="currentColor" />
              </button>
            ) : (
              <button
                className="send-button"
                aria-label="Send question"
                disabled={
                  needsKey ||
                  !draft.trim() ||
                  props.modeUpdating ||
                  props.modelsLoading ||
                  props.localContextLoading ||
                  (!props.attachments.length && !props.localContext)
                }
                onClick={() => void send()}
              >
                <ArrowUp size={17} />
              </button>
            )}
          </div>
        </div>
        <div className="chat-footer">
          <span className="shortcut-hints">
            ↵ Send <span className="separator">·</span> ⇧↵ New line
          </span>
        </div>
      </div>
    </aside>
  );
}
