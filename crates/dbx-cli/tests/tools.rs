//! Exercise the actual CLI against an isolated profile, including exit status
//! and the separation of machine-readable stdout from failure diagnostics.
use std::{
    io::Write,
    path::Path,
    process::{Command, Output, Stdio},
};

use dbx_core::{
    models::connection::ConnectionConfig,
    persistence::{secret_codec::managed_key_path, test_storage},
    storage::{McpGlobalPolicy, Storage},
};
use serde_json::{json, Value};

async fn profile(directory: &Path, read_only: bool) -> Storage {
    let storage = test_storage::open(&directory.join("dbx.db")).await.unwrap();
    let connection: ConnectionConfig = serde_json::from_value(json!({
        "id": "cli-fixture", "name": "offline-cli", "db_type": "sqlite", "host": "", "port": 0,
        "username": "", "password": "tool-fixture-secret", "database": directory.join("data.sqlite")
    }))
    .unwrap();
    storage.save_connections(&[connection]).await.unwrap();
    storage
        .save_mcp_global_policy(&McpGlobalPolicy { read_only, allow_dangerous_sql: true, ..Default::default() })
        .await
        .unwrap();
    storage
}

fn invoke(directory: &Path, arguments: &[&str], input: Option<&[u8]>) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_dbx"));
    command
        .args(arguments)
        .current_dir(directory)
        .env("DBX_DATA_DIR", directory)
        .env("DBX_SECRET_KEY_FILE", managed_key_path(directory))
        .env("DBX_MCP_ALLOW_WRITES", "true")
        .env("DBX_MCP_ALLOW_DANGEROUS_SQL", "true")
        .env("DBX_MCP_PLUGIN_TOOLS", "flat")
        .env_remove("DBX_SECRET_KEY")
        .env_remove("DBX_WEB_URL")
        .env_remove("DBX_WEB_PASSWORD")
        .env_remove("DBX_MCP_SCOPE_CONNECTION_ID")
        .env_remove("DBX_MCP_SCOPE_CONNECTION_IDS")
        .env_remove("DBX_MCP_SCOPE_CONNECTION_NAME")
        .env_remove("DBX_MCP_SCOPE_DATABASE")
        .env_remove("DBX_MCP_SCOPE_SCHEMA")
        .env_remove("DBX_MCP_CONFIRMED_WRITE_SQL")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().unwrap();
    if let Some(input) = input {
        child.stdin.take().unwrap().write_all(input).unwrap();
    }
    child.wait_with_output().unwrap()
}

fn success(output: Output) -> Value {
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    assert!(output.stderr.is_empty(), "{}", String::from_utf8_lossy(&output.stderr));
    assert!(!String::from_utf8_lossy(&output.stdout).contains("tool-fixture-secret"));
    serde_json::from_slice(&output.stdout).unwrap()
}

fn failure(output: Output, code: &str) -> Value {
    assert!(!output.status.success());
    assert!(output.stdout.is_empty(), "{}", String::from_utf8_lossy(&output.stdout));
    let value: Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(value["error"]["code"], code, "{value}");
    value
}

#[tokio::test]
async fn native_tools_discover_schemas_and_accept_default_inline_file_and_stdin_arguments() {
    let directory = tempfile::tempdir().unwrap();
    let _storage = profile(directory.path(), false).await;
    let listed = success(invoke(directory.path(), &["tools", "list", "--json"], None));
    let tools = listed["tools"].as_array().unwrap();
    for expected in ["dbx_list_connections", "dbx_plugin_list", "dbx_plugin_tools", "dbx_plugin_call"] {
        let tool = tools.iter().find(|tool| tool["name"] == expected).unwrap_or_else(|| panic!("missing {expected}"));
        assert_eq!(tool["inputSchema"]["type"], "object");
    }
    let filtered =
        success(invoke(directory.path(), &["tools", "list", "--filter", "LIST_CONNECTIONS", "--json"], None));
    assert_eq!(filtered["tools"].as_array().unwrap().len(), 1);
    assert_eq!(filtered["tools"][0]["name"], "dbx_list_connections");
    let empty = success(invoke(directory.path(), &["tools", "list", "no_such_tool", "--json"], None));
    assert!(empty["tools"].as_array().unwrap().is_empty());
    let connections = success(invoke(directory.path(), &["tools", "call", "dbx_list_connections", "--json"], None));
    assert!(connections["content"][0]["text"].as_str().unwrap().contains("offline-cli"));

    let input = r#"{"connection_name":"offline-cli"}"#;
    let path = directory.path().join("arguments.json");
    std::fs::write(&path, input).unwrap();
    for (arguments, stdin) in [
        (vec!["tools", "call", "dbx_get_connection", input, "--json"], None),
        (vec!["tools", "call", "dbx_get_connection", "--file", path.to_str().unwrap(), "--json"], None),
        (vec!["tools", "call", "dbx_get_connection", "--file", "-", "--json"], Some(input.as_bytes())),
    ] {
        let result = success(invoke(directory.path(), &arguments, stdin));
        assert_ne!(result["isError"], true);
        assert!(result["content"][0]["text"].as_str().unwrap().contains("offline-cli"));
    }
    assert!(!directory.path().join("data.sqlite").exists(), "metadata tools must not open the saved database");
}

#[tokio::test]
async fn native_tools_need_explicit_write_flags_even_when_environment_and_saved_policy_allow_writes() {
    let directory = tempfile::tempdir().unwrap();
    let storage = profile(directory.path(), false).await;
    let arguments = r#"{"connection_name":"offline-cli","new_name":"copied"}"#;
    let error = failure(
        invoke(directory.path(), &["tools", "call", "dbx_duplicate_connection", arguments, "--json"], None),
        "TOOL_ERROR",
    );
    assert_eq!(error["error"]["result"]["isError"], true);
    assert!(error["error"]["message"].as_str().unwrap().contains("MCP_READ_ONLY"));
    assert_eq!(storage.load_connections().await.unwrap().len(), 1);
    success(invoke(
        directory.path(),
        &["tools", "call", "dbx_duplicate_connection", arguments, "--allow-writes", "--json"],
        None,
    ));
    assert_eq!(storage.load_connections().await.unwrap().len(), 2);
    assert!(!storage.load_mcp_global_policy().await.unwrap().read_only);
    assert!(!directory.path().join("data.sqlite").exists());
}

#[tokio::test]
async fn native_tools_write_flags_do_not_elevate_a_saved_readonly_policy() {
    let directory = tempfile::tempdir().unwrap();
    let storage = profile(directory.path(), true).await;
    let error = failure(
        invoke(
            directory.path(),
            &[
                "tools",
                "call",
                "dbx_duplicate_connection",
                r#"{"connection_name":"offline-cli","new_name":"copied"}"#,
                "--allow-writes",
                "--allow-dangerous",
                "--json",
            ],
            None,
        ),
        "TOOL_ERROR",
    );
    assert!(error["error"]["message"].as_str().unwrap().contains("MCP_READ_ONLY"));
    assert_eq!(storage.load_connections().await.unwrap().len(), 1);
    assert!(storage.load_mcp_global_policy().await.unwrap().read_only);
}

#[tokio::test]
async fn native_tools_report_protocol_failures_and_reject_invalid_input_before_profile_initialization() {
    let directory = tempfile::tempdir().unwrap();
    for (arguments, code) in [
        (vec!["tools", "call", "unknown", "{bad-secret", "--json"], "INVALID_JSON"),
        (vec!["tools", "call", "unknown", "[]", "--json"], "INVALID_JSON"),
        (vec!["tools", "list", "--format", "csv"], "INVALID_OPTION"),
        (vec!["tools", "call", "unknown", "--allow-dangerous", "--json"], "INVALID_OPTION"),
        (vec!["tools", "call", "unknown", "{}", "--file", "missing.json", "--json"], "INVALID_ARGUMENT"),
        (vec!["plugins", "call", "org.example.plugin", "inspect", "{bad-secret", "--json"], "INVALID_JSON"),
        (vec!["plugins", "call", "org.example.plugin", "inspect", "[]", "--json"], "INVALID_JSON"),
        (
            vec!["plugins", "call", "org.example.plugin", "inspect", "{}", "--file", "missing.json", "--json"],
            "INVALID_ARGUMENT",
        ),
        (vec!["plugins", "list", "--connection", "saved-id", "--json"], "INVALID_OPTION"),
    ] {
        let output = invoke(directory.path(), &arguments, None);
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert!(!String::from_utf8_lossy(&output.stderr).contains("bad-secret"));
        assert!(String::from_utf8_lossy(&output.stderr).contains(code));
        assert!(!directory.path().join("dbx.db").exists());
    }
    let _storage = profile(directory.path(), false).await;
    failure(invoke(directory.path(), &["tools", "call", "unknown", "--json"], None), "MCP_ERROR");
}

#[tokio::test]
async fn native_plugin_cli_inventory_and_errors_are_independent_of_a_denied_mcp_policy() {
    let directory = tempfile::tempdir().unwrap();
    let storage = profile(directory.path(), true).await;
    storage
        .save_mcp_global_policy(&McpGlobalPolicy {
            read_only: true,
            allowed_connection_ids: Some(Vec::new()),
            allowed_tool_names: Some(Vec::new()),
            ..Default::default()
        })
        .await
        .unwrap();
    let inventory = success(invoke(directory.path(), &["plugins", "list", "--json"], None));
    assert!(inventory["plugins"].as_array().unwrap().is_empty());
    failure(invoke(directory.path(), &["plugins", "tools", "org.example.missing", "--json"], None), "PLUGIN_NOT_FOUND");
    failure(
        invoke(
            directory.path(),
            &["plugins", "call", "org.example.missing", "inspect", "--connection", "offline-cli", "--json"],
            None,
        ),
        "PLUGIN_ERROR",
    );
    assert_eq!(storage.load_connections().await.unwrap().len(), 1);
    assert!(!directory.path().join("data.sqlite").exists());
}
