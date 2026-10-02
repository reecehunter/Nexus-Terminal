use anyhow::{bail, Context, Result};
use serde::Serialize;
use std::{
    path::Path,
    process::Stdio,
    sync::atomic::{AtomicU32, Ordering},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
    sync::mpsc,
};
use tokio_util::sync::CancellationToken;

pub const MAX_OUTPUT_BYTES: usize = 64 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub canceled: bool,
    pub truncated: bool,
}

struct Chunk {
    stream: &'static str,
    bytes: Vec<u8>,
}

async fn read_pipe(
    mut pipe: impl AsyncRead + Unpin,
    stream: &'static str,
    sender: mpsc::Sender<Chunk>,
) {
    let mut buffer = [0_u8; 4096];
    loop {
        match pipe.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                if sender
                    .send(Chunk {
                        stream,
                        bytes: buffer[..count].to_vec(),
                    })
                    .await
                    .is_err()
                {
                    break;
                }
            }
        }
    }
}

fn signal_group(pid: u32, signal: i32) {
    // The child starts in its own process group; negative PID targets its descendants too.
    unsafe {
        libc::kill(-(pid as i32), signal);
    }
}

pub fn terminate_process_group(pid: u32) {
    if pid > 0 {
        signal_group(pid, libc::SIGKILL);
    }
}

struct ProcessGroup<'a> {
    pid: u32,
    slot: &'a AtomicU32,
}
impl Drop for ProcessGroup<'_> {
    fn drop(&mut self) {
        terminate_process_group(self.pid);
        let _ = self
            .slot
            .compare_exchange(self.pid, 0, Ordering::SeqCst, Ordering::SeqCst);
    }
}

pub async fn run(
    command: &str,
    directory: &Path,
    cancel: &CancellationToken,
    process_id: &AtomicU32,
    on_output: impl FnMut(&str, Vec<u8>),
) -> Result<CommandResult> {
    run_with_timeout(
        command,
        directory,
        cancel,
        process_id,
        Duration::from_secs(60),
        on_output,
    )
    .await
}

async fn run_with_timeout(
    command: &str,
    directory: &Path,
    cancel: &CancellationToken,
    process_id: &AtomicU32,
    timeout: Duration,
    mut on_output: impl FnMut(&str, Vec<u8>),
) -> Result<CommandResult> {
    if command.trim().is_empty() || command.len() > 16 * 1024 || command.contains('\0') {
        bail!("Command is empty or invalid");
    }
    if cancel.is_cancelled() {
        bail!("Canceled");
    }
    let mut process = Command::new("/bin/zsh");
    // Positional arguments keep paths and command text out of wrapper interpolation.
    process
        .args([
            "-l",
            "-c",
            "builtin cd -- \"$1\" || exit 1; eval -- \"$2\"",
            "nexus",
        ])
        .arg(directory)
        .arg(command)
        .current_dir(directory)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true);
    let mut child = process
        .spawn()
        .context("Could not start the approved command")?;
    let pid = child.id().context("Command process ID unavailable")?;
    process_id.store(pid, Ordering::SeqCst);
    let _group = ProcessGroup {
        pid,
        slot: process_id,
    };
    if cancel.is_cancelled() {
        terminate_process_group(pid);
    }
    let stdout = child.stdout.take().context("Command stdout unavailable")?;
    let stderr = child.stderr.take().context("Command stderr unavailable")?;
    let (sender, mut receiver) = mpsc::channel(8);
    let stdout_task = tokio::spawn(read_pipe(stdout, "stdout", sender.clone()));
    let stderr_task = tokio::spawn(read_pipe(stderr, "stderr", sender));
    let mut result = CommandResult {
        stdout: String::new(),
        stderr: String::new(),
        exit_code: None,
        timed_out: false,
        canceled: false,
        truncated: false,
    };
    let mut stdout_bytes = Vec::new();
    let mut stderr_bytes = Vec::new();
    let mut retained = 0;
    let mut pipes_open = true;
    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => { result.canceled = true; break; }
            _ = &mut deadline => { result.timed_out = true; break; }
            chunk = receiver.recv(), if pipes_open => {
                match chunk {
                    Some(chunk) => {
                        let count = chunk.bytes.len().min(MAX_OUTPUT_BYTES - retained);
                        result.truncated |= count < chunk.bytes.len();
                        retained += count;
                        let bytes = &chunk.bytes[..count];
                        if chunk.stream == "stdout" { stdout_bytes.extend_from_slice(bytes); } else { stderr_bytes.extend_from_slice(bytes); }
                        if count > 0 { on_output(chunk.stream, bytes.to_vec()); }
                    }
                    None => pipes_open = false,
                }
            }
            status = child.wait() => {
                result.exit_code = status.context("Could not wait for command completion")?.code();
                break;
            }
        }
    }
    // A task cannot launch a persistent background job that outlives the request.
    signal_group(pid, libc::SIGKILL);
    if result.canceled || result.timed_out {
        let _ = child.wait().await;
    }
    let drain_deadline = tokio::time::sleep(Duration::from_secs(1));
    tokio::pin!(drain_deadline);
    loop {
        let chunk = tokio::select! {
            _ = &mut drain_deadline => { result.truncated = true; break; },
            chunk = receiver.recv() => chunk,
        };
        let Some(chunk) = chunk else {
            break;
        };
        let count = chunk.bytes.len().min(MAX_OUTPUT_BYTES - retained);
        result.truncated |= count < chunk.bytes.len();
        retained += count;
        let bytes = &chunk.bytes[..count];
        if chunk.stream == "stdout" {
            stdout_bytes.extend_from_slice(bytes);
        } else {
            stderr_bytes.extend_from_slice(bytes);
        }
        if count > 0 {
            on_output(chunk.stream, bytes.to_vec());
        }
    }
    stdout_task.abort();
    stderr_task.abort();
    let _ = stdout_task.await;
    let _ = stderr_task.await;
    result.stdout = String::from_utf8_lossy(&stdout_bytes).into_owned();
    result.stderr = String::from_utf8_lossy(&stderr_bytes).into_owned();
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn runs_in_exact_directory_handles_quotes_and_separate_streams() {
        let folder = tempfile::Builder::new()
            .prefix("command space ' ")
            .tempdir()
            .unwrap();
        let directory = folder.path().canonicalize().unwrap();
        let result = run(
            "pwd; printf 'λ'; printf 'error' >&2; exit 7",
            &directory,
            &CancellationToken::new(),
            &AtomicU32::new(0),
            |_, _| {},
        )
        .await
        .unwrap();
        assert_eq!(result.exit_code, Some(7));
        assert!(result.stdout.starts_with(directory.to_str().unwrap()));
        assert!(result.stdout.ends_with('λ'));
        assert_eq!(result.stderr, "error");
    }
    #[tokio::test]
    async fn times_out_and_cancels_process_group() {
        let folder = tempfile::tempdir().unwrap();
        let directory = folder.path().canonicalize().unwrap();
        let result = run_with_timeout(
            "sleep 20 & wait",
            &directory,
            &CancellationToken::new(),
            &AtomicU32::new(0),
            Duration::from_millis(150),
            |_, _| {},
        )
        .await
        .unwrap();
        assert!(result.timed_out);
        let cancel = CancellationToken::new();
        let cloned = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(150)).await;
            cloned.cancel();
        });
        let result = run(
            "sleep 20",
            &directory,
            &cancel,
            &AtomicU32::new(0),
            |_, _| {},
        )
        .await
        .unwrap();
        assert!(result.canceled);
    }
    #[tokio::test]
    async fn drains_large_output_but_bounds_retention() {
        let folder = tempfile::tempdir().unwrap();
        let result = run(
            "head -c 200000 /dev/zero | tr '\\0' x",
            folder.path(),
            &CancellationToken::new(),
            &AtomicU32::new(0),
            |_, _| {},
        )
        .await
        .unwrap();
        assert_eq!(result.exit_code, Some(0));
        assert_eq!(result.stdout.len(), MAX_OUTPUT_BYTES);
        assert!(result.truncated);
    }
}
