mod chat;
mod connection;
mod context;
mod hotkeys;
mod menus;
mod permissions;
mod redaction;
mod runner;
mod settings;
mod shell_integration;
mod streaming;
mod terminal;
mod workspaces;

use std::{collections::HashSet, sync::Mutex};
use tauri::{ipc::Channel, Emitter, Manager, State, WebviewWindow};

struct AppState {
    workspaces: Mutex<workspaces::Workspaces>,
    settings: settings::SettingsStore,
    hotkey_editors: Mutex<HashSet<String>>,
}
impl AppState {
    fn registry(&self) -> Result<std::sync::MutexGuard<'_, workspaces::Workspaces>, String> {
        self.workspaces
            .lock()
            .map_err(|_| "Workspace state unavailable".into())
    }
    fn shutdown(&self) {
        if let Ok(mut registry) = self.registry() {
            registry.shutdown();
        }
    }
}

#[tauri::command]
fn terminal_start(
    tab_id: String,
    source_session_id: Option<String>,
    output: Channel<terminal::TerminalEvent>,
    window: WebviewWindow,
    state: State<AppState>,
) -> Result<terminal::TerminalInfo, String> {
    let mut registry = state.registry()?;
    let directory = registry.starting_directory(window.label(), source_session_id.as_deref());
    let workspace = registry.open(window.label(), &tab_id)?;
    if let Some(previous) = workspace.terminal.take() {
        let previous_id = previous.id.clone();
        previous.stop();
        registry.chat(window.label())?.cancel_session(&previous_id);
    }
    let session =
        terminal::TerminalSession::start(output, directory).map_err(|error| error.to_string())?;
    let info = session.info();
    registry.open(window.label(), &tab_id)?.terminal = Some(session);
    Ok(info)
}

#[tauri::command]
async fn terminal_input(
    session_id: String,
    data: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let session = {
        let registry = state.registry()?;
        let session = registry.session(window.label(), &session_id)?;
        registry.manual_input(window.label(), &session_id);
        session
    };
    // PTY writes can block until the shell reads a large paste; keep IPC acknowledgments responsive.
    tokio::task::spawn_blocking(move || session.write(&data).map_err(|error| error.to_string()))
        .await
        .map_err(|error| format!("Terminal input task failed: {error}"))?
}

#[tauri::command]
fn terminal_resize(
    session_id: String,
    columns: u16,
    rows: u16,
    window: WebviewWindow,
    state: State<AppState>,
) -> Result<(), String> {
    state
        .registry()?
        .session(window.label(), &session_id)?
        .resize(columns, rows)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn terminal_publish_snapshot(
    snapshot: terminal::TerminalSnapshot,
    window: WebviewWindow,
    state: State<AppState>,
) -> Result<(), String> {
    let session = state
        .registry()?
        .session(window.label(), &snapshot.session_id)?;
    session
        .publish_snapshot(snapshot)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn terminal_revision(
    session_id: String,
    window: WebviewWindow,
    state: State<AppState>,
) -> Result<u64, String> {
    state
        .registry()?
        .session(window.label(), &session_id)?
        .current_revision()
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn terminal_interrupt(
    session_id: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let session = {
        let registry = state.registry()?;
        let session = registry.session(window.label(), &session_id)?;
        registry.manual_input(window.label(), &session_id);
        session
    };
    tokio::task::spawn_blocking(move || session.write("\u{3}").map_err(|error| error.to_string()))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
fn chat_set_mode(
    mode: permissions::PermissionMode,
    window: WebviewWindow,
    state: State<AppState>,
) -> Result<(), String> {
    state
        .registry()?
        .chat(window.label())?
        .set_mode(mode)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn terminal_ack(
    session_id: String,
    sequence: u64,
    window: WebviewWindow,
    state: State<AppState>,
) -> Result<(), String> {
    state
        .registry()?
        .session(window.label(), &session_id)?
        .acknowledge(sequence);
    Ok(())
}

#[tauri::command]
fn terminal_stop(
    session_id: String,
    window: WebviewWindow,
    state: State<AppState>,
) -> Result<(), String> {
    let mut registry = state.registry()?;
    registry.chat(window.label())?.cancel_session(&session_id);
    registry.session(window.label(), &session_id)?.stop();
    Ok(())
}

#[tauri::command]
fn prepare_context(
    session_id: String,
    directory_override: Option<String>,
    window: WebviewWindow,
    state: State<AppState>,
) -> Result<context::ContextSnapshot, String> {
    let session = state.registry()?.session(window.label(), &session_id)?;
    let directory = if let Some(directory) = directory_override {
        std::path::PathBuf::from(directory)
    } else {
        session.cwd().map_err(|error| {
            format!("Cannot track the current directory: {error}. Choose a directory for chat.")
        })?
    };
    context::snapshot(&directory).map_err(|error| error.to_string())
}

#[tauri::command]
fn hotkeys_editing(
    editing: bool,
    window: WebviewWindow,
    state: State<AppState>,
) -> Result<(), String> {
    let mut editors = state
        .hotkey_editors
        .lock()
        .map_err(|_| "Shortcut state unavailable")?;
    let previous = editors.clone();
    if editing {
        editors.insert(window.label().to_owned());
    } else {
        editors.remove(window.label());
    }
    // Let the web view record existing menu shortcuts while Settings is open.
    if let Err(error) = menus::apply(
        window.app_handle(),
        &if editors.is_empty() {
            state
                .settings
                .hotkeys()
                .map_err(|error| error.to_string())?
        } else {
            hotkeys::Hotkeys::new()
        },
    ) {
        *editors = previous;
        let _ = menus::apply(
            window.app_handle(),
            &if editors.is_empty() {
                state
                    .settings
                    .hotkeys()
                    .map_err(|error| error.to_string())?
            } else {
                hotkeys::Hotkeys::new()
            },
        );
        return Err(error.to_string());
    }
    Ok(())
}

#[tauri::command]
fn settings_get(state: State<AppState>) -> Result<settings::SettingsView, String> {
    state.settings.view().map_err(|error| error.to_string())
}

#[tauri::command]
async fn models_list(
    api_key: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<settings::ModelOption>, String> {
    let key = state
        .settings
        .connection_key(api_key.as_deref())
        .map_err(|error| error.to_string())?;
    connection::list_models(&key)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn model_save(
    model: String,
    reasoning_effort: chat::ReasoningEffort,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<settings::SettingsView, String> {
    let key = state
        .settings
        .connection_key(None)
        .map_err(|error| error.to_string())?;
    let reasoning_effort = connection::validate(&key, &model, reasoning_effort)
        .await
        .map_err(|error| error.to_string())?;
    let view = state
        .settings
        .save_model(model, reasoning_effort)
        .map_err(|error| error.to_string())?;
    window
        .app_handle()
        .emit("settings-changed", &view)
        .map_err(|error| error.to_string())?;
    Ok(view)
}

#[tauri::command]
async fn settings_save(
    model: String,
    api_key: Option<String>,
    hotkeys: Option<hotkeys::Hotkeys>,
    reasoning_effort: chat::ReasoningEffort,
    test_connection: bool,
    redact_sensitive_info: Option<bool>,
    show_status_bar: Option<bool>,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<settings::SettingsView, String> {
    let previous = state
        .settings
        .hotkeys()
        .map_err(|error| error.to_string())?;
    let next = hotkeys.unwrap_or_else(|| previous.clone());
    hotkeys::validate(&next).map_err(|error| error.to_string())?;
    let current = state.settings.view().map_err(|error| error.to_string())?;
    let connection_changed = model != current.model
        || reasoning_effort != current.reasoning_effort
        || api_key.as_ref().is_some_and(|key| !key.is_empty());
    let mut verified = current.connection_verified;
    let mut accepted_effort = reasoning_effort;
    if test_connection || connection_changed || (current.has_api_key && !verified) {
        let key = state
            .settings
            .connection_key(api_key.as_deref())
            .map_err(|error| error.to_string())?;
        // No key or model is persisted until the provider accepts the complete configuration.
        accepted_effort = connection::validate(&key, &model, reasoning_effort)
            .await
            .map_err(|error| error.to_string())?;
        verified = true;
    }
    let editing = !state
        .hotkey_editors
        .lock()
        .map_err(|_| "Shortcut state unavailable")?
        .is_empty();
    if let Err(error) = menus::apply(
        window.app_handle(),
        &if editing {
            hotkeys::Hotkeys::new()
        } else {
            next.clone()
        },
    ) {
        let _ = menus::apply(
            window.app_handle(),
            &if editing {
                hotkeys::Hotkeys::new()
            } else {
                previous.clone()
            },
        );
        return Err(error.to_string());
    }
    let view = match state.settings.save(
        model,
        api_key,
        next,
        accepted_effort,
        verified,
        redact_sensitive_info.unwrap_or(current.redact_sensitive_info),
        show_status_bar.unwrap_or(current.show_status_bar),
    ) {
        Ok(view) => view,
        Err(error) => {
            let _ = menus::apply(
                window.app_handle(),
                &if editing {
                    hotkeys::Hotkeys::new()
                } else {
                    previous.clone()
                },
            );
            return Err(error.to_string());
        }
    };
    window
        .app_handle()
        .emit("settings-changed", &view)
        .map_err(|error| error.to_string())?;
    Ok(view)
}

#[tauri::command]
fn settings_delete_key(
    window: WebviewWindow,
    state: State<AppState>,
) -> Result<settings::SettingsView, String> {
    let view = state
        .settings
        .delete_key()
        .map_err(|error| error.to_string())?;
    window
        .app_handle()
        .emit("settings-changed", &view)
        .map_err(|error| error.to_string())?;
    Ok(view)
}

#[tauri::command]
fn chat_start(
    input: chat::ChatInput,
    events: Channel<chat::ChatEvent>,
    window: WebviewWindow,
    state: State<AppState>,
) -> Result<(), String> {
    let (model, api_key, redact_sensitive_info) = state
        .settings
        .credentials()
        .map_err(|error| error.to_string())?;
    if input.session_id != "window" {
        return Err("Invalid window chat routing".into());
    }
    if input.attachments.len() > 16 {
        return Err("Attach at most 16 terminal sessions".into());
    }
    let mut registry = state.registry()?;
    let mut sessions = std::collections::HashMap::new();
    for attachment in &input.attachments {
        if attachment.label.len() > 256 || sessions.contains_key(&attachment.session_id) {
            return Err("Invalid terminal attachment".into());
        }
        sessions.insert(
            attachment.session_id.clone(),
            registry.session(window.label(), &attachment.session_id)?,
        );
    }
    let mut input = input;
    input.redact_sensitive_info = Some(redact_sensitive_info);
    registry
        .chat(window.label())?
        .start(input, events, model, api_key, sessions)
        .map_err(|error| error.to_string())
}
#[tauri::command]
fn chat_cancel(
    request_id: String,
    window: WebviewWindow,
    state: State<AppState>,
) -> Result<(), String> {
    uuid::Uuid::parse_str(&request_id).map_err(|_| "Invalid request ID")?;
    // Record early cancellation even when chat_start has not arrived yet.
    state.registry()?.chat(window.label())?.cancel(&request_id);
    Ok(())
}

#[tauri::command]
fn chat_waiting_for_user_input(
    session_id: String,
    window: WebviewWindow,
    state: State<AppState>,
) -> Result<bool, String> {
    Ok(state
        .registry()?
        .waiting_for_user_input(window.label(), &session_id))
}

#[tauri::command]
fn chat_decide(
    request_id: String,
    approval_id: String,
    approved: bool,
    reason: Option<String>,
    window: WebviewWindow,
    state: State<AppState>,
) -> Result<(), String> {
    let manager = state.registry()?.request(window.label(), &request_id)?;
    if let Some(reason) = reason {
        if approved {
            return Err("Steering must reject the action".into());
        }
        manager.steer(&request_id, &approval_id, reason)
    } else {
        manager.decide(&request_id, &approval_id, approved)
    }
    .map_err(|error| error.to_string())
}
#[tauri::command]
fn chat_clear(window: WebviewWindow, state: State<AppState>) -> Result<(), String> {
    state.registry()?.chat(window.label())?.clear();
    Ok(())
}
#[tauri::command]
fn workspace_close(
    tab_id: Option<String>,
    tab_ids: Option<Vec<String>>,
    confirmed: bool,
    frontend_busy: bool,
    window: WebviewWindow,
    state: State<AppState>,
) -> Result<bool, String> {
    let mut registry = state.registry()?;
    if tab_id.is_some() && tab_ids.is_some() {
        return Err("Choose one session or a group".into());
    }
    if let Some(ids) = tab_ids.or_else(|| tab_id.map(|id| vec![id])) {
        return registry.close_tabs_if_idle(window.label(), &ids, confirmed, frontend_busy);
    }
    let busy = registry.chat(window.label())?.has_active_request()
        || registry
            .tabs
            .values()
            .any(|tab| tab.owner == window.label() && tab.busy());
    if !confirmed && (busy || frontend_busy) {
        return Ok(false);
    }
    // Destroy bypasses CloseRequested after the user has approved closure.
    drop(registry);
    window.destroy().map_err(|error| error.to_string())?;
    state.registry()?.close_window(window.label());
    Ok(true)
}
#[tauri::command]
fn window_new(
    source_session_id: Option<String>,
    window: WebviewWindow,
    state: State<AppState>,
) -> Result<(), String> {
    create_window(
        window.app_handle(),
        window.label(),
        source_session_id.as_deref(),
        &state,
    )
}
fn create_window(
    app: &tauri::AppHandle,
    owner: &str,
    source: Option<&str>,
    state: &AppState,
) -> Result<(), String> {
    let label = format!("window-{}", uuid::Uuid::new_v4());
    let directory =
        source.and_then(|id| state.registry().ok()?.session(owner, id).ok()?.cwd().ok());
    if let Some(directory) = directory {
        state
            .registry()?
            .directories
            .insert(label.clone(), directory);
    }
    let mut config = app.config().app.windows[0].clone();
    config.label = label.clone();
    let result =
        tauri::WebviewWindowBuilder::from_config(app, &config).and_then(|builder| builder.build());
    if let Err(error) = result {
        state.registry()?.directories.remove(&label);
        return Err(error.to_string());
    }
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let settings = settings::SettingsStore::new(app.path().app_config_dir()?);
            app.manage(AppState {
                hotkey_editors: Mutex::new(HashSet::new()),
                workspaces: Mutex::new(workspaces::Workspaces::default()),
                settings,
            });
            let bindings = app
                .state::<AppState>()
                .settings
                .hotkeys()
                .unwrap_or_else(|_| hotkeys::defaults());
            let menu = menus::build(app.handle(), &bindings)?;
            app.set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            let action = event.id().as_ref();
            if hotkeys::actions()
                .iter()
                .any(|definition| definition.id == action)
            {
                if let Some(window) = app
                    .webview_windows()
                    .values()
                    .find(|window| window.is_focused().unwrap_or(false))
                {
                    let _ = window.emit("workspace-action", action);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            terminal_start,
            terminal_input,
            terminal_resize,
            terminal_publish_snapshot,
            terminal_revision,
            terminal_interrupt,
            terminal_ack,
            terminal_stop,
            prepare_context,
            settings_get,
            models_list,
            model_save,
            hotkeys_editing,
            settings_save,
            settings_delete_key,
            chat_start,
            chat_cancel,
            chat_waiting_for_user_input,
            chat_decide,
            chat_clear,
            chat_set_mode,
            workspace_close,
            window_new,
        ])
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window.emit("workspace-action", "close-window");
            }
            tauri::WindowEvent::Destroyed => {
                if let Ok(mut editors) = window.state::<AppState>().hotkey_editors.lock() {
                    editors.remove(window.label());
                    if editors.is_empty() {
                        if let Ok(bindings) = window.state::<AppState>().settings.hotkeys() {
                            let _ = menus::apply(window.app_handle(), &bindings);
                        }
                    }
                }
                if let Ok(mut registry) = window.state::<AppState>().registry() {
                    registry.close_window(window.label());
                }
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("Could not initialize Nexus")
        .run(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
            ) {
                app.state::<AppState>().shutdown();
            }
        });
}
