use anyhow::{Context, Result};
use portable_pty::CommandBuilder;
use std::{fs, path::PathBuf};
use uuid::Uuid;

/// A private startup directory installs hooks without editing the user's dotfiles.
pub struct ShellIntegration(PathBuf);
impl ShellIntegration {
    pub fn prepare(command: &mut CommandBuilder) -> Result<Self> {
        let directory = std::env::temp_dir().join(format!("nexus-shell-{}", Uuid::new_v4()));
        fs::create_dir(&directory).context("Could not create shell integration directory")?;
        let integration = Self(directory);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&integration.0, fs::Permissions::from_mode(0o700))?;
        }
        fs::write(
            integration.0.join("highlight.zsh"),
            include_str!("../shell/highlight.zsh"),
        )?;
        fs::write(
            integration.0.join("prompt.zsh"),
            include_str!("../shell/prompt.zsh"),
        )?;
        fs::write(
            integration.0.join(".zshenv"),
            r#"
# Restore the original location while the user's startup file runs.
if [[ "$NEXUS_HAD_ZDOTDIR" == 1 ]]; then
  ZDOTDIR="$NEXUS_USER_ZDOTDIR"
else
  unset ZDOTDIR
fi
[[ -r "${ZDOTDIR:-$HOME}/.zshenv" ]] && builtin source "${ZDOTDIR:-$HOME}/.zshenv"
typeset -gx NEXUS_USER_ZDOTDIR="${ZDOTDIR:-$HOME}"
ZDOTDIR="$NEXUS_BOOTSTRAP_DIR"
"#,
        )?;
        fs::write(
            integration.0.join(".zprofile"),
            r#"
ZDOTDIR="$NEXUS_USER_ZDOTDIR"
[[ -r "$ZDOTDIR/.zprofile" ]] && builtin source "$ZDOTDIR/.zprofile"
NEXUS_USER_ZDOTDIR="${ZDOTDIR:-$HOME}"
ZDOTDIR="$NEXUS_BOOTSTRAP_DIR"
"#,
        )?;
        fs::write(
            integration.0.join(".zshrc"),
            r#"
ZDOTDIR="$NEXUS_USER_ZDOTDIR"
[[ -r "$ZDOTDIR/.zshrc" ]] && builtin source "$ZDOTDIR/.zshrc"
builtin source "$NEXUS_BOOTSTRAP_DIR/highlight.zsh"
builtin source "$NEXUS_BOOTSTRAP_DIR/prompt.zsh"
unset NEXUS_USER_ZDOTDIR NEXUS_HAD_ZDOTDIR NEXUS_BOOTSTRAP_DIR
"#,
        )?;
        let original = std::env::var_os("ZDOTDIR");
        command.env(
            "NEXUS_HAD_ZDOTDIR",
            if original.is_some() { "1" } else { "0" },
        );
        command.env("NEXUS_USER_ZDOTDIR", original.unwrap_or_default());
        command.env("NEXUS_BOOTSTRAP_DIR", &integration.0);
        command.env("ZDOTDIR", &integration.0);
        Ok(integration)
    }
}
impl Drop for ShellIntegration {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
