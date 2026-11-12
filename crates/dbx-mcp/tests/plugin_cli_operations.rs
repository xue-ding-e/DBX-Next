use std::sync::Mutex;

use async_trait::async_trait;
use dbx_core::{
    agent_events::ToolResult, agent_tools::AgentSqlPermissions, models::connection::ConnectionConfig,
    storage::McpGlobalPolicy,
};
use dbx_mcp::{plugin_tools::PluginToolProvider, DbxBackend};
use serde_json::{json, Value};

type RecordedCall = (String, String, Option<String>, Value);

#[derive(Default)]
struct Backend {
    connections: Vec<ConnectionConfig>,
    calls: Mutex<Vec<RecordedCall>>,
}

#[async_trait]
impl DbxBackend for Backend {
    async fn load_mcp_global_policy(&self) -> Result<McpGlobalPolicy, String> {
        panic!("direct CLI operations must not load MCP policy")
    }

    async fn load_connections(&self) -> Result<Vec<ConnectionConfig>, String> {
        Ok(self.connections.clone())
    }

    async fn add_connection_for_mcp(&self, _: ConnectionConfig) -> Result<ConnectionConfig, String> {
        panic!("plugin invocation must not create connections")
    }

    async fn duplicate_connection_for_mcp(&self, _: &str, _: &str, _: &str) -> Result<ConnectionConfig, String> {
        panic!("plugin invocation must not duplicate connections")
    }

    async fn remove_connection_for_mcp(&self, _: &str) -> Result<bool, String> {
        panic!("plugin invocation must not remove connections")
    }

    async fn execute_agent_tool(
        &self,
        _: &ConnectionConfig,
        _: &str,
        _: &str,
        _: Value,
        _: AgentSqlPermissions,
    ) -> ToolResult {
        panic!("plugin CLI must dispatch the plugin operation directly")
    }

    async fn list_plugin_cli_tools(&self) -> Result<Vec<PluginToolProvider>, String> {
        Ok(["vendor.metrics", "community.queue"]
            .into_iter()
            .map(|id| PluginToolProvider {
                plugin_id: id.into(),
                plugin_name: id.into(),
                tools: dbx_core::ai::plugin_tools::parse_tool_list(&json!({ "tools": [
                { "name": "inspect", "annotations": { "readOnlyHint": true },
                  "inputSchema": { "type": "object", "properties": { "connectionId": { "type": "string" } } } },
                { "name": "update", "annotations": { "readOnlyHint": false, "destructiveHint": false } },
                { "name": "delete", "annotations": { "readOnlyHint": false, "destructiveHint": true } },
                { "name": "opaque" },
                { "name": "local", "annotations": { "readOnlyHint": true },
                  "inputSchema": { "type": "object", "x-dbx-connection": "none" } }
            ] })),
            })
            .collect())
    }

    async fn call_plugin_mcp_tool(
        &self,
        plugin: &str,
        tool: &str,
        connection: Option<&str>,
        args: &Value,
    ) -> Result<Value, String> {
        self.calls.lock().unwrap().push((plugin.into(), tool.into(), connection.map(str::to_string), args.clone()));
        Ok(json!({ "content": [{ "type": "text", "text": "ok" }], "isError": false }))
    }
}

fn connection(id: &str, name: &str, plugin: &str) -> ConnectionConfig {
    serde_json::from_value(json!({
        "id": id, "name": name, "db_type": "plugin", "plugin_id": plugin,
        "host": "private.invalid", "port": 1234, "username": "user", "password": "saved-secret",
    }))
    .unwrap()
}

#[tokio::test]
async fn cli_discovers_multiple_plugin_families_and_binds_saved_connections_without_mcp() {
    let backend = Backend {
        connections: vec![connection("m1", "shared", "vendor.metrics"), connection("q1", "shared", "community.queue")],
        ..Default::default()
    };
    assert_eq!(backend.list_plugin_cli_inventory().await.unwrap().len(), 2);
    backend.call_plugin_cli_tool("vendor.metrics", "inspect", Some("shared"), &json!({
        "connectionId": "shared", "lifecycle": { "password": "forged" }, "runtime": { "host": "evil" }, "value": 42,
    }), false, false).await.unwrap();
    backend.call_plugin_cli_tool("community.queue", "inspect", None, &json!({}), false, false).await.unwrap();
    let calls = backend.calls.lock().unwrap();
    assert_eq!(calls[0].2.as_deref(), Some("m1"));
    assert_eq!(calls[0].3, json!({ "connectionId": "m1", "value": 42 }));
    assert_eq!(calls[1].2.as_deref(), Some("q1"));
}

#[tokio::test]
async fn cli_enforces_write_and_destructive_flags_before_dispatch() {
    let backend = Backend { connections: vec![connection("m1", "metrics", "vendor.metrics")], ..Default::default() };
    for (tool, writes, dangerous, expected) in [
        ("update", false, false, "PLUGIN_WRITE_BLOCKED"),
        ("delete", true, false, "PLUGIN_OPERATION_BLOCKED"),
        ("opaque", true, false, "PLUGIN_OPERATION_BLOCKED"),
        ("inspect", false, true, "INVALID_OPTION"),
    ] {
        let error = backend
            .call_plugin_cli_tool("vendor.metrics", tool, None, &json!({}), writes, dangerous)
            .await
            .unwrap_err();
        assert!(error.contains(expected), "{error}");
    }
    assert!(backend.calls.lock().unwrap().is_empty());
    backend.call_plugin_cli_tool("vendor.metrics", "update", None, &json!({}), true, false).await.unwrap();
    backend.call_plugin_cli_tool("vendor.metrics", "delete", None, &json!({}), true, true).await.unwrap();
    assert_eq!(backend.calls.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn cli_flags_cannot_override_read_only_or_production_connections() {
    for production in [false, true] {
        let mut config = connection("m1", "metrics", "vendor.metrics");
        config.read_only = !production;
        config.is_production = production;
        let backend = Backend { connections: vec![config], ..Default::default() };
        let error =
            backend.call_plugin_cli_tool("vendor.metrics", "delete", None, &json!({}), true, true).await.unwrap_err();
        assert!(
            error.contains(if production { "PRODUCTION_WRITE_BLOCKED" } else { "CONNECTION_READ_ONLY" }),
            "{error}"
        );
        assert!(backend.calls.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn opaque_plugin_writes_cannot_bypass_a_marked_production_database() {
    let mut config = connection("m1", "metrics", "vendor.metrics");
    config.database = Some("dev".to_string());
    config.production_databases = vec!["prod".to_string()];
    let backend = Backend { connections: vec![config], ..Default::default() };
    let error = backend
        .call_plugin_cli_tool("vendor.metrics", "update", None, &json!({"database":"prod"}), true, true)
        .await
        .unwrap_err();
    assert!(error.contains("PRODUCTION_WRITE_BLOCKED"), "{error}");
    assert!(backend.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn cli_rejects_ambiguity_cross_plugin_selection_and_conflicting_arguments() {
    let backend = Backend {
        connections: vec![
            connection("m1", "shared", "vendor.metrics"),
            connection("m2", "shared", "vendor.metrics"),
            connection("q1", "queue", "community.queue"),
        ],
        ..Default::default()
    };
    for (tool, selector, args) in [
        ("inspect", None, json!({})),
        ("inspect", Some("shared"), json!({})),
        ("inspect", Some("q1"), json!({})),
        ("inspect", Some("m1"), json!({"dbx_connection":"m2"})),
        ("unknown", Some("m1"), json!({})),
        ("inspect", Some("m1"), json!([])),
    ] {
        assert!(backend.call_plugin_cli_tool("vendor.metrics", tool, selector, &args, false, false).await.is_err());
    }
    assert!(backend.calls.lock().unwrap().is_empty());
    backend.call_plugin_cli_tool("vendor.metrics", "local", None, &json!({}), false, false).await.unwrap();
    assert!(backend.calls.lock().unwrap()[0].2.is_none());
}

#[test]
fn complete_cli_catalog_does_not_inherit_the_ai_context_limit() {
    let listing =
        json!({ "tools": (0..100).map(|index| json!({"name":format!("operation_{index}")})).collect::<Vec<_>>() });
    assert_eq!(dbx_core::ai::plugin_tools::parse_tool_list(&listing).len(), 64);
    assert_eq!(dbx_core::ai::plugin_tools::parse_tool_list_with_limit(&listing, usize::MAX).len(), 100);
}
