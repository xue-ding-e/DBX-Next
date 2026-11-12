//! Real CLI -> installed plugin -> JSONL sidecar regression. All binaries,
//! manifests, connection profiles, and RPC logs live in temporary directories.
use std::{
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    time::{Duration, Instant},
};

use dbx_core::{
    models::connection::ConnectionConfig,
    persistence::{secret_codec::managed_key_path, test_storage},
    storage::{McpGlobalPolicy, Storage},
};
use serde_json::{json, Value};

const ALPHA: &str = "org.example.cli.alpha";
const BETA: &str = "org.example.cli.beta";
const NATIVE: &str = "org.example.cli.native";
const LEGACY: &str = "org.example.cli.legacy";

fn compile_sidecar(directory: &Path) -> PathBuf {
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/plugin_sidecar.rs");
    let binary = directory.join(format!("fixture-sidecar{}", std::env::consts::EXE_SUFFIX));
    let compiler = std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into());
    let mut command = Command::new(&compiler);
    command.args(["--edition=2021", "--crate-name", "dbx_cli_plugin_fixture"]).arg(source).arg("-o").arg(&binary);
    #[cfg(all(windows, target_env = "msvc"))]
    {
        // Direct rustc does not read .cargo/config.toml's linker selection.
        let library = Command::new(&compiler).args(["--print", "target-libdir"]).output().unwrap();
        assert!(library.status.success(), "{}", String::from_utf8_lossy(&library.stderr));
        let library = PathBuf::from(String::from_utf8(library.stdout).unwrap().trim());
        let linker = library.parent().unwrap().join("bin/rust-lld.exe");
        if linker.is_file() {
            command.arg("-C").arg(format!("linker={}", linker.display()));
        }
    }
    let output = command.output().expect("rustc must be available when running the Rust integration suite");
    assert!(output.status.success(), "sidecar compilation failed: {}", String::from_utf8_lossy(&output.stderr));
    binary
}

fn operation(method: &str, access: &str, connection: &str) -> Value {
    json!({
        "method": method, "description": format!("Fixture {access} operation with {connection} binding"),
        "access": access, "connection": connection,
        "input_schema": { "type": "object", "properties": { "marker": { "type": "string" } }, "additionalProperties": false }
    })
}

fn install(directory: &Path, binary: &Path, id: &str, automation: Value) {
    let plugin = directory.join("plugins").join(id);
    std::fs::create_dir_all(&plugin).unwrap();
    let executable = format!("sidecar{}", std::env::consts::EXE_SUFFIX);
    std::fs::copy(binary, plugin.join(&executable)).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(plugin.join(&executable), std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let manifest = json!({
        "manifest_version": 1, "id": id, "name": format!("CLI fixture {id}"), "version": "1.0.0", "publisher": "fixture",
        "engines": { "host_api": "^1.0" }, "automation": automation,
        "entrypoints": { "backend": { "protocol_versions": [1], "transport": "stdio-jsonl", "executable": executable } },
        "contributions": [{ "type": "connection-provider", "id": format!("{id}.provider"), "database_type": "fixture",
            "fields": [], "capabilities": ["connect", "disconnect"] }]
    });
    // Install a development-layout plugin just as PluginRegistry's own tests
    // do; compatibility and activation still pass through the real runtime.
    std::fs::write(plugin.join("manifest.json"), serde_json::to_vec_pretty(&manifest).unwrap()).unwrap();
}

fn connection(plugin: &str, id: &str, name: &str, read_only: bool, production: bool) -> ConnectionConfig {
    serde_json::from_value(json!({
        "id": id, "name": name, "db_type": "plugin", "plugin_id": plugin,
        "plugin_connection_provider": format!("{plugin}.provider"),
        "plugin_connection_type": "fixture",
        "host": "127.0.0.1", "port": 49001, "username": "", "password": "",
        "read_only": read_only, "is_production": production, "connect_timeout_secs": 3
    }))
    .unwrap()
}

async fn profile(directory: &Path, binary: &Path) -> Storage {
    install(
        directory,
        binary,
        ALPHA,
        json!({
            "read_id": operation("demo/read", "read", "id"),
            "read_none": operation("demo/read", "read", "none"),
            "write_id": operation("demo/write", "write", "id"),
            "full_id": operation("demo/full", "full", "id"),
            "rpc_error": operation("demo/fail", "read", "id")
        }),
    );
    install(directory, binary, BETA, json!({ "read_lifecycle": operation("demo/read", "read", "lifecycle") }));
    let storage = test_storage::open(&directory.join("dbx.db")).await.unwrap();
    storage
        .save_connections(&[
            connection(ALPHA, "alpha-id", "Alpha saved name", false, false),
            connection(BETA, "beta-id", "Beta saved name", false, false),
            connection(ALPHA, "alpha-readonly", "Alpha protected", true, false),
            connection(ALPHA, "alpha-production", "Alpha production", false, true),
            connection(ALPHA, "alpha-duplicate-a", "Ambiguous name", false, false),
            connection(ALPHA, "alpha-duplicate-b", "Ambiguous name", false, false),
        ])
        .await
        .unwrap();
    assert!(
        !storage.load_mcp_global_policy().await.unwrap().configured,
        "fixture must start without configured MCP policy"
    );
    storage
}

#[cfg(windows)]
fn process_exists(pid: u32) -> bool {
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
        fn WaitForSingleObject(handle: *mut std::ffi::c_void, milliseconds: u32) -> u32;
        fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
    }
    // SYNCHRONIZE only: this probe cannot terminate or modify the process.
    unsafe {
        let handle = OpenProcess(0x0010_0000, 0, pid);
        if handle.is_null() {
            return false;
        }
        let running = WaitForSingleObject(handle, 0) == 258;
        CloseHandle(handle);
        running
    }
}

#[cfg(unix)]
fn process_exists(pid: u32) -> bool {
    extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }
    // Signal zero is a read-only existence check; EPERM also means it exists.
    unsafe { kill(pid as i32, 0) == 0 || std::io::Error::last_os_error().raw_os_error() == Some(1) }
}

fn assert_sidecars_stopped(directory: &Path) {
    for id in [ALPHA, BETA, NATIVE, LEGACY] {
        let path = directory.join("plugins").join(id).join("sidecar.pid");
        let Ok(pid) = std::fs::read_to_string(&path) else { continue };
        let pid: u32 = pid.trim().parse().unwrap();
        let started = Instant::now();
        while process_exists(pid) && started.elapsed() < Duration::from_secs(3) {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(!process_exists(pid), "CLI left fixture sidecar {id} (PID {pid}) running");
    }
}

fn invoke(directory: &Path, arguments: &[&str], input: Option<&[u8]>) -> Output {
    let before = rpc_logs(directory);
    let mut command = Command::new(env!("CARGO_BIN_EXE_dbx"));
    command
        .args(arguments)
        .current_dir(directory)
        .env("DBX_DATA_DIR", directory)
        .env("DBX_SECRET_KEY_FILE", managed_key_path(directory))
        .env("DBX_MCP_ALLOW_WRITES", "true")
        .env("DBX_MCP_ALLOW_DANGEROUS_SQL", "true")
        .env_remove("DBX_SECRET_KEY")
        .env_remove("DBX_WEB_URL")
        .env_remove("DBX_WEB_PASSWORD")
        .env_remove("DBX_MCP_SCOPE_CONNECTION_ID")
        .env_remove("DBX_MCP_SCOPE_CONNECTION_IDS")
        .env_remove("DBX_MCP_SCOPE_CONNECTION_NAME")
        .env_remove("DBX_MCP_SCOPE_DATABASE")
        .env_remove("DBX_MCP_SCOPE_SCHEMA")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().unwrap();
    if let Some(input) = input {
        child.stdin.take().unwrap().write_all(input).unwrap();
    }
    let output = child.wait_with_output().unwrap();
    assert_sidecars_stopped(directory);
    let after = rpc_logs(directory);
    if arguments.first().copied() == Some("plugins") {
        match arguments.get(1).copied() {
            Some("list") => assert_eq!(before, after, "plugin inventory started a sidecar"),
            Some("tools" | "operations" | "call") => {
                if let Some(target) = arguments.get(2).copied() {
                    for ((plugin, previous), (_, current)) in before.iter().zip(&after) {
                        if *plugin != target {
                            assert_eq!(previous, current, "target {target} unexpectedly started or called {plugin}");
                        }
                    }
                }
            }
            _ => {}
        }
    }
    output
}

fn success(output: Output) -> Value {
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    serde_json::from_slice(&output.stdout).expect("CLI success must be valid JSON")
}

fn failure(output: Output, code: &str, detail: &str) -> Value {
    assert!(!output.status.success(), "unexpected success: {}", String::from_utf8_lossy(&output.stdout));
    assert!(output.stdout.is_empty());
    let value: Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(value["error"]["code"], code, "{value}");
    assert!(value["error"]["message"].as_str().unwrap().contains(detail), "{value}");
    value
}

fn calls(directory: &Path, plugin: &str, method: &str) -> usize {
    std::fs::read_to_string(directory.join("plugins").join(plugin).join("rpc.log"))
        .unwrap_or_default()
        .lines()
        .filter(|line| *line == method)
        .count()
}

fn rpc_logs(directory: &Path) -> Vec<(&'static str, Option<String>)> {
    [ALPHA, BETA, NATIVE, LEGACY]
        .into_iter()
        .map(|plugin| {
            let path = directory.join("plugins").join(plugin).join("rpc.log");
            let log = match std::fs::read_to_string(&path) {
                Ok(log) => Some(log),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => panic!("cannot read fixture RPC log {}: {error}", path.display()),
            };
            (plugin, log)
        })
        .collect()
}

fn verify_declarative_discovery_and_bindings(directory: &Path) {
    let inventory = success(invoke(directory, &["plugins", "list", "--json"], None));
    for id in [ALPHA, BETA] {
        let plugin = inventory["plugins"].as_array().unwrap().iter().find(|plugin| plugin["id"] == id).unwrap();
        assert_eq!(plugin["status"], "ready", "{plugin}");
        assert!(plugin["tool_count"].as_u64().unwrap() > 0);
        let manifest: Value =
            serde_json::from_slice(&std::fs::read(directory.join("plugins").join(id).join("manifest.json")).unwrap())
                .unwrap();
        assert!(manifest["contributions"].as_array().unwrap().iter().all(|entry| entry["type"] != "mcp"));
        for file in ["rpc.log", "sidecar.pid"] {
            assert!(
                !directory.join("plugins").join(id).join(file).exists(),
                "inventory started {id} and created {file}"
            );
        }
    }
    let tools = success(invoke(directory, &["plugins", "tools", ALPHA, "--json"], None));
    for (name, mode) in [("read_id", "id"), ("read_none", "none")] {
        let tool = tools["tools"].as_array().unwrap().iter().find(|tool| tool["name"] == name).unwrap();
        assert_eq!(tool["inputSchema"]["x-dbx-connection"], mode);
        assert_eq!(tool["annotations"]["readOnlyHint"], true);
    }
    let beta_tools = success(invoke(directory, &["plugins", "tools", BETA, "--json"], None));
    assert_eq!(beta_tools["tools"][0]["inputSchema"]["x-dbx-connection"], "lifecycle");

    let input = br#"{"marker":"stdin","runtime":{"host":"spoofed"},"lifecycle":{"connection":{"id":"forged"}}}"#;
    let value = success(invoke(
        directory,
        &["plugins", "call", ALPHA, "read_id", "--connection", "alpha-id", "--file", "-", "--json"],
        Some(input),
    ));
    let value = &value["structuredContent"];
    assert_eq!(value["received"], json!({ "marker": "stdin", "connectionId": "alpha-id" }));
    assert_eq!(value["connected"]["connection"]["id"], "alpha-id");
    assert_eq!(value["connected"]["runtime"], json!({ "host": "127.0.0.1", "port": 49001 }));
    assert!(calls(directory, ALPHA, "connection/connect") > 0);
    assert!(calls(directory, ALPHA, "demo/read") > 0);

    let value = success(invoke(
        directory,
        &[
            "plugins",
            "call",
            BETA,
            "read_lifecycle",
            r#"{"marker":"lifecycle","runtime":{"port":1},"lifecycle":{"connection":{"id":"forged"}}}"#,
            "--connection",
            "Beta saved name",
            "--json",
        ],
        None,
    ));
    let value = &value["structuredContent"];
    assert_eq!(value["received"]["marker"], "lifecycle");
    assert!(value["received"].get("connectionId").is_none());
    assert_eq!(value["received"]["lifecycle"]["connection"]["id"], "beta-id");
    assert_eq!(value["received"]["lifecycle"]["runtime"], json!({ "host": "127.0.0.1", "port": 49001 }));
    assert_eq!(value["received"]["lifecycle"]["runtime"], value["connected"]["runtime"]);

    let value = success(invoke(
        directory,
        &["plugins", "call", ALPHA, "read_none", r#"{"marker":"without-connection"}"#, "--json"],
        None,
    ));
    assert_eq!(value["structuredContent"]["received"], json!({ "marker": "without-connection" }));
    assert!(value["structuredContent"]["connected"].is_null());
    let count = calls(directory, ALPHA, "demo/read");
    failure(
        invoke(directory, &["plugins", "call", ALPHA, "read_none", "--connection", "alpha-id", "--json"], None),
        "PLUGIN_ERROR",
        "does not accept a connection",
    );
    assert_eq!(calls(directory, ALPHA, "demo/read"), count);
    // Neither native surface exists on these two packages: both method-not-
    // found replies must lead to their declared, plugin-agnostic RPC registry.
    for method in ["automation/tools", "mcp/tools", "automation/call", "mcp/call"] {
        assert!(calls(directory, ALPHA, method) > 0, "missing fallback probe {method}");
    }
}

async fn verify_permissions_and_errors(directory: &Path, storage: &Storage) {
    // Native CLI permissions remain independent even after MCP is explicitly
    // configured to hide all tools and all connections.
    storage
        .save_mcp_global_policy(&McpGlobalPolicy {
            read_only: true,
            allowed_connection_ids: Some(Vec::new()),
            allowed_tool_names: Some(Vec::new()),
            ..Default::default()
        })
        .await
        .unwrap();
    let writes = calls(directory, ALPHA, "demo/write");
    failure(
        invoke(directory, &["plugins", "call", ALPHA, "write_id", "--connection", "alpha-id", "--json"], None),
        "PLUGIN_ERROR",
        "PLUGIN_WRITE_BLOCKED",
    );
    assert_eq!(calls(directory, ALPHA, "demo/write"), writes);
    success(invoke(
        directory,
        &["plugins", "call", ALPHA, "write_id", "--connection", "Alpha saved name", "--allow-writes", "--json"],
        None,
    ));
    assert_eq!(calls(directory, ALPHA, "demo/write"), writes + 1);
    let destructive = calls(directory, ALPHA, "demo/full");
    failure(
        invoke(
            directory,
            &["plugins", "call", ALPHA, "full_id", "--connection", "alpha-id", "--allow-writes", "--json"],
            None,
        ),
        "PLUGIN_ERROR",
        "PLUGIN_OPERATION_BLOCKED",
    );
    assert_eq!(calls(directory, ALPHA, "demo/full"), destructive);
    success(invoke(
        directory,
        &[
            "plugins",
            "call",
            ALPHA,
            "full_id",
            "--connection",
            "alpha-id",
            "--allow-writes",
            "--allow-dangerous",
            "--json",
        ],
        None,
    ));
    assert_eq!(calls(directory, ALPHA, "demo/full"), destructive + 1);
    for (connection, detail) in
        [("alpha-readonly", "CONNECTION_READ_ONLY"), ("alpha-production", "PRODUCTION_WRITE_BLOCKED")]
    {
        failure(
            invoke(
                directory,
                &[
                    "plugins",
                    "call",
                    ALPHA,
                    "write_id",
                    "--connection",
                    connection,
                    "--allow-writes",
                    "--allow-dangerous",
                    "--json",
                ],
                None,
            ),
            "PLUGIN_ERROR",
            detail,
        );
    }
    assert_eq!(calls(directory, ALPHA, "demo/write"), writes + 1, "protected writes reached the sidecar");

    let reads = calls(directory, ALPHA, "demo/read");
    for (input, detail) in [("Ambiguous name", "Ambiguous name"), ("beta-id", "beta-id")] {
        failure(
            invoke(directory, &["plugins", "call", ALPHA, "read_id", "--connection", input, "--json"], None),
            "PLUGIN_ERROR",
            detail,
        );
    }
    failure(
        invoke(
            directory,
            &[
                "plugins",
                "call",
                ALPHA,
                "read_id",
                r#"{"dbx_connection":"beta-id"}"#,
                "--connection",
                "alpha-id",
                "--json",
            ],
            None,
        ),
        "PLUGIN_ERROR",
        "Conflicting",
    );
    failure(
        invoke(
            directory,
            &["plugins", "call", ALPHA, "read_id", r#"{"marker":42}"#, "--connection", "alpha-id", "--json"],
            None,
        ),
        "PLUGIN_ERROR",
        "marker",
    );
    failure(
        invoke(directory, &["plugins", "call", ALPHA, "missing-operation", "--connection", "alpha-id", "--json"], None),
        "PLUGIN_ERROR",
        "PLUGIN_TOOL_NOT_FOUND",
    );
    assert_eq!(calls(directory, ALPHA, "demo/read"), reads, "invalid calls reached demo/read");
    let probes = calls(directory, ALPHA, "plugin/initialize");
    let error = failure(
        invoke(directory, &["plugins", "call", ALPHA, "read_id", "{invalid-fixture-secret", "--json"], None),
        "INVALID_JSON",
        "JSON object",
    );
    assert!(!error.to_string().contains("invalid-fixture-secret"));
    assert_eq!(calls(directory, ALPHA, "plugin/initialize"), probes, "bad JSON started a sidecar");
    failure(
        invoke(directory, &["plugins", "call", ALPHA, "rpc_error", "--connection", "alpha-id", "--json"], None),
        "PLUGIN_ERROR",
        "fixture RPC failure",
    );
    assert!(calls(directory, ALPHA, "demo/fail") > 0);

    let file = directory.join("arguments.json");
    std::fs::write(&file, "\u{feff}{\"marker\":\"bom-file\"}").unwrap();
    let result = success(invoke(
        directory,
        &["plugins", "call", ALPHA, "read_id", "--file", file.to_str().unwrap(), "--connection", "alpha-id", "--json"],
        None,
    ));
    assert_eq!(result["structuredContent"]["received"]["marker"], "bom-file");
}

async fn verify_native_priority_and_legacy_fallback(directory: &Path, binary: &Path, storage: &Storage) {
    install(directory, binary, NATIVE, json!({ "declared_fallback": operation("demo/read", "read", "id") }));
    // This older native sidecar has no static catalog. Inventory must report
    // it as uninspected and leave dynamic discovery to the explicit tools call.
    install(directory, binary, LEGACY, json!({}));
    let mut connections = storage.load_connections().await.unwrap();
    connections.push(connection(NATIVE, "native-id", "Native saved name", false, false));
    connections.push(connection(LEGACY, "legacy-id", "Legacy saved name", false, false));
    storage.save_connections(&connections).await.unwrap();
    let inventory = success(invoke(directory, &["plugins", "list", "--json"], None));
    let legacy_entry = inventory["plugins"].as_array().unwrap().iter().find(|entry| entry["id"] == LEGACY).unwrap();
    assert_eq!(legacy_entry["status"], "uninspected");
    assert_eq!(legacy_entry["tool_count"], 0);
    assert!(legacy_entry["diagnostic"].as_str().unwrap().contains("dbx plugins tools"));
    for plugin in [NATIVE, LEGACY] {
        assert!(!directory.join("plugins").join(plugin).join("rpc.log").exists(), "inventory probed {plugin}");
        assert!(!directory.join("plugins").join(plugin).join("sidecar.pid").exists(), "inventory spawned {plugin}");
    }
    let native = success(invoke(directory, &["plugins", "tools", NATIVE, "--json"], None));
    let names =
        native["tools"].as_array().unwrap().iter().map(|tool| tool["name"].as_str().unwrap()).collect::<Vec<_>>();
    assert!(names.contains(&"native_read"));
    assert!(!names.contains(&"legacy_only"));
    assert!(!names.contains(&"declared_fallback"));
    let legacy = success(invoke(directory, &["plugins", "tools", LEGACY, "--json"], None));
    assert_eq!(legacy["tools"][0]["name"], "legacy_read");
    for (plugin, tool, connection, protocol) in
        [(NATIVE, "native_read", "native-id", "automation"), (LEGACY, "legacy_read", "legacy-id", "mcp")]
    {
        let result = success(invoke(
            directory,
            &["plugins", "call", plugin, tool, r#"{"marker":"native-route"}"#, "--connection", connection, "--json"],
            None,
        ));
        let result = &result["structuredContent"];
        assert_eq!(result["protocol"], protocol);
        assert_eq!(result["received"]["arguments"]["connectionId"], connection);
        assert_eq!(result["received"]["lifecycle"]["connection"]["id"], connection);
        assert_eq!(result["received"]["lifecycle"]["runtime"], json!({ "host": "127.0.0.1", "port": 49001 }));
        assert_eq!(result["received"]["lifecycle"]["runtime"], result["connected"]["runtime"]);
    }
    assert!(calls(directory, NATIVE, "automation/tools") > 0);
    assert!(calls(directory, NATIVE, "automation/call") > 0);
    assert_eq!(calls(directory, NATIVE, "mcp/tools"), 0, "native discovery lost priority");
    assert_eq!(calls(directory, NATIVE, "mcp/call"), 0, "native invocation lost priority");
    assert_eq!(calls(directory, NATIVE, "demo/read"), 0, "native plugin fell through to its manifest declaration");
    for method in ["automation/tools", "mcp/tools", "automation/call", "mcp/call"] {
        assert!(calls(directory, LEGACY, method) > 0, "legacy compatibility route did not probe {method}");
    }
    let failure = failure(
        invoke(directory, &["plugins", "call", NATIVE, "native_fail", "--connection", "native-id", "--json"], None),
        "TOOL_ERROR",
        "fixture native tool failure",
    );
    assert_eq!(failure["error"]["result"]["isError"], true);
    assert_eq!(failure["error"]["result"]["structuredContent"]["fixtureFailure"], true);
}

#[tokio::test]
async fn real_cli_executes_community_plugin_automation_and_releases_its_sidecars() {
    // One compiler invocation for the entire end-to-end matrix, and no Cargo
    // recursion or dependency downloads. Both directories clean up on return.
    let compiled = tempfile::tempdir().unwrap();
    let binary = compile_sidecar(compiled.path());
    let directory = tempfile::tempdir().unwrap();
    let storage = profile(directory.path(), &binary).await;
    verify_declarative_discovery_and_bindings(directory.path());
    verify_permissions_and_errors(directory.path(), &storage).await;
    verify_native_priority_and_legacy_fallback(directory.path(), &binary, &storage).await;
    assert_sidecars_stopped(directory.path());
}
