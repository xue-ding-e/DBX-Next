//! Test-only JSONL sidecar, compiled with rustc and the standard library alone.
//! It accepts the fixture's ASCII method names and echoes raw JSON params.
use std::{
    env,
    fs::OpenOptions,
    io::{self, BufRead, Write},
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

// Inspect only the current object's fields: nested or escaped "id"/"method"
// strings in test arguments cannot be mistaken for JSON-RPC routing fields.
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

fn tools(name: &str, failure: bool) -> String {
    let mut entries = vec![format!(
        r#"{{"name":"{name}","description":"Fixture native read","inputSchema":{{"type":"object","properties":{{"connectionId":{{"type":"string"}},"marker":{{"type":"string"}}}}}},"annotations":{{"readOnlyHint":true,"destructiveHint":false}}}}"#
    )];
    if failure {
        entries.push(r#"{"name":"native_fail","description":"Fixture failure","inputSchema":{"type":"object","properties":{"connectionId":{"type":"string"}}},"annotations":{"readOnlyHint":true,"destructiveHint":false}}"#.into());
    }
    format!(r#"{{"tools":[{}]}}"#, entries.join(","))
}

fn main() -> io::Result<()> {
    let plugin = env::var("DBX_PLUGIN_ID").unwrap_or_else(|_| "org.example.fixture".into());
    let version = env::var("DBX_PLUGIN_VERSION").unwrap_or_else(|_| "1.0.0".into());
    let native = plugin.ends_with(".native");
    let legacy = plugin.ends_with(".legacy");
    let mut connected = "null".to_string();
    std::fs::write("sidecar.pid", std::process::id().to_string())?;
    let mut log = OpenOptions::new().create(true).append(true).open("rpc.log")?;
    let mut stdout = io::stdout().lock();
    for line in io::stdin().lock().lines() {
        let line = line?;
        let Some(id) = field(&line, "id").filter(|id| *id != "null") else { continue };
        let method = field(&line, "method").unwrap_or("\"\"").trim_matches('"');
        let params = field(&line, "params").unwrap_or("{}");
        writeln!(log, "{method}")?;
        log.flush()?;
        let result = match method {
            "plugin/initialize" => Some(format!(
                r#"{{"protocolVersion":1,"capabilities":[],"plugin":{{"id":"{plugin}","version":"{version}"}}}}"#
            )),
            "connection/connect" => {
                connected = params.to_string();
                Some(r#"{"success":true}"#.into())
            }
            "connection/test" | "connection/disconnect" | "plugin/shutdown" => Some(r#"{"success":true}"#.into()),
            "automation/tools" if native => Some(tools("native_read", true)),
            "mcp/tools" if native || legacy => Some(tools(if native { "legacy_only" } else { "legacy_read" }, false)),
            "automation/call" if native => {
                if field(params, "tool") == Some("\"native_fail\"") {
                    Some(r#"{"content":[{"type":"text","text":"fixture native tool failure"}],"structuredContent":{"fixtureFailure":true},"isError":true}"#.into())
                } else {
                    Some(format!(
                        r#"{{"content":[],"structuredContent":{{"protocol":"automation","received":{params},"connected":{connected}}},"isError":false}}"#
                    ))
                }
            }
            "mcp/call" if native || legacy => Some(format!(
                r#"{{"content":[],"structuredContent":{{"protocol":"mcp","received":{params},"connected":{connected}}},"isError":false}}"#
            )),
            "demo/read" | "demo/write" | "demo/full" => {
                Some(format!(r#"{{"received":{params},"connected":{connected},"plugin":"{plugin}"}}"#))
            }
            _ => None,
        };
        if let Some(result) = result {
            writeln!(stdout, r#"{{"jsonrpc":"2.0","id":{id},"result":{result}}}"#)?;
        } else {
            let (code, message) =
                if method == "demo/fail" { (-32042, "fixture RPC failure") } else { (-32601, "Method not found") };
            writeln!(stdout, r#"{{"jsonrpc":"2.0","id":{id},"error":{{"code":{code},"message":"{message}"}}}}"#)?;
        }
        stdout.flush()?;
    }
    std::fs::write("sidecar.exit", "stdin closed")?;
    Ok(())
}
