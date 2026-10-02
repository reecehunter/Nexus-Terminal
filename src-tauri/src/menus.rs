use crate::hotkeys::{self, Hotkeys};
use tauri::{
    menu::{Menu, MenuItem, Submenu},
    AppHandle,
};

pub fn build(app: &AppHandle, hotkeys: &Hotkeys) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::default(app)?;
    for entry in menu.items()? {
        if let Some(submenu) = entry.as_submenu() {
            match submenu.text()?.as_str() {
                "File" => {
                    while !submenu.items()?.is_empty() {
                        submenu.remove_at(0)?;
                    }
                }
                "Window" => {
                    let items = submenu.items()?;
                    if !items.is_empty() {
                        submenu.remove_at(items.len() - 1)?;
                    }
                }
                _ => {}
            }
        }
    }
    let navigation = Submenu::new(app, "Navigate", true)?;
    for action in hotkeys::actions() {
        let binding = hotkeys.get(&action.id).and_then(Option::as_deref);
        let item = MenuItem::with_id(app, &action.id, &action.title, true, binding)?;
        if let Some(file) = menu
            .items()?
            .iter()
            .filter_map(|entry| entry.as_submenu())
            .find(|submenu| submenu.text().is_ok_and(|text| text == "File"))
        {
            if action.group == "App"
                || matches!(
                    action.id.as_str(),
                    "new-tab"
                        | "new-window"
                        | "close-pane"
                        | "close-window"
                        | "split-right"
                        | "split-down"
                        | "toggle-assistant"
                        | "open-settings"
                )
            {
                file.append(&item)?;
            } else {
                navigation.append(&item)?;
            }
        }
    }
    menu.insert(&navigation, 2)?;
    Ok(menu)
}
fn items(app: &AppHandle) -> tauri::Result<Vec<MenuItem<tauri::Wry>>> {
    let mut items = Vec::new();
    if let Some(menu) = app.menu() {
        for entry in menu.items()? {
            if let Some(submenu) = entry.as_submenu() {
                for entry in submenu.items()? {
                    if let Some(item) = entry.as_menuitem() {
                        if hotkeys::actions()
                            .iter()
                            .any(|action| item.id() == action.id)
                        {
                            items.push(item.clone());
                        }
                    }
                }
            }
        }
    }
    Ok(items)
}
pub fn apply(app: &AppHandle, hotkeys: &Hotkeys) -> tauri::Result<()> {
    let items = items(app)?;
    // Clear old accelerators first so swapping two bindings does not temporarily duplicate them.
    for item in &items {
        item.set_accelerator(None::<&str>)?;
    }
    for item in &items {
        let binding = hotkeys.get(item.id().as_ref()).and_then(Option::as_deref);
        item.set_accelerator(binding)?;
    }
    Ok(())
}
