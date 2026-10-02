# 🌌 Nexus

*A macOS terminal with a window-level AI assistant.*

Nexus brings an AI agent directly into your terminal workflow. Press **Cmd+J**, attach terminal panes, and seamlessly ask the agent to inspect or work within your live shells, SSH sessions, and interactive applications (like Vim and less).

---

## ✨ Features

- **Integrated AI Assistant**: Seamlessly switch between chat and your terminal to get help, run commands, or inspect output.
- **Multi-pane & Multi-tab Interface**: Flexible layouts with intuitive keyboard shortcuts for splitting, navigating, and organizing your workspace.
- **Granular Permissions**: Maintain full control over what the AI can execute with configurable permission modes (Ask for approval, Approve for me, Full access).
- **Live Context Awareness**: The agent understands your current terminal state, including visible screen, cursor position, and recent scrollback.
- **Secure Local Execution**: API keys stay in your macOS Keychain. Optional local directory attachments enable scoped file reads without compromising security.
- **Automatic Redaction**: Sensitive credentials and common personal identifiers are redacted before context is sent to the AI assistant. This protection can be toggled in Settings.

## 🚀 Installation & First Use

1. **Download**: Grab the latest signed Apple Silicon or Intel DMG from the [Releases](#) page.
2. **Install**: Open the DMG and drag Nexus to your Applications folder.
3. **Configure**: Launch Nexus, press **Cmd+J** to open the assistant panel, and click the link to open Settings. Enter your OpenAI API key and select your preferred model.
   - *Note: Keys are securely stored in the macOS Keychain. The terminal functions normally even without an API key.*
4. **Test & Save**: Click **Test & save connection** to validate your credentials before starting.

To upgrade, simply replace the application in your Applications folder with the newest release. Settings, credentials, and local transcripts are preserved automatically.

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
| --- | --- |
| `Cmd+T` | Create a terminal tab |
| `Cmd+N` | Create an independent window |
| `Cmd+W` | Close the focused session |
| `Cmd+Shift+W` | Close the current window |
| `Cmd+D` | Split the focused session side by side |
| `Cmd+Shift+D` | Split the focused session top and bottom |
| `Cmd+1` … `Cmd+9` | Select a tab by its current position |
| `Cmd+Option+/` | Cycle through panes in the selected tab |
| `Cmd+Option+[ / ]` | Cycle through panes in the selected tab |
| `Cmd+Option+arrows`| Focus a pane in that direction |
| `Cmd+,` | Open Settings |
| `Cmd+J` | Toggle chat and move focus between chat and terminal |
| `Escape` | Close chat and focus the terminal |
| `Enter` *(in chat)* | Send a question |
| `Shift+Enter` *(in chat)*| Insert a newline |
| `Cmd+C` / `Cmd+V` | Copy selected terminal text / paste |
| `Ctrl+C` *(in terminal)*| Interrupt the foreground command |

## 🔒 Permissions & Security

Nexus enforces strict, transparent permission boundaries for the AI agent. Each window operates with its own permission mode:

- 🛡️ **Ask for approval** *(Default)*: Automatically inspects the terminal, but explicitly asks before sending any input or running local commands.
- 🤝 **Approve for me**: Automatically allows recognized, conservative inspection and navigation. Prompts for uncertain commands, script execution, edits, or consequential input.
- 🚀 **Full access**: Sends input and runs commands without approval, utilizing the attached session's privileges.

**Security Details:**
- Excluded paths (e.g., `.env*`, `.ssh`, `.aws`, common private key formats) are strictly protected from the `run_command` and local file read tools.
- Remote SSH contexts are handled safely; automated actions pause for human authentication prompts.
- All OpenAI requests are made with `store: false` to minimize provider data retention.
- Automatic redaction is enabled by default and can be toggled in Settings. It covers detected credentials, provider keys, private keys, email addresses, phone numbers, Social Security numbers, and credit-card numbers before provider requests.

## 🛠️ Development & Building from Source

### Prerequisites
- macOS 12+
- Node.js 22.12+ (Node 24 recommended)
- Rust 1.90+
- Xcode Command Line Tools

### Setup
```sh
npm ci
npm run app:dev
```

### Building
To create a local application bundle (targets your build machine's architecture):
```sh
npm run app:build
open "src-tauri/target/release/bundle/macos/Nexus.app"
```

For signed and notarized releases, run `npm run app:release` using the credentials detailed in [RELEASING.md](docs/RELEASING.md).

## 🏗️ Architecture & Structure

Nexus is built with a modern stack leveraging React, Tauri, and Rust:
- **`src/`**: React UI, xterm.js integration, typed IPC bridge, window-level agent, and request-scoped chat state.
- **`src-tauri/src/terminal.rs`**: PTY lifecycle, flow control, and native macOS directory tracking.
- **`src-tauri/src/chat.rs` & `permissions.rs`**: OpenAI terminal tool loop, in-memory history, conservative permission policy, and single-use approvals.
- **`src-tauri/src/context.rs` & `runner.rs`**: Scoped reads, task processes, SSE decoding, and Keychain/settings access.

## ✅ Testing & Verification

Ensure everything is running smoothly with the comprehensive test suite:

```sh
npm run check
npm run test:release
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

The Rust suite includes a mock API server and robust real PTY/process tests covering file inspection, output limits, Unicode handling, timeouts, and more. *No real API key or paid calls are required for automated tests.*

### Multi-session Smoke Test
Create two tabs and split one right, then split its focused pane down. Confirm there is only one assistant panel and draft per window. Attach panes across both tabs, switch focus, and verify customized attachments stay fixed. Resize splits and close a pane; confirm remaining terminals keep their output and lost attachments disappear. Restart an attached shell and confirm its replacement requires selection again. Create a second OS window and confirm conversations, attachments, and modes are independent. Check `Cmd+T`, `Cmd+N`, `Cmd+W`, `Cmd+Shift+W`, `Cmd+1–9`, and pane shortcuts. Confirm custom Settings shortcuts work in both windows and persist after relaunch.

### Agent Smoke Test
*(Uses your API key)* In a disposable directory, ask the agent to inspect the terminal and run `pwd`; verify **Ask** requests approval and **Auto** approves only recognized routine inspection. Reject an edit and confirm nothing is sent. Change output or resize while an approval is pending and confirm the stale action is rejected. In **Full**, try navigating `less README.md` and editing a disposable file in Vim. Type manually during agent work and confirm it pauses; **Resume** must retain the original task. Run a long job and confirm Stop leaves it running until explicit Interrupt. Attach an existing SSH session and confirm commands target that session, remote paths are never presented as local context, and authentication pauses for human entry. No automated test needs real SSH credentials or a paid API call.
