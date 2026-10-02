use crate::{
    chat::ReasoningEffort,
    hotkeys::{self, Hotkeys},
};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, sync::Mutex};

const SERVICE: &str = "dev.reece.ai-terminal.openai";
const ACCOUNT: &str = "api-key";
pub const DEFAULT_MODEL: &str = "gpt-5.4-mini";

fn default_redact_sensitive_info() -> bool {
    true
}

#[derive(Clone, Serialize, Deserialize)]
struct Settings {
    model: String,
    #[serde(default = "hotkeys::defaults")]
    hotkeys: Hotkeys,
    #[serde(default)]
    hotkeys_version: u32,
    #[serde(default)]
    reasoning_effort: ReasoningEffort,
    #[serde(default)]
    connection_verified: bool,
    #[serde(default = "default_redact_sensitive_info")]
    redact_sensitive_info: bool,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            model: DEFAULT_MODEL.into(),
            hotkeys: hotkeys::defaults(),
            hotkeys_version: 1,
            reasoning_effort: ReasoningEffort::Medium,
            connection_verified: false,
            redact_sensitive_info: true,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    pub model: String,
    pub has_api_key: bool,
    pub hotkeys: Hotkeys,
    pub reasoning_effort: ReasoningEffort,
    pub connection_verified: bool,
    pub redact_sensitive_info: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    pub id: String,
    #[serde(default, alias = "owned_by")]
    pub owned_by: String,
}

pub struct SettingsStore {
    directory: PathBuf,
    lock: Mutex<()>,
}
impl SettingsStore {
    pub fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            lock: Mutex::new(()),
        }
    }

    fn load(&self) -> Result<Settings> {
        match fs::read(self.directory.join("settings.json")) {
            Ok(bytes) => {
                let mut settings: Settings =
                    serde_json::from_slice(&bytes).context("Saved settings are invalid")?;
                if settings.hotkeys_version == 0 {
                    // Retire only the old defaults; preserve unrelated custom bindings.
                    for (action, binding) in [
                        ("previous-tab", "Cmd+Shift+BracketLeft"),
                        ("next-tab", "Cmd+Shift+BracketRight"),
                    ] {
                        if settings.hotkeys.get(action).and_then(Option::as_deref) == Some(binding)
                        {
                            settings.hotkeys.insert(action.into(), None);
                        }
                    }
                    settings.hotkeys_version = 1;
                }
                // Introduce new actions without overwriting bindings or creating conflicts.
                for (action, binding) in hotkeys::defaults() {
                    if !settings.hotkeys.contains_key(&action) {
                        let binding = binding.filter(|candidate| {
                            !settings
                                .hotkeys
                                .values()
                                .any(|existing| existing.as_ref() == Some(candidate))
                        });
                        settings.hotkeys.insert(action, binding);
                    }
                }
                Ok(settings)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()),
            Err(error) => Err(error).context("Could not read settings"),
        }
    }

    pub fn view(&self) -> Result<SettingsView> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| anyhow::anyhow!("Settings unavailable"))?;
        let settings = self.load()?;
        Ok(SettingsView {
            model: settings.model,
            hotkeys: settings.hotkeys,
            reasoning_effort: settings.reasoning_effort,
            connection_verified: settings.connection_verified,
            redact_sensitive_info: settings.redact_sensitive_info,

            has_api_key: keychain_read()?.is_some(),
        })
    }

    pub fn hotkeys(&self) -> Result<Hotkeys> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| anyhow::anyhow!("Settings unavailable"))?;
        Ok(self.load()?.hotkeys)
    }

    pub fn save(
        &self,
        model: String,
        api_key: Option<String>,
        hotkeys: Hotkeys,
        reasoning_effort: ReasoningEffort,
        connection_verified: bool,
        redact_sensitive_info: bool,
    ) -> Result<SettingsView> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| anyhow::anyhow!("Settings unavailable"))?;
        hotkeys::validate(&hotkeys)?;
        let model = model.trim().to_owned();
        if model.is_empty() || model.len() > 120 || model.chars().any(char::is_whitespace) {
            bail!("Enter a valid model ID");
        }
        if let Some(api_key) = api_key.filter(|key| !key.trim().is_empty()) {
            if api_key.len() > 1024 || api_key.chars().any(char::is_whitespace) {
                bail!("API key must not contain whitespace");
            }
            keychain_write(&api_key)?;
        }
        fs::create_dir_all(&self.directory)?;
        let temporary = self.directory.join("settings.tmp");
        fs::write(
            &temporary,
            serde_json::to_vec_pretty(&Settings {
                model: model.clone(),
                hotkeys: hotkeys.clone(),
                hotkeys_version: 1,
                reasoning_effort,
                connection_verified,
                redact_sensitive_info,
            })?,
        )?;
        fs::rename(temporary, self.directory.join("settings.json"))?;
        Ok(SettingsView {
            model,
            hotkeys,
            reasoning_effort,
            connection_verified,
            redact_sensitive_info,

            has_api_key: keychain_read()?.is_some(),
        })
    }

    pub fn credentials(&self) -> Result<(String, String, bool)> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| anyhow::anyhow!("Settings unavailable"))?;
        let settings = self.load()?;
        let key = keychain_read()?.context("Add your OpenAI API key in Settings to use chat")?;
        Ok((settings.model, key, settings.redact_sensitive_info))
    }

    pub fn connection_key(&self, draft_key: Option<&str>) -> Result<String> {
        if let Some(key) = draft_key.filter(|key| !key.is_empty()) {
            if key.len() > 1024 || key.chars().any(char::is_whitespace) {
                bail!("API key must not contain whitespace");
            }
            return Ok(key.to_owned());
        }
        keychain_read()?.context("Add your OpenAI API key in Settings to connect AI")
    }

    pub fn save_model(
        &self,
        model: String,
        reasoning_effort: ReasoningEffort,
    ) -> Result<SettingsView> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| anyhow::anyhow!("Settings unavailable"))?;
        let model = model.trim().to_owned();
        if model.is_empty() || model.len() > 120 || model.chars().any(char::is_whitespace) {
            bail!("Enter a valid model ID");
        }
        let mut settings = self.load()?;
        settings.model = model;
        settings.reasoning_effort = reasoning_effort;
        settings.connection_verified = true;
        fs::create_dir_all(&self.directory)?;
        let temporary = self.directory.join("settings.tmp");
        fs::write(&temporary, serde_json::to_vec_pretty(&settings)?)?;
        fs::rename(temporary, self.directory.join("settings.json"))?;
        Ok(SettingsView {
            model: settings.model,
            hotkeys: settings.hotkeys,
            reasoning_effort: settings.reasoning_effort,
            connection_verified: settings.connection_verified,
            redact_sensitive_info: settings.redact_sensitive_info,

            has_api_key: keychain_read()?.is_some(),
        })
    }

    pub fn delete_key(&self) -> Result<SettingsView> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| anyhow::anyhow!("Settings unavailable"))?;
        keychain_delete()?;
        let settings = self.load()?;
        Ok(SettingsView {
            model: settings.model,
            hotkeys: settings.hotkeys,
            reasoning_effort: settings.reasoning_effort,
            connection_verified: false,
            redact_sensitive_info: settings.redact_sensitive_info,

            has_api_key: false,
        })
    }
}

#[cfg(target_os = "macos")]
fn keychain_read() -> Result<Option<String>> {
    use security_framework::passwords::{generic_password, PasswordOptions};
    match generic_password(PasswordOptions::new_generic_password(SERVICE, ACCOUNT)) {
        Ok(bytes) => Ok(Some(
            String::from_utf8(bytes).context("Stored API key is invalid")?,
        )),
        Err(error) if error.code() == -25300 => Ok(None),
        Err(error) => Err(error).context("Could not access macOS Keychain"),
    }
}
#[cfg(target_os = "macos")]
fn keychain_write(key: &str) -> Result<()> {
    security_framework::passwords::set_generic_password(SERVICE, ACCOUNT, key.as_bytes())
        .context("Could not save the API key to macOS Keychain")
}
#[cfg(target_os = "macos")]
fn keychain_delete() -> Result<()> {
    match security_framework::passwords::delete_generic_password(SERVICE, ACCOUNT) {
        Ok(()) => Ok(()),
        Err(error) if error.code() == -25300 => Ok(()),
        Err(error) => Err(error).context("Could not delete the API key"),
    }
}
#[cfg(not(target_os = "macos"))]
fn keychain_read() -> Result<Option<String>> {
    bail!("Keychain requires macOS")
}
#[cfg(not(target_os = "macos"))]
fn keychain_write(_key: &str) -> Result<()> {
    bail!("Keychain requires macOS")
}
#[cfg(not(target_os = "macos"))]
fn keychain_delete() -> Result<()> {
    bail!("Keychain requires macOS")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn existing_model_only_settings_receive_default_hotkeys() {
        let settings: Settings = serde_json::from_str(r#"{"model":"old-model"}"#).unwrap();
        assert_eq!(settings.hotkeys, hotkeys::defaults());
        assert!(!settings.connection_verified);
        assert_eq!(settings.reasoning_effort, ReasoningEffort::Medium);
        assert!(settings.redact_sensitive_info);
    }
    #[test]
    fn retires_old_defaults_without_overwriting_custom_bindings() {
        let directory = tempfile::tempdir().unwrap();
        let mut settings = Settings {
            hotkeys_version: 0,
            ..Settings::default()
        };
        settings
            .hotkeys
            .insert("previous-tab".into(), Some("Cmd+Shift+BracketLeft".into()));
        settings
            .hotkeys
            .insert("next-tab".into(), Some("Ctrl+KeyL".into()));
        fs::write(
            directory.path().join("settings.json"),
            serde_json::to_vec(&settings).unwrap(),
        )
        .unwrap();
        let store = SettingsStore::new(directory.path().to_owned());
        let migrated = store.hotkeys().unwrap();
        assert_eq!(migrated["previous-tab"], None);
        assert_eq!(migrated["next-tab"].as_deref(), Some("Ctrl+KeyL"));
        settings.hotkeys_version = 1;
        fs::write(
            directory.path().join("settings.json"),
            serde_json::to_vec(&settings).unwrap(),
        )
        .unwrap();
        assert_eq!(
            store.hotkeys().unwrap()["previous-tab"].as_deref(),
            Some("Cmd+Shift+BracketLeft")
        );
    }
    #[test]
    fn new_cycle_shortcut_is_added_unless_a_custom_binding_already_uses_it() {
        let directory = tempfile::tempdir().unwrap();
        let store = SettingsStore::new(directory.path().to_owned());
        let mut settings = Settings::default();
        settings.hotkeys.remove("cycle-panes");
        fs::write(
            directory.path().join("settings.json"),
            serde_json::to_vec(&settings).unwrap(),
        )
        .unwrap();
        assert_eq!(
            store.hotkeys().unwrap()["cycle-panes"].as_deref(),
            Some("Cmd+Alt+Slash")
        );
        settings
            .hotkeys
            .insert("next-pane".into(), Some("Cmd+Alt+Slash".into()));
        fs::write(
            directory.path().join("settings.json"),
            serde_json::to_vec(&settings).unwrap(),
        )
        .unwrap();
        let loaded = store.hotkeys().unwrap();
        assert_eq!(loaded["cycle-panes"], None);
        assert_eq!(loaded["next-pane"].as_deref(), Some("Cmd+Alt+Slash"));
        hotkeys::validate(&loaded).unwrap();
    }
    #[test]
    fn custom_and_disabled_shortcuts_round_trip_without_credentials() {
        let mut settings = Settings::default();
        settings
            .hotkeys
            .insert("next-pane".into(), Some("Ctrl+KeyL".into()));
        settings.hotkeys.insert("previous-pane".into(), None);
        let bytes = serde_json::to_vec(&settings).unwrap();
        let restored: Settings = serde_json::from_slice(&bytes).unwrap();
        hotkeys::validate(&restored.hotkeys).unwrap();
        assert_eq!(settings.hotkeys, restored.hotkeys);
    }
}
