//! The CLI uses the MCP server's discovery, dispatch, and policy checks rather
//! than maintaining a separate registry of built-in and plugin tools.
use std::{path::Path, sync::Arc};

use dbx_mcp::{server::PluginToolsMode, DbxBackend, DbxMcpServer, McpScope};
use rmcp::{model::CallToolRequestParams, model::CallToolResult, model::Tool, ServiceExt};
use serde_json::{json, Map, Value};

use super::{json_string, markdown_table, CliError, Flags, OutputFormat};

pub(super) enum ToolsCommand {
    List { filter: Option<String> },
    Call { tool: String, arguments: Map<String, Value> },
}

pub(super) async fn parse_command(flags: &Flags) -> Result<ToolsCommand, CliError> {
    validate_tool_flags(flags, "tools")?;
    match flags.args.get(1).map(String::as_str) {
        Some("list") if (2..=3).contains(&flags.args.len()) => {
            if flags.file.is_some() {
                return Err(CliError::new("INVALID_OPTION", "--file is only supported by dbx tools call."));
            }
            if flags.tool_filter.is_some() && flags.args.len() == 3 {
                return Err(CliError::new("INVALID_ARGUMENT", "Provide a name filter either positionally or with --filter, not both."));
            }
            let filter = flags.tool_filter.as_ref().or_else(|| flags.args.get(2)).map(|value| value.trim());
            if filter == Some("") {
                return Err(CliError::new("INVALID_ARGUMENT", "The tool name filter must not be empty."));
            }
            Ok(ToolsCommand::List { filter: filter.map(str::to_lowercase) })
        }
        Some("call") if (3..=4).contains(&flags.args.len()) => {
            if flags.tool_filter.is_some() {
                return Err(CliError::new("INVALID_OPTION", "--filter is only supported by dbx tools list."));
            }
            let tool = &flags.args[2];
            if tool.trim().is_empty() {
                return Err(CliError::new("INVALID_ARGUMENT", "A tool name is required."));
            }
            let arguments = parse_arguments(flags.args.get(3).map(String::as_str), flags.file.as_deref()).await?;
            Ok(ToolsCommand::Call { tool: tool.clone(), arguments })
        }
        _ => Err(CliError::new("INVALID_ARGUMENT", "Usage: dbx tools list [--filter name] [--json] | dbx tools call <tool> [JSON | --file <path|->] [--allow-writes] [--allow-dangerous] [--json]")),
    }
}

pub(super) fn validate_tool_flags(flags: &Flags, command: &str) -> Result<(), CliError> {
    if flags.format == OutputFormat::Csv {
        return Err(CliError::new("INVALID_OPTION", format!("CSV format is not supported for dbx {command} commands. Use --json to retain tool schemas and structured results.")));
    }
    if flags.allow_dangerous && !flags.allow_writes {
        return Err(CliError::new("INVALID_OPTION", "--allow-dangerous requires --allow-writes."));
    }
    if flags.schema.is_some()
        || flags.database.is_some()
        || !flags.tables.is_empty()
        || flags.max_tables.is_some()
        || flags.max_rows.is_some()
        || flags.timeout_ms.is_some()
        || flags.out.is_some()
        || flags.notes.is_some()
        || flags.lang.is_some()
    {
        return Err(CliError::new(
            "INVALID_OPTION",
            format!(
                "Pass tool-specific parameters in the JSON arguments object. Run dbx {command} --help for CLI options."
            ),
        ));
    }
    Ok(())
}

pub(super) async fn parse_arguments(inline: Option<&str>, file: Option<&Path>) -> Result<Map<String, Value>, CliError> {
    if inline.is_some() && file.is_some() {
        return Err(CliError::new(
            "INVALID_ARGUMENT",
            "Provide tool arguments either inline or with --file, not both.",
        ));
    }
    let input =
        if let Some(path) = file { read_arguments_file(path).await? } else { inline.unwrap_or("{}").to_string() };
    // Do not echo malformed input: plugin arguments may contain secrets.
    // UTF-8 BOMs are common in JSON files written by Windows editors.
    match serde_json::from_str::<Value>(input.trim_start_matches('\u{feff}')) {
        Ok(Value::Object(arguments)) => Ok(arguments),
        _ => Err(CliError::new("INVALID_JSON", "Tool arguments must be a valid JSON object.")),
    }
}

async fn read_arguments_file(path: &Path) -> Result<String, CliError> {
    if path == Path::new("-") {
        return tokio::task::spawn_blocking(|| {
            use std::io::{IsTerminal, Read};
            let mut stdin = std::io::stdin();
            if stdin.is_terminal() {
                return Err(CliError::new("INVALID_INPUT", "Pipe JSON into --file - or supply a JSON file path."));
            }
            let mut input = String::new();
            stdin
                .read_to_string(&mut input)
                .map_err(|_| CliError::new("INVALID_INPUT", "Could not read tool JSON from stdin."))?;
            Ok(input)
        })
        .await
        .map_err(|error| CliError::new("INVALID_INPUT", error.to_string()))?;
    }
    tokio::fs::read_to_string(path).await.map_err(|error| {
        CliError::new("INVALID_INPUT", format!("Could not read tool JSON file {}: {error}", path.display()))
    })
}

pub(super) async fn run(
    backend: Arc<dyn DbxBackend>,
    flags: &Flags,
    command: ToolsCommand,
) -> Result<String, CliError> {
    let server = DbxMcpServer::with_plugin_tools_mode(
        backend,
        McpScope::from_env(),
        std::env::var_os("DBX_WEB_URL").is_some(),
        PluginToolsMode::Both,
    )
    .with_cli_permissions(flags.allow_writes, flags.allow_dangerous);
    run_server(server, command, flags.format).await
}

async fn run_server(server: DbxMcpServer, command: ToolsCommand, format: OutputFormat) -> Result<String, CliError> {
    let (server_transport, client_transport) = tokio::io::duplex(16 * 1024);
    // JoinSet aborts the server task on every early return or cancellation.
    let mut tasks = tokio::task::JoinSet::new();
    tasks.spawn(async move {
        if let Ok(service) = server.serve(server_transport).await {
            let _ = service.waiting().await;
        }
    });
    let client = ().serve(client_transport).await.map_err(|error| CliError::new("MCP_ERROR", error.to_string()))?;
    let result = async {
        match command {
            ToolsCommand::List { filter } => {
                let mut tools = client.peer().list_all_tools().await.map_err(mcp_error)?;
                if let Some(filter) = filter {
                    tools.retain(|tool| tool.name.to_lowercase().contains(&filter));
                }
                tools.sort_by(|left, right| left.name.cmp(&right.name));
                format_tools(&tools, format)
            }
            ToolsCommand::Call { tool, arguments } => {
                let result = client
                    .peer()
                    .call_tool(CallToolRequestParams::new(tool).with_arguments(arguments))
                    .await
                    .map_err(mcp_error)?;
                format_result(result, format)
            }
        }
    }
    .await;
    // A tool-level isError is still a completed protocol call: shut down the
    // local MCP pair before returning the CLI failure, just as on success.
    let _ = client.cancel().await;
    tasks.shutdown().await;
    result
}

fn mcp_error(error: rmcp::ServiceError) -> CliError {
    CliError::new("MCP_ERROR", error.to_string())
}

fn format_tools(tools: &[Tool], format: OutputFormat) -> Result<String, CliError> {
    if format == OutputFormat::Json {
        return json_string(&json!({ "tools": tools }));
    }
    if tools.is_empty() {
        return Ok("No tools match the current name filter and MCP policy.\n".to_string());
    }
    let rows = tools
        .iter()
        .map(|tool| {
            json!({
                "name": tool.name,
                "description": tool.description.as_deref().unwrap_or_default(),
                "readOnly": tool.annotations.as_ref().and_then(|value| value.read_only_hint)
                    .map(|value| if value { "yes" } else { "no" }).unwrap_or("not declared"),
            })
        })
        .collect::<Vec<_>>();
    Ok(format!(
        "{}\n",
        markdown_table(&["Name", "Description", "Read only"], &rows, &["name", "description", "readOnly"])
    ))
}

fn format_result(result: CallToolResult, format: OutputFormat) -> Result<String, CliError> {
    let value = serde_json::to_value(result).map_err(|error| CliError::new("ERROR", error.to_string()))?;
    format_value_result(value, format)
}

/// Plugin CLI backends can return either a native JSON value or a tool-result
/// envelope. Preserve either form without introducing an MCP client or server.
pub(super) fn format_value_result(value: Value, format: OutputFormat) -> Result<String, CliError> {
    let content = value.get("content").and_then(Value::as_array);
    if value.get("isError").and_then(Value::as_bool) == Some(true) {
        let message = content
            .into_iter()
            .flatten()
            .filter(|content| content.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|content| content.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n");
        let mut error = CliError::new(
            "TOOL_ERROR",
            if message.trim().is_empty() { "The tool returned isError: true.".to_string() } else { message },
        );
        error.tool_result = Some(value);
        return Err(error);
    }
    let structured = value.get("structuredContent");
    if format == OutputFormat::Json || (content.is_none() && structured.is_none()) {
        return json_string(&value);
    }
    let mut output = String::new();
    for content in content.into_iter().flatten() {
        if let Some(text) = content
            .get("text")
            .and_then(Value::as_str)
            .filter(|_| content.get("type").and_then(Value::as_str) == Some("text"))
        {
            output.push_str(text);
            if !output.ends_with('\n') {
                output.push('\n');
            }
        } else {
            output.push_str(&json_string(content)?);
        }
    }
    if let Some(structured) = structured {
        output.push_str(&json_string(structured)?);
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, sync::Mutex};

    use async_trait::async_trait;
    use dbx_core::{
        agent_events::ToolResult,
        agent_tools::AgentSqlPermissions,
        mcp_policy::{McpConnectionGroupPath, MCP_EXECUTION_POLICY_VERSION},
        models::connection::ConnectionConfig,
        storage::{McpConnectionPolicy, McpDatabasePolicy, McpDatabaseScope, McpGlobalPolicy, McpGroupPolicy},
    };
    use dbx_mcp::plugin_tools::PluginToolProvider;

    use super::*;

    struct TestBackend {
        policy: Mutex<McpGlobalPolicy>,
        connections: Vec<ConnectionConfig>,
        sql_calls: Mutex<Vec<AgentSqlPermissions>>,
        plugin_calls: Mutex<Vec<(String, String, Option<String>, Value)>>,
    }

    impl TestBackend {
        fn new(policy: McpGlobalPolicy) -> Arc<Self> {
            Arc::new(Self {
                policy: Mutex::new(policy),
                connections: vec![
                    serde_json::from_value(json!({
                        "id": "sql", "name": "sample", "db_type": "postgres",
                        "host": "127.0.0.1", "port": 5432, "username": "", "password": "", "database": "app"
                    }))
                    .unwrap(),
                    serde_json::from_value(json!({
                        "id": "nats", "name": "sample NATS", "db_type": "plugin", "plugin_id": "io.dbx.nats",
                        "host": "127.0.0.1", "port": 4222, "username": "", "password": ""
                    }))
                    .unwrap(),
                    serde_json::from_value(json!({
                        "id": "metrics", "name": "Community Metrics", "db_type": "plugin", "plugin_id": "org.example.metrics",
                        "host": "127.0.0.1", "port": 0, "username": "", "password": ""
                    }))
                    .unwrap(),
                ],
                sql_calls: Mutex::new(Vec::new()),
                plugin_calls: Mutex::new(Vec::new()),
            })
        }
    }

    #[async_trait]
    impl DbxBackend for TestBackend {
        async fn load_mcp_global_policy(&self) -> Result<McpGlobalPolicy, String> {
            Ok(self.policy.lock().unwrap().clone())
        }

        async fn load_connections(&self) -> Result<Vec<ConnectionConfig>, String> {
            Ok(self.connections.clone())
        }

        async fn load_connection_group_details(&self) -> Result<HashMap<String, McpConnectionGroupPath>, String> {
            Ok(HashMap::from([(
                "sql".to_string(),
                McpConnectionGroupPath { ids: vec!["team".to_string()], names: vec!["Team".to_string()] },
            )]))
        }

        async fn execute_agent_tool(
            &self,
            _connection: &ConnectionConfig,
            _database: &str,
            tool_name: &str,
            _arguments: Value,
            permissions: AgentSqlPermissions,
        ) -> ToolResult {
            self.sql_calls.lock().unwrap().push(permissions);
            ToolResult {
                tool_call_id: "fixture".to_string(),
                tool_name: tool_name.to_string(),
                content: "executed".to_string(),
                is_error: false,
                explain_data: None,
            }
        }

        async fn add_connection_for_mcp(&self, _config: ConnectionConfig) -> Result<ConnectionConfig, String> {
            panic!("not used by these tests")
        }

        async fn duplicate_connection_for_mcp(
            &self,
            _source_id: &str,
            _copy_id: &str,
            _copy_name: &str,
        ) -> Result<ConnectionConfig, String> {
            panic!("not used by these tests")
        }

        async fn remove_connection_for_mcp(&self, _connection_id: &str) -> Result<bool, String> {
            panic!("not used by these tests")
        }

        async fn list_plugin_mcp_tools(&self) -> Result<Vec<PluginToolProvider>, String> {
            Ok(vec![
                PluginToolProvider {
                    plugin_id: "io.dbx.nats".to_string(),
                    plugin_name: "NATS".to_string(),
                    tools: dbx_core::ai::plugin_tools::parse_tool_list(&json!({ "tools": [
                    { "name": "nats_info", "description": "Inspect NATS",
                      "inputSchema": { "type": "object", "properties": { "connectionId": { "type": "string" } } },
                      "annotations": { "readOnlyHint": true } },
                    { "name": "nats_publish", "description": "Publish a message",
                      "inputSchema": { "type": "object", "properties": { "connectionId": { "type": "string" }, "subject": { "type": "string" } } },
                      "annotations": { "readOnlyHint": false } }
                ] })),
                },
                PluginToolProvider {
                    plugin_id: "org.example.metrics".into(),
                    plugin_name: "Community Metrics".into(),
                    tools: dbx_core::ai::plugin_tools::parse_tool_list(&json!({ "tools": [{
                    "name": "inspect", "description": "Read a community plugin's metrics",
                    "inputSchema": { "type": "object", "properties": { "connectionId": { "type": "string" }, "target": { "type": "string" } } },
                    "annotations": { "readOnlyHint": true }
                }] })),
                },
            ])
        }

        async fn call_plugin_mcp_tool(
            &self,
            plugin_id: &str,
            tool: &str,
            connection_id: Option<&str>,
            arguments: &Value,
        ) -> Result<Value, String> {
            self.plugin_calls.lock().unwrap().push((
                plugin_id.to_string(),
                tool.to_string(),
                connection_id.map(str::to_string),
                arguments.clone(),
            ));
            Ok(json!({
                "content": [{ "type": "text", "text": "plugin response" }],
                "structuredContent": { "pluginId": plugin_id, "tool": tool, "arguments": arguments }, "isError": false
            }))
        }
    }

    fn flags(values: &[&str]) -> Flags {
        crate::parse_flags(&values.iter().map(|value| value.to_string()).collect::<Vec<_>>()).unwrap()
    }

    fn server(backend: Arc<TestBackend>, writes: bool, dangerous: bool) -> DbxMcpServer {
        DbxMcpServer::with_plugin_tools_mode(backend, McpScope::default(), false, PluginToolsMode::Both)
            .with_cli_permissions(writes, dangerous)
    }

    fn call(tool: &str, arguments: Value) -> ToolsCommand {
        ToolsCommand::Call { tool: tool.to_string(), arguments: arguments.as_object().unwrap().clone() }
    }

    async fn sql(server: DbxMcpServer, statement: &str) -> Result<String, CliError> {
        run_server(
            server,
            call(
                "dbx_execute_query",
                json!({
                    "connection_id": "sql", "sql": statement
                }),
            ),
            OutputFormat::Json,
        )
        .await
    }

    fn assert_tool_error(error: CliError, code: &str) {
        assert_eq!(error.code, "TOOL_ERROR");
        assert!(error.message.contains(code), "expected {code}: {}", error.message);
        assert_eq!(error.tool_result.unwrap()["isError"], true);
    }

    #[tokio::test]
    async fn arguments_default_to_an_object_and_support_inline_and_utf8_files() {
        match parse_command(&flags(&["tools", "call", "dbx_list_connections"])).await.unwrap() {
            ToolsCommand::Call { arguments, .. } => assert!(arguments.is_empty()),
            _ => panic!("expected call"),
        }
        let inline = flags(&["tools", "call", "example", r#"{"message":"你好","count":3}"#]);
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("arguments.json");
        std::fs::write(&path, "\u{feff}{\"message\":\"你好\",\"count\":3}").unwrap();
        let from_file = flags(&["tools", "call", "example", "--file", path.to_str().unwrap()]);
        for input in [inline, from_file] {
            match parse_command(&input).await.unwrap() {
                ToolsCommand::Call { arguments, .. } => {
                    assert_eq!(arguments, json!({ "message": "你好", "count": 3 }).as_object().unwrap().clone())
                }
                _ => panic!("expected call"),
            }
        }
    }

    #[tokio::test]
    async fn malformed_arguments_and_unsupported_options_fail_before_loading_the_profile() {
        for input in ["[]", "null", "true", "42", r#""secret""#, "{broken-secret", "{} {}"] {
            let error =
                crate::run(vec!["tools".into(), "call".into(), "example".into(), input.into(), "--json".into()])
                    .await
                    .unwrap_err()
                    .0;
            assert_eq!(error.code, "INVALID_JSON");
            assert!(!error.message.contains("secret"));
        }
        for input in [
            vec!["tools"],
            vec!["tools", "call"],
            vec!["tools", "list", "one", "two"],
            vec!["tools", "list", "name", "--filter", "other"],
            vec!["tools", "call", "example", "{}", "--file", "missing.json"],
        ] {
            assert_eq!(parse_command(&flags(&input)).await.err().unwrap().code, "INVALID_ARGUMENT");
        }
        for input in [
            vec!["tools", "list", "--format", "csv"],
            vec!["tools", "list", "--file", "missing.json"],
            vec!["tools", "call", "example", "--allow-dangerous"],
            vec!["tools", "call", "example", "--schema", "public"],
            vec!["tools", "call", "example", "--filter", "name"],
        ] {
            assert_eq!(parse_command(&flags(&input)).await.err().unwrap().code, "INVALID_OPTION");
        }
        let directory = tempfile::tempdir().unwrap();
        let missing = directory.path().join("missing.json");
        let error = parse_command(&flags(&["tools", "call", "example", "--file", missing.to_str().unwrap()]))
            .await
            .err()
            .unwrap();
        assert_eq!(error.code, "INVALID_INPUT");
    }

    #[test]
    fn help_capabilities_and_filter_flags_explain_the_generic_tool_surface() {
        assert!(crate::usage().contains("dbx tools list"));
        assert!(crate::usage().contains("dbx tools call"));
        let capabilities: Value =
            serde_json::from_str(&crate::format_capabilities(OutputFormat::Json).unwrap()).unwrap();
        assert_eq!(capabilities["tools"]["readOnlyByDefault"], true);
        assert_eq!(capabilities["tools"]["savedMcpPolicyEnforced"], true);
        assert_eq!(capabilities["tools"]["pluginToolsMode"], "both");
        for option in ["--allow-dangerous", "--allow-dangerous-sql"] {
            assert!(flags(&["tools", "call", "example", "--allow-writes", option]).allow_dangerous);
        }
        assert_eq!(
            crate::validate_agent_only_flags(&flags(&["doctor", "--filter", "name"])).unwrap_err().code,
            "INVALID_OPTION"
        );
    }

    #[tokio::test]
    async fn duplex_lists_builtin_meta_and_flat_plugin_tools_with_schemas_and_name_filter() {
        let backend = TestBackend::new(McpGlobalPolicy::default());
        // Exercise the same entry point as main, including its explicit Both mode.
        let input = flags(&["tools", "list", "--json"]);
        let output = run(backend.clone(), &input, parse_command(&input).await.unwrap()).await.unwrap();
        let output: Value = serde_json::from_str(&output).unwrap();
        let tools = output["tools"].as_array().unwrap();
        for name in
            ["dbx_list_connections", "dbx_plugin_list", "dbx_plugin_tools", "dbx_plugin_call", "dbx_nats__nats_info"]
        {
            let tool = tools.iter().find(|tool| tool["name"] == name).unwrap_or_else(|| panic!("missing {name}"));
            assert_eq!(tool["inputSchema"]["type"], "object");
        }
        let flat = tools.iter().find(|tool| tool["name"] == "dbx_nats__nats_info").unwrap();
        assert_eq!(flat["annotations"]["readOnlyHint"], true);
        assert!(flat["inputSchema"]["properties"].get("connectionId").is_none());
        for input in [flags(&["tools", "list", "--filter", "NATS_INFO"]), flags(&["tools", "list", "NATS_INFO"])] {
            let output = run_server(
                server(backend.clone(), false, false),
                parse_command(&input).await.unwrap(),
                OutputFormat::Json,
            )
            .await
            .unwrap();
            let output: Value = serde_json::from_str(&output).unwrap();
            assert_eq!(output["tools"].as_array().unwrap().len(), 1);
            assert_eq!(output["tools"][0]["name"], "dbx_nats__nats_info");
        }
    }

    #[tokio::test]
    async fn duplex_flat_and_meta_calls_share_host_bound_dispatch_and_preserve_structured_results() {
        let backend = TestBackend::new(McpGlobalPolicy::default());
        for command in [
            call("dbx_nats__nats_info", json!({ "dbx_connection": "nats" })),
            call(
                "dbx_plugin_call",
                json!({ "plugin_id": "io.dbx.nats", "tool": "nats_info", "dbx_connection": "nats" }),
            ),
        ] {
            let output = run_server(server(backend.clone(), false, false), command, OutputFormat::Json).await.unwrap();
            let output: Value = serde_json::from_str(&output).unwrap();
            assert_eq!(output["content"][0]["text"], "plugin response");
            assert_eq!(output["structuredContent"]["tool"], "nats_info");
            assert_ne!(output["isError"], true);
        }
        let calls = backend.plugin_calls.lock().unwrap();
        assert_eq!(calls.len(), 2);
        assert!(calls.iter().all(|(plugin, tool, connection, arguments)| plugin == "io.dbx.nats"
            && tool == "nats_info"
            && connection.as_deref() == Some("nats")
            && arguments["connectionId"] == "nats"));
    }

    #[tokio::test]
    async fn duplex_discovers_and_calls_an_unrelated_community_plugin_without_cli_registration() {
        let backend = TestBackend::new(McpGlobalPolicy::default());
        let output = run_server(
            server(backend.clone(), false, false),
            ToolsCommand::List { filter: Some("metrics".into()) },
            OutputFormat::Json,
        )
        .await
        .unwrap();
        let listed: Value = serde_json::from_str(&output).unwrap();
        assert_eq!(listed["tools"].as_array().unwrap().len(), 1);
        let name = listed["tools"][0]["name"].as_str().unwrap();
        let output = run_server(
            server(backend.clone(), false, false),
            call(name, json!({ "dbx_connection": "metrics", "target": "cpu" })),
            OutputFormat::Json,
        )
        .await
        .unwrap();
        let output: Value = serde_json::from_str(&output).unwrap();
        assert_eq!(output["structuredContent"]["pluginId"], "org.example.metrics");
        assert_eq!(output["structuredContent"]["arguments"]["target"], "cpu");
        assert_eq!(output["structuredContent"]["arguments"]["connectionId"], "metrics");
        let calls = backend.plugin_calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "org.example.metrics");
        assert_eq!(calls[0].2.as_deref(), Some("metrics"));
    }

    #[tokio::test]
    async fn duplex_readonly_default_blocks_plugin_writes_through_both_surfaces() {
        let backend = TestBackend::new(McpGlobalPolicy { allow_dangerous_sql: true, ..Default::default() });
        for command in [
            call("dbx_nats__nats_publish", json!({ "dbx_connection": "nats", "subject": "sample" })),
            call(
                "dbx_plugin_call",
                json!({ "plugin_id": "io.dbx.nats", "tool": "nats_publish", "arguments": { "subject": "sample" }, "dbx_connection": "nats" }),
            ),
        ] {
            let error =
                run_server(server(backend.clone(), false, false), command, OutputFormat::Json).await.unwrap_err();
            assert_tool_error(error, "MCP_READ_ONLY");
        }
        assert!(backend.plugin_calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn duplex_unknown_tools_are_protocol_failures_and_allowlists_filter_and_block_calls() {
        let backend = TestBackend::new(McpGlobalPolicy::default());
        let error = run_server(server(backend, false, false), call("unknown", json!({})), OutputFormat::Json)
            .await
            .unwrap_err();
        assert_eq!(error.code, "MCP_ERROR");
        let backend = TestBackend::new(McpGlobalPolicy {
            allowed_tool_names: Some(vec!["dbx_list_connections".into()]),
            ..Default::default()
        });
        let output =
            run_server(server(backend.clone(), true, true), ToolsCommand::List { filter: None }, OutputFormat::Json)
                .await
                .unwrap();
        let output: Value = serde_json::from_str(&output).unwrap();
        assert_eq!(output["tools"].as_array().unwrap().len(), 1);
        assert_eq!(output["tools"][0]["name"], "dbx_list_connections");
        assert_tool_error(sql(server(backend.clone(), true, true), "SELECT 1").await.unwrap_err(), "TOOL_OUT_OF_SCOPE");
        assert!(backend.sql_calls.lock().unwrap().is_empty());
    }

    fn connection_rule() -> McpConnectionPolicy {
        McpConnectionPolicy {
            connection_id: "sql".into(),
            read_only: false,
            allow_dangerous_sql: true,
            execution_mode_configured: true,
            execution_mode_policy_version: Some(MCP_EXECUTION_POLICY_VERSION),
            database_scope: McpDatabaseScope::All,
            allowed_databases: Vec::new(),
            database_policies: Vec::new(),
            allow_salesforce_dml: true,
        }
    }

    #[tokio::test]
    async fn cli_ceiling_narrows_group_connection_database_and_legacy_overrides_without_saving_changes() {
        let group = McpGlobalPolicy {
            read_only: true,
            group_policies: vec![McpGroupPolicy {
                group_id: "team".into(),
                read_only: false,
                allow_dangerous_sql: true,
            }],
            ..Default::default()
        };
        let connection =
            McpGlobalPolicy { read_only: true, connection_policies: vec![connection_rule()], ..Default::default() };
        let database = McpGlobalPolicy {
            read_only: true,
            connection_policies: vec![McpConnectionPolicy {
                execution_mode_configured: false,
                database_policies: vec![McpDatabasePolicy {
                    database_name: "app".into(),
                    read_only: false,
                    allow_dangerous_sql: true,
                }],
                ..connection_rule()
            }],
            ..Default::default()
        };
        let legacy = McpGlobalPolicy {
            allow_dangerous_sql: true,
            connection_policies: vec![McpConnectionPolicy { execution_mode_policy_version: None, ..connection_rule() }],
            ..Default::default()
        };
        for (name, policy) in [("group", group), ("connection", connection), ("database", database), ("legacy", legacy)]
        {
            let backend = TestBackend::new(policy.clone());
            assert_tool_error(
                sql(server(backend.clone(), false, false), "INSERT INTO widgets VALUES (1)").await.unwrap_err(),
                "MCP_READ_ONLY",
            );
            assert!(backend.sql_calls.lock().unwrap().is_empty(), "{name} bypassed the read-only cap");
            sql(server(backend.clone(), true, false), "INSERT INTO widgets VALUES (1)").await.unwrap();
            assert_tool_error(
                sql(server(backend.clone(), true, false), "DROP TABLE widgets").await.unwrap_err(),
                "SQL_BLOCKED",
            );
            sql(server(backend.clone(), true, true), "DROP TABLE widgets").await.unwrap();
            let calls = backend.sql_calls.lock().unwrap();
            assert_eq!(calls.len(), 2, "unexpected backend calls for {name}");
            assert!(calls[0].allow_writes && !calls[0].allow_dangerous, "{name}: {:?}", calls[0]);
            assert!(calls[1].allow_writes && calls[1].allow_dangerous, "{name}: {:?}", calls[1]);
            assert_eq!(*backend.policy.lock().unwrap(), policy, "CLI modified saved {name} policy");
        }
    }

    #[tokio::test]
    async fn cli_flags_cannot_elevate_saved_policy_or_bypass_connection_and_production_protection() {
        let backend = TestBackend::new(McpGlobalPolicy { read_only: true, ..Default::default() });
        assert_tool_error(
            sql(server(backend, true, true), "INSERT INTO widgets VALUES (1)").await.unwrap_err(),
            "MCP_READ_ONLY",
        );
        let backend = TestBackend::new(McpGlobalPolicy::default());
        assert_tool_error(sql(server(backend, true, true), "DROP TABLE widgets").await.unwrap_err(), "SQL_BLOCKED");
        for production in [false, true] {
            let mut backend = TestBackend::new(McpGlobalPolicy { allow_dangerous_sql: true, ..Default::default() });
            let connection = &mut Arc::get_mut(&mut backend).unwrap().connections[0];
            connection.read_only = !production;
            connection.is_production = production;
            assert_tool_error(
                sql(server(backend.clone(), true, true), "INSERT INTO widgets VALUES (1)").await.unwrap_err(),
                if production { "PRODUCTION_WRITE_BLOCKED" } else { "CONNECTION_READ_ONLY" },
            );
            assert!(backend.sql_calls.lock().unwrap().is_empty());
        }
    }

    #[tokio::test]
    async fn repeated_cli_builders_cannot_restore_writes_or_dangerous_permissions() {
        let backend = TestBackend::new(McpGlobalPolicy { allow_dangerous_sql: true, ..Default::default() });
        let capped =
            server(backend.clone(), true, true).with_cli_permissions(false, false).with_cli_permissions(true, true);
        sql(capped.clone(), "SELECT 1").await.unwrap();
        assert_eq!(backend.sql_calls.lock().unwrap()[0], AgentSqlPermissions::default());
        assert_tool_error(sql(capped, "INSERT INTO widgets VALUES (1)").await.unwrap_err(), "MCP_READ_ONLY");
        let capped = server(backend.clone(), true, false).with_cli_permissions(true, true);
        assert_tool_error(sql(capped, "DROP TABLE widgets").await.unwrap_err(), "SQL_BLOCKED");
        assert_eq!(backend.sql_calls.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn cli_ceiling_is_reapplied_when_saved_permissions_change_between_calls() {
        let backend = TestBackend::new(McpGlobalPolicy { read_only: true, ..Default::default() });
        let capped = server(backend.clone(), false, false);
        sql(capped.clone(), "SELECT 1").await.unwrap();
        *backend.policy.lock().unwrap() = McpGlobalPolicy {
            allow_dangerous_sql: true,
            connection_policies: vec![connection_rule()],
            ..Default::default()
        };
        assert_tool_error(sql(capped, "INSERT INTO widgets VALUES (1)").await.unwrap_err(), "MCP_READ_ONLY");
        assert_eq!(backend.sql_calls.lock().unwrap().len(), 1);
    }

    #[test]
    fn structured_only_errors_fail_and_success_keeps_all_mcp_content() {
        let error_result: CallToolResult = serde_json::from_value(json!({
            "content": [], "isError": true, "structuredContent": { "code": "fixture-failure" }
        }))
        .unwrap();
        let error = format_result(error_result, OutputFormat::Json).unwrap_err();
        assert_eq!(error.code, "TOOL_ERROR");
        assert_eq!(error.tool_result.unwrap()["structuredContent"]["code"], "fixture-failure");
        let value = json!({
            "content": [{ "type": "text", "text": "plain text" }, { "type": "image", "data": "AA==", "mimeType": "image/png" }],
            "structuredContent": { "answer": 42 }, "isError": false
        });
        let result: CallToolResult = serde_json::from_value(value.clone()).unwrap();
        let output: Value = serde_json::from_str(&format_result(result.clone(), OutputFormat::Json).unwrap()).unwrap();
        assert_eq!(output, value);
        let text = format_result(result, OutputFormat::Table).unwrap();
        assert!(text.contains("plain text"));
        assert!(text.contains("image/png"));
        assert!(text.contains("42"));
    }
}
