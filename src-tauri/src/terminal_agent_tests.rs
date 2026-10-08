use super::*;
use crate::terminal::{TerminalEvent, TerminalSnapshot};
use std::{future::Future, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::mpsc,
};

const TEST_TIMEOUT: Duration = Duration::from_secs(12);
const IO_TIMEOUT: Duration = Duration::from_secs(3);
const QUIET_WINDOW: Duration = Duration::from_millis(50);

async fn bounded<T>(future: impl Future<Output = T>) -> T {
    tokio::time::timeout(TEST_TIMEOUT, future)
        .await
        .expect("terminal agent test exceeded its deadline")
}

// The frontend owns screen parsing. This fixture supplies controlled rendered screens
// through that same publication boundary, using sequences/revisions from a real PTY.
// Command effects are checked independently in raw PTY bytes and a disposable directory.
struct PtyFixture {
    session: Arc<TerminalSession>,
    directory: tempfile::TempDir,
    output: mpsc::UnboundedReceiver<Value>,
    bytes: Vec<u8>,
    observations: Vec<(u64, u64)>,
    revision_notifications: Vec<u64>,
    columns: u16,
    rows: u16,
}

impl Drop for PtyFixture {
    fn drop(&mut self) {
        // Also runs on assertion failure or timeout, including an outstanding shell read.
        self.session.stop();
    }
}

impl PtyFixture {
    async fn start() -> Self {
        let directory = tempfile::tempdir().expect("create PTY directory");
        let (sender, output) = mpsc::unbounded_channel();
        let channel = Channel::<TerminalEvent>::new(move |body| {
            let event: Value = body.deserialize().expect("decode terminal event");
            // Teardown may close the receiver before the terminal exit event arrives.
            let _ = sender.send(event);
            Ok(())
        });
        let session = TerminalSession::start_at(channel, directory.path().to_path_buf(), false)
            .expect("start real non-login zsh PTY");
        let mut fixture = Self {
            session,
            directory,
            output,
            bytes: Vec::new(),
            observations: Vec::new(),
            revision_notifications: Vec::new(),
            columns: 80,
            rows: 24,
        };
        // -f avoids user rc files; disabling echo keeps input distinct from effects.
        // Split markers also cannot match the bootstrap command's initial echo.
        fixture.session.write(
            "unsetopt zle prompt_cr prompt_sp; PS1='$ '; RPS1=''; stty -echo; printf '\\n%s%s\\n' 'FIXTURE_' 'READY'\r",
        ).expect("initialize PTY");
        fixture
            .observe("\r\nFIXTURE_READY\r\n", "FIXTURE_READY\n$ ")
            .await;
        fixture
    }

    fn consume(&mut self, event: Value) {
        assert_eq!(event["sessionId"], self.session.id);
        if event["type"] == "revision" {
            // These notifications also arrive for input that produces no output. Their
            // revision may race an output event; publication reads current_revision.
            self.revision_notifications
                .push(event["revision"].as_u64().expect("revision notification"));
            return;
        }
        assert_eq!(event["type"], "output", "unexpected PTY event: {event}");
        let sequence = event["sequence"].as_u64().expect("output sequence");
        let revision = event["revision"].as_u64().expect("output revision");
        let previous = self.observations.last().copied().unwrap_or((0, 0));
        assert_eq!(sequence, previous.0 + 1, "output chunks must be ordered");
        assert!(
            revision > previous.1,
            "output must invalidate older observations"
        );
        let data: Vec<u8> =
            serde_json::from_value(event["data"].clone()).expect("PTY output bytes");
        self.bytes.extend_from_slice(&data);
        self.observations.push((sequence, revision));
        // Release backpressure only after consuming this entire chunk.
        self.session.acknowledge(sequence);
    }

    fn raw_contains(&self, marker: &str) -> bool {
        String::from_utf8_lossy(&self.bytes).contains(marker)
    }

    async fn observe(&mut self, raw_marker: &str, screen: &str) -> TerminalSnapshot {
        tokio::time::timeout(IO_TIMEOUT, async {
            while !self.raw_contains(raw_marker) {
                let event = self.output.recv().await.expect("PTY channel closed");
                self.consume(event);
            }
            self.publish_when_quiet(screen).await
        })
        .await
        .expect("expected actual PTY output and snapshot publication")
    }

    async fn publish_when_quiet(&mut self, screen: &str) -> TerminalSnapshot {
        // Input and resize can invalidate a snapshot without changing its sequence.
        // Republish using current_revision, never an invented counter or stale event.
        loop {
            match tokio::time::timeout(QUIET_WINDOW, self.output.recv()).await {
                Ok(Some(event)) => self.consume(event),
                Ok(None) => panic!("PTY channel closed before snapshot publication"),
                Err(_) => {
                    let snapshot = TerminalSnapshot {
                        session_id: self.session.id.clone(),
                        sequence: self.observations.last().expect("PTY output received").0,
                        revision: self.session.current_revision().expect("live PTY revision"),
                        screen: screen.into(),
                        scrollback: String::new(),
                        cursor_x: 0,
                        cursor_y: (screen.lines().count().saturating_sub(1) as u16)
                            .min(self.rows - 1),
                        columns: self.columns,
                        rows: self.rows,
                        alternate: false,
                        truncated: false,
                    };
                    if self.session.publish_snapshot(snapshot.clone()).is_ok() {
                        return snapshot;
                    }
                    // A reader can invalidate between current_revision and publication.
                    // Consume the arriving output, then retry within the caller's deadline.
                }
            }
        }
    }

    async fn resize(&mut self, columns: u16, rows: u16) -> TerminalSnapshot {
        self.session
            .resize_with_revision(columns, rows)
            .expect("resize real PTY");
        self.columns = columns;
        self.rows = rows;
        tokio::time::timeout(IO_TIMEOUT, self.publish_when_quiet("$ "))
            .await
            .expect("resized snapshot publication")
    }

    async fn assert_input_had_no_effect(&mut self, marker: &str, file: &str) {
        // A later command is an ordering fence: any mistakenly sent action would run
        // before it, so absence is not inferred just from a short quiet interval.
        self.session
            .write("printf '\\n%s%s\\n' 'HUMAN_' 'FENCE'\r")
            .expect("write human verification command");
        self.observe("\r\nHUMAN_FENCE\r\n", "HUMAN_FENCE\n$ ").await;
        assert!(!self.raw_contains(marker), "blocked input reached the PTY");
        assert!(
            !self.directory.path().join(file).exists(),
            "blocked input ran"
        );
    }
}

struct AgentFixture {
    manager: ChatManager,
    control: Arc<RequestControl>,
    events: Arc<Mutex<Vec<Value>>>,
}

impl Drop for AgentFixture {
    fn drop(&mut self) {
        self.control.invalidate();
    }
}

impl AgentFixture {
    fn new(pty: &PtyFixture, mode: PermissionMode) -> Self {
        let events = Arc::new(Mutex::new(Vec::new()));
        let collected = events.clone();
        let control = Arc::new(RequestControl {
            request_id: Uuid::new_v4().to_string(),
            session_id: pty.session.id.clone(),
            conversation_id: Uuid::new_v4().to_string(),
            cancel: CancellationToken::new(),
            running_process: AtomicU32::new(0),
            pending: Mutex::new(HashMap::new()),
            steering: Mutex::new(None),
            events: Channel::new(move |body| {
                collected
                    .lock()
                    .expect("chat event collection")
                    .push(body.deserialize::<Value>().expect("decode chat event"));
                Ok(())
            }),
            sessions: HashMap::from([(pty.session.id.clone(), pty.session.clone())]),
            labels: HashMap::from([(pty.session.id.clone(), "Fixture terminal".into())]),
            mode: AtomicU8::new(match mode {
                PermissionMode::Ask => 0,
                PermissionMode::Auto => 1,
                PermissionMode::Full => 2,
            }),
            paused: AtomicU32::new(0),
        });
        let manager = ChatManager::default();
        *manager.active.lock().expect("active request") = Some(control.clone());
        Self {
            manager,
            control,
            events,
        }
    }

    async fn tool(&self, name: &str, arguments: Value, denied: &mut bool) -> Value {
        self.manager
            .execute_tool(name, Some(arguments), None, &self.control, denied)
            .await
            .expect("terminal tool dispatch")
    }

    async fn pending_approval(&self) -> String {
        tokio::time::timeout(IO_TIMEOUT, async {
            loop {
                let approval = self
                    .control
                    .pending
                    .lock()
                    .expect("approval map")
                    .keys()
                    .next()
                    .cloned();
                if let Some(approval) = approval {
                    return approval;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("terminal input should request approval")
    }

    fn input(&self, revision: u64, text: &str) -> Value {
        json!({"sessionId":self.control.session_id,"revision":revision,
            "text":text,"keys":["Enter"],"purpose":"Run a harmless fixture marker command"})
    }

    fn assert_tool_status(&self, name: &str, status: &str) {
        assert!(
            self.events
                .lock()
                .expect("chat events")
                .iter()
                .any(|event| {
                    event["type"] == "tool"
                        && event["name"] == name
                        && event["status"] == status
                        && event["requestId"] == self.control.request_id
                        && event["sessionId"] == self.control.session_id
                        && event["conversationId"] == self.control.conversation_id
                }),
            "missing {name} {status} event with request routing"
        );
    }
}

#[tokio::test]
async fn real_pty_output_is_acknowledged_and_published_through_terminal_tools() {
    bounded(async {
        let mut pty = PtyFixture::start().await;
        let agent = AgentFixture::new(&pty, PermissionMode::Full);
        let initial = pty.session.snapshot().unwrap();
        let output_start_sequence = initial.sequence;
        assert_eq!((initial.columns, initial.rows), (80, 24));
        let mut denied = false;
        let value = agent
            .tool(
                "terminal_snapshot",
                json!({"sessionId":pty.session.id}),
                &mut denied,
            )
            .await;
        assert_eq!(
            serde_json::from_value::<TerminalSnapshot>(value).unwrap(),
            initial
        );

        // More than the eight-chunk / 32 KiB flow window must drain to reach this marker.
        pty.session
            .write("head -c 48000 /dev/zero | tr '\\0' x; printf '\\n%s%s\\n' 'FLOW_' 'DRAINED'\r")
            .unwrap();
        let current = pty
            .observe("\r\nFLOW_DRAINED\r\n", "FLOW_DRAINED\n$ ")
            .await;
        assert!(current.sequence > initial.sequence + 8);
        assert!(current.revision > initial.revision);
        assert!(pty.session.publish_snapshot(initial).is_err());
        let (raw, truncated) = pty.session.output_since(0);
        assert!(!truncated);
        assert_eq!(raw, pty.bytes);

        let result = agent
            .tool(
                "terminal_wait",
                json!({"sessionId":pty.session.id,
            "afterSequence":output_start_sequence,"timeoutMs":1000}),
                &mut denied,
            )
            .await;
        assert_eq!(result["sequence"], current.sequence);
        assert_eq!(result["revision"], current.revision);
        assert_eq!(result["waitTimedOut"], false);
        assert!(result["stdout"].as_str().unwrap().contains("FLOW_DRAINED"));
        assert_eq!(result["outputTruncated"], false);
        agent.assert_tool_status("terminal_snapshot", "done");
        agent.assert_tool_status("terminal_wait", "done");
    })
    .await;
}

#[tokio::test]
async fn full_access_sends_literal_input_and_requires_observing_actual_effects() {
    bounded(async {
        let mut pty = PtyFixture::start().await;
        let agent = AgentFixture::new(&pty, PermissionMode::Full);
        let initial = pty.session.snapshot().unwrap();
        let mut denied = false;
        let command = "printf '\\n%s%s\\n' 'AGENT_' 'OK: λ🙂'; : > full-access-ran";
        assert!(
            !command.contains("AGENT_OK"),
            "echo must not satisfy the marker"
        );
        let result = agent
            .tool(
                "terminal_input",
                agent.input(initial.revision, command),
                &mut denied,
            )
            .await;
        assert_eq!(result["sent"], true);
        assert_eq!(result["sessionId"], pty.session.id);
        let current = pty
            .observe("\r\nAGENT_OK: λ🙂\r\n", "AGENT_OK: λ🙂\n$ ")
            .await;
        assert!(current.sequence > initial.sequence);
        assert!(current.revision > initial.revision);
        assert!(pty.directory.path().join("full-access-ran").exists());
        assert!(!denied);
        assert!(agent.control.pending.lock().unwrap().is_empty());
        assert!(!agent
            .events
            .lock()
            .unwrap()
            .iter()
            .any(|event| event["status"] == "approval"));
        agent.assert_tool_status("terminal_input", "done");
        let wait = agent
            .tool(
                "terminal_wait",
                json!({"sessionId":pty.session.id,
            "afterSequence":initial.sequence,"timeoutMs":1000}),
                &mut denied,
            )
            .await;
        assert_eq!(wait["waitTimedOut"], false);
        assert!(wait["screen"].as_str().unwrap().contains("AGENT_OK: λ🙂"));
        assert!(wait["stdout"].as_str().unwrap().contains("AGENT_OK: λ🙂"));
    })
    .await;
}

#[tokio::test]
async fn rejected_ask_input_has_no_effect_and_cannot_be_retried_in_the_turn() {
    bounded(async {
        let mut pty = PtyFixture::start().await;
        let agent = AgentFixture::new(&pty, PermissionMode::Ask);
        let initial = pty.session.snapshot().unwrap();
        let arguments = agent.input(
            initial.revision,
            "printf '\\n%s%s\\n' 'REJECTED_' 'RAN'; : > rejected-ran",
        );
        let mut denied = false;
        let executing = agent.tool("terminal_input", arguments.clone(), &mut denied);
        let rejecting = async {
            let approval = agent.pending_approval().await;
            assert_eq!(pty.session.current_revision().unwrap(), initial.revision);
            agent
                .manager
                .decide(&agent.control.request_id, &approval, false)
                .unwrap();
            assert!(agent
                .manager
                .decide(&agent.control.request_id, &approval, true)
                .is_err());
        };
        let (result, ()) = tokio::join!(executing, rejecting);
        assert_eq!(result["rejected"], true);
        assert!(denied);
        assert_eq!(pty.session.snapshot().unwrap(), initial);
        let retry = agent.tool("terminal_input", arguments, &mut denied).await;
        assert!(retry["error"].as_str().unwrap().contains("rejected"));
        assert!(agent.control.pending.lock().unwrap().is_empty());
        agent.assert_tool_status("terminal_input", "approval");
        agent.assert_tool_status("terminal_input", "rejected");
        pty.assert_input_had_no_effect("REJECTED_RAN", "rejected-ran")
            .await;
    })
    .await;
}

#[tokio::test]
async fn approval_after_real_pty_resize_rejects_the_stale_revision() {
    bounded(async {
        let mut pty = PtyFixture::start().await;
        let agent = AgentFixture::new(&pty, PermissionMode::Ask);
        let initial = pty.session.snapshot().unwrap();
        let mut denied = false;
        let executing = agent.tool(
            "terminal_input",
            agent.input(
                initial.revision,
                "printf '\\n%s%s\\n' 'STALE_' 'RAN'; : > stale-ran",
            ),
            &mut denied,
        );
        let approving = async {
            let approval = agent.pending_approval().await;
            let resized = pty.resize(100, 30).await;
            assert_eq!((resized.columns, resized.rows), (100, 30));
            assert!(resized.revision > initial.revision);
            assert!(pty.session.publish_snapshot(initial.clone()).is_err());
            agent
                .manager
                .decide(&agent.control.request_id, &approval, true)
                .unwrap();
            resized
        };
        let (result, resized) = tokio::join!(executing, approving);
        assert!(result["error"]
            .as_str()
            .unwrap()
            .contains("Stale terminal observation"));
        assert_eq!(pty.session.snapshot().unwrap(), resized);
        assert!(
            !denied,
            "approval was granted but the revision check rejected the write"
        );
        assert!(agent.control.pending.lock().unwrap().is_empty());
        agent.assert_tool_status("terminal_input", "error");
        pty.assert_input_had_no_effect("STALE_RAN", "stale-ran")
            .await;
    })
    .await;
}

#[tokio::test]
async fn manual_takeover_pauses_the_request_and_invalidates_pending_approval() {
    bounded(async {
        let mut pty = PtyFixture::start().await;
        let agent = AgentFixture::new(&pty, PermissionMode::Ask);
        let initial = pty.session.snapshot().unwrap();
        let mut denied = false;
        let executing = agent.tool(
            "terminal_input",
            agent.input(
                initial.revision,
                "printf '\\n%s%s\\n' 'TAKEOVER_' 'RAN'; : > takeover-ran",
            ),
            &mut denied,
        );
        let takeover = async {
            let approval = agent.pending_approval().await;
            assert!(agent.manager.uses_session(&pty.session.id));
            agent
                .manager
                .pause_session("unattached-session", "irrelevant input");
            assert!(agent.manager.has_active_request());
            agent
                .manager
                .pause_session(&pty.session.id, "Human took over the terminal");
            assert!(agent.control.cancel.is_cancelled());
            assert_eq!(agent.control.paused.load(Ordering::SeqCst), 1);
            assert!(agent.control.pending.lock().unwrap().is_empty());
            assert!(agent
                .manager
                .decide(&agent.control.request_id, &approval, true)
                .is_err());
        };
        let (result, ()) = tokio::join!(executing, takeover);
        assert!(result["error"].as_str().unwrap().contains("Canceled"));
        assert!(!agent.manager.has_active_request());
        assert!(!agent.manager.uses_session(&pty.session.id));
        assert_eq!(pty.session.snapshot().unwrap(), initial);
        assert_eq!(
            agent
                .events
                .lock()
                .unwrap()
                .iter()
                .filter(|event| {
                    event["type"] == "paused" && event["label"] == "Human took over the terminal"
                })
                .count(),
            1
        );
        pty.assert_input_had_no_effect("TAKEOVER_RAN", "takeover-ran")
            .await;
    })
    .await;
}

#[tokio::test]
async fn terminal_wait_timeout_returns_an_observation_without_claiming_completion() {
    bounded(async {
        let pty = PtyFixture::start().await;
        let agent = AgentFixture::new(&pty, PermissionMode::Full);
        let snapshot = pty.session.snapshot().unwrap();
        let mut denied = false;
        let result = agent
            .tool(
                "terminal_wait",
                json!({"sessionId":pty.session.id,
            "afterSequence":snapshot.sequence,"timeoutMs":20}),
                &mut denied,
            )
            .await;
        assert_eq!(result["waitTimedOut"], true);
        assert_eq!(result["sequence"], snapshot.sequence);
        assert_eq!(result["revision"], snapshot.revision);
        assert_eq!(result["screen"], snapshot.screen);
        assert_eq!(result["stdout"], "");
        assert_eq!(result["outputTruncated"], false);
        assert!(result.get("sent").is_none());
        let invalid = agent
            .tool(
                "terminal_wait",
                json!({"sessionId":pty.session.id,
            "afterSequence":snapshot.sequence,"timeoutMs":10001}),
                &mut denied,
            )
            .await;
        assert!(invalid["error"].as_str().unwrap().contains("10 seconds"));
    })
    .await;
}

#[tokio::test]
async fn silent_input_revision_notification_allows_same_sequence_republication() {
    bounded(async {
        let mut pty = PtyFixture::start().await;
        let initial = pty.session.snapshot().unwrap();
        let agent = AgentFixture::new(&pty, PermissionMode::Full);
        let notifications_before = pty.revision_notifications.len();
        let mut denied = false;
        let mut arguments = agent.input(initial.revision, " ");
        arguments["keys"] = json!([]);
        let result = agent.tool("terminal_input", arguments, &mut denied).await;
        assert_eq!(result["sent"], true);
        assert!(
            pty.session.snapshot().is_err(),
            "input must invalidate the screen"
        );
        let republished = tokio::time::timeout(IO_TIMEOUT, pty.publish_when_quiet("$ "))
            .await
            .expect("silent input snapshot republication");
        assert_eq!(republished.sequence, initial.sequence);
        assert!(republished.revision > initial.revision);
        assert!(pty.revision_notifications[notifications_before..]
            .iter()
            .any(|revision| *revision > initial.revision));
        assert_eq!(
            pty.session
                .current_snapshot(&agent.control.cancel)
                .await
                .unwrap(),
            republished
        );
    })
    .await;
}

// A local mock reads the entire HTTP body, including bodies split over socket reads.
async fn read_request(socket: &mut tokio::net::TcpStream) -> Value {
    let mut bytes = Vec::new();
    let header_end = loop {
        let mut buffer = [0; 4096];
        let count = socket
            .read(&mut buffer)
            .await
            .expect("read mock HTTP headers");
        assert!(count > 0, "connection closed during headers");
        bytes.extend_from_slice(&buffer[..count]);
        assert!(
            bytes.len() <= MAX_REQUEST_BYTES * 2,
            "mock request too large"
        );
        if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
            break end + 4;
        }
    };
    let headers = std::str::from_utf8(&bytes[..header_end]).unwrap();
    assert!(headers.starts_with("POST /v1/responses HTTP/1.1"));
    let length = headers
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().unwrap())
        })
        .expect("mock request Content-Length");
    assert!(length <= MAX_REQUEST_BYTES * 2);
    while bytes.len() < header_end + length {
        let mut buffer = [0; 4096];
        let count = socket.read(&mut buffer).await.expect("read mock HTTP body");
        assert!(count > 0, "connection closed during body");
        bytes.extend_from_slice(&buffer[..count]);
    }
    serde_json::from_slice(&bytes[header_end..header_end + length]).expect("mock request JSON")
}

fn call_result(request: &Value, call_id: &str) -> Value {
    let output = request["input"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["type"] == "function_call_output" && item["call_id"] == call_id)
        .expect("preceding tool result must be replayed to the API");
    serde_json::from_str(output["output"].as_str().unwrap()).unwrap()
}

async fn write_sse(socket: &mut tokio::net::TcpStream, events: &[Value]) {
    let body = events
        .iter()
        .map(|event| format!("data: {event}\n\n"))
        .collect::<String>();
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes()).await.unwrap();
    for fragment in body.as_bytes().chunks(11) {
        socket.write_all(fragment).await.unwrap();
        tokio::task::yield_now().await;
    }
}

fn assert_complete_tool_pairs(items: &[Value]) {
    let mut outstanding = std::collections::HashSet::new();
    for item in items {
        match item["type"].as_str() {
            Some("function_call") => {
                assert!(outstanding.insert(item["call_id"].as_str().unwrap().to_owned()));
            }
            Some("function_call_output") => {
                assert!(
                    outstanding.remove(item["call_id"].as_str().unwrap()),
                    "orphan tool result"
                );
            }
            _ => {}
        }
    }
    assert!(outstanding.is_empty(), "unpaired tool calls");
}

struct AbortOnDrop<T>(tokio::task::JoinHandle<T>);
impl<T> Drop for AbortOnDrop<T> {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[tokio::test]
async fn mocked_api_observes_inputs_waits_and_answers_with_replayable_tool_pairs() {
    bounded(async {
        let mut pty = PtyFixture::start().await;
        let initial = pty.session.snapshot().unwrap();
        let agent = AgentFixture::new(&pty, PermissionMode::Full);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/v1/responses", listener.local_addr().unwrap());
        let session_id = pty.session.id.clone();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = requests.clone();
        let answer = "The attached terminal printed MOCK_AGENT_OK.";
        let mut server = AbortOnDrop(tokio::spawn(async move {
            let mut observed_sequence = 0;
            for step in 0..4 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let request = read_request(&mut socket).await;
                assert_complete_tool_pairs(request["input"].as_array().unwrap());
                let (name, arguments) = match step {
                    0 => ("terminal_snapshot", json!({"sessionId":session_id})),
                    1 => {
                        let snapshot = call_result(&request, "terminal_call_0");
                        assert_eq!(snapshot["sessionId"], session_id);
                        observed_sequence = snapshot["sequence"].as_u64().unwrap();
                        ("terminal_input", json!({"sessionId":session_id,
                            "revision":snapshot["revision"],"text":"printf '\\n%s%s\\n' 'MOCK_AGENT_' 'OK'; : > mock-agent-ran",
                            "keys":["Enter"],"purpose":"Print a harmless marker in the attached terminal"}))
                    }
                    2 => {
                        assert_eq!(call_result(&request, "terminal_call_1")["sent"], true);
                        ("terminal_wait", json!({"sessionId":session_id,
                            "afterSequence":observed_sequence,"timeoutMs":2000}))
                    }
                    _ => {
                        let waited = call_result(&request, "terminal_call_2");
                        assert_eq!(waited["waitTimedOut"], false);
                        assert!(waited["sequence"].as_u64().unwrap() > observed_sequence);
                        assert!(waited["screen"].as_str().unwrap().contains("MOCK_AGENT_OK"));
                        assert!(waited["stdout"].as_str().unwrap().contains("MOCK_AGENT_OK"));
                        ("", json!({}))
                    }
                };
                recorded.lock().unwrap().push(request);
                let output = if name.is_empty() {
                    json!([{"type":"message","role":"assistant","content":[{
                        "type":"output_text","text":answer,"annotations":[]}]}])
                } else {
                    json!([{"type":"reasoning","encrypted_content":"opaque-fixture-reasoning"},
                        {"type":"function_call","id":format!("fc_terminal_{step}"),
                        "call_id":format!("terminal_call_{step}"),"name":name,"arguments":arguments.to_string()}])
                };
                // A streamed argument fragment is untrusted until response.completed.
                let fragment = json!({"type":"response.function_call_arguments.delta",
                    "delta":"{\"text\":\": > premature-agent-ran\"}"});
                let mut events = vec![fragment];
                if name.is_empty() {
                    events.push(json!({"type":"response.output_text.delta","delta":answer}));
                }
                events.push(json!({"type":"response.completed","response":{"output":output}}));
                write_sse(&mut socket, &events).await;
            }
        }));
        let input = ChatInput {
            reasoning_effort: ReasoningEffort::Medium,
            request_id: agent.control.request_id.clone(),
            session_id: pty.session.id.clone(),
            conversation_id: agent.control.conversation_id.clone(),
            text: "Print the fixture marker in the attached terminal and verify its output.".into(),
            directory: None,
            terminal_text: None,
            attachments: vec![Attachment { session_id: pty.session.id.clone(), label: "Fixture terminal".into() }],
            history: vec![],
            redact_sensitive_info: None,
        };
        let turning = agent.manager.run_turn_with_client(&input, None, "mock-terminal-model",
            "not-a-real-api-key", &agent.control, OpenAiClient::for_test(endpoint));
        let frontend = pty.observe("\r\nMOCK_AGENT_OK\r\n", "MOCK_AGENT_OK\n$ ");
        let (result, observed) = tokio::join!(turning, frontend);
        result.expect("complete mock terminal agent turn");
        (&mut server.0).await.expect("mock API assertions");
        assert!(observed.revision > initial.revision);
        assert!(pty.directory.path().join("mock-agent-ran").exists());
        assert!(!pty.directory.path().join("premature-agent-ran").exists());

        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 4);
        for (step, request) in requests.iter().enumerate() {
            assert_eq!(request["store"], false);
            assert_eq!(request["stream"], true);
            assert_eq!(request["parallel_tool_calls"], false);
            let tools = request["tools"].as_array().unwrap();
            assert_eq!(tools.len(), if step == 3 { 0 } else { 3 },
                "verified completion must request a final response without terminal tools");
            if step == 3 {
                continue;
            }
            for name in ["terminal_snapshot", "terminal_input", "terminal_wait"] {
                let tool = tools.iter().find(|tool| tool["name"] == name).unwrap();
                assert_eq!(tool["type"], "function");
                assert_eq!(tool["strict"], true);
                let parameters = &tool["parameters"];
                assert_eq!(parameters["additionalProperties"], false);
                assert_eq!(parameters["properties"]["sessionId"]["type"], "string");
                let properties = parameters["properties"].as_object().unwrap();
                let required = parameters["required"].as_array().unwrap();
                assert_eq!(required.len(), properties.len());
                assert!(properties.keys().all(|key| required.contains(&json!(key))));
            }
            assert_eq!(request["input"].as_array().unwrap().iter()
                .filter(|item| item["type"] == "function_call_output").count(), step);
        }
        assert_eq!(requests[0]["tools"].as_array().unwrap().iter()
            .find(|tool| tool["name"] == "terminal_input").unwrap()["parameters"]["properties"]["revision"]["type"], "integer");
        assert!(requests[3]["input"].as_array().unwrap().iter()
            .any(|item| item["encrypted_content"] == "opaque-fixture-reasoning"));
        drop(requests);
        let history = agent.manager.history.lock().unwrap();
        assert_eq!(history.last_request_id, input.request_id);
        assert_eq!(history.turns.len(), 1);
        let saved = history.turns.back().unwrap();
        assert_complete_tool_pairs(saved);
        assert_eq!(saved.last().unwrap()["content"][0]["text"], answer);
        drop(history);
        assert!(agent.events.lock().unwrap().iter().any(|event| {
            event["type"] == "textDelta" && event["delta"] == answer
        }));
        for name in ["terminal_snapshot", "terminal_input", "terminal_wait"] {
            agent.assert_tool_status(name, "done");
        }
        assert!(agent.control.pending.lock().unwrap().is_empty());
    }).await;
}

#[tokio::test]
async fn mocked_api_pauses_at_task_limit_without_an_extra_request_and_compacts_complete_pairs() {
    bounded(async {
        assert_eq!(MAX_TOOL_CALLS, 100, "exercise the configured 100-action limit");
        let pty = PtyFixture::start().await;
        let mut snapshot = pty.session.snapshot().unwrap();
        // Keep one stable frontend observation large enough that repeated results
        // exercise real turn compaction before the action limit is reached.
        snapshot.scrollback = "Earlier harmless fixture output.\n".repeat(160);
        pty.session.publish_snapshot(snapshot.clone()).unwrap();
        let agent = AgentFixture::new(&pty, PermissionMode::Full);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/v1/responses", listener.local_addr().unwrap());
        let expected_snapshot = snapshot.clone();
        let (turn_finished, finished_turn) = oneshot::channel();
        let mut server = AbortOnDrop(tokio::spawn(async move {
            let mut compaction_observed = false;
            for step in 0..MAX_TOOL_CALLS {
                let (mut socket, _) = listener.accept().await.unwrap();
                let request = read_request(&mut socket).await;
                let messages = request["input"].as_array().unwrap();
                assert_complete_tool_pairs(messages);
                assert!(serde_json::to_vec(messages).unwrap().len() <= MAX_REQUEST_BYTES);
                let completed = messages.iter()
                    .filter(|item| item["type"] == "function_call_output").count();
                assert!(completed <= step);
                compaction_observed |= completed < step;
                if step > 0 {
                    let previous = call_result(&request, &format!("limit_call_{}", step - 1));
                    assert_eq!(serde_json::from_value::<TerminalSnapshot>(previous).unwrap(), expected_snapshot);
                }
                write_sse(&mut socket, &[json!({"type":"response.completed","response":{"output":[{
                    "type":"function_call","id":format!("fc_limit_{step}"),
                    "call_id":format!("limit_call_{step}"),"name":"terminal_snapshot",
                    "arguments":json!({"sessionId":expected_snapshot.session_id}).to_string()
                }]}})]).await;
            }
            // Keep accepting until run_turn returns. An off-by-one API dispatch fails
            // immediately here rather than hiding behind a closed mock endpoint.
            tokio::select! {
                biased;
                unexpected = listener.accept() => panic!("unexpected 101st API connection: {unexpected:?}"),
                finished = finished_turn => finished.expect("turn should return at the action limit"),
            }
            assert!(tokio::time::timeout(QUIET_WINDOW, listener.accept()).await.is_err(),
                "no additional API connection may be queued after the turn pauses");
            compaction_observed
        }));
        let input = ChatInput {
            reasoning_effort: ReasoningEffort::Medium,
            request_id: agent.control.request_id.clone(),
            session_id: pty.session.id.clone(),
            conversation_id: agent.control.conversation_id.clone(),
            text: "Observe the attached terminal until the bounded task pauses.".into(),
            directory: None,
            terminal_text: None,
            attachments: vec![Attachment {
                session_id: pty.session.id.clone(), label: "Fixture terminal".into(),
            }],
            history: vec![],
            redact_sensitive_info: None,
        };
        agent.manager.run_turn_with_client(&input, None, "mock-terminal-model",
            "not-a-real-api-key", &agent.control, OpenAiClient::for_test(endpoint))
            .await.expect("task limit should pause successfully");
        turn_finished.send(()).expect("mock should still guard against another request");
        assert!((&mut server.0).await.expect("task limit mock assertions"),
            "large repeated snapshots must exercise compaction");
        assert_eq!(agent.control.paused.load(Ordering::SeqCst), 1);
        assert!(!agent.control.cancel.is_cancelled(), "the paused task can be continued");
        assert!(agent.control.pending.lock().unwrap().is_empty());
        assert_eq!(pty.session.snapshot().unwrap(), snapshot);

        let history = agent.manager.history.lock().unwrap();
        assert_eq!(history.conversation_id, input.conversation_id);
        assert_eq!(history.last_request_id, input.request_id);
        assert_eq!(history.turns.len(), 1);
        let saved = history.turns.back().unwrap();
        assert!(saved[0]["content"].as_str().unwrap().contains(&input.text));
        assert_complete_tool_pairs(saved);
        assert!(serde_json::to_vec(saved).unwrap().len() <= MAX_REQUEST_BYTES / 2);
        let completed = saved.iter().filter(|item| item["type"] == "function_call_output").count();
        assert!(completed > 0 && completed < MAX_TOOL_CALLS,
            "compaction should retain recent complete exchanges");
        assert!(!saved.iter().any(|item| item["call_id"] == "limit_call_0"));
        let last = saved.last().unwrap();
        assert_eq!(last["type"], "function_call_output");
        assert_eq!(last["call_id"], format!("limit_call_{}", MAX_TOOL_CALLS - 1));
        let final_snapshot: TerminalSnapshot = serde_json::from_str(last["output"].as_str().unwrap()).unwrap();
        assert_eq!(final_snapshot, snapshot);
        drop(history);

        let events = agent.events.lock().unwrap();
        for status in ["running", "done"] {
            assert_eq!(events.iter().filter(|event| event["type"] == "tool"
                && event["name"] == "terminal_snapshot" && event["status"] == status).count(), MAX_TOOL_CALLS);
        }
        let paused = events.iter().filter(|event| event["type"] == "paused").collect::<Vec<_>>();
        assert_eq!(paused.len(), 1);
        assert_eq!(paused[0]["label"], "Task reached 100 actions. Continue to resume with fresh observations.");
        assert_eq!(paused[0]["requestId"], input.request_id);
        assert_eq!(paused[0]["sessionId"], input.session_id);
        assert_eq!(paused[0]["conversationId"], input.conversation_id);
        assert!(!events.iter().any(|event| event["status"] == "approval"
            || event["status"] == "error" || event["type"] == "done"));
    }).await;
}

#[tokio::test]
async fn mocked_api_manual_pause_before_first_approval_preserves_question_on_resume() {
    bounded(async {
        let pty = PtyFixture::start().await;
        let initial = pty.session.snapshot().unwrap();
        let agent = AgentFixture::new(&pty, PermissionMode::Ask);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/v1/responses", listener.local_addr().unwrap());
        let session_id = pty.session.id.clone();
        let (streaming, reached_input_stream) = oneshot::channel();
        let server = AbortOnDrop(tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let first = read_request(&mut socket).await;
            assert_eq!(first["input"].as_array().unwrap().len(), 1);
            write_sse(&mut socket, &[json!({"type":"response.completed","response":{"output":[{
                "type":"function_call","id":"fc_before_pause","call_id":"snapshot_before_pause",
                "name":"terminal_snapshot","arguments":json!({"sessionId":session_id}).to_string()
            }]}})]).await;

            let (mut socket, _) = listener.accept().await.unwrap();
            let second = read_request(&mut socket).await;
            assert_complete_tool_pairs(second["input"].as_array().unwrap());
            assert_eq!(call_result(&second, "snapshot_before_pause")["sessionId"], session_id);
            // Keep the input proposal incomplete. Manual takeover happens while the
            // client is still streaming, before any approval can be created.
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").await.unwrap();
            let fragment = json!({"type":"response.function_call_arguments.delta",
                "delta":"{\"text\":\": > paused-input-ran\"}"});
            socket.write_all(format!("data: {fragment}\n\n").as_bytes()).await.unwrap();
            streaming.send(()).expect("signal incomplete input stream");
            // Wait for cancellation to close this socket; the owning guard also aborts
            // this task if a test assertion or deadline fails.
            let mut byte = [0];
            let _ = socket.read(&mut byte).await;
        }));
        let input = ChatInput {
            reasoning_effort: ReasoningEffort::Medium,
            request_id: agent.control.request_id.clone(),
            session_id: pty.session.id.clone(),
            conversation_id: agent.control.conversation_id.clone(),
            text: "Inspect the terminal, then print the fixture marker and verify it.".into(),
            directory: None,
            terminal_text: None,
            attachments: vec![Attachment { session_id: pty.session.id.clone(), label: "Fixture terminal".into() }],
            history: vec![],
            redact_sensitive_info: None,
        };
        let original_question = input.text.clone();
        let turning = agent.manager.run_turn_with_client(&input, None, "mock-terminal-model",
            "not-a-real-api-key", &agent.control, OpenAiClient::for_test(endpoint));
        let takeover = async {
            tokio::time::timeout(IO_TIMEOUT, reached_input_stream).await
                .expect("mock should reach the input proposal").expect("mock stream signal");
            assert!(agent.control.pending.lock().unwrap().is_empty());
            // The initial question and completed snapshot exchange are already saved.
            let history = agent.manager.history.lock().unwrap();
            let saved = history.turns.back().unwrap();
            assert!(saved[0]["content"].as_str().unwrap().contains(&original_question));
            assert_complete_tool_pairs(saved);
            drop(history);
            agent.manager.pause_session(&pty.session.id, "Human paused before input approval");
        };
        let (result, ()) = tokio::join!(turning, takeover);
        assert!(result.unwrap_err().to_string().contains("Canceled"));
        drop(server);
        assert_eq!(pty.session.snapshot().unwrap(), initial);
        assert!(!pty.directory.path().join("paused-input-ran").exists());
        assert!(!agent.events.lock().unwrap().iter().any(|event| event["status"] == "approval"));

        let resumed = RequestControl {
            request_id: Uuid::new_v4().to_string(),
            session_id: agent.control.session_id.clone(),
            conversation_id: agent.control.conversation_id.clone(),
            cancel: CancellationToken::new(),
            running_process: AtomicU32::new(0),
            pending: Mutex::new(HashMap::new()),
            steering: Mutex::new(None),
            events: agent.control.events.clone(),
            sessions: agent.control.sessions.clone(),
            labels: agent.control.labels.clone(),
            mode: AtomicU8::new(0),
            paused: AtomicU32::new(0),
        };
        let resumed_input = ChatInput { request_id: resumed.request_id.clone(),
            text: "Continue the original task.".into(), ..input };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/v1/responses", listener.local_addr().unwrap());
        let mut resume_server = AbortOnDrop(tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_request(&mut socket).await;
            write_sse(&mut socket, &[json!({"type":"response.completed","response":{"output":[{
                "type":"message","role":"assistant","content":[{
                    "type":"output_text","text":"The original task is available to continue.","annotations":[]
                }]
            }]}})]).await;
            request
        }));
        agent.manager.run_turn_with_client(&resumed_input, None, "mock-terminal-model",
            "not-a-real-api-key", &resumed, OpenAiClient::for_test(endpoint)).await.unwrap();
        let replay = (&mut resume_server.0).await.expect("resume mock request");
        let messages = replay["input"].as_array().unwrap();
        assert!(messages[0]["content"].as_str().unwrap().contains(&original_question));
        assert!(messages.last().unwrap()["content"].as_str().unwrap().contains("Continue the original task."));
        assert_complete_tool_pairs(messages);
        assert_eq!(call_result(&replay, "snapshot_before_pause")["revision"], initial.revision);
        assert_eq!(agent.manager.history.lock().unwrap().turns.len(), 2);
    }).await;
}
