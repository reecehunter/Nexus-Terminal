use crate::{chat::ChatManager, terminal::TerminalSession};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::Arc,
};

pub struct Workspace {
    pub owner: String,
    pub terminal: Option<Arc<TerminalSession>>,
}
impl Workspace {
    pub fn busy(&self) -> bool {
        self.terminal
            .as_ref()
            .is_some_and(|session| session.has_foreground_job())
    }
    fn stop(&self) {
        if let Some(terminal) = &self.terminal {
            terminal.stop();
        }
    }
}
#[derive(Default)]
pub struct Workspaces {
    pub tabs: HashMap<String, Workspace>,
    chats: HashMap<String, Arc<ChatManager>>,
    pub directories: HashMap<String, PathBuf>,
    // Closed IDs cannot be revived by a delayed terminal_start IPC call.
    closed: HashSet<String>,
    closed_windows: HashSet<String>,
    shutting_down: bool,
}
impl Workspaces {
    pub fn starting_directory(&mut self, owner: &str, source: Option<&str>) -> Option<PathBuf> {
        if let Some(id) = source {
            self.session(owner, id)
                .ok()?
                .cwd()
                .ok()
                .filter(|path| path.is_dir())
        } else {
            self.directories.remove(owner).filter(|path| path.is_dir())
        }
    }
    pub fn open(&mut self, owner: &str, tab_id: &str) -> Result<&mut Workspace, String> {
        if self.shutting_down || self.closed_windows.contains(owner) {
            return Err("Window has closed".into());
        }
        uuid::Uuid::parse_str(tab_id).map_err(|_| "Invalid tab ID")?;
        if self.closed.contains(tab_id) {
            return Err("Tab has closed".into());
        }
        let workspace = self.tabs.entry(tab_id.into()).or_insert_with(|| Workspace {
            owner: owner.into(),
            terminal: None,
        });
        if workspace.owner != owner {
            return Err("Tab belongs to another window".into());
        }
        Ok(workspace)
    }
    pub fn tab(&self, owner: &str, tab_id: &str) -> Result<&Workspace, String> {
        self.tabs
            .get(tab_id)
            .filter(|tab| tab.owner == owner)
            .ok_or_else(|| "Tab unavailable in this window".into())
    }
    pub fn session(&self, owner: &str, session_id: &str) -> Result<Arc<TerminalSession>, String> {
        self.tabs
            .values()
            .filter(|tab| tab.owner == owner)
            .filter_map(|tab| tab.terminal.as_ref())
            .find(|session| session.id == session_id)
            .cloned()
            .ok_or_else(|| "Terminal session has ended. Restart the terminal.".into())
    }
    pub fn request(&self, owner: &str, request_id: &str) -> Result<Arc<ChatManager>, String> {
        self.chats
            .get(owner)
            .filter(|chat| chat.owns_request(request_id))
            .cloned()
            .ok_or_else(|| "Request is no longer active in this window".into())
    }
    pub fn chat(&mut self, owner: &str) -> Result<Arc<ChatManager>, String> {
        if self.shutting_down || self.closed_windows.contains(owner) {
            return Err("Window has closed".into());
        }
        Ok(self.chats.entry(owner.into()).or_default().clone())
    }
    pub fn manual_input(&self, owner: &str, session_id: &str) {
        if let Some(chat) = self.chats.get(owner) {
            if chat.accept_user_input(session_id) {
                return;
            }
            chat.pause_session(session_id, "Manual terminal input. Resume to continue.");
        }
    }
    pub fn waiting_for_user_input(&self, owner: &str, session_id: &str) -> bool {
        self.chats
            .get(owner)
            .is_some_and(|chat| chat.waiting_for_user_input(session_id))
    }
    pub fn close_tab(&mut self, owner: &str, tab_id: &str) -> Result<(), String> {
        if let Some(tab) = self.tabs.get(tab_id) {
            if tab.owner != owner {
                return Err("Tab belongs to another window".into());
            }
        }
        self.closed.insert(tab_id.into());
        if let Some(tab) = self.tabs.remove(tab_id) {
            if let Some(session) = &tab.terminal {
                if let Some(chat) = self.chats.get(owner) {
                    chat.cancel_session(&session.id);
                }
            }
            tab.stop();
        }
        Ok(())
    }
    pub fn close_tabs_if_idle(
        &mut self,
        owner: &str,
        ids: &[String],
        confirmed: bool,
        frontend_busy: bool,
    ) -> Result<bool, String> {
        if ids.is_empty() {
            return Err("No sessions selected".into());
        }
        let mut busy = frontend_busy;
        if let Some(chat) = self.chats.get(owner) {
            busy |= ids
                .iter()
                .filter_map(|id| self.tabs.get(id))
                .filter_map(|tab| tab.terminal.as_ref())
                .any(|session| chat.uses_session(&session.id));
        }
        // Validate the entire group before stopping any session or canceling requests.
        for id in ids {
            if self.tabs.contains_key(id) {
                busy |= self.tab(owner, id)?.busy();
            }
        }
        if !confirmed && busy {
            return Ok(false);
        }
        for id in ids {
            self.close_tab(owner, id)?;
        }
        Ok(true)
    }
    pub fn close_window(&mut self, owner: &str) {
        if let Some(chat) = self.chats.remove(owner) {
            chat.cancel_all();
        }
        self.closed_windows.insert(owner.into());
        let ids: Vec<_> = self
            .tabs
            .iter()
            .filter(|(_, tab)| tab.owner == owner)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            let _ = self.close_tab(owner, &id);
        }
        self.directories.remove(owner);
    }
    pub fn shutdown(&mut self) {
        for (_, chat) in self.chats.drain() {
            chat.cancel_all();
        }
        self.shutting_down = true;
        for (id, tab) in self.tabs.drain() {
            self.closed.insert(id);
            tab.stop();
        }
        self.directories.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ownership_and_cleanup_are_isolated() {
        let mut registry = Workspaces::default();
        let first = uuid::Uuid::new_v4().to_string();
        let second = uuid::Uuid::new_v4().to_string();
        registry.open("main", &first).unwrap();
        registry.open("window-2", &second).unwrap();
        assert!(registry.open("window-2", &first).is_err());
        assert!(registry.tab("window-2", &first).is_err());
        assert!(registry.close_tab("window-2", &first).is_err());
        registry.close_window("main");
        assert!(registry.open("main", &first).is_err());
        assert!(registry.tab("window-2", &second).is_ok());
        registry.shutdown();
        assert!(registry.tabs.is_empty());
    }
    #[test]
    fn assistants_are_shared_by_window_and_independent_across_windows() {
        let mut registry = Workspaces::default();
        let first = uuid::Uuid::new_v4().to_string();
        let second = uuid::Uuid::new_v4().to_string();
        registry.open("main", &first).unwrap();
        registry.open("main", &second).unwrap();
        let chat = registry.chat("main").unwrap();
        assert!(Arc::ptr_eq(&chat, &registry.chat("main").unwrap()));
        assert!(!Arc::ptr_eq(&chat, &registry.chat("other").unwrap()));
        registry.close_tab("main", &first).unwrap();
        assert!(Arc::ptr_eq(&chat, &registry.chat("main").unwrap()));
        registry.close_window("main");
        assert!(registry.chat("main").is_err());
        assert!(registry.chat("other").is_ok());
    }
    #[test]
    fn closing_before_start_prevents_resurrection() {
        let mut registry = Workspaces::default();
        let id = uuid::Uuid::new_v4().to_string();
        registry.close_tab("main", &id).unwrap();
        assert!(registry.open("main", &id).is_err());
    }
    #[test]
    fn destroyed_windows_reject_late_new_tabs() {
        let mut registry = Workspaces::default();
        registry.close_window("main");
        assert!(registry
            .open("main", &uuid::Uuid::new_v4().to_string())
            .is_err());
        registry.shutdown();
        assert!(registry
            .open("window-2", &uuid::Uuid::new_v4().to_string())
            .is_err());
    }
    #[test]
    fn initial_directory_is_consumed_once_and_missing_sources_fall_back() {
        let mut registry = Workspaces::default();
        let folder = tempfile::tempdir().unwrap();
        registry
            .directories
            .insert("main".into(), folder.path().into());
        assert_eq!(
            registry.starting_directory("main", None),
            Some(folder.path().into())
        );
        assert_eq!(registry.starting_directory("main", None), None);
        assert_eq!(registry.starting_directory("main", Some("missing")), None);
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn simultaneous_terminals_keep_output_directory_and_window_lifecycle_separate() {
        use std::sync::Mutex;
        use std::time::{Duration, Instant};
        fn terminal_at(directory: PathBuf) -> (Arc<TerminalSession>, Arc<Mutex<String>>) {
            let slot: Arc<Mutex<Option<Arc<TerminalSession>>>> = Arc::new(Mutex::new(None));
            let output = Arc::new(Mutex::new(String::new()));
            let callback_slot = slot.clone();
            let callback_output = output.clone();
            let channel = tauri::ipc::Channel::new(move |body| {
                let event: serde_json::Value = body.deserialize().unwrap();
                if event["type"] == "output" {
                    let bytes: Vec<u8> = serde_json::from_value(event["data"].clone()).unwrap();
                    callback_output
                        .lock()
                        .unwrap()
                        .push_str(&String::from_utf8_lossy(&bytes));
                    if let Some(session) = callback_slot.lock().unwrap().as_ref() {
                        session.acknowledge(event["sequence"].as_u64().unwrap());
                    }
                }
                Ok(())
            });
            let terminal = TerminalSession::start_at(channel, directory, false).unwrap();
            *slot.lock().unwrap() = Some(terminal.clone());
            (terminal, output)
        }
        fn wait_until(condition: impl Fn() -> bool) {
            let deadline = Instant::now() + Duration::from_secs(3);
            while !condition() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(10));
            }
            assert!(condition(), "PTY condition timed out");
        }
        let first_directory = tempfile::tempdir().unwrap();
        let second_directory = tempfile::tempdir().unwrap();
        let first_id = uuid::Uuid::new_v4().to_string();
        let second_id = uuid::Uuid::new_v4().to_string();
        let (first, first_output) = terminal_at(first_directory.path().into());
        let (second, second_output) = terminal_at(second_directory.path().into());
        let mut registry = Workspaces::default();
        registry.open("main", &first_id).unwrap().terminal = Some(first.clone());
        registry.open("window-2", &second_id).unwrap().terminal = Some(second.clone());
        first.write("printf 'FIRST_%s\\n' READY\r").unwrap();
        second.write("printf 'SECOND_%s\\n' READY\r").unwrap();
        wait_until(|| first_output.lock().unwrap().contains("FIRST_READY"));
        wait_until(|| second_output.lock().unwrap().contains("SECOND_READY"));
        assert!(!first_output.lock().unwrap().contains("SECOND_READY"));
        assert!(!second_output.lock().unwrap().contains("FIRST_READY"));
        assert!(registry.session("window-2", &first.id).is_err());
        assert_eq!(
            registry.starting_directory("main", Some(&first.id)),
            Some(first_directory.path().canonicalize().unwrap())
        );
        second.write("sleep 30\r").unwrap();
        wait_until(|| second.has_foreground_job());
        assert!(registry.tab("window-2", &second_id).unwrap().busy());
        registry.close_window("main");
        assert!(first.write("echo closed\r").is_err());
        assert!(registry.session("window-2", &second.id).is_ok());
        second.write("\u{3}").unwrap();
        second.write("printf 'SURVIVED_%s\\n' READY\r").unwrap();
        wait_until(|| second_output.lock().unwrap().contains("SURVIVED_READY"));
        registry.shutdown();
        assert!(second.write("echo closed\r").is_err());
    }
    #[test]
    fn group_close_is_atomic_and_cancel_preserves_every_session() {
        let mut registry = Workspaces::default();
        let first = uuid::Uuid::new_v4().to_string();
        let second = uuid::Uuid::new_v4().to_string();
        registry.open("main", &first).unwrap();
        registry.open("other", &second).unwrap();
        assert!(registry
            .close_tabs_if_idle("main", &[first.clone(), second.clone()], true, false)
            .is_err());
        assert!(registry.tab("main", &first).is_ok());
        assert!(!registry
            .close_tabs_if_idle("main", std::slice::from_ref(&first), false, true)
            .unwrap());
        assert!(registry.tab("main", &first).is_ok());
        assert!(registry
            .close_tabs_if_idle("main", std::slice::from_ref(&first), true, true)
            .unwrap());
        assert!(registry.tab("main", &first).is_err());
        assert!(registry.tab("other", &second).is_ok());
    }
}
