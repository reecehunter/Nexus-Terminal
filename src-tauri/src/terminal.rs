use anyhow::{bail, Context, Result};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    io::{Read, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::ipc::Channel;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub const MAX_SNAPSHOT_BYTES: usize = 64 * 1024;
pub const MAX_RAW_OUTPUT_BYTES: usize = 64 * 1024;
const INPUT_WRITE_TIMEOUT: Duration = Duration::from_secs(5);
const INPUT_WRITE_CHUNK_BYTES: usize = 1024;

fn configure_nonblocking(master: &dyn MasterPty) -> Result<i32> {
    let descriptor = master
        .as_raw_fd()
        .context("PTY descriptor is unavailable")?;
    // portable-pty duplicates this master for its reader/writer. O_NONBLOCK applies to
    // the shared open file description, so both sides must handle WouldBlock.
    let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(descriptor, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
    {
        return Err(std::io::Error::last_os_error()).context("Could not configure nonblocking PTY");
    }
    Ok(descriptor)
}

fn poll_descriptor(descriptor: i32, events: i16) -> std::io::Result<bool> {
    let mut poll = libc::pollfd {
        fd: descriptor,
        events,
        revents: 0,
    };
    // The owning session retains the descriptor throughout this bounded readiness wait.
    let result = unsafe { libc::poll(&mut poll, 1, 20) };
    if result < 0 {
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::Interrupted {
            return Ok(false);
        }
        return Err(error);
    }
    if poll.revents & libc::POLLNVAL != 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::BrokenPipe,
            "PTY descriptor closed",
        ));
    }
    // Let read/write report EOF or the actual error when POLLHUP/POLLERR is signaled.
    Ok(result > 0)
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSnapshot {
    pub session_id: String,
    pub sequence: u64,
    pub revision: u64,
    pub screen: String,
    pub scrollback: String,
    pub cursor_x: u16,
    pub cursor_y: u16,
    pub columns: u16,
    pub rows: u16,
    pub alternate: bool,
    pub truncated: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub session_id: String,
    pub home: String,
    pub shell: String,
}

#[derive(Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TerminalEvent {
    Output {
        session_id: String,
        sequence: u64,
        revision: u64,
        data: Vec<u8>,
    },
    Revision {
        session_id: String,
        revision: u64,
    },
    Exit {
        session_id: String,
        code: u32,
    },
    Error {
        session_id: String,
        message: String,
    },
}

struct OutputChunk {
    sequence: u64,
    data: Vec<u8>,
}

struct FlowWindow {
    sent: u64,
    acknowledged: u64,
    revision: u64,
    columns: u16,
    rows: u16,
    output_pending: bool,
    input_pending: bool,
    snapshot: Option<TerminalSnapshot>,
    raw_output: VecDeque<OutputChunk>,
    raw_bytes: usize,
    raw_dropped_through: u64,
}

impl Default for FlowWindow {
    fn default() -> Self {
        Self {
            sent: 0,
            acknowledged: 0,
            revision: 0,
            columns: 80,
            rows: 24,
            output_pending: false,
            input_pending: false,
            snapshot: None,
            raw_output: VecDeque::new(),
            raw_bytes: 0,
            raw_dropped_through: 0,
        }
    }
}

impl FlowWindow {
    fn invalidate(&mut self) {
        self.revision += 1;
        self.snapshot = None;
    }

    fn parsed_snapshot(&self) -> Option<&TerminalSnapshot> {
        self.snapshot.as_ref().filter(|snapshot| {
            !self.output_pending
                && !self.input_pending
                && snapshot.sequence == self.sent
                && snapshot.revision == self.revision
        })
    }

    fn retain_output(&mut self, data: &[u8]) {
        self.raw_bytes += data.len();
        self.raw_output.push_back(OutputChunk {
            sequence: self.sent,
            data: data.to_vec(),
        });
        // Evict complete chunks. This ring never modifies the live parser's byte stream.
        while self.raw_bytes > MAX_RAW_OUTPUT_BYTES {
            if let Some(chunk) = self.raw_output.pop_front() {
                self.raw_bytes -= chunk.data.len();
                self.raw_dropped_through = chunk.sequence;
            }
        }
    }
}

pub struct TerminalSession {
    pub id: String,
    home: PathBuf,
    pid: u32,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    stopped: AtomicBool,
    exited: Arc<AtomicBool>,
    flow: Mutex<FlowWindow>,
    ready: Condvar,
    snapshot_ready: Notify,
    output: Channel<TerminalEvent>,
    io_descriptor: i32,
    _shell_integration: Option<crate::shell_integration::ShellIntegration>,
}

impl TerminalSession {
    pub fn start(output: Channel<TerminalEvent>, directory: Option<PathBuf>) -> Result<Arc<Self>> {
        Self::start_with_prompt_identity(output, directory, None)
    }

    pub fn start_with_prompt_identity(
        output: Channel<TerminalEvent>,
        directory: Option<PathBuf>,
        prompt_identity: Option<String>,
    ) -> Result<Arc<Self>> {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .context("Home directory is unavailable")?;
        Self::start_at_with_prompt_identity(
            output,
            directory.filter(|path| path.is_dir()).unwrap_or(home),
            true,
            prompt_identity,
        )
    }

    pub(crate) fn start_at(
        output: Channel<TerminalEvent>,
        home: PathBuf,
        login: bool,
    ) -> Result<Arc<Self>> {
        Self::start_at_with_prompt_identity(output, home, login, None)
    }

    pub(crate) fn start_at_with_prompt_identity(
        output: Channel<TerminalEvent>,
        home: PathBuf,
        login: bool,
        prompt_identity: Option<String>,
    ) -> Result<Arc<Self>> {
        let pair = native_pty_system().openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        let io_descriptor = configure_nonblocking(pair.master.as_ref())?;
        let mut command = CommandBuilder::new("/bin/zsh");
        command.args([if login { "-l" } else { "-f" }, "-i"]);
        command.cwd(&home);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        command.env("TERM_PROGRAM", "Nexus");
        // CLICOLOR requests color from supporting tools without forcing redirected output.
        if std::env::var_os("NO_COLOR").is_none() {
            command.env("CLICOLOR", "1");
        }
        let shell_integration = if login {
            Some(crate::shell_integration::ShellIntegration::prepare(
                &mut command,
                prompt_identity.as_deref(),
            )?)
        } else {
            None
        };
        let mut child = pair
            .slave
            .spawn_command(command)
            .context("Could not start zsh")?;
        let pid = child
            .process_id()
            .context("Shell process ID is unavailable")?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        let session = Arc::new(Self {
            id: Uuid::new_v4().to_string(),
            home,
            pid,
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            stopped: AtomicBool::new(false),
            exited: Arc::new(AtomicBool::new(false)),
            flow: Mutex::new(FlowWindow::default()),
            ready: Condvar::new(),
            snapshot_ready: Notify::new(),
            output: output.clone(),
            io_descriptor,
            _shell_integration: shell_integration,
        });
        let reading_session = session.clone();
        let reading_output = output.clone();
        let (reading_done, output_drained) = std::sync::mpsc::sync_channel(1);
        thread::spawn(move || {
            let mut buffer = [0_u8; 4096];
            'reading: loop {
                if reading_session.stopped.load(Ordering::SeqCst) {
                    break;
                }
                let count = match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => count,
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        if let Err(error) = poll_descriptor(io_descriptor, libc::POLLIN) {
                            let _ = reading_output.send(TerminalEvent::Error {
                                session_id: reading_session.id.clone(),
                                message: error.to_string(),
                            });
                            break;
                        }
                        continue;
                    }
                    Err(error) => {
                        if !reading_session.stopped.load(Ordering::SeqCst)
                            && error.raw_os_error() != Some(libc::EIO)
                        {
                            let _ = reading_output.send(TerminalEvent::Error {
                                session_id: reading_session.id.clone(),
                                message: error.to_string(),
                            });
                        }
                        break;
                    }
                };
                // Acknowledge only after xterm parses a chunk: at most 32 KiB can be in flight.
                let mut window = match reading_session.flow.lock() {
                    Ok(window) => window,
                    Err(_) => break,
                };
                // Invalidate before backpressure: even an unsent chunk makes the screen stale.
                window.invalidate();
                window.output_pending = true;
                reading_session.snapshot_ready.notify_waiters();
                while window.sent - window.acknowledged >= 8
                    && !reading_session.stopped.load(Ordering::SeqCst)
                {
                    window = match reading_session.ready.wait(window) {
                        Ok(window) => window,
                        Err(_) => break 'reading,
                    };
                }
                if reading_session.stopped.load(Ordering::SeqCst) {
                    break;
                }
                window.sent += 1;
                let sequence = window.sent;
                let revision = window.revision;
                window.retain_output(&buffer[..count]);
                window.output_pending = false;
                drop(window);
                if reading_output
                    .send(TerminalEvent::Output {
                        session_id: reading_session.id.clone(),
                        sequence,
                        revision,
                        data: buffer[..count].to_vec(),
                    })
                    .is_err()
                {
                    reading_session.stop();
                    break;
                }
            }
            let _ = reading_done.send(());
        });
        let waiting_session = session.clone();
        thread::spawn(move || {
            let status = child.wait();
            // Synchronize death with observation/input checks using the same state lock.
            if let Ok(_window) = waiting_session.flow.lock() {
                waiting_session.exited.store(true, Ordering::SeqCst);
            } else {
                waiting_session.exited.store(true, Ordering::SeqCst);
            }
            waiting_session.snapshot_ready.notify_waiters();
            // Preserve trailing output before reporting exit to the frontend.
            let _ = output_drained.recv_timeout(Duration::from_secs(2));
            match status {
                Ok(status) => {
                    let _ = output.send(TerminalEvent::Exit {
                        session_id: waiting_session.id.clone(),
                        code: status.exit_code(),
                    });
                }
                Err(error) => {
                    let _ = output.send(TerminalEvent::Error {
                        session_id: waiting_session.id.clone(),
                        message: error.to_string(),
                    });
                }
            }
            waiting_session.stopped.store(true, Ordering::SeqCst);
            waiting_session.ready.notify_all();
            waiting_session.snapshot_ready.notify_waiters();
        });
        Ok(session)
    }

    pub fn info(&self) -> TerminalInfo {
        TerminalInfo {
            session_id: self.id.clone(),
            home: self.home.to_string_lossy().into_owned(),
            shell: "/bin/zsh".into(),
        }
    }

    pub fn write(&self, data: &str) -> Result<()> {
        self.write_input(data, None, None)
    }

    /// Atomically claim a current, parsed observation before sending agent input.
    #[cfg(test)]
    pub fn write_agent(&self, data: &str, expected_revision: u64) -> Result<()> {
        self.write_input(data, Some(expected_revision), None)
    }

    pub fn write_agent_cancelable(
        &self,
        data: &str,
        expected_revision: u64,
        cancel: &CancellationToken,
    ) -> Result<()> {
        self.write_input(data, Some(expected_revision), Some(cancel))
    }

    fn write_input(
        &self,
        data: &str,
        expected_revision: Option<u64>,
        cancel: Option<&CancellationToken>,
    ) -> Result<()> {
        if data.len() > 64 * 1024 {
            bail!("Paste is limited to 64 KiB at a time");
        }
        let deadline = Instant::now() + INPUT_WRITE_TIMEOUT;
        let mut writer = loop {
            self.check_input(cancel, deadline)?;
            match self.writer.try_lock() {
                Ok(writer) => break writer,
                Err(std::sync::TryLockError::Poisoned(_)) => bail!("Shell input unavailable"),
                Err(std::sync::TryLockError::WouldBlock) => thread::sleep(Duration::from_millis(5)),
            }
        };
        let mut window = self
            .flow
            .lock()
            .map_err(|_| anyhow::anyhow!("Terminal observation unavailable"))?;
        self.ensure_ready()?;
        // A queued spawn_blocking task may acquire the writer only after cancellation.
        if cancel.is_some_and(CancellationToken::is_cancelled) {
            bail!("Terminal input canceled");
        }
        if let Some(revision) = expected_revision {
            if revision != window.revision || window.parsed_snapshot().is_none() {
                bail!("Stale terminal observation; request a new snapshot");
            }
        }
        // Reserve the input revision before I/O. Keeping the state lock during a large
        // paste could deadlock the reader; a failed/partial write stays invalidated too.
        window.invalidate();
        window.input_pending = true;
        drop(window);
        self.snapshot_ready.notify_waiters();
        let result = self.write_bounded(writer.as_mut(), data.as_bytes(), cancel, deadline);
        let mut window = self
            .flow
            .lock()
            .map_err(|_| anyhow::anyhow!("Terminal observation unavailable"))?;
        window.input_pending = false;
        let revision = window.revision;
        drop(window);
        drop(writer);
        self.snapshot_ready.notify_waiters();
        // Some keys produce no echo. Notify the frontend even on a partial/failed write
        // so it can republish its parsed buffer for the reserved revision.
        self.emit_revision(revision);
        result
    }

    fn check_input(&self, cancel: Option<&CancellationToken>, deadline: Instant) -> Result<()> {
        self.ensure_ready()?;
        if cancel.is_some_and(CancellationToken::is_cancelled) {
            bail!("Terminal input canceled; any unsent remainder was discarded");
        }
        if Instant::now() >= deadline {
            bail!("Terminal input timed out; any unsent remainder was discarded");
        }
        Ok(())
    }

    fn write_bounded(
        &self,
        writer: &mut dyn Write,
        data: &[u8],
        cancel: Option<&CancellationToken>,
        deadline: Instant,
    ) -> Result<()> {
        let mut offset = 0;
        while offset < data.len() {
            self.check_input(cancel, deadline)?;
            // Send each Enter separately, checking cancellation immediately before it.
            let remaining = &data[offset..];
            let boundary = remaining
                .iter()
                .position(|byte| matches!(byte, b'\r' | b'\n'));
            let count = boundary
                .map_or(remaining.len(), |position| position.max(1))
                .min(INPUT_WRITE_CHUNK_BYTES);
            match writer.write(&remaining[..count]) {
                Ok(0) => bail!("PTY input closed before all bytes were sent"),
                Ok(written) => offset += written,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    poll_descriptor(self.io_descriptor, libc::POLLOUT)
                        .context("Could not wait for PTY input")?;
                }
                Err(error) => return Err(error).context("Could not write terminal input"),
            }
        }
        self.check_input(cancel, deadline)?;
        writer.flush().context("Could not flush terminal input")
    }

    pub fn resize(&self, columns: u16, rows: u16) -> Result<()> {
        self.resize_with_revision(columns, rows).map(|_| ())
    }

    pub fn resize_with_revision(&self, columns: u16, rows: u16) -> Result<u64> {
        if !(2..=1000).contains(&columns) || !(1..=1000).contains(&rows) {
            bail!("Invalid terminal size");
        }
        let master = self
            .master
            .lock()
            .map_err(|_| anyhow::anyhow!("Terminal unavailable"))?;
        let mut window = self
            .flow
            .lock()
            .map_err(|_| anyhow::anyhow!("Terminal observation unavailable"))?;
        self.ensure_ready()?;
        master.resize(PtySize {
            rows,
            cols: columns,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        if window.columns != columns || window.rows != rows {
            window.columns = columns;
            window.rows = rows;
            window.invalidate();
            self.snapshot_ready.notify_waiters();
        }
        let revision = window.revision;
        drop(window);
        drop(master);
        self.emit_revision(revision);
        Ok(revision)
    }

    fn emit_revision(&self, revision: u64) {
        let _ = self.output.send(TerminalEvent::Revision {
            session_id: self.id.clone(),
            revision,
        });
    }

    pub fn ensure_ready(&self) -> Result<()> {
        if self.stopped.load(Ordering::SeqCst) || self.exited.load(Ordering::SeqCst) {
            bail!("Shell has exited");
        }
        Ok(())
    }

    /// Allows the frontend to republish after a resize or input without new output.
    pub fn current_revision(&self) -> Result<u64> {
        let window = self
            .flow
            .lock()
            .map_err(|_| anyhow::anyhow!("Terminal observation unavailable"))?;
        self.ensure_ready()?;
        Ok(window.revision)
    }

    #[cfg(test)]
    pub fn output_since(&self, after_sequence: u64) -> (Vec<u8>, bool) {
        self.output_since_through(after_sequence, u64::MAX)
    }

    /// Raw PTY bytes in `(after_sequence, through_sequence]`, captured under one ring lock.
    /// `truncated` indicates evicted requested chunks (or unavailable poisoned state).
    /// Read-only access remains available after exit for inspecting trailing output.
    pub fn output_since_through(
        &self,
        after_sequence: u64,
        through_sequence: u64,
    ) -> (Vec<u8>, bool) {
        let Ok(window) = self.flow.lock() else {
            return (Vec::new(), true);
        };
        let mut output = Vec::with_capacity(window.raw_bytes);
        for chunk in &window.raw_output {
            if chunk.sequence > after_sequence && chunk.sequence <= through_sequence {
                output.extend_from_slice(&chunk.data);
            }
        }
        (
            output,
            after_sequence < window.raw_dropped_through.min(through_sequence),
        )
    }

    pub fn publish_snapshot(&self, snapshot: TerminalSnapshot) -> Result<()> {
        if snapshot.session_id != self.id {
            bail!("Snapshot belongs to a different terminal");
        }
        if !(2..=1000).contains(&snapshot.columns)
            || !(1..=1000).contains(&snapshot.rows)
            || snapshot.cursor_x >= snapshot.columns
            || snapshot.cursor_y >= snapshot.rows
            || snapshot
                .screen
                .len()
                .saturating_add(snapshot.scrollback.len())
                > MAX_SNAPSHOT_BYTES
        {
            bail!("Invalid terminal snapshot size or cursor");
        }
        let mut window = self
            .flow
            .lock()
            .map_err(|_| anyhow::anyhow!("Terminal observation unavailable"))?;
        self.ensure_ready()?;
        if snapshot.sequence == 0
            || snapshot.sequence != window.sent
            || snapshot.revision != window.revision
            || window.output_pending
            || window.input_pending
        {
            bail!("Snapshot does not match the latest terminal output and revision");
        }
        if snapshot.columns != window.columns || snapshot.rows != window.rows {
            bail!("Snapshot dimensions do not match the terminal");
        }
        window.snapshot = Some(snapshot);
        drop(window);
        self.snapshot_ready.notify_waiters();
        Ok(())
    }

    pub fn snapshot(&self) -> Result<TerminalSnapshot> {
        let window = self
            .flow
            .lock()
            .map_err(|_| anyhow::anyhow!("Terminal observation unavailable"))?;
        self.ensure_ready()?;
        window
            .parsed_snapshot()
            .cloned()
            .context("Latest terminal output has not been parsed; wait for a snapshot")
    }

    /// Wait for a parsed current snapshot strictly newer than `after_sequence`.
    /// Cancellation, timeout, and shell exit are errors, never stale fallback screens.
    pub async fn wait_snapshot(
        &self,
        after_sequence: u64,
        timeout_ms: u64,
        cancel: &CancellationToken,
    ) -> Result<TerminalSnapshot> {
        let deadline = tokio::time::Instant::now()
            .checked_add(Duration::from_millis(timeout_ms))
            .context("Snapshot timeout is too large")?;
        tokio::time::timeout_at(
            deadline,
            self.wait_for_snapshot(Some(after_sequence), cancel),
        )
        .await
        .context("Snapshot wait timed out")?
    }

    /// Wait through temporary staleness, bounded to five seconds if the frontend is gone.
    pub async fn current_snapshot(&self, cancel: &CancellationToken) -> Result<TerminalSnapshot> {
        if cancel.is_cancelled() {
            bail!("Snapshot wait canceled");
        }
        if let Ok(snapshot) = self.snapshot() {
            return Ok(snapshot);
        }
        tokio::time::timeout(Duration::from_secs(5), self.wait_for_snapshot(None, cancel))
            .await
            .context("Current snapshot wait timed out")?
    }

    async fn wait_for_snapshot(
        &self,
        after_sequence: Option<u64>,
        cancel: &CancellationToken,
    ) -> Result<TerminalSnapshot> {
        loop {
            // Register before checking state so a concurrent publication cannot be lost.
            let notified = self.snapshot_ready.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if cancel.is_cancelled() {
                bail!("Snapshot wait canceled");
            }
            {
                let window = self
                    .flow
                    .lock()
                    .map_err(|_| anyhow::anyhow!("Terminal observation unavailable"))?;
                self.ensure_ready()?;
                if let Some(snapshot) = window.parsed_snapshot().filter(|snapshot| {
                    after_sequence.is_none_or(|sequence| snapshot.sequence > sequence)
                }) {
                    return Ok(snapshot.clone());
                }
            }
            tokio::select! {
                biased;
                _ = cancel.cancelled() => bail!("Snapshot wait canceled"),
                _ = &mut notified => {}
            }
        }
    }

    pub fn acknowledge(&self, sequence: u64) {
        if let Ok(mut window) = self.flow.lock() {
            window.acknowledged = window.acknowledged.max(sequence.min(window.sent));
            self.ready.notify_all();
        }
    }

    pub fn cwd(&self) -> Result<PathBuf> {
        if self.stopped.load(Ordering::SeqCst) || self.exited.load(Ordering::SeqCst) {
            bail!("Shell has exited");
        }
        process_directory(self.pid)
    }

    pub fn has_foreground_job(&self) -> bool {
        if self.stopped.load(Ordering::SeqCst) || self.exited.load(Ordering::SeqCst) {
            return false;
        }
        self.master
            .lock()
            .ok()
            .and_then(|master| master.as_raw_fd())
            .map(|fd| {
                // The shell owns the foreground group while idle at its prompt.
                let foreground = unsafe { libc::tcgetpgrp(fd) };
                foreground > 0 && foreground != self.pid as i32
            })
            .unwrap_or(true)
    }

    pub fn stop(&self) {
        let window = self.flow.lock().ok();
        if self.stopped.swap(true, Ordering::SeqCst) {
            return;
        }
        drop(window);
        self.ready.notify_all();
        self.snapshot_ready.notify_waiters();
        let foreground = self
            .master
            .lock()
            .ok()
            .and_then(|master| master.as_raw_fd())
            .map(|fd| unsafe {
                // fd belongs to this PTY; query its foreground job before terminating the shell.
                libc::tcgetpgrp(fd)
            })
            .unwrap_or(-1);
        unsafe {
            if foreground > 0 && foreground != self.pid as i32 {
                libc::kill(-foreground, libc::SIGKILL);
            }
            libc::kill(-(self.pid as i32), libc::SIGTERM);
        }
        let pid = self.pid;
        let exited = self.exited.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(300));
            // Do not leave a foreground application alive after its terminal closes.
            unsafe {
                if !exited.load(Ordering::SeqCst) {
                    libc::kill(-(pid as i32), libc::SIGKILL);
                }
            }
        });
    }
}

#[cfg(target_os = "macos")]
pub fn process_directory(pid: u32) -> Result<PathBuf> {
    let mut info = std::mem::MaybeUninit::<libc::proc_vnodepathinfo>::zeroed();
    let size = std::mem::size_of::<libc::proc_vnodepathinfo>();
    let received = unsafe {
        // Native libproc fills exactly this C struct. Check the byte count before reading it.
        libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDVNODEPATHINFO,
            0,
            info.as_mut_ptr().cast(),
            size as i32,
        )
    };
    if received != size as i32 {
        return Err(std::io::Error::last_os_error()).context("macOS directory query failed");
    }
    let info = unsafe { info.assume_init() };
    let bytes = info
        .pvi_cdir
        .vip_path
        .iter()
        .flatten()
        .take_while(|&&byte| byte != 0)
        .map(|&byte| byte as u8)
        .collect::<Vec<_>>();
    if bytes.is_empty() {
        bail!("Process directory is unavailable");
    }
    use std::os::unix::ffi::OsStringExt;
    Ok(PathBuf::from(std::ffi::OsString::from_vec(bytes)))
}

#[cfg(not(target_os = "macos"))]
pub fn process_directory(_pid: u32) -> Result<PathBuf> {
    bail!("Directory tracking currently requires macOS")
}

#[cfg(test)]
mod tests {
    use super::*;

    struct RecordingWriter(Arc<Mutex<Vec<u8>>>);

    impl Write for RecordingWriter {
        fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(data);
            Ok(data.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    // Real PTY sizing with deterministic output state and recorded input. No process is
    // spawned, so lifecycle tests set the exited flag instead of calling stop (pid is 0).
    fn observed_session() -> (Arc<TerminalSession>, Arc<Mutex<Vec<u8>>>) {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let input = Arc::new(Mutex::new(Vec::new()));
        let io_descriptor = configure_nonblocking(pair.master.as_ref()).unwrap();
        let session = Arc::new(TerminalSession {
            id: Uuid::new_v4().to_string(),
            home: std::env::temp_dir(),
            pid: 0,
            master: Mutex::new(pair.master),
            writer: Mutex::new(Box::new(RecordingWriter(input.clone()))),
            stopped: AtomicBool::new(false),
            exited: Arc::new(AtomicBool::new(false)),
            flow: Mutex::new(FlowWindow::default()),
            ready: Condvar::new(),
            snapshot_ready: Notify::new(),
            output: Channel::new(|_| Ok(())),
            io_descriptor,
            _shell_integration: None,
        });
        (session, input)
    }

    fn parsed_output(session: &TerminalSession) -> TerminalSnapshot {
        let mut window = session.flow.lock().unwrap();
        window.sent += 1;
        window.invalidate();
        window.output_pending = false;
        TerminalSnapshot {
            session_id: session.id.clone(),
            sequence: window.sent,
            revision: window.revision,
            screen: "λ🙂 prompt $".into(),
            scrollback: "previous output".into(),
            cursor_x: 12,
            cursor_y: 0,
            columns: window.columns,
            rows: window.rows,
            alternate: false,
            truncated: false,
        }
    }

    #[test]
    fn snapshot_validates_identity_sequence_revision_dimensions_cursor_and_bytes() {
        let (session, _) = observed_session();
        assert!(session.snapshot().is_err());
        let snapshot = parsed_output(&session);
        let mut invalid = snapshot.clone();
        invalid.sequence = 0;
        assert!(session.publish_snapshot(invalid).is_err());
        let mut invalid = snapshot.clone();
        invalid.sequence += 1;
        assert!(session.publish_snapshot(invalid).is_err());
        let mut invalid = snapshot.clone();
        invalid.revision += 1;
        assert!(session.publish_snapshot(invalid).is_err());
        let mut invalid = snapshot.clone();
        invalid.session_id = "another-session".into();
        assert!(session.publish_snapshot(invalid).is_err());
        for (columns, rows) in [(0, 24), (1, 24), (80, 0), (1001, 24), (80, 1001), (81, 24)] {
            let mut invalid = snapshot.clone();
            invalid.columns = columns;
            invalid.rows = rows;
            assert!(session.publish_snapshot(invalid).is_err());
        }
        for (x, y) in [(80, 0), (0, 24)] {
            let mut invalid = snapshot.clone();
            invalid.cursor_x = x;
            invalid.cursor_y = y;
            assert!(session.publish_snapshot(invalid).is_err());
        }
        let mut boundary = snapshot.clone();
        boundary.screen = "🙂".repeat(MAX_SNAPSHOT_BYTES / 4);
        boundary.scrollback.clear();
        session.publish_snapshot(boundary.clone()).unwrap();
        boundary.scrollback.push('x');
        assert!(session.publish_snapshot(boundary).is_err());
        session.publish_snapshot(snapshot.clone()).unwrap();
        assert_eq!(session.snapshot().unwrap(), snapshot);
        let wire = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(wire["sessionId"], session.id);
        assert_eq!(wire["cursorX"], 12);
        assert_eq!(
            serde_json::from_value::<TerminalSnapshot>(wire).unwrap(),
            snapshot
        );
    }

    #[test]
    fn output_including_backpressured_output_rejects_old_or_unparsed_screens() {
        let (session, _) = observed_session();
        let old = parsed_output(&session);
        session.publish_snapshot(old.clone()).unwrap();
        let current = parsed_output(&session);
        assert!(session.snapshot().is_err());
        assert!(session.publish_snapshot(old).is_err());
        session.flow.lock().unwrap().output_pending = true;
        assert!(session.publish_snapshot(current.clone()).is_err());
        assert!(session.write_agent("x", current.revision).is_err());
        session.flow.lock().unwrap().output_pending = false;
        session.flow.lock().unwrap().input_pending = true;
        assert!(session.publish_snapshot(current.clone()).is_err());
        session.flow.lock().unwrap().input_pending = false;
        session.publish_snapshot(current.clone()).unwrap();
        assert_eq!(session.snapshot().unwrap(), current);
    }

    #[test]
    fn manual_input_resize_and_agent_input_invalidate_revisions_atomically() {
        let (session, input) = observed_session();
        let old = parsed_output(&session);
        session.publish_snapshot(old.clone()).unwrap();
        session.write("manual").unwrap();
        assert_eq!(session.current_revision().unwrap(), old.revision + 1);
        assert!(session.write_agent("stale", old.revision).is_err());
        assert!(session.publish_snapshot(old).is_err());
        let current = parsed_output(&session);
        session.publish_snapshot(current.clone()).unwrap();
        let resized_revision = session.resize_with_revision(100, 30).unwrap();
        assert_eq!(resized_revision, current.revision + 1);
        assert!(session.write_agent("stale", current.revision).is_err());
        assert!(session.snapshot().is_err());
        let mut resized = current;
        resized.revision = resized_revision;
        resized.columns = 100;
        resized.rows = 30;
        resized.alternate = true;
        session.publish_snapshot(resized.clone()).unwrap();
        assert!(session.snapshot().unwrap().alternate);
        assert_eq!(
            session.resize_with_revision(100, 30).unwrap(),
            resized_revision
        );
        assert!(session.resize(0, 30).is_err());
        assert_eq!(session.current_revision().unwrap(), resized_revision);
        session.write_agent("\x1b[B", resized_revision).unwrap();
        assert!(session.write_agent("duplicate", resized_revision).is_err());
        assert_eq!(&*input.lock().unwrap(), b"manual\x1b[B");
    }

    #[test]
    fn competing_agents_cannot_reuse_the_same_observation() {
        let (session, input) = observed_session();
        let snapshot = parsed_output(&session);
        session.publish_snapshot(snapshot.clone()).unwrap();
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let mut writers = Vec::new();
        for _ in 0..2 {
            let session = session.clone();
            let barrier = barrier.clone();
            writers.push(thread::spawn(move || {
                barrier.wait();
                session.write_agent("x", snapshot.revision).is_ok()
            }));
        }
        barrier.wait();
        let accepted = writers
            .into_iter()
            .map(|writer| writer.join().unwrap())
            .filter(|accepted| *accepted)
            .count();
        assert_eq!(accepted, 1);
        assert_eq!(&*input.lock().unwrap(), b"x");
    }

    #[test]
    fn canceled_queued_agent_input_is_never_written() {
        let (session, input) = observed_session();
        let snapshot = parsed_output(&session);
        session.publish_snapshot(snapshot.clone()).unwrap();
        let writer_lock = session.writer.lock().unwrap();
        let cancel = CancellationToken::new();
        let queued_session = session.clone();
        let queued_cancel = cancel.clone();
        let (completed, completion) = std::sync::mpsc::channel();
        let queued = thread::spawn(move || {
            let result = queued_session.write_agent_cancelable(
                "must not execute",
                snapshot.revision,
                &queued_cancel,
            );
            completed.send(result).unwrap();
        });
        cancel.cancel();
        let result = completion
            .recv_timeout(Duration::from_millis(500))
            .expect("cancellation must interrupt waiting for the writer lock");
        drop(writer_lock);
        queued.join().unwrap();
        assert!(result.unwrap_err().to_string().contains("canceled"));
        assert!(input.lock().unwrap().is_empty());
        assert_eq!(session.current_revision().unwrap(), snapshot.revision);
    }

    struct CancelingWriter {
        input: Arc<Mutex<Vec<u8>>>,
        cancel: CancellationToken,
    }

    impl Write for CancelingWriter {
        fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
            // Simulate a partial successful syscall followed by user cancellation.
            let count = data.len().min(7);
            self.input.lock().unwrap().extend_from_slice(&data[..count]);
            self.cancel.cancel();
            Ok(count)
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn cancellation_mid_paste_discards_remaining_text_and_enter() {
        let (mut session, input) = observed_session();
        let cancel = CancellationToken::new();
        Arc::get_mut(&mut session).unwrap().writer = Mutex::new(Box::new(CancelingWriter {
            input: input.clone(),
            cancel: cancel.clone(),
        }));
        let snapshot = parsed_output(&session);
        session.publish_snapshot(snapshot.clone()).unwrap();
        let error = session
            .write_agent_cancelable("echo must-not-execute\r", snapshot.revision, &cancel)
            .unwrap_err();
        assert!(error.to_string().contains("canceled"));
        assert_eq!(&*input.lock().unwrap(), b"echo mu");
        assert!(!input.lock().unwrap().contains(&b'\r'));
        assert!(session.snapshot().is_err());
        assert!(!session.flow.lock().unwrap().input_pending);
    }

    struct ChildGuard(Box<dyn portable_pty::Child + Send + Sync>);

    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    struct TrackedWriter {
        writer: Box<dyn Write + Send>,
        input: Arc<Mutex<Vec<u8>>>,
    }

    impl Write for TrackedWriter {
        fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
            let count = self.writer.write(data)?;
            self.input.lock().unwrap().extend_from_slice(&data[..count]);
            Ok(count)
        }

        fn flush(&mut self) -> std::io::Result<()> {
            self.writer.flush()
        }
    }

    #[test]
    fn stalled_native_pty_write_cancels_without_sending_enter() {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let descriptor = configure_nonblocking(pair.master.as_ref()).unwrap();
        let mut command = CommandBuilder::new("/bin/zsh");
        command.args([
            "-f",
            "-c",
            "stty raw -echo; printf STALLED_INPUT_READY; exec sleep 30",
        ]);
        let _child = ChildGuard(pair.slave.spawn_command(command).unwrap());
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let writer = pair.master.take_writer().unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut ready_output = Vec::new();
        while !String::from_utf8_lossy(&ready_output).contains("STALLED_INPUT_READY") {
            assert!(
                Instant::now() < deadline,
                "raw-mode child never became ready"
            );
            let mut buffer = [0; 256];
            match reader.read(&mut buffer) {
                Ok(0) => panic!("raw-mode child exited early"),
                Ok(count) => ready_output.extend_from_slice(&buffer[..count]),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    poll_descriptor(descriptor, libc::POLLIN).unwrap();
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                Err(error) => panic!("raw-mode child read failed: {error}"),
            }
        }
        let (mut session, input) = observed_session();
        let state = Arc::get_mut(&mut session).unwrap();
        state.master = Mutex::new(pair.master);
        state.io_descriptor = descriptor;
        state.writer = Mutex::new(Box::new(TrackedWriter {
            writer,
            input: input.clone(),
        }));
        let snapshot = parsed_output(&session);
        session.publish_snapshot(snapshot.clone()).unwrap();
        let cancel = CancellationToken::new();
        let delayed_cancel = cancel.clone();
        let cancellation = thread::spawn(move || {
            thread::sleep(Duration::from_millis(50));
            delayed_cancel.cancel();
        });
        let data = format!("{}\r", "x".repeat(64 * 1024 - 1));
        let started = Instant::now();
        let result = session.write_agent_cancelable(&data, snapshot.revision, &cancel);
        cancellation.join().unwrap();
        assert!(result.unwrap_err().to_string().contains("canceled"));
        assert!(started.elapsed() < Duration::from_secs(2));
        let input = input.lock().unwrap();
        assert!(!input.is_empty());
        assert!(input.len() < data.len());
        assert!(!input.contains(&b'\r'));
    }

    #[test]
    fn input_and_resize_emit_revision_events_without_output() {
        let (mut session, _) = observed_session();
        let events = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
        let recorded = events.clone();
        Arc::get_mut(&mut session).unwrap().output = Channel::new(move |body| {
            recorded.lock().unwrap().push(body.deserialize().unwrap());
            Ok(())
        });
        session.write("manual").unwrap();
        let resize_revision = session.resize_with_revision(100, 30).unwrap();
        let snapshot = parsed_output(&session);
        session.publish_snapshot(snapshot.clone()).unwrap();
        session.write_agent("\x1b", snapshot.revision).unwrap();
        let events = events.lock().unwrap();
        assert_eq!(events.len(), 3);
        assert_eq!(events[0]["type"], "revision");
        assert_eq!(events[0]["sessionId"], session.id);
        assert_eq!(events[0]["revision"], 1);
        assert_eq!(events[1]["revision"], resize_revision);
        assert_eq!(events[2]["revision"], snapshot.revision + 1);
    }

    #[tokio::test]
    async fn waits_for_publication_and_for_same_sequence_resize_republication() {
        let (session, _) = observed_session();
        let snapshot = parsed_output(&session);
        let cancel = CancellationToken::new();
        let waiting_session = session.clone();
        let waiting_cancel = cancel.clone();
        let waiter = tokio::spawn(async move {
            waiting_session
                .wait_snapshot(0, 1000, &waiting_cancel)
                .await
        });
        tokio::task::yield_now().await;
        assert!(!waiter.is_finished());
        session.publish_snapshot(snapshot.clone()).unwrap();
        assert_eq!(waiter.await.unwrap().unwrap(), snapshot);
        let revision = session.resize_with_revision(100, 30).unwrap();
        let waiting_session = session.clone();
        let waiter = tokio::spawn(async move { waiting_session.current_snapshot(&cancel).await });
        tokio::task::yield_now().await;
        assert!(!waiter.is_finished());
        let mut resized = snapshot;
        resized.revision = revision;
        resized.columns = 100;
        resized.rows = 30;
        session.publish_snapshot(resized.clone()).unwrap();
        assert_eq!(waiter.await.unwrap().unwrap(), resized);
    }

    #[tokio::test]
    async fn wait_timeout_cancel_and_exit_never_return_a_stale_snapshot() {
        let (session, _) = observed_session();
        let snapshot = parsed_output(&session);
        session.publish_snapshot(snapshot.clone()).unwrap();
        let cancel = CancellationToken::new();
        assert!(session
            .wait_snapshot(snapshot.sequence, 1, &cancel)
            .await
            .unwrap_err()
            .to_string()
            .contains("timed out"));
        let waiting_session = session.clone();
        let waiting_cancel = cancel.clone();
        let waiter = tokio::spawn(async move {
            waiting_session
                .wait_snapshot(snapshot.sequence, 1000, &waiting_cancel)
                .await
        });
        tokio::task::yield_now().await;
        cancel.cancel();
        assert!(waiter
            .await
            .unwrap()
            .unwrap_err()
            .to_string()
            .contains("canceled"));
        assert!(session.current_snapshot(&cancel).await.is_err());
        parsed_output(&session);
        let waiting_session = session.clone();
        let waiter = tokio::spawn(async move {
            waiting_session
                .current_snapshot(&CancellationToken::new())
                .await
        });
        tokio::task::yield_now().await;
        session.exited.store(true, Ordering::SeqCst);
        session.snapshot_ready.notify_waiters();
        assert!(waiter
            .await
            .unwrap()
            .unwrap_err()
            .to_string()
            .contains("exited"));
        assert!(session.snapshot().is_err());
        assert!(session.publish_snapshot(snapshot).is_err());
        assert!(session.write_agent("x", 0).is_err());
        assert!(session.resize(80, 24).is_err());
    }

    #[tokio::test]
    async fn current_snapshot_bounds_an_unavailable_frontend() {
        let (session, _) = observed_session();
        parsed_output(&session);
        let result = tokio::time::timeout(
            Duration::from_secs(6),
            session.current_snapshot(&CancellationToken::new()),
        )
        .await
        .expect("current_snapshot must have its own bounded wait");
        assert!(result.unwrap_err().to_string().contains("timed out"));
    }

    #[test]
    fn raw_output_is_incremental_bounded_and_marks_evicted_chunks() {
        let (session, _) = observed_session();
        {
            let mut window = session.flow.lock().unwrap();
            for sequence in 1..=17 {
                window.sent = sequence;
                window.retain_output(&vec![sequence as u8; 4096]);
            }
        }
        let (all, truncated) = session.output_since(0);
        assert_eq!(all.len(), MAX_RAW_OUTPUT_BYTES);
        assert!(truncated);
        assert_eq!(all[0], 2);
        let (retained, truncated) = session.output_since(1);
        assert_eq!(retained, all);
        assert!(!truncated);
        assert_eq!(session.output_since(16), (vec![17; 4096], false));
        assert_eq!(session.output_since(17), (Vec::new(), false));
        assert_eq!(session.output_since(100), (Vec::new(), false));
        assert_eq!(session.output_since_through(1, 2), (vec![2; 4096], false));
        assert_eq!(session.output_since_through(0, 1), (Vec::new(), true));
        assert_eq!(session.output_since_through(16, 16), (Vec::new(), false));
        assert_eq!(session.output_since_through(17, 1), (Vec::new(), false));
    }

    #[test]
    fn raw_ring_preserves_unicode_bytes_across_chunk_boundaries() {
        let (session, _) = observed_session();
        {
            let mut window = session.flow.lock().unwrap();
            window.sent = 1;
            window.retain_output(&[0xf0, 0x9f]);
            window.sent = 2;
            window.retain_output(&[0x99, 0x82]);
        }
        let (bytes, truncated) = session.output_since(0);
        assert_eq!(String::from_utf8(bytes).unwrap(), "🙂");
        assert!(!truncated);
    }

    #[test]
    fn output_waits_for_acknowledgments_and_resumes_in_order() {
        let folder = tempfile::tempdir().unwrap();
        let slot: Arc<Mutex<Option<Arc<TerminalSession>>>> = Arc::new(Mutex::new(None));
        let bytes = Arc::new(Mutex::new(Vec::<u8>::new()));
        let sequences = Arc::new(Mutex::new(Vec::<u64>::new()));
        let auto_ack = Arc::new(AtomicBool::new(false));
        let callback_slot = slot.clone();
        let callback_bytes = bytes.clone();
        let callback_sequences = sequences.clone();
        let callback_ack = auto_ack.clone();
        let output = Channel::new(move |body| {
            let event: serde_json::Value = body.deserialize().unwrap();
            if event["type"] == "output" {
                let sequence = event["sequence"].as_u64().unwrap();
                callback_sequences.lock().unwrap().push(sequence);
                callback_bytes.lock().unwrap().extend(
                    event["data"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|byte| byte.as_u64().unwrap() as u8),
                );
                if callback_ack.load(Ordering::SeqCst) {
                    callback_slot
                        .lock()
                        .unwrap()
                        .as_ref()
                        .unwrap()
                        .acknowledge(sequence);
                }
            }
            Ok(())
        });
        let session =
            TerminalSession::start_at(output, folder.path().to_path_buf(), false).unwrap();
        *slot.lock().unwrap() = Some(session.clone());
        session
            .write("head -c 80000 /dev/zero | tr '\\0' x; printf '\\nFLOOD_END\\n'\r")
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while sequences.lock().unwrap().len() < 8 && std::time::Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(sequences.lock().unwrap().len(), 8);
        assert!(bytes.lock().unwrap().len() <= 32 * 1024);
        auto_ack.store(true, Ordering::SeqCst);
        session.acknowledge(8);
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while !String::from_utf8_lossy(&bytes.lock().unwrap()).contains("\r\nFLOOD_END\r\n")
            && std::time::Instant::now() < deadline
        {
            thread::sleep(Duration::from_millis(20));
        }
        session.stop();
        assert!(String::from_utf8_lossy(&bytes.lock().unwrap()).contains("\r\nFLOOD_END\r\n"));
        assert!(bytes.lock().unwrap().len() > 80_000);
        let (retained, truncated) = session.output_since(0);
        assert!(truncated);
        assert!(retained.len() <= MAX_RAW_OUTPUT_BYTES);
        assert!(String::from_utf8_lossy(&retained).contains("\r\nFLOOD_END\r\n"));
        assert!(sequences
            .lock()
            .unwrap()
            .windows(2)
            .all(|pair| pair[1] == pair[0] + 1));
    }

    #[test]
    fn tracks_directory_with_spaces() {
        let folder = tempfile::Builder::new()
            .prefix("terminal directory ")
            .tempdir()
            .unwrap();
        let mut child = std::process::Command::new("/bin/zsh")
            .args(["-f", "-c", "sleep 3"])
            .current_dir(folder.path())
            .spawn()
            .unwrap();
        let found = process_directory(child.id()).unwrap();
        let _ = child.kill();
        let _ = child.wait();
        assert_eq!(
            found.canonicalize().unwrap(),
            folder.path().canonicalize().unwrap()
        );
    }
    #[test]
    fn pty_supports_unicode_resize_interrupt_and_shutdown() {
        let folder = tempfile::Builder::new()
            .prefix("pty context ")
            .tempdir()
            .unwrap();
        let slot: Arc<Mutex<Option<Arc<TerminalSession>>>> = Arc::new(Mutex::new(None));
        let chunks = Arc::new(Mutex::new(Vec::<u8>::new()));
        let callback_slot = slot.clone();
        let callback_chunks = chunks.clone();
        let channel = Channel::new(move |body| {
            let event: serde_json::Value = body.deserialize().unwrap();
            if event["type"] == "output" {
                callback_chunks.lock().unwrap().extend(
                    event["data"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|value| value.as_u64().unwrap() as u8),
                );
                if let Some(session) = callback_slot.lock().unwrap().as_ref() {
                    session.acknowledge(event["sequence"].as_u64().unwrap());
                }
            }
            Ok(())
        });
        let session =
            TerminalSession::start_at(channel, folder.path().to_path_buf(), false).unwrap();
        *slot.lock().unwrap() = Some(session.clone());
        session.resize(110, 35).unwrap();
        assert_eq!(session.master.lock().unwrap().get_size().unwrap().cols, 110);
        session.write("printf '\\nPTY_MARKER: λ🙂\\n'\r").unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while !String::from_utf8_lossy(&chunks.lock().unwrap()).contains("PTY_MARKER: λ🙂\r\n")
            && std::time::Instant::now() < deadline
        {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(String::from_utf8_lossy(&chunks.lock().unwrap()).contains("PTY_MARKER: λ🙂\r\n"));
        let (raw, truncated) = session.output_since(0);
        assert!(!truncated);
        assert!(String::from_utf8_lossy(&raw).contains("PTY_MARKER: λ🙂\r\n"));
        session.write("sleep 10\r").unwrap();
        thread::sleep(Duration::from_millis(100));
        session.write("\u{3}").unwrap();
        session.write("printf '\\nINTERRUPTED_OK\\n'\r").unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while !String::from_utf8_lossy(&chunks.lock().unwrap()).contains("\r\nINTERRUPTED_OK\r\n")
            && std::time::Instant::now() < deadline
        {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(String::from_utf8_lossy(&chunks.lock().unwrap()).contains("\r\nINTERRUPTED_OK\r\n"));
        session.stop();
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while !session.exited.load(Ordering::SeqCst) && std::time::Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(session.exited.load(Ordering::SeqCst));
        assert!(session.write("echo should-not-run\r").is_err());
    }
}
