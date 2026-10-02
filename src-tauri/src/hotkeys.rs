use anyhow::{bail, Result};
use serde::Deserialize;
use std::{
    collections::{BTreeMap, HashSet},
    sync::LazyLock,
};

pub type Hotkeys = BTreeMap<String, Option<String>>;
#[derive(Deserialize)]
pub struct Action {
    pub id: String,
    pub title: String,
    pub group: String,
    pub binding: Option<String>,
}
#[derive(Deserialize)]
struct Definitions {
    actions: Vec<Action>,
    reserved: Vec<String>,
}
static DEFINITIONS: LazyLock<Definitions> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../src/hotkeys.json"))
        .expect("Bundled shortcut definitions must be valid")
});
pub fn actions() -> &'static [Action] {
    &DEFINITIONS.actions
}
pub fn defaults() -> Hotkeys {
    actions()
        .iter()
        .map(|action| (action.id.clone(), action.binding.clone()))
        .collect()
}
fn valid_code(code: &str) -> bool {
    matches!(
        code,
        "BracketLeft"
            | "BracketRight"
            | "Comma"
            | "Period"
            | "Slash"
            | "Backslash"
            | "Semicolon"
            | "Quote"
            | "Backquote"
            | "Minus"
            | "Equal"
            | "Space"
            | "Tab"
            | "Enter"
            | "Backspace"
            | "Delete"
            | "ArrowLeft"
            | "ArrowRight"
            | "ArrowUp"
            | "ArrowDown"
            | "Home"
            | "End"
            | "PageUp"
            | "PageDown"
    ) || code
        .strip_prefix("Key")
        .is_some_and(|letter| letter.len() == 1 && letter.as_bytes()[0].is_ascii_uppercase())
        || code
            .strip_prefix("Digit")
            .is_some_and(|digit| digit.len() == 1 && digit.as_bytes()[0].is_ascii_digit())
        || code
            .strip_prefix('F')
            .and_then(|number| number.parse::<u8>().ok())
            .is_some_and(|number| (1..=24).contains(&number) && code == format!("F{number}"))
}
pub fn validate(hotkeys: &Hotkeys) -> Result<()> {
    if hotkeys.len() != actions().len()
        || hotkeys
            .keys()
            .any(|id| !actions().iter().any(|action| &action.id == id))
    {
        bail!("Invalid shortcut actions");
    }
    let mut used = HashSet::new();
    for action in actions() {
        let Some(binding) = hotkeys.get(&action.id).and_then(Option::as_ref) else {
            continue;
        };
        let mut tokens: Vec<_> = binding.split('+').collect();
        let code = tokens.pop().unwrap_or("");
        let canonical: Vec<_> = ["Cmd", "Ctrl", "Alt", "Shift"]
            .into_iter()
            .filter(|modifier| tokens.contains(modifier))
            .chain(std::iter::once(code))
            .collect();
        if !valid_code(code)
            || !(tokens.contains(&"Cmd") || tokens.contains(&"Ctrl"))
            || canonical.join("+") != *binding
        {
            bail!("Invalid shortcut for {}", action.title);
        }
        if DEFINITIONS.reserved.contains(binding) {
            bail!("{binding} is reserved by macOS or standard editing commands");
        }
        if !used.insert(binding) {
            bail!("Duplicate shortcut: {binding}");
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn default_shortcuts_are_unique_and_complete() {
        validate(&defaults()).unwrap();
        assert_eq!(defaults()["previous-tab"], None);
        assert_eq!(defaults()["next-tab"], None);
    }
    #[test]
    fn rejects_conflicts_invalid_codes_and_reserved_native_shortcuts() {
        for value in [
            "Cmd+KeyT",
            "Cmd+Shift+Slash",
            "Alt+KeyL",
            "Cmd+Shift+Shift+KeyL",
            "Cmd+Invalid",
            "Ctrl+Cmd+KeyL",
        ] {
            let mut hotkeys = defaults();
            hotkeys.insert("next-pane".into(), Some(value.into()));
            assert!(validate(&hotkeys).is_err(), "Accepted {value}");
        }
        let mut hotkeys = defaults();
        hotkeys.insert("next-pane".into(), None);
        validate(&hotkeys).unwrap();
    }
}
