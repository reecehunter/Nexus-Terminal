use anyhow::{bail, Context, Result};
use serde::Serialize;
use std::{
    fs::{self, File},
    io::Read,
    path::{Component, Path, PathBuf},
};

pub const MAX_FILE_BYTES: usize = 64 * 1024;
pub const MAX_ENTRIES: usize = 200;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntry {
    pub name: String,
    pub kind: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryListing {
    pub path: String,
    pub entries: Vec<DirectoryEntry>,
    pub truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextSnapshot {
    pub directory: String,
    pub listing: DirectoryListing,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub path: String,
    pub text: String,
    pub truncated: bool,
}

pub fn excluded(path: &Path) -> bool {
    path.components().any(|part| {
        let Component::Normal(name) = part else {
            return false;
        };
        let name = name.to_string_lossy().to_ascii_lowercase();
        name.starts_with(".env")
            || matches!(
                name.as_str(),
                ".ssh"
                    | ".aws"
                    | ".gnupg"
                    | ".azure"
                    | ".kube"
                    | ".docker"
                    | "gcloud"
                    | "credentials"
                    | "id_rsa"
                    | "id_ed25519"
                    | "id_ecdsa"
                    | "id_dsa"
                    | "id_ed25519_sk"
                    | "id_ecdsa_sk"
            )
            || name.ends_with(".pem")
            || name.ends_with(".key")
            || name.ends_with(".p12")
            || name.ends_with(".pfx")
            || name.ends_with(".ppk")
    })
}

pub fn resolve(root: &Path, input: &str) -> Result<PathBuf> {
    let input = Path::new(input);
    if input
        .components()
        .any(|part| matches!(part, Component::ParentDir))
    {
        bail!("Parent-directory traversal is not allowed");
    }
    let candidate = if input.is_absolute() {
        input.to_path_buf()
    } else {
        root.join(input)
    };
    if excluded(&candidate) {
        bail!("Credential and private-key paths are excluded from automatic file access");
    }
    let resolved = candidate
        .canonicalize()
        .context("Path does not exist or cannot be accessed")?;
    if !resolved.starts_with(root) {
        bail!("Path is outside the captured directory");
    }
    if excluded(&resolved) {
        bail!("Credential and private-key paths are excluded from automatic file access");
    }
    Ok(resolved)
}

pub fn listing(root: &Path, input: &str) -> Result<DirectoryListing> {
    let path = resolve(root, input)?;
    let mut entries = Vec::new();
    let mut truncated = false;
    for entry in fs::read_dir(&path).context("Cannot list this directory")? {
        let entry = entry?;
        if excluded(&entry.path()) {
            continue;
        }
        if entries.len() == MAX_ENTRIES {
            truncated = true;
            break;
        }
        let file_type = entry.file_type()?;
        entries.push(DirectoryEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            kind: if file_type.is_symlink() {
                "symlink"
            } else if file_type.is_dir() {
                "directory"
            } else {
                "file"
            }
            .into(),
        });
    }
    entries.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(DirectoryListing {
        path: path.to_string_lossy().into_owned(),
        entries,
        truncated,
    })
}

pub fn read_file(root: &Path, input: &str) -> Result<FileContent> {
    let path = resolve(root, input)?;
    if !path.is_file() {
        bail!("Only regular text files can be read");
    }
    use std::os::unix::fs::OpenOptionsExt;
    let file = File::options()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&path)
        .context("Cannot open this file")?;
    if !file.metadata()?.is_file() {
        bail!("Only regular text files can be read");
    }
    let mut bytes = Vec::new();
    file.take((MAX_FILE_BYTES + 4) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.contains(&0) {
        bail!("Binary files are not supported");
    }
    let truncated = bytes.len() > MAX_FILE_BYTES;
    bytes.truncate(MAX_FILE_BYTES);
    // A UTF-8 codepoint can straddle the byte limit; trim only an incomplete trailing codepoint.
    let text = match std::str::from_utf8(&bytes) {
        Ok(text) => text.to_owned(),
        Err(error) if truncated && error.error_len().is_none() => {
            std::str::from_utf8(&bytes[..error.valid_up_to()])?.to_owned()
        }
        Err(_) => bail!("File must contain UTF-8 text"),
    };
    // Detect standard private-key headers even when the filename has no key extension.
    if text.lines().any(|line| {
        let line = line.trim();
        line.starts_with("-----BEGIN ") && line.ends_with("PRIVATE KEY-----")
            || line.starts_with("PuTTY-User-Key-File-")
    }) {
        bail!("Private-key contents are excluded from automatic file access");
    }
    Ok(FileContent {
        path: path.to_string_lossy().into_owned(),
        text,
        truncated,
    })
}

pub fn snapshot(directory: &Path) -> Result<ContextSnapshot> {
    let directory = directory
        .canonicalize()
        .context("Directory does not exist or cannot be accessed")?;
    if !directory.is_dir() {
        bail!("Choose a directory, not a file");
    }
    let listing = listing(&directory, ".")?;
    Ok(ContextSnapshot {
        directory: directory.to_string_lossy().into_owned(),
        listing,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_traversal_missing_binary_and_secrets() {
        let folder = tempfile::tempdir().unwrap();
        let root = folder.path().canonicalize().unwrap();
        fs::write(root.join("text file.txt"), "hello λ").unwrap();
        fs::write(root.join("binary"), [0, 1, 2]).unwrap();
        fs::write(root.join(".env.local"), "secret").unwrap();
        fs::write(
            root.join("ordinary-name"),
            "-----BEGIN OPENSSH PRIVATE KEY-----\nfake test data",
        )
        .unwrap();
        fs::create_dir(root.join("gcloud")).unwrap();
        fs::write(root.join("gcloud/credentials.json"), "fake test data").unwrap();
        assert_eq!(read_file(&root, "text file.txt").unwrap().text, "hello λ");
        for path in [
            "../outside",
            "missing",
            "binary",
            ".env.local",
            "ordinary-name",
            "gcloud/credentials.json",
            "id_ed25519_sk",
        ] {
            assert!(read_file(&root, path).is_err(), "{path}");
        }
    }
    #[test]
    fn rejects_symlink_escape_and_secret_target() {
        let folder = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let root = folder.path().canonicalize().unwrap();
        fs::write(outside.path().join("file"), "outside").unwrap();
        std::os::unix::fs::symlink(outside.path().join("file"), root.join("link")).unwrap();
        fs::write(root.join(".env"), "secret").unwrap();
        std::os::unix::fs::symlink(root.join(".env"), root.join("innocent")).unwrap();
        assert!(read_file(&root, "link").is_err());
        assert!(read_file(&root, "innocent").is_err());
    }
    #[test]
    fn bounds_reads_and_listings_without_breaking_unicode() {
        let folder = tempfile::tempdir().unwrap();
        let root = folder.path().canonicalize().unwrap();
        fs::write(
            root.join("large"),
            format!("{}λ", "a".repeat(MAX_FILE_BYTES - 1)),
        )
        .unwrap();
        let content = read_file(&root, "large").unwrap();
        assert!(content.truncated);
        assert_eq!(content.text.len(), MAX_FILE_BYTES - 1);
        for index in 0..MAX_ENTRIES + 1 {
            fs::write(root.join(format!("file-{index}")), "").unwrap();
        }
        let result = listing(&root, ".").unwrap();
        assert_eq!(result.entries.len(), MAX_ENTRIES);
        assert!(result.truncated);
    }
}
