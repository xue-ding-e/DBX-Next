//! Native CLI automation for installed plugins. Discovery and calls use the
//! backend's CLI API; MCP exposure and MCP policy are not prerequisites.
use dbx_mcp::{plugin_tools::PluginToolProvider, DbxBackend};
use serde_json::{json, Value};

use super::{json_string, markdown_table, tools, CliError, Flags, OutputFormat};

pub(super) enum PluginsCommand {
    List,
    Tools { plugin_id: String },
    Call { plugin_id: String, tool: String, arguments: Value },
}

pub(super) async fn parse_command(flags: &Flags) -> Result<PluginsCommand, CliError> {
    tools::validate_tool_flags(flags, "plugins")?;
    if flags.tool_filter.is_some() {
        return Err(CliError::new("INVALID_OPTION", "--filter is only supported by dbx tools list."));
    }
    let is_call = flags.args.get(1).is_some_and(|value| value == "call");
    if !is_call && (flags.file.is_some() || flags.plugin_connection.is_some()) {
        return Err(CliError::new("INVALID_OPTION", "--file and --connection are only supported by dbx plugins call."));
    }
    if flags.plugin_connection.as_ref().is_some_and(|value| value.trim().is_empty()) {
        return Err(CliError::new("INVALID_ARGUMENT", "--connection must name a saved connection ID or exact name."));
    }
    match flags.args.get(1).map(String::as_str) {
        Some("list") if flags.args.len() == 2 => Ok(PluginsCommand::List),
        Some("tools" | "operations") if flags.args.len() == 3 => {
            validate_name(&flags.args[2], "A plugin ID is required.")?;
            Ok(PluginsCommand::Tools { plugin_id: flags.args[2].clone() })
        }
        Some("call") if (4..=5).contains(&flags.args.len()) => {
            validate_name(&flags.args[2], "A plugin ID is required.")?;
            validate_name(&flags.args[3], "A plugin tool name is required.")?;
            let arguments = tools::parse_arguments(flags.args.get(4).map(String::as_str), flags.file.as_deref()).await?;
            Ok(PluginsCommand::Call {
                plugin_id: flags.args[2].clone(), tool: flags.args[3].clone(), arguments: Value::Object(arguments),
            })
        }
        _ => Err(CliError::new("INVALID_ARGUMENT", "Usage: dbx plugins list [--json] | dbx plugins tools <plugin-id> [--json] | dbx plugins call <plugin-id> <tool> [JSON | --file <path|->] [--connection <id-or-name>] [--allow-writes] [--allow-dangerous] [--json]")),
    }
}

fn validate_name(value: &str, message: &'static str) -> Result<(), CliError> {
    if value.trim().is_empty() {
        Err(CliError::new("INVALID_ARGUMENT", message))
    } else {
        Ok(())
    }
}

pub(super) async fn run(backend: &dyn DbxBackend, flags: &Flags, command: PluginsCommand) -> Result<String, CliError> {
    match command {
        PluginsCommand::List => {
            let mut plugins = backend.list_plugin_cli_inventory().await.map_err(plugin_error)?;
            plugins.sort_by(|left, right| left.id.cmp(&right.id));
            if flags.format == OutputFormat::Json {
                return json_string(&json!({ "plugins": plugins }));
            }
            if plugins.is_empty() {
                return Ok("No installed plugins were found.\n".to_string());
            }
            let rows = plugins.iter().map(|plugin| json!(plugin)).collect::<Vec<_>>();
            Ok(format!(
                "{}\n",
                markdown_table(
                    &["Plugin ID", "Name", "Version", "Status", "Tools", "Connections", "Diagnostic"],
                    &rows,
                    &["id", "name", "version", "status", "tool_count", "connection_count", "diagnostic"],
                )
            ))
        }
        PluginsCommand::Tools { plugin_id } => {
            let providers = backend.list_plugin_cli_tools_for(Some(&plugin_id)).await.map_err(plugin_error)?;
            if let Some(provider) =
                providers.iter().find(|provider| provider.plugin_id == plugin_id && !provider.tools.is_empty())
            {
                return format_tools(provider, flags.format);
            }
            let inventory = backend.list_plugin_cli_inventory().await.map_err(plugin_error)?;
            if let Some(plugin) = inventory.iter().find(|plugin| plugin.id == plugin_id) {
                return Err(CliError::new("PLUGIN_TOOLS_UNAVAILABLE", format!(
                    "Plugin \"{plugin_id}\" has no callable CLI tools ({}). {} Automation requires native tools, manifest rpc_tools, or an automation descriptor matching the installed plugin version.",
                    plugin.status, plugin.diagnostic.as_deref().unwrap_or("Use dbx plugins list --json to inspect its status.")
                )));
            }
            Err(CliError::new(
                "PLUGIN_NOT_FOUND",
                format!("Plugin \"{plugin_id}\" was not found. Use dbx plugins list to inspect installed plugins."),
            ))
        }
        PluginsCommand::Call { plugin_id, tool, arguments } => {
            let value = backend
                .call_plugin_cli_tool(
                    &plugin_id,
                    &tool,
                    flags.plugin_connection.as_deref(),
                    &arguments,
                    flags.allow_writes,
                    flags.allow_dangerous,
                )
                .await
                .map_err(plugin_error)?;
            tools::format_value_result(value, flags.format)
        }
    }
}

fn plugin_error(message: String) -> CliError {
    CliError::new("PLUGIN_ERROR", message)
}

fn format_tools(provider: &PluginToolProvider, format: OutputFormat) -> Result<String, CliError> {
    let rows = provider
        .tools
        .iter()
        .map(|tool| {
            json!({
                "name": tool.name, "description": tool.description, "inputSchema": tool.input_schema,
                "annotations": tool.annotations, "readOnly": tool.read_only,
            })
        })
        .collect::<Vec<_>>();
    if format == OutputFormat::Json {
        return json_string(
            &json!({ "pluginId": provider.plugin_id, "pluginName": provider.plugin_name, "tools": rows }),
        );
    }
    Ok(format!(
        "{} ({})\n{}\nSelect a saved connection with --connection <id-or-name>; the host supplies connection fields.\n",
        provider.plugin_name,
        provider.plugin_id,
        markdown_table(&["Tool", "Description", "Read only"], &rows, &["name", "description", "readOnly"])
    ))
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use async_trait::async_trait;
    use dbx_core::{
        agent_events::ToolResult, agent_tools::AgentSqlPermissions, models::connection::ConnectionConfig,
        storage::McpGlobalPolicy,
    };
    use dbx_mcp::plugin_tools::PluginInventoryEntry;

    use super::*;

    #[derive(Debug)]
    struct Invocation {
        plugin_id: String,
        tool: String,
        connection: Option<String>,
        arguments: Value,
        allow_writes: bool,
        allow_dangerous: bool,
    }

    #[derive(Default)]
    struct CliBackend {
        calls: Mutex<Vec<Invocation>>,
        tool_targets: Mutex<Vec<Option<String>>>,
    }

    #[async_trait]
    impl DbxBackend for CliBackend {
        async fn load_mcp_global_policy(&self) -> Result<McpGlobalPolicy, String> {
            panic!("native plugin CLI must not read MCP policy")
        }

        async fn load_connections(&self) -> Result<Vec<ConnectionConfig>, String> {
            panic!("connection binding belongs to the backend CLI call")
        }

        async fn execute_agent_tool(
            &self,
            _connection: &ConnectionConfig,
            _database: &str,
            _tool_name: &str,
            _arguments: Value,
            _permissions: AgentSqlPermissions,
        ) -> ToolResult {
            panic!("plugin CLI must not use the SQL agent")
        }

        async fn add_connection_for_mcp(&self, _config: ConnectionConfig) -> Result<ConnectionConfig, String> {
            panic!("plugin CLI must not manage connections through MCP")
        }

        async fn duplicate_connection_for_mcp(
            &self,
            _source_id: &str,
            _copy_id: &str,
            _copy_name: &str,
        ) -> Result<ConnectionConfig, String> {
            panic!("plugin CLI must not manage connections through MCP")
        }

        async fn remove_connection_for_mcp(&self, _connection_id: &str) -> Result<bool, String> {
            panic!("plugin CLI must not manage connections through MCP")
        }

        async fn list_plugin_mcp_tools(&self) -> Result<Vec<PluginToolProvider>, String> {
            panic!("plugin CLI must use native CLI discovery")
        }

        async fn call_plugin_mcp_tool(
            &self,
            _plugin_id: &str,
            _tool: &str,
            _connection: Option<&str>,
            _arguments: &Value,
        ) -> Result<Value, String> {
            panic!("plugin CLI must use native CLI execution")
        }

        async fn list_plugin_cli_inventory(&self) -> Result<Vec<PluginInventoryEntry>, String> {
            Ok(vec![
                PluginInventoryEntry { id: "org.example.ui".into(), name: "UI Extension".into(), version: "2.0.0".into(), status: "ui-only".into(), tool_count: 0, connection_count: 0, diagnostic: Some("No automation declaration; add manifest rpc_tools or a matching version automation descriptor.".into()) },
                PluginInventoryEntry { id: "org.example.plugin".into(), name: "Community Plugin".into(), version: "1.0.0".into(), status: "ready".into(), tool_count: 2, connection_count: 1, diagnostic: None },
                PluginInventoryEntry { id: "org.example.unavailable".into(), name: "Unavailable Backend".into(), version: "1.0.0".into(), status: "unavailable".into(), tool_count: 0, connection_count: 1, diagnostic: Some("Backend could not start.".into()) },
                PluginInventoryEntry { id: "org.example.z-incompatible".into(), name: "Incompatible Plugin".into(), version: "1.0.0".into(), status: "incompatible".into(), tool_count: 0, connection_count: 0, diagnostic: Some("Plugin requires a newer host.".into()) },
                PluginInventoryEntry { id: "org.example.z-uninspected".into(), name: "Native Plugin".into(), version: "1.0.0".into(), status: "uninspected".into(), tool_count: 0, connection_count: 1, diagnostic: Some("Run dbx plugins tools org.example.z-uninspected to inspect native operations.".into()) },
            ])
        }

        async fn list_plugin_cli_tools(&self) -> Result<Vec<PluginToolProvider>, String> {
            Ok(vec![PluginToolProvider {
                plugin_id: "org.example.plugin".into(),
                plugin_name: "Community Plugin".into(),
                tools: dbx_core::ai::plugin_tools::parse_tool_list(&json!({ "tools": [
                    { "name": "inspect", "description": "Read status", "inputSchema": { "type": "object", "properties": { "detail": { "type": "boolean" } } }, "annotations": { "readOnlyHint": true } },
                    { "name": "change", "description": "Change status", "inputSchema": { "type": "object" }, "annotations": { "readOnlyHint": false } }
                ] })),
            }])
        }

        async fn list_plugin_cli_tools_for(&self, plugin_id: Option<&str>) -> Result<Vec<PluginToolProvider>, String> {
            self.tool_targets.lock().unwrap().push(plugin_id.map(str::to_string));
            let mut providers = self.list_plugin_cli_tools().await?;
            if let Some(plugin_id) = plugin_id {
                providers.retain(|provider| provider.plugin_id == plugin_id);
            }
            Ok(providers)
        }

        async fn call_plugin_cli_tool(
            &self,
            plugin_id: &str,
            tool: &str,
            connection: Option<&str>,
            arguments: &Value,
            allow_writes: bool,
            allow_dangerous: bool,
        ) -> Result<Value, String> {
            self.calls.lock().unwrap().push(Invocation {
                plugin_id: plugin_id.into(),
                tool: tool.into(),
                connection: connection.map(str::to_string),
                arguments: arguments.clone(),
                allow_writes,
                allow_dangerous,
            });
            match tool {
                "tool_failure" => Ok(
                    json!({ "content": [{ "type": "text", "text": "operation failed" }], "isError": true, "structuredContent": { "reason": "fixture" } }),
                ),
                "backend_failure" => Err("CONNECTION_AMBIGUOUS: use a saved connection ID".into()),
                _ => Ok(json!({ "native": true, "arguments": arguments })),
            }
        }
    }

    fn flags(args: &[&str]) -> Flags {
        crate::parse_flags(&args.iter().map(|arg| arg.to_string()).collect::<Vec<_>>()).unwrap()
    }

    async fn invoke(backend: &CliBackend, args: &[&str]) -> Result<String, CliError> {
        let flags = flags(args);
        crate::validate_agent_only_flags(&flags)?;
        let command = parse_command(&flags).await?;
        run(backend, &flags, command).await
    }

    #[tokio::test]
    async fn native_inventory_includes_ui_only_plugins_and_diagnostics_without_mcp() {
        let backend = CliBackend::default();
        let output = invoke(&backend, &["plugins", "list", "--json"]).await.unwrap();
        let output: Value = serde_json::from_str(&output).unwrap();
        assert_eq!(output["plugins"].as_array().unwrap().len(), 5);
        assert_eq!(output["plugins"][0]["id"], "org.example.plugin");
        assert_eq!(output["plugins"][1]["status"], "ui-only");
        assert_eq!(output["plugins"][1]["tool_count"], 0);
        assert!(output["plugins"][1]["diagnostic"].as_str().unwrap().contains("rpc_tools"));
        assert_eq!(output["plugins"][2]["status"], "unavailable");
        assert_eq!(output["plugins"][3]["status"], "incompatible");
        assert_eq!(output["plugins"][4]["status"], "uninspected");
        let text = invoke(&backend, &["plugins", "list"]).await.unwrap();
        assert!(text.contains("UI Extension"));
        assert!(text.contains("ui-only"));
        assert!(text.contains("matching version automation descriptor"));
        assert!(text.contains("Backend could not start."));
        assert!(text.contains("Plugin requires a newer host."));
        assert!(text.contains("Run dbx plugins tools org.example.z-uninspected"));
        assert!(backend.tool_targets.lock().unwrap().is_empty(), "inventory must not request operation discovery");
    }

    #[tokio::test]
    async fn native_tool_discovery_exposes_schemas_and_explains_plugins_without_operations() {
        let backend = CliBackend::default();
        for alias in ["tools", "operations"] {
            let output = invoke(&backend, &["plugins", alias, "org.example.plugin", "--json"]).await.unwrap();
            let output: Value = serde_json::from_str(&output).unwrap();
            assert_eq!(output["pluginId"], "org.example.plugin");
            assert_eq!(output["tools"][0]["name"], "inspect");
            assert_eq!(output["tools"][0]["inputSchema"]["properties"]["detail"]["type"], "boolean");
            assert_eq!(output["tools"][0]["annotations"]["readOnlyHint"], true);
        }
        assert_eq!(
            *backend.tool_targets.lock().unwrap(),
            vec![Some("org.example.plugin".to_string()), Some("org.example.plugin".to_string())]
        );
        let unavailable = invoke(&backend, &["plugins", "tools", "org.example.ui"]).await.unwrap_err();
        assert_eq!(unavailable.code, "PLUGIN_TOOLS_UNAVAILABLE");
        assert!(unavailable.message.contains("rpc_tools"));
        assert!(unavailable.message.contains("automation descriptor"));
        assert_eq!(invoke(&backend, &["plugins", "tools", "missing"]).await.unwrap_err().code, "PLUGIN_NOT_FOUND");
        assert!(backend.tool_targets.lock().unwrap().iter().all(Option::is_some));
    }

    #[tokio::test]
    async fn native_calls_forward_exact_connection_arguments_and_explicit_flags_without_mcp_policy() {
        let backend = CliBackend::default();
        for (options, expected) in [
            (vec![], (false, false)),
            (vec!["--allow-writes"], (true, false)),
            (vec!["--allow-writes", "--allow-dangerous"], (true, true)),
        ] {
            let mut args = vec![
                "plugins",
                "call",
                "org.example.plugin",
                "inspect",
                r#"{"detail":true}"#,
                "--connection",
                "Exact Connection Name",
                "--json",
            ];
            args.extend(options);
            let output = invoke(&backend, &args).await.unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&output).unwrap(),
                json!({ "native": true, "arguments": { "detail": true } })
            );
            let calls = backend.calls.lock().unwrap();
            let call = calls.last().unwrap();
            assert_eq!(call.plugin_id, "org.example.plugin");
            assert_eq!(call.tool, "inspect");
            assert_eq!(call.connection.as_deref(), Some("Exact Connection Name"));
            assert_eq!(call.arguments, json!({ "detail": true }));
            assert_eq!((call.allow_writes, call.allow_dangerous), expected);
        }
        invoke(&backend, &["plugins", "call", "org.example.plugin", "inspect", r#"{"dbx_connection":"saved-id"}"#])
            .await
            .unwrap();
        let calls = backend.calls.lock().unwrap();
        assert!(calls.last().unwrap().connection.is_none());
        assert_eq!(calls.last().unwrap().arguments["dbx_connection"], "saved-id");
    }

    #[tokio::test]
    async fn native_calls_accept_utf8_bom_files_and_default_empty_arguments() {
        let backend = CliBackend::default();
        invoke(&backend, &["plugins", "call", "org.example.plugin", "inspect"]).await.unwrap();
        assert_eq!(backend.calls.lock().unwrap()[0].arguments, json!({}));
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("plugin-arguments.json");
        std::fs::write(&file, "\u{feff}{\"message\":\"你好\"}").unwrap();
        invoke(
            &backend,
            &[
                "plugins",
                "call",
                "org.example.plugin",
                "inspect",
                "--file",
                file.to_str().unwrap(),
                "--connection",
                "saved-id",
                "--json",
            ],
        )
        .await
        .unwrap();
        let calls = backend.calls.lock().unwrap();
        assert_eq!(calls[1].arguments, json!({ "message": "你好" }));
        assert_eq!(calls[1].connection.as_deref(), Some("saved-id"));
    }

    #[tokio::test]
    async fn native_tool_errors_and_backend_failures_remain_cli_failures_with_json_details() {
        let backend = CliBackend::default();
        let error =
            invoke(&backend, &["plugins", "call", "org.example.plugin", "tool_failure", "--json"]).await.unwrap_err();
        assert_eq!(error.code, "TOOL_ERROR");
        assert!(error.message.contains("operation failed"));
        let result = error.tool_result.unwrap();
        assert_eq!(result["isError"], true);
        assert_eq!(result["structuredContent"]["reason"], "fixture");
        let error = invoke(
            &backend,
            &["plugins", "call", "org.example.plugin", "backend_failure", "--connection", "ambiguous", "--json"],
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "PLUGIN_ERROR");
        assert!(error.message.contains("CONNECTION_AMBIGUOUS"));
    }

    #[tokio::test]
    async fn native_bad_input_is_rejected_before_loading_a_profile_and_never_echoes_json() {
        for input in ["[]", "null", "true", "1", "{bad-plugin-secret", "{} {}"] {
            let error = crate::run(vec![
                "plugins".into(),
                "call".into(),
                "org.example.plugin".into(),
                "inspect".into(),
                input.into(),
                "--json".into(),
            ])
            .await
            .unwrap_err()
            .0;
            assert_eq!(error.code, "INVALID_JSON");
            assert!(!error.message.contains("secret"));
        }
        let backend = CliBackend::default();
        for args in [
            vec!["plugins"],
            vec!["plugins", "list", "extra"],
            vec!["plugins", "tools"],
            vec!["plugins", "call", "org.example.plugin"],
            vec!["plugins", "call", "org.example.plugin", "inspect", "{}", "--file", "missing.json"],
            vec!["plugins", "call", "org.example.plugin", "inspect", "--connection", " "],
        ] {
            assert_eq!(invoke(&backend, &args).await.unwrap_err().code, "INVALID_ARGUMENT");
        }
        for args in [
            vec!["plugins", "list", "--format", "csv"],
            vec!["plugins", "list", "--file", "missing.json"],
            vec!["plugins", "call", "org.example.plugin", "inspect", "--allow-dangerous"],
            vec!["plugins", "call", "org.example.plugin", "inspect", "--schema", "public"],
        ] {
            assert_eq!(invoke(&backend, &args).await.unwrap_err().code, "INVALID_OPTION");
        }
        assert!(backend.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn connection_option_is_local_to_plugin_calls_and_capabilities_advertise_native_cli() {
        for args in [
            vec!["tools", "call", "example", "--connection", "saved-id"],
            vec!["doctor", "--connection", "saved-id"],
            vec!["query", "sample", "SELECT 1", "--connection", "saved-id"],
            vec!["plugins", "list", "--connection", "saved-id"],
            vec!["plugins", "tools", "org.example.plugin", "--connection", "saved-id"],
        ] {
            assert_eq!(crate::validate_agent_only_flags(&flags(&args)).unwrap_err().code, "INVALID_OPTION");
        }
        assert!(crate::validate_agent_only_flags(&flags(&["query", "sample", "SELECT 1"])).is_ok());
        assert!(crate::validate_agent_only_flags(&flags(&[
            "plugins",
            "call",
            "org.example.plugin",
            "inspect",
            "--connection",
            "saved-id"
        ]))
        .is_ok());
        let capabilities: Value =
            serde_json::from_str(&crate::format_capabilities(OutputFormat::Json).unwrap()).unwrap();
        assert_eq!(capabilities["plugins"]["requiresMcp"], false);
        assert_eq!(capabilities["plugins"]["readOnlyByDefault"], true);
        assert!(crate::usage().contains("dbx plugins list"));
        assert!(crate::usage().contains("dbx plugins tools"));
        assert!(crate::usage().contains("dbx plugins call"));
    }
}
