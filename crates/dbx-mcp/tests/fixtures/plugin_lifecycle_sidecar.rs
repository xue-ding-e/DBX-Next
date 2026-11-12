//! Standard-library-only JSONL fixture for cold connection lifecycle tests.
//! A loopback control socket holds each connect response until the test releases
//! it. RPC handling stays concurrent so a blocked connection cannot mask a
//! host-wide lock that would incorrectly block a different connection ID.

use std::{
    collections::HashSet,
    env,
    fs::OpenOptions,
    io::{self, BufRead, BufReader, Write},
    net::TcpStream,
    sync::{Arc, Mutex},
    thread,
};

fn whitespace(bytes: &[u8], mut at: usize) -> usize {
    while bytes.get(at).is_some_and(u8::is_ascii_whitespace) {
        at += 1;
    }
    at
}

fn string_end(bytes: &[u8], mut at: usize) -> Option<usize> {
    if bytes.get(at) != Some(&b'"') {
        return None;
    }
    at += 1;
    while let Some(byte) = bytes.get(at) {
        match byte {
            b'\\' => at += 2,
            b'"' => return Some(at + 1),
            _ => at += 1,
        }
    }
    None
}

fn value_end(bytes: &[u8], mut at: usize) -> Option<usize> {
    match bytes.get(at)? {
        b'"' => string_end(bytes, at),
        b'{' | b'[' => {
            let mut depth = 0usize;
            while let Some(byte) = bytes.get(at) {
                match byte {
                    b'"' => {
                        at = string_end(bytes, at)?;
                        continue;
                    }
                    b'{' | b'[' => depth += 1,
                    b'}' | b']' => {
                        depth = depth.checked_sub(1)?;
                        if depth == 0 {
                            return Some(at + 1);
                        }
                    }
                    _ => {}
                }
                at += 1;
            }
            None
        }
        _ => {
            while bytes.get(at).is_some_and(|byte| !byte.is_ascii_whitespace() && !b",]}".contains(byte)) {
                at += 1;
            }
            Some(at)
        }
    }
}

// Inspect only this object's fields; nested id/method strings are not routing.
fn field<'a>(json: &'a str, key: &str) -> Option<&'a str> {
    let bytes = json.as_bytes();
    let mut at = whitespace(bytes, 0);
    if bytes.get(at) != Some(&b'{') {
        return None;
    }
    at += 1;
    loop {
        at = whitespace(bytes, at);
        let key_start = at;
        let key_end = string_end(bytes, at)?;
        at = whitespace(bytes, key_end);
        if bytes.get(at) != Some(&b':') {
            return None;
        }
        let start = whitespace(bytes, at + 1);
        let end = value_end(bytes, start)?;
        if json.get(key_start + 1..key_end - 1) == Some(key) {
            return json.get(start..end);
        }
        at = whitespace(bytes, end);
        if bytes.get(at) != Some(&b',') {
            return None;
        }
        at += 1;
    }
}

#[derive(Default)]
struct State {
    live: HashSet<String>,
    connects: u64,
    disconnects: u64,
    calls: u64,
}

fn handle(line: String, state: &Mutex<State>, stdout: &Mutex<io::Stdout>) -> io::Result<()> {
    let Some(id) = field(&line, "id") else { return Ok(()) };
    let method = field(&line, "method").unwrap_or("\"\"").trim_matches('"');
    let params = field(&line, "params").unwrap_or("{}");
    let connection = field(params, "connection").unwrap_or("{}");
    let connection_id = field(connection, "id").unwrap_or("\"\"").trim_matches('"');
    let result = match method {
        "plugin/initialize" => format!(
            r#"{{"protocolVersion":1,"capabilities":[],"plugin":{{"id":"{}","version":"{}"}}}}"#,
            env::var("DBX_PLUGIN_ID").unwrap(),
            env::var("DBX_PLUGIN_VERSION").unwrap(),
        ),
        "connection/connect" => {
            state.lock().unwrap().connects += 1;
            let address = std::fs::read_to_string("control.addr")?;
            let mut control = TcpStream::connect(address.trim())?;
            writeln!(control, "{connection_id}")?;
            control.flush()?;
            let mut release = String::new();
            BufReader::new(control).read_line(&mut release)?;
            if release.trim() != "continue" {
                return Err(io::Error::other("connect was not released by the test"));
            }
            state.lock().unwrap().live.insert(connection_id.to_string());
            r#"{"success":true}"#.to_string()
        }
        "connection/disconnect" => {
            let mut state = state.lock().unwrap();
            state.disconnects += 1;
            // Like real ID-based plugins, disconnect targets the current session
            // for this saved ID, including a session created by a later connect.
            state.live.remove(connection_id);
            r#"{"success":true}"#.to_string()
        }
        "automation/tools" => r#"{"tools":[{"name":"inspect","description":"Read fixture state","inputSchema":{"type":"object","properties":{"connectionId":{"type":"string"}}},"annotations":{"readOnlyHint":true,"destructiveHint":false}}]}"#.to_string(),
        "automation/call" => {
            let lifecycle = field(params, "lifecycle").unwrap_or("{}");
            let connection = field(lifecycle, "connection").unwrap_or("{}");
            let id = field(connection, "id").unwrap_or("\"\"").trim_matches('"');
            let mut state = state.lock().unwrap();
            assert!(state.live.contains(id), "business RPC used a disconnected fixture session");
            state.calls += 1;
            format!(r#"{{"content":[],"structuredContent":{{"connectionId":"{id}"}},"isError":false}}"#)
        }
        "fixture/barrier" => r#"{"ok":true}"#.to_string(),
        "fixture/status" => {
            let state = state.lock().unwrap();
            format!(
                r#"{{"connects":{},"disconnects":{},"calls":{},"live":{}}}"#,
                state.connects, state.disconnects, state.calls, state.live.len(),
            )
        }
        _ => panic!("Unexpected fixture RPC: {method}"),
    };
    let mut stdout = stdout.lock().unwrap();
    writeln!(stdout, r#"{{"jsonrpc":"2.0","id":{id},"result":{result}}}"#)?;
    stdout.flush()
}

fn main() -> io::Result<()> {
    let state = Arc::new(Mutex::new(State::default()));
    let stdout = Arc::new(Mutex::new(io::stdout()));
    let mut log = OpenOptions::new().create(true).append(true).open("rpc.log")?;
    for line in io::stdin().lock().lines() {
        let line = line?;
        // Logging happens in input order, before dispatch. A barrier response
        // therefore proves every earlier request is already visible in rpc.log.
        writeln!(log, "{line}")?;
        log.flush()?;
        let state = Arc::clone(&state);
        let stdout = Arc::clone(&stdout);
        thread::spawn(move || handle(line, &state, &stdout).expect("fixture RPC must complete"));
    }
    Ok(())
}
