use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PermissionMode {
    #[default]
    Ask,
    Auto,
    Full,
}

/// Recognize a small read-only command grammar; unrecognized forms require approval.
/// This classifies command text, not shell aliases/functions or executable provenance.
pub fn automatic_command(command: &str) -> bool {
    let Some(arguments) = command_arguments(command) else {
        return false;
    };
    let Some((program, arguments)) = arguments.split_first() else {
        return false;
    };
    match program.as_str() {
        "pwd" => {
            arguments.is_empty()
                || (arguments.len() == 1 && matches!(arguments[0].as_str(), "-L" | "-P"))
        }
        "ls" => read_arguments(
            arguments,
            &[
                "-a", "-A", "-l", "-h", "-1", "-d", "-F", "-R", "-t", "-r", "-S", "-la", "-al",
                "-lh", "-lah", "-alh",
            ],
            &[],
            false,
        ),
        "cat" => read_arguments(arguments, &["-n", "-b", "-s", "-v", "-e", "-t"], &[], false),
        "head" | "tail" => read_arguments(arguments, &[], &["-n", "-c"], true),
        "wc" => read_arguments(arguments, &["-c", "-m", "-l", "-w", "-L"], &[], false),
        "rg" => read_arguments(
            arguments,
            &[
                "-n",
                "-i",
                "-s",
                "-l",
                "-L",
                "-c",
                "-w",
                "-x",
                "-v",
                "-F",
                "--fixed-strings",
                "--files",
                "--hidden",
                "--no-ignore",
                "--count",
                "--files-with-matches",
                "--files-without-match",
                "--line-number",
                "--ignore-case",
                "--no-heading",
                "--no-config",
                "--color=never",
            ],
            &[
                "-e",
                "--regexp",
                "-g",
                "--glob",
                "-m",
                "--max-count",
                "-A",
                "-B",
                "-C",
                "--context",
                "--max-depth",
            ],
            false,
        ),
        "git" => git_arguments(arguments),
        _ => false,
    }
}

fn command_arguments(command: &str) -> Option<Vec<String>> {
    // Disallow expansion, composition, redirects, globbing, comments, and control bytes,
    // even inside quotes. Only literal words and simple quoted paths are supported.
    if command.len() > 16 * 1024
        || command.chars().any(|character| {
            (character.is_control() && character != '\t')
                || ";|&<>$`(){}[]*?!~\\#".contains(character)
        })
    {
        return None;
    }
    let mut arguments = Vec::new();
    let mut word = String::new();
    let mut quote = None;
    let mut started = false;
    for character in command.chars() {
        if let Some(delimiter) = quote {
            if character == delimiter {
                quote = None;
            } else {
                word.push(character);
            }
        } else if matches!(character, '\'' | '"') {
            quote = Some(character);
            started = true;
        } else if matches!(character, ' ' | '\t') {
            if started {
                arguments.push(std::mem::take(&mut word));
                started = false;
            }
        } else {
            // Non-ASCII whitespace can be shell-specific; fail closed instead of guessing.
            if character.is_whitespace() {
                return None;
            }
            word.push(character);
            started = true;
        }
    }
    if quote.is_some() {
        return None;
    }
    if started {
        arguments.push(word);
    }
    Some(arguments)
}

fn positive_count(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && value.parse::<u32>().is_ok_and(|count| count > 0)
}

fn read_arguments(
    arguments: &[String],
    flags: &[&str],
    values: &[&str],
    counts_only: bool,
) -> bool {
    let mut index = 0;
    let mut operands_only = false;
    while let Some(argument) = arguments.get(index) {
        if operands_only || !argument.starts_with('-') || argument == "-" {
            index += 1;
            continue;
        }
        if argument == "--" {
            operands_only = true;
        } else if flags.contains(&argument.as_str()) {
            // Exact flags only: unknown short-flag bundles and long aliases fail closed.
        } else if values.contains(&argument.as_str()) {
            index += 1;
            let Some(value) = arguments.get(index) else {
                return false;
            };
            let numeric = counts_only
                || matches!(
                    argument.as_str(),
                    "-m" | "--max-count" | "-A" | "-B" | "-C" | "--context" | "--max-depth"
                );
            if (numeric && !positive_count(value)) || (!numeric && value.starts_with('-')) {
                return false;
            }
        } else if counts_only && (argument.starts_with("-n") || argument.starts_with("-c")) {
            if !positive_count(&argument[2..]) {
                return false;
            }
        } else {
            return false;
        }
        index += 1;
    }
    true
}

fn git_arguments(arguments: &[String]) -> bool {
    let Some((subcommand, arguments)) = arguments.split_first() else {
        return false;
    };
    match subcommand.as_str() {
        "status" => arguments.iter().all(|argument| {
            matches!(
                argument.as_str(),
                "--short"
                    | "-s"
                    | "--branch"
                    | "-b"
                    | "-sb"
                    | "-bs"
                    | "--porcelain"
                    | "--porcelain=v1"
                    | "--porcelain=v2"
                    | "--untracked-files=no"
                    | "--untracked-files=normal"
                    | "--untracked-files=all"
                    | "--ignored"
            )
        }),
        "diff" => {
            // Diff drivers can execute programs. Require both opt-outs even for plain diff.
            let options = arguments
                .iter()
                .take_while(|argument| argument.as_str() != "--");
            options.clone().any(|argument| argument == "--no-ext-diff")
                && options.clone().any(|argument| argument == "--no-textconv")
                && read_arguments(
                    arguments,
                    &[
                        "--no-ext-diff",
                        "--no-textconv",
                        "--no-color",
                        "--color=never",
                        "--stat",
                        "--numstat",
                        "--shortstat",
                        "--name-only",
                        "--name-status",
                        "--cached",
                        "--staged",
                        "--check",
                        "--exit-code",
                        "--quiet",
                        "--patch",
                        "-p",
                    ],
                    &["-U", "--unified"],
                    true,
                )
        }
        _ => false,
    }
}

/// Only cursor/page movement in a visibly recognized pager or Vim normal-mode screen.
pub fn automatic_navigation(screen: &str, alternate: bool, text: &str, keys: &[String]) -> bool {
    if !alternate || !text.is_empty() || keys.is_empty() {
        return false;
    }
    if !keys.iter().all(|key| {
        matches!(
            key.as_str(),
            "ArrowUp"
                | "ArrowDown"
                | "ArrowLeft"
                | "ArrowRight"
                | "PageUp"
                | "PageDown"
                | "Home"
                | "End"
        )
    }) {
        return false;
    }
    let lines = screen.lines().map(str::trim).collect::<Vec<_>>();
    let tail = lines
        .iter()
        .rev()
        .filter(|line| !line.is_empty())
        .take(4)
        .map(|line| line.to_lowercase())
        .collect::<Vec<_>>();
    let pager = tail
        .iter()
        .any(|line| line == "(end)" || line.starts_with("--more--") || line == "less help");
    let vim = lines.iter().filter(|line| **line == "~").count() >= 2
        && tail
            .iter()
            .any(|line| line.contains("-- normal --") || line.contains("vim - vi improved"));
    pager || vim
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_modes_use_wire_names_and_default_to_ask() {
        assert_eq!(PermissionMode::default(), PermissionMode::Ask);
        for (mode, name) in [
            (PermissionMode::Ask, "ask"),
            (PermissionMode::Auto, "auto"),
            (PermissionMode::Full, "full"),
        ] {
            assert_eq!(serde_json::to_value(mode).unwrap(), name);
            assert_eq!(
                serde_json::from_value::<PermissionMode>(name.into()).unwrap(),
                mode
            );
        }
        assert!(serde_json::from_str::<PermissionMode>("\"unknown\"").is_err());
    }

    #[test]
    fn accepts_only_recognized_read_only_forms() {
        for command in [
            "pwd",
            "pwd -P",
            "ls -lah",
            "ls -- 'directory with spaces'",
            "cat -n README.md",
            "head -n 20 file",
            "tail -c100 file",
            "wc -l file",
            "rg -n -e needle src",
            "rg --files",
            "git status",
            "git status --short --branch",
            "git diff --no-ext-diff --no-textconv",
            "git diff --no-ext-diff --no-textconv --cached -- src",
        ] {
            assert!(automatic_command(command), "{command}");
        }
    }

    #[test]
    fn rejects_composition_expansion_side_effects_and_unknown_options() {
        for command in [
            "",
            "pwd -x",
            "pwd -P -L",
            "echo hi",
            "/bin/ls",
            "command ls",
            "ls; touch file",
            "ls | cat",
            "cat file > out",
            "pwd && ls",
            "ls\ncat file",
            "cat $(pwd)",
            "cat `pwd`",
            "ls *",
            "cat $HOME/file",
            "cat 'a;b'",
            "ls # comment",
            "cat '\\n'",
            "cat 'unclosed",
            "cat file\0",
            "ls --unknown",
            "tail -f file",
            "head -n",
            "head -n -1 file",
            "head -n 4294967296",
            "rg --pre command file",
            "rg --search-zip needle",
            "rg --config config",
            "rg -e --pre command",
            "git -c alias.status=command status",
            "git status --unknown",
            "git reset",
            "git diff",
            "git diff --no-ext-diff",
            "git diff --no-ext-diff --no-textconv --output=out",
            "git diff --no-ext-diff --no-textconv --ext-diff",
            "git diff --no-ext-diff --no-textconv --textconv",
        ] {
            assert!(!automatic_command(command), "{command}");
        }
    }

    #[test]
    fn diff_safety_options_must_be_options_not_paths() {
        assert!(!automatic_command(
            "git diff -- --no-ext-diff --no-textconv"
        ));
        assert!(!automatic_command(
            "git diff --no-ext-diff -- --no-textconv"
        ));
    }

    #[test]
    fn navigation_requires_recognized_application_and_only_movement_keys() {
        let arrows = vec!["ArrowDown".to_owned(), "PageUp".to_owned()];
        assert!(automatic_navigation(
            "file contents\n(END)",
            true,
            "",
            &arrows
        ));
        assert!(automatic_navigation(
            "~\n~\n-- NORMAL --",
            true,
            "",
            &arrows
        ));
        assert!(!automatic_navigation("(END)", false, "", &arrows));
        assert!(!automatic_navigation(
            "unrecognized application",
            true,
            "",
            &arrows
        ));
        assert!(!automatic_navigation("(END)", true, "q", &arrows));
        assert!(!automatic_navigation("(END)", true, "", &["Enter".into()]));
        assert!(!automatic_navigation("(END)", true, "", &[]));
        assert!(automatic_navigation("(END)\nPassword:", true, "", &arrows));
    }
}
