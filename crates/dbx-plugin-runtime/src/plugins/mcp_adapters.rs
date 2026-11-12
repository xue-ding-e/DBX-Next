//! CLI automation operations shared with the optional MCP compatibility bridge.
//!
//! Native dynamic discovery remains authoritative in the host. Declarative
//! operations explicitly allowlist RPCs; they never infer method names or
//! permissions. Saved connection lifecycle and credentials belong to the host.

use std::collections::{BTreeMap, HashSet};
use std::io::Read;
use std::path::Path;
use std::time::Duration;

use base64::Engine;
use futures::future::BoxFuture;
use semver::{Version, VersionReq};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tokio::sync::broadcast;
use tokio::time::Instant;

use super::{PluginEvent, PluginSidecarSession};

const MAX_OPERATIONS: usize = 4096;
const MAX_DESCRIPTOR_BYTES: usize = 2 * 1024 * 1024;
const MAX_SCHEMA_DEPTH: usize = 32;
const MAX_SCHEMA_NODES: usize = 8192;
const MAX_DURATION_MS: u64 = 30_000;
const MAX_CAPTURE_EVENTS: u64 = 200;
const FEED_START_TIMEOUT: Duration = Duration::from_secs(20);
const FEED_STOP_TIMEOUT: Duration = Duration::from_secs(5);
const BUILTIN_PROFILES: &[&str] = &[include_str!("../../../../plugins/automation/com.astergaze.nats.json")];

/// An explicitly declared CLI automation operation. MCP uses the same registry.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PluginRpcToolDeclaration {
    pub method: String,
    pub description: String,
    pub input_schema: Value,
    /// Required: missing access must never silently classify a method as read-only.
    pub access: PluginRpcAccess,
    #[serde(default)]
    pub connection: PluginRpcConnection,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<PluginRpcSnapshot>,
}

/// Read observes state; write changes state without destructive replacement;
/// full permits destructive or otherwise unrestricted side effects.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PluginRpcAccess {
    Read,
    Write,
    Full,
}

/// The host injects connectionId, lifecycle, both, or neither into RPC arguments.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PluginRpcConnection {
    None,
    #[default]
    Id,
    Lifecycle,
    Both,
}

impl PluginRpcConnection {
    fn label(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Id => "id",
            Self::Lifecycle => "lifecycle",
            Self::Both => "both",
        }
    }
}

/// Turn a feed-producing RPC into a finite snapshot with explicit cleanup.
/// Field names denote top-level JSON keys, not paths or expressions.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PluginRpcSnapshot {
    pub event_method: String,
    pub stop_method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub closed_event_method: Option<String>,
    #[serde(default = "connection_field")]
    pub event_connection_field: String,
    #[serde(default = "feed_field")]
    pub event_feed_field: String,
    #[serde(default = "feed_field")]
    pub feed_id_field: String,
    #[serde(default = "feed_field")]
    pub stop_feed_field: String,
    #[serde(default = "duration_parameter")]
    pub duration_param: String,
    #[serde(default = "messages_parameter")]
    pub max_messages_param: String,
    #[serde(default = "default_duration")]
    pub default_duration_ms: u64,
    #[serde(default = "maximum_duration")]
    pub max_duration_ms: u64,
    #[serde(default = "default_messages")]
    pub default_max_messages: u64,
    #[serde(default = "maximum_messages")]
    pub max_messages: u64,
}

fn connection_field() -> String {
    "connectionId".to_string()
}
fn feed_field() -> String {
    "feedId".to_string()
}
fn duration_parameter() -> String {
    "durationMs".to_string()
}
fn messages_parameter() -> String {
    "maxMessages".to_string()
}
fn default_duration() -> u64 {
    1000
}
fn maximum_duration() -> u64 {
    MAX_DURATION_MS
}
fn default_messages() -> u64 {
    50
}
fn maximum_messages() -> u64 {
    MAX_CAPTURE_EVENTS
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Descriptor {
    schema_version: u32,
    plugin_id: String,
    plugin_version: String,
    rpc_tools: BTreeMap<String, PluginRpcToolDeclaration>,
}

// This seam exercises the same dispatch, notification buffering, deadlines,
// and cleanup without creating another connection or child process.
trait RpcSession: Sync {
    fn call<'a>(
        &'a self,
        method: &'a str,
        args: Value,
        timeout: Option<Duration>,
    ) -> BoxFuture<'a, Result<Value, String>>;
    fn events(&self) -> broadcast::Receiver<PluginEvent>;
}

impl RpcSession for PluginSidecarSession {
    fn call<'a>(
        &'a self,
        method: &'a str,
        args: Value,
        timeout: Option<Duration>,
    ) -> BoxFuture<'a, Result<Value, String>> {
        Box::pin(self.invoke_with_timeout::<Value>(method, args, None, timeout))
    }

    fn events(&self) -> broadcast::Receiver<PluginEvent> {
        self.subscribe_events()
    }
}

pub(super) async fn invoke(
    session: &PluginSidecarSession,
    method: &str,
    params: &Value,
    timeout: Option<Duration>,
    local_descriptor: Option<&Path>,
) -> Result<Option<Value>, String> {
    if !matches!(method, "mcp/tools" | "mcp/call") {
        return Ok(None);
    }
    let manifest = &session.plugin().manifest;
    let empty = BTreeMap::new();
    let legacy = manifest.mcp_contribution().map(|mcp| &mcp.rpc_tools).unwrap_or(&empty);
    let Some(tools) = resolve_tools(&manifest.id, &manifest.version, &manifest.automation, legacy, local_descriptor)?
    else {
        return Ok(None);
    };
    invoke_operations(session, &manifest.id, &tools, method, params, timeout).await.map(Some)
}

/// Inspect declarative metadata without starting the plugin's backend process.
pub(super) fn declared_catalog(
    manifest: &super::PluginManifest,
    local_descriptor: Option<&Path>,
) -> Result<Option<Value>, String> {
    let empty = BTreeMap::new();
    let legacy = manifest.mcp_contribution().map(|mcp| &mcp.rpc_tools).unwrap_or(&empty);
    resolve_tools(&manifest.id, &manifest.version, &manifest.automation, legacy, local_descriptor).map(|tools| {
        tools.map(|tools| json!({"tools": tools.iter().map(|(name, tool)| definition(name, tool)).collect::<Vec<_>>()}))
    })
}

/// Invalid declarations are installation/compatibility errors, never a reason
/// to silently fall through to a different profile or truncate an operation list.
pub(super) fn validate_tools(tools: &BTreeMap<String, PluginRpcToolDeclaration>) -> Result<(), String> {
    if tools.len() > MAX_OPERATIONS {
        return Err(format!("Automation registry exceeds {MAX_OPERATIONS} operations"));
    }
    if serde_json::to_vec(tools).map_err(|error| error.to_string())?.len() > MAX_DESCRIPTOR_BYTES {
        return Err(format!("Automation declarations exceed {MAX_DESCRIPTOR_BYTES} bytes"));
    }
    for (name, tool) in tools {
        validate_name(name, "operation name")?;
        validate_method(&tool.method)?;
        if tool.description.trim().is_empty() || tool.description.len() > 16_384 {
            return Err(format!("Automation operation '{name}' requires a description of 1..16384 bytes"));
        }
        if tool.input_schema.get("type").and_then(Value::as_str) != Some("object") {
            return Err(format!("Automation operation '{name}' input_schema must have type object"));
        }
        validate_schema(&tool.input_schema, 0, &mut 0)?;
        reject_reserved_schema_fields(&tool.input_schema)?;
        if let Some(snapshot) = &tool.snapshot {
            validate_snapshot(snapshot)?;
            let schema = operation_schema(tool, false);
            validate_schema(&schema, 0, &mut 0)?;
        }
    }
    Ok(())
}

fn resolve_tools(
    plugin_id: &str,
    plugin_version: &str,
    automation: &BTreeMap<String, PluginRpcToolDeclaration>,
    legacy: &BTreeMap<String, PluginRpcToolDeclaration>,
    local_descriptor: Option<&Path>,
) -> Result<Option<BTreeMap<String, PluginRpcToolDeclaration>>, String> {
    if !automation.is_empty() && !legacy.is_empty() {
        return Err("Declare automation or mcp.rpc_tools, not both".to_string());
    }
    let manifest_tools = if automation.is_empty() { legacy } else { automation };
    if !manifest_tools.is_empty() {
        validate_tools(manifest_tools)?;
        return Ok(Some(manifest_tools.clone()));
    }
    if let Some(path) = local_descriptor {
        match std::fs::File::open(path) {
            Ok(file) => {
                if !file.metadata().map_err(|error| format!("Cannot inspect automation descriptor: {error}"))?.is_file()
                {
                    return Err("Automation descriptor must be a regular file".to_string());
                }
                let mut bytes = Vec::new();
                file.take((MAX_DESCRIPTOR_BYTES + 1) as u64)
                    .read_to_end(&mut bytes)
                    .map_err(|error| format!("Cannot read automation descriptor: {error}"))?;
                let descriptor = parse_descriptor(&bytes)?;
                if descriptor.plugin_id != plugin_id {
                    return Err("Automation descriptor plugin_id does not match the installed plugin".to_string());
                }
                if !matches_version(&descriptor, plugin_version)? {
                    return Err("Automation descriptor plugin_version does not match the installed version".to_string());
                }
                return Ok(Some(descriptor.rpc_tools));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Cannot open automation descriptor: {error}")),
        }
    }
    for profile in BUILTIN_PROFILES {
        let descriptor = parse_descriptor(profile.as_bytes())?;
        if descriptor.plugin_id == plugin_id && matches_version(&descriptor, plugin_version)? {
            return Ok(Some(descriptor.rpc_tools));
        }
    }
    Ok(None)
}

fn parse_descriptor(bytes: &[u8]) -> Result<Descriptor, String> {
    if bytes.len() > MAX_DESCRIPTOR_BYTES {
        return Err(format!("Automation descriptor exceeds {MAX_DESCRIPTOR_BYTES} bytes"));
    }
    // Windows editors and PowerShell 5.1 commonly emit a UTF-8 BOM.
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    let descriptor: Descriptor =
        serde_json::from_slice(bytes).map_err(|error| format!("Invalid automation descriptor: {error}"))?;
    if descriptor.schema_version != 1 {
        return Err("Unsupported automation descriptor schema_version (expected 1)".to_string());
    }
    validate_name(&descriptor.plugin_id, "plugin_id")?;
    VersionReq::parse(&descriptor.plugin_version)
        .map_err(|error| format!("Invalid automation descriptor plugin_version: {error}"))?;
    validate_tools(&descriptor.rpc_tools)?;
    Ok(descriptor)
}

fn matches_version(descriptor: &Descriptor, installed: &str) -> Result<bool, String> {
    let installed =
        Version::parse(installed).map_err(|error| format!("Installed plugin version is not valid semver: {error}"))?;
    Ok(VersionReq::parse(&descriptor.plugin_version).map_err(|error| error.to_string())?.matches(&installed))
}

fn validate_name(value: &str, what: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(format!("Invalid automation {what}"));
    }
    Ok(())
}

fn validate_method(method: &str) -> Result<(), String> {
    if method.is_empty()
        || method.len() > 256
        || !method.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'/' | b'-'))
    {
        return Err("Invalid automation RPC method".to_string());
    }
    let namespace = method.split(['/', ':', '.']).next().unwrap_or_default();
    if ["plugin", "connection", "mcp", "host", "driver", "automation"]
        .iter()
        .any(|reserved| namespace.eq_ignore_ascii_case(reserved))
    {
        return Err(format!("Automation RPC method '{method}' uses a reserved namespace"));
    }
    Ok(())
}

fn validate_snapshot(snapshot: &PluginRpcSnapshot) -> Result<(), String> {
    validate_method(&snapshot.event_method)?;
    validate_method(&snapshot.stop_method)?;
    if let Some(method) = &snapshot.closed_event_method {
        validate_method(method)?;
        if method == &snapshot.event_method {
            return Err("Snapshot data and closed event methods must differ".to_string());
        }
    }
    for field in [
        &snapshot.event_connection_field,
        &snapshot.event_feed_field,
        &snapshot.feed_id_field,
        &snapshot.stop_feed_field,
        &snapshot.duration_param,
        &snapshot.max_messages_param,
    ] {
        validate_name(field, "snapshot field")?;
    }
    if snapshot.event_connection_field == snapshot.event_feed_field
        || snapshot.duration_param == snapshot.max_messages_param
        || is_host_argument(&snapshot.stop_feed_field)
        || is_host_argument(&snapshot.duration_param)
        || is_host_argument(&snapshot.max_messages_param)
    {
        return Err("Snapshot fields overlap or overwrite host connection binding".to_string());
    }
    if snapshot.default_duration_ms == 0
        || snapshot.default_duration_ms > snapshot.max_duration_ms
        || snapshot.max_duration_ms > MAX_DURATION_MS
        || snapshot.default_max_messages == 0
        || snapshot.default_max_messages > snapshot.max_messages
        || snapshot.max_messages > MAX_CAPTURE_EVENTS
    {
        return Err(format!(
            "Snapshot limits must be positive and at most {MAX_DURATION_MS} ms / {MAX_CAPTURE_EVENTS} events"
        ));
    }
    Ok(())
}

fn is_host_argument(key: &str) -> bool {
    matches!(
        key,
        "lifecycle"
            | "config"
            | "connection"
            | "connectionId"
            | "connection_id"
            | "connectionName"
            | "dbx_connection"
            | "provider"
            | "runtime"
            | "operationId"
            | "external_config"
            | "connection_secrets"
            | "password"
            | "credentials"
            | "read_only"
            | "readOnly"
    )
}

fn reject_reserved_schema_fields(schema: &Value) -> Result<(), String> {
    if schema
        .get("properties")
        .and_then(Value::as_object)
        .is_some_and(|properties| properties.keys().any(|key| is_host_argument(key)))
        || schema
            .get("required")
            .and_then(Value::as_array)
            .is_some_and(|required| required.iter().filter_map(Value::as_str).any(is_host_argument))
    {
        return Err("Operation input_schema must not declare host-reserved connection fields".to_string());
    }
    // Composition can also introduce top-level properties, so inspect those
    // schemas at the same binding boundary rather than only the outer object.
    for key in ["allOf", "anyOf", "oneOf"] {
        if let Some(branches) = schema.get(key).and_then(Value::as_array) {
            for branch in branches {
                reject_reserved_schema_fields(branch)?;
            }
        }
    }
    Ok(())
}

fn validate_schema(schema: &Value, depth: usize, nodes: &mut usize) -> Result<(), String> {
    *nodes += 1;
    if depth > MAX_SCHEMA_DEPTH || *nodes > MAX_SCHEMA_NODES {
        return Err("Automation input_schema exceeds the supported depth or node limit".to_string());
    }
    if schema.is_boolean() {
        return Ok(());
    }
    let object = schema.as_object().ok_or("Automation input_schema nodes must be objects or booleans")?;
    const KEYS: &[&str] = &[
        "$schema",
        "$id",
        "$comment",
        "title",
        "description",
        "examples",
        "deprecated",
        "readOnly",
        "writeOnly",
        "type",
        "properties",
        "required",
        "additionalProperties",
        "minProperties",
        "maxProperties",
        "items",
        "minItems",
        "maxItems",
        "uniqueItems",
        "minLength",
        "maxLength",
        "minimum",
        "maximum",
        "exclusiveMinimum",
        "exclusiveMaximum",
        "enum",
        "const",
        "default",
        "allOf",
        "anyOf",
        "oneOf",
        "not",
        "contentEncoding",
        "x-dbx-maxDecodedBytes",
    ];
    for key in object.keys() {
        if !KEYS.contains(&key.as_str()) {
            return Err(format!("Unsupported automation input_schema keyword '{key}'"));
        }
    }
    if let Some(kind) = schema.get("type") {
        let valid_type = |kind: &Value| {
            kind.as_str().is_some_and(|kind| {
                ["object", "array", "string", "integer", "number", "boolean", "null"].contains(&kind)
            })
        };
        if !valid_type(kind) && !kind.as_array().is_some_and(|kinds| !kinds.is_empty() && kinds.iter().all(valid_type))
        {
            return Err("Automation schema has an invalid type".to_string());
        }
    }
    for key in ["$schema", "$id", "$comment", "title", "description"] {
        if schema.get(key).is_some_and(|value| !value.is_string()) {
            return Err(format!("Automation schema {key} must be a string"));
        }
    }
    for key in ["deprecated", "readOnly", "writeOnly", "uniqueItems"] {
        if schema.get(key).is_some_and(|value| !value.is_boolean()) {
            return Err(format!("Automation schema {key} must be a boolean"));
        }
    }
    for key in ["examples", "enum"] {
        if schema
            .get(key)
            .is_some_and(|value| !value.is_array() || (key == "enum" && value.as_array().is_some_and(Vec::is_empty)))
        {
            return Err(format!("Automation schema {key} must be an array (enum cannot be empty)"));
        }
    }
    for key in
        ["minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties", "x-dbx-maxDecodedBytes"]
    {
        if schema.get(key).is_some_and(|value| value.as_u64().is_none()) {
            return Err(format!("Automation schema {key} must be an unsigned integer"));
        }
    }
    for (minimum, maximum) in [("minLength", "maxLength"), ("minItems", "maxItems"), ("minProperties", "maxProperties")]
    {
        if let (Some(minimum), Some(maximum)) = (schema[minimum].as_u64(), schema[maximum].as_u64()) {
            if minimum > maximum {
                return Err("Automation schema minimum exceeds maximum".to_string());
            }
        }
    }
    for key in ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"] {
        if schema
            .get(key)
            .is_some_and(|value| !value.is_number() || value.as_f64().is_none_or(|number| !number.is_finite()))
        {
            return Err(format!("Automation schema {key} must be a finite number"));
        }
    }
    if let (Some(minimum), Some(maximum)) = (schema.get("minimum"), schema.get("maximum")) {
        if compare_numbers(minimum, maximum) == Some(std::cmp::Ordering::Greater) {
            return Err("Automation schema minimum exceeds maximum".to_string());
        }
    }
    if let Some(properties) = schema.get("properties") {
        for property in properties.as_object().ok_or("Automation schema properties must be an object")?.values() {
            validate_schema(property, depth + 1, nodes)?;
        }
    }
    if let Some(required) = schema.get("required") {
        let required = required.as_array().ok_or("Automation schema required must be an array")?;
        let mut unique = HashSet::new();
        for key in required {
            let key = key.as_str().ok_or("Automation schema required entries must be strings")?;
            if !unique.insert(key) {
                return Err("Automation schema required contains duplicates".to_string());
            }
        }
    }
    if let Some(additional) = schema.get("additionalProperties") {
        validate_schema(additional, depth + 1, nodes)?;
    }
    if let Some(items) = schema.get("items") {
        validate_schema(items, depth + 1, nodes)?;
    }
    for key in ["allOf", "anyOf", "oneOf"] {
        if let Some(branches) = schema.get(key) {
            let branches = branches
                .as_array()
                .filter(|branches| !branches.is_empty())
                .ok_or_else(|| format!("Automation schema {key} must be a nonempty array"))?;
            for branch in branches {
                validate_schema(branch, depth + 1, nodes)?;
            }
        }
    }
    if let Some(not) = schema.get("not") {
        validate_schema(not, depth + 1, nodes)?;
    }
    if let Some(encoding) = schema.get("contentEncoding") {
        if encoding.as_str() != Some("base64") {
            return Err("Automation schema supports only base64 contentEncoding".to_string());
        }
    }
    if schema.get("x-dbx-maxDecodedBytes").is_some() && schema["contentEncoding"] != "base64" {
        return Err("x-dbx-maxDecodedBytes requires contentEncoding=base64".to_string());
    }
    if let Some(initial) = schema.get("default") {
        validate_value(initial, schema, "schema.default", false)?;
    }
    Ok(())
}

fn operation_schema(tool: &PluginRpcToolDeclaration, discovery: bool) -> Value {
    let mut schema = tool.input_schema.clone();
    let properties = schema
        .as_object_mut()
        .expect("validated object schema")
        .entry("properties")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .expect("validated properties");
    if let Some(snapshot) = &tool.snapshot {
        // Snapshot controls belong to the host and are not forwarded to the
        // start RPC. Their published and enforced bounds share one definition.
        properties.insert(snapshot.duration_param.clone(), json!({
            "type": "integer", "minimum": 1, "maximum": snapshot.max_duration_ms,
            "default": snapshot.default_duration_ms, "description": "Maximum capture duration in milliseconds, excluding setup and cleanup.",
        }));
        properties.insert(
            snapshot.max_messages_param.clone(),
            json!({
                "type": "integer", "minimum": 1, "maximum": snapshot.max_messages,
                "default": snapshot.default_max_messages, "description": "Stop after this many matching events.",
            }),
        );
    }
    if discovery {
        if tool.connection != PluginRpcConnection::None {
            properties.insert(
                "connectionId".to_string(),
                json!({
                    "type": "string", "minLength": 1,
                    "description": "Host-bound saved connection; callers cannot override the lifecycle binding.",
                }),
            );
        }
        schema["x-dbx-connection"] = json!(tool.connection.label());
    }
    schema
}

fn definition(name: &str, tool: &PluginRpcToolDeclaration) -> Value {
    json!({
        "name": name, "description": tool.description, "inputSchema": operation_schema(tool, true),
        "annotations": {
            "readOnlyHint": tool.access == PluginRpcAccess::Read,
            "destructiveHint": tool.access == PluginRpcAccess::Full,
            "idempotentHint": tool.access == PluginRpcAccess::Read && tool.snapshot.is_none(),
            "openWorldHint": true,
        },
    })
}

// Some clients use schemas only to guide generation. Enforce the supported
// assertions here, including exact integer widths, defaults and decoded bytes.
// Unsupported schema keywords are rejected at declaration time, never ignored.
fn validate_value(value: &Value, schema: &Value, path: &str, strip_binding: bool) -> Result<Value, String> {
    let invalid = |reason: &str| format!("Invalid automation {path}: {reason}");
    if schema == &Value::Bool(true) {
        return Ok(value.clone());
    }
    if schema == &Value::Bool(false) {
        return Err(invalid("schema forbids this value"));
    }
    let mut value = value.clone();
    if strip_binding {
        if let Some(object) = value.as_object_mut() {
            object.retain(|key, _| !is_host_argument(key));
        }
    }
    if let Some(branches) = schema.get("allOf").and_then(Value::as_array) {
        for branch in branches {
            value = validate_value(&value, branch, path, strip_binding)?;
        }
    }
    for key in ["anyOf", "oneOf"] {
        if let Some(branches) = schema.get(key).and_then(Value::as_array) {
            let matches = branches
                .iter()
                .filter_map(|branch| validate_value(&value, branch, path, strip_binding).ok())
                .collect::<Vec<_>>();
            if matches.is_empty() || (key == "oneOf" && matches.len() != 1) {
                return Err(invalid(&format!("value does not satisfy {key}")));
            }
            value = matches.into_iter().next().unwrap();
        }
    }
    if schema.get("not").is_some_and(|not| validate_value(&value, not, path, strip_binding).is_ok()) {
        return Err(invalid("value satisfies a forbidden schema"));
    }
    if schema.get("enum").and_then(Value::as_array).is_some_and(|choices| !choices.contains(&value))
        || schema.get("const").is_some_and(|constant| constant != &value)
    {
        return Err(invalid("value is not an allowed choice"));
    }
    if let Some(kind) = schema.get("type") {
        let matches = |kind: &str| match kind {
            "object" => value.is_object(),
            "array" => value.is_array(),
            "string" => value.is_string(),
            "integer" => json_integer(&value).is_some(),
            "number" => value.as_f64().is_some_and(f64::is_finite),
            "boolean" => value.is_boolean(),
            "null" => value.is_null(),
            _ => false,
        };
        let matches = kind.as_str().is_some_and(matches)
            || kind.as_array().is_some_and(|kinds| kinds.iter().filter_map(Value::as_str).any(matches));
        if !matches {
            return Err(invalid("value has the wrong type or integer range"));
        }
    }
    if let Some(input) = value.as_object() {
        let properties = schema.get("properties").and_then(Value::as_object);
        let mut result = Map::new();
        for (key, value) in input {
            let property = properties.and_then(|properties| properties.get(key));
            let value = match property {
                Some(property) => validate_value(value, property, &format!("{path}.{key}"), false)?,
                None => match schema.get("additionalProperties") {
                    Some(Value::Bool(false)) => return Err(invalid(&format!("unknown field '{key}'"))),
                    Some(additional) if additional.is_object() => {
                        validate_value(value, additional, &format!("{path}.{key}"), false)?
                    }
                    _ => value.clone(),
                },
            };
            result.insert(key.clone(), value);
        }
        if let Some(properties) = properties {
            for (key, property) in properties {
                if !result.contains_key(key) {
                    if let Some(initial) = property.get("default") {
                        if !strip_binding || !is_host_argument(key) {
                            result.insert(
                                key.clone(),
                                validate_value(initial, property, &format!("{path}.{key}"), false)?,
                            );
                        }
                    }
                }
            }
        }
        if let Some(required) = schema.get("required").and_then(Value::as_array) {
            for key in required.iter().filter_map(Value::as_str) {
                if !result.contains_key(key) {
                    return Err(invalid(&format!("missing required field '{key}'")));
                }
            }
        }
        check_length(result.len(), schema, "minProperties", "maxProperties").map_err(|error| invalid(error))?;
        value = Value::Object(result);
    } else if let Some(items) = value.as_array() {
        check_length(items.len(), schema, "minItems", "maxItems").map_err(|error| invalid(error))?;
        let fallback = Value::Bool(true);
        let item_schema = schema.get("items").unwrap_or(&fallback);
        let mut result = Vec::new();
        let mut unique = HashSet::new();
        for (index, item) in items.iter().enumerate() {
            let item = validate_value(item, item_schema, &format!("{path}[{index}]"), false)?;
            if schema.get("uniqueItems").and_then(Value::as_bool) == Some(true) && !unique.insert(item.to_string()) {
                return Err(invalid("array contains duplicate items"));
            }
            result.push(item);
        }
        value = Value::Array(result);
    } else if let Some(text) = value.as_str() {
        check_length(text.chars().count(), schema, "minLength", "maxLength").map_err(|error| invalid(error))?;
        if schema.get("contentEncoding").and_then(Value::as_str) == Some("base64") {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(text)
                .map_err(|_| invalid("expected valid standard base64"))?;
            if schema
                .get("x-dbx-maxDecodedBytes")
                .and_then(Value::as_u64)
                .is_some_and(|limit| bytes.len() as u64 > limit)
            {
                return Err(invalid("decoded base64 size exceeds x-dbx-maxDecodedBytes"));
            }
        }
    } else if value.is_number() {
        for (key, rejected) in [
            ("minimum", std::cmp::Ordering::Less),
            ("maximum", std::cmp::Ordering::Greater),
            ("exclusiveMinimum", std::cmp::Ordering::Less),
            ("exclusiveMaximum", std::cmp::Ordering::Greater),
        ] {
            if let Some(bound) = schema.get(key) {
                let ordering =
                    compare_numbers(&value, bound).ok_or_else(|| invalid("number is outside the supported range"))?;
                if ordering == rejected || (key.starts_with("exclusive") && ordering == std::cmp::Ordering::Equal) {
                    return Err(invalid("number is outside the allowed range"));
                }
            }
        }
    }
    Ok(value)
}

fn check_length(length: usize, schema: &Value, minimum: &str, maximum: &str) -> Result<(), &'static str> {
    if schema[minimum].as_u64().is_some_and(|minimum| (length as u64) < minimum)
        || schema[maximum].as_u64().is_some_and(|maximum| (length as u64) > maximum)
    {
        return Err("length is outside the allowed range");
    }
    Ok(())
}

fn json_integer(value: &Value) -> Option<i128> {
    value.as_i64().map(i128::from).or_else(|| value.as_u64().map(i128::from))
}

fn compare_numbers(left: &Value, right: &Value) -> Option<std::cmp::Ordering> {
    if let (Some(left), Some(right)) = (json_integer(left), json_integer(right)) {
        Some(left.cmp(&right))
    } else {
        left.as_f64()?.partial_cmp(&right.as_f64()?)
    }
}

#[derive(Clone)]
struct Binding {
    mode: PluginRpcConnection,
    id: Option<String>,
    lifecycle: Option<Value>,
    read_only: bool,
}

impl Binding {
    fn from_host(mode: PluginRpcConnection, params: &Value) -> Result<Self, String> {
        if mode == PluginRpcConnection::None {
            return Ok(Self { mode, id: None, lifecycle: None, read_only: false });
        }
        let lifecycle = params
            .get("lifecycle")
            .filter(|value| value.is_object())
            .ok_or("Automation operation requires a host connection lifecycle")?;
        let connection = lifecycle
            .get("connection")
            .filter(|value| value.is_object())
            .ok_or("Automation operation requires lifecycle.connection from the host")?;
        let id = connection
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
            .ok_or("Automation operation requires lifecycle.connection.id from the host")?;
        if connection.get("read_only").is_some_and(|read_only| !read_only.is_boolean()) {
            return Err("Host lifecycle connection.read_only must be a boolean".to_string());
        }
        Ok(Self {
            mode,
            id: Some(id.to_string()),
            lifecycle: Some(lifecycle.clone()),
            read_only: connection.get("read_only").and_then(Value::as_bool) == Some(true),
        })
    }

    fn inject(&self, args: &mut Value) {
        let object = args.as_object_mut().expect("validated RPC arguments");
        object.retain(|key, _| !is_host_argument(key));
        if matches!(self.mode, PluginRpcConnection::Id | PluginRpcConnection::Both) {
            object.insert("connectionId".to_string(), json!(self.id));
        }
        if matches!(self.mode, PluginRpcConnection::Lifecycle | PluginRpcConnection::Both) {
            object.insert("lifecycle".to_string(), self.lifecycle.clone().expect("bound lifecycle"));
        }
    }
}

async fn invoke_operations(
    session: &impl RpcSession,
    plugin_id: &str,
    tools: &BTreeMap<String, PluginRpcToolDeclaration>,
    method: &str,
    params: &Value,
    timeout: Option<Duration>,
) -> Result<Value, String> {
    if method == "mcp/tools" {
        // CLI uses the entire registry. Presentation limits in AI/MCP surfaces
        // are separate policies; this registry never silently truncates it.
        return Ok(json!({ "tools": tools.iter().map(|(name, tool)| definition(name, tool)).collect::<Vec<_>>() }));
    }
    if method != "mcp/call" {
        return Err("Unknown automation compatibility method".to_string());
    }
    let name = params.get("tool").and_then(Value::as_str).ok_or("Automation call requires an operation name")?;
    let tool = tools.get(name).ok_or_else(|| format!("Unknown automation operation: {name}"))?;
    let binding = Binding::from_host(tool.connection, params)?;
    // Do not rely on the plugin to enforce read-only mode. Older RPCs may
    // publish messages or divert queue deliveries without checking this flag.
    if tool.access != PluginRpcAccess::Read && binding.read_only {
        return Err(format!("Automation operation '{name}' is not allowed on a read-only connection"));
    }
    let empty = json!({});
    let input = params.get("arguments").filter(|value| !value.is_null()).unwrap_or(&empty);
    let mut args = validate_value(input, &operation_schema(tool, false), "arguments", true)?;
    binding.inject(&mut args);
    let value = if let Some(snapshot) = &tool.snapshot {
        capture(session, plugin_id, tool, snapshot, binding, args, timeout).await?
    } else {
        session.call(&tool.method, args, timeout).await?
    };
    // Some existing RPC handlers already return a structured operation result.
    // Do not hide their error flag inside a successful compatibility envelope.
    if value.get("isError").and_then(Value::as_bool).is_some() && value.get("content").is_some_and(Value::is_array) {
        return Ok(value);
    }
    let is_error = value.get("isError").and_then(Value::as_bool) == Some(true);
    // The compatibility envelope is shared by the CLI backend and MCP. MCP's
    // structured content must be an object even when a native RPC returns a scalar.
    let structured = if value.is_object() { value.clone() } else { json!({ "result": value }) };
    Ok(json!({
        "content": [{ "type": "text", "text": value.to_string() }],
        "structuredContent": structured,
        "isError": is_error,
    }))
}

async fn capture(
    session: &impl RpcSession,
    plugin_id: &str,
    tool: &PluginRpcToolDeclaration,
    snapshot: &PluginRpcSnapshot,
    binding: Binding,
    mut args: Value,
    timeout: Option<Duration>,
) -> Result<Value, String> {
    let started = Instant::now();
    let object = args.as_object_mut().expect("validated object");
    let duration_ms = object.remove(&snapshot.duration_param).unwrap().as_u64().unwrap();
    let max_messages = object.remove(&snapshot.max_messages_param).unwrap().as_u64().unwrap() as usize;
    let start_timeout = timeout.unwrap_or(FEED_START_TIMEOUT).min(FEED_START_TIMEOUT);
    if start_timeout.is_zero() {
        return Err("Automation snapshot timed out before starting a feed".to_string());
    }
    // Subscribe BEFORE starting the RPC. A plugin may emit notifications before
    // its response arrives; subscribing only after the handle loses those events.
    let mut receiver = session.events();
    // A protocol that generates its own handle cannot identify a feed to stop if
    // the start response is lost. Managed connection teardown remains the host's
    // fallback. Every identified feed below is stopped on normal and error exits.
    let opened = session.call(&tool.method, args, Some(start_timeout)).await?;
    let feed_id = opened.get(&snapshot.feed_id_field)
        .filter(|id| id.as_str().is_some_and(|id| !id.trim().is_empty()) || json_integer(id).is_some())
        .ok_or("Feed start did not return a nonempty string or integer feed handle; cleanup cannot safely identify the feed")?;
    let capture = Capture {
        plugin_id,
        snapshot,
        binding: &binding,
        feed_id,
        started,
        timeout,
        duration: Duration::from_millis(duration_ms),
        max_messages,
    };
    let result = collect_snapshot(&mut receiver, &capture).await;
    // Cleanup gets a separate bounded budget even when capture exhausted the
    // caller's deadline. Never reconnect or stop a different connection's feeds.
    let mut stop_args = json!({});
    stop_args[&snapshot.stop_feed_field] = feed_id.clone();
    binding.inject(&mut stop_args);
    let stopped = session.call(&snapshot.stop_method, stop_args, Some(FEED_STOP_TIMEOUT)).await.and_then(|response| {
        if response.get("ok").and_then(Value::as_bool) == Some(false)
            || response.get("success").and_then(Value::as_bool) == Some(false)
            || response.get("isError").and_then(Value::as_bool) == Some(true)
        {
            Err("Stop RPC reported an unsuccessful result".to_string())
        } else {
            // A successful JSON-RPC stop may legitimately return null.
            Ok(())
        }
    });
    match (result, stopped) {
        (Ok(mut result), Ok(())) => {
            result["stopped"] = json!(true);
            Ok(result)
        }
        (Err(error), Ok(())) => Err(error),
        (Ok(_), Err(error)) => Err(format!("Automation snapshot could not stop feed {feed_id}: {error}")),
        (Err(error), Err(cleanup)) => Err(format!("{error}; also failed to stop feed {feed_id}: {cleanup}")),
    }
}

struct Capture<'a> {
    plugin_id: &'a str,
    snapshot: &'a PluginRpcSnapshot,
    binding: &'a Binding,
    feed_id: &'a Value,
    started: Instant,
    timeout: Option<Duration>,
    duration: Duration,
    max_messages: usize,
}

async fn collect_snapshot(
    receiver: &mut broadcast::Receiver<PluginEvent>,
    capture: &Capture<'_>,
) -> Result<Value, String> {
    let collection_started = Instant::now();
    let remaining = capture.timeout.map(|budget| budget.saturating_sub(capture.started.elapsed()));
    let caller_deadline = remaining.is_some_and(|remaining| remaining <= capture.duration);
    let window = remaining.map_or(capture.duration, |remaining| capture.duration.min(remaining));
    let deadline = tokio::time::sleep(window);
    tokio::pin!(deadline);
    let mut events = Vec::new();
    let mut dropped = 0_u64;
    let reason = loop {
        // Check the timer first so unrelated events cannot extend the capture.
        tokio::select! {
            biased;
            _ = &mut deadline => {
                if caller_deadline { return Err("Automation snapshot exceeded the caller's timeout".to_string()); }
                break "duration";
            }
            event = receiver.recv() => {
                let event = match event {
                    Ok(event) => event,
                    Err(broadcast::error::RecvError::Lagged(count)) => {
                        return Err(format!("Automation snapshot event buffer lost {count} events; snapshot is incomplete"));
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        return Err("Automation snapshot event channel closed".to_string());
                    }
                };
                let snapshot = capture.snapshot;
                let closed = snapshot.closed_event_method.as_deref() == Some(event.method.as_str());
                if event.plugin_id != capture.plugin_id
                    || event.params.get(&snapshot.event_feed_field) != Some(capture.feed_id)
                    || capture.binding.id.as_deref().is_some_and(|id| {
                        event.params.get(&snapshot.event_connection_field).and_then(Value::as_str) != Some(id)
                    })
                    || (event.method != snapshot.event_method && !closed)
                {
                    continue;
                }
                dropped = dropped.saturating_add(event.params.get("dropped").and_then(Value::as_u64).unwrap_or(0));
                events.push(event);
                if closed { break "feedClosed"; }
                if events.len() >= capture.max_messages { break "maxMessages"; }
            }
        }
    };
    Ok(json!({
        "events": events, "eventCount": events.len(), "dropped": dropped, "stopReason": reason,
        "elapsedMs": collection_started.elapsed().as_millis(),
        "maxMessages": capture.max_messages, "durationMs": capture.duration.as_millis(),
    }))
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    const ALPHA: &str = "org.example.inventory";
    const BETA: &str = "dev.community.jobs";

    fn declaration(method: &str, connection: &str, access: &str) -> PluginRpcToolDeclaration {
        serde_json::from_value(json!({
            "method": method, "description": "A community automation operation.",
            "input_schema": { "type": "object", "properties": {}, "additionalProperties": false },
            "access": access, "connection": connection,
        }))
        .unwrap()
    }

    fn registry(tool: PluginRpcToolDeclaration) -> BTreeMap<String, PluginRpcToolDeclaration> {
        BTreeMap::from([("inspect".to_string(), tool)])
    }

    fn descriptor(plugin_id: &str, version: &str, tools: &BTreeMap<String, PluginRpcToolDeclaration>) -> Value {
        json!({ "schema_version": 1, "plugin_id": plugin_id, "plugin_version": version, "rpc_tools": tools })
    }

    fn lifecycle() -> Value {
        json!({
            "connection": { "id": "managed", "read_only": false, "password": "host-secret" },
            "runtime": { "host": "transport-endpoint", "port": 7777 },
        })
    }

    #[derive(Clone, Debug)]
    struct RecordedCall {
        method: String,
        args: Value,
        timeout: Option<Duration>,
    }

    struct FakeSession {
        calls: Mutex<Vec<RecordedCall>>,
        sender: Mutex<Option<broadcast::Sender<PluginEvent>>>,
        early: Mutex<Vec<PluginEvent>>,
        open: Result<Value, String>,
        stop: Result<Value, String>,
        reply: Option<Value>,
        close_events: bool,
        start_delay: Duration,
    }

    impl FakeSession {
        fn new(capacity: usize) -> Self {
            let (sender, _) = broadcast::channel(capacity);
            Self {
                calls: Mutex::new(Vec::new()),
                sender: Mutex::new(Some(sender)),
                early: Mutex::new(Vec::new()),
                open: Ok(json!({ "handle": 7 })),
                stop: Ok(Value::Null),
                reply: None,
                close_events: false,
                start_delay: Duration::ZERO,
            }
        }
        fn calls(&self) -> Vec<RecordedCall> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl RpcSession for FakeSession {
        fn call<'a>(
            &'a self,
            method: &'a str,
            args: Value,
            timeout: Option<Duration>,
        ) -> BoxFuture<'a, Result<Value, String>> {
            Box::pin(async move {
                self.calls.lock().unwrap().push(RecordedCall {
                    method: method.to_string(),
                    args: args.clone(),
                    timeout,
                });
                if method == "jobs/watch" {
                    if !self.start_delay.is_zero() {
                        tokio::time::sleep(self.start_delay).await;
                    }
                    let mut sender = self.sender.lock().unwrap();
                    for event in self.early.lock().unwrap().drain(..) {
                        if let Some(sender) = sender.as_ref() {
                            let _ = sender.send(event);
                        }
                    }
                    if self.close_events {
                        sender.take();
                    }
                    return self.open.clone();
                }
                if method == "jobs/stop" {
                    return self.stop.clone();
                }
                Ok(self.reply.clone().unwrap_or_else(|| json!({ "method": method, "arguments": args })))
            })
        }
        fn events(&self) -> broadcast::Receiver<PluginEvent> {
            self.sender.lock().unwrap().as_ref().unwrap().subscribe()
        }
    }

    async fn run(
        session: &FakeSession,
        plugin_id: &str,
        tools: &BTreeMap<String, PluginRpcToolDeclaration>,
        arguments: Value,
        host_lifecycle: Option<Value>,
        timeout: Option<Duration>,
    ) -> Result<Value, String> {
        validate_tools(tools)?;
        let mut params = json!({ "tool": "inspect", "arguments": arguments });
        if let Some(lifecycle) = host_lifecycle {
            params["lifecycle"] = lifecycle;
        }
        invoke_operations(session, plugin_id, tools, "mcp/call", &params, timeout).await
    }

    fn snapshot_registry(mode: &str) -> BTreeMap<String, PluginRpcToolDeclaration> {
        let mut tool = declaration("jobs/watch", mode, "read");
        tool.snapshot = Some(
            serde_json::from_value(json!({
                "event_method": "jobs/changed", "stop_method": "jobs/stop", "closed_event_method": "jobs/closed",
                "event_connection_field": "scope", "event_feed_field": "ticket",
                "feed_id_field": "handle", "stop_feed_field": "token",
                "duration_param": "window", "max_messages_param": "count",
                "default_duration_ms": 100, "max_duration_ms": 500,
                "default_max_messages": 1, "max_messages": 3,
            }))
            .unwrap(),
        );
        registry(tool)
    }

    fn change(plugin_id: &str, method: &str, params: Value) -> PluginEvent {
        PluginEvent { plugin_id: plugin_id.to_string(), method: method.to_string(), params }
    }

    #[test]
    fn declaration_contract_requires_explicit_access_and_defaults_to_id_binding() {
        let mut value = json!({
            "method": "inventory/list", "description": "List inventory.",
            "input_schema": { "type": "object" }, "access": "read",
        });
        let tool: PluginRpcToolDeclaration = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(tool.connection, PluginRpcConnection::Id);
        value.as_object_mut().unwrap().remove("access");
        assert!(serde_json::from_value::<PluginRpcToolDeclaration>(value.clone()).is_err());
        value["access"] = json!("guess");
        assert!(serde_json::from_value::<PluginRpcToolDeclaration>(value.clone()).is_err());
        value["access"] = json!("read");
        value["unknown"] = json!(true);
        assert!(serde_json::from_value::<PluginRpcToolDeclaration>(value).is_err());
    }

    #[tokio::test]
    async fn declared_rpc_does_not_convert_a_structured_failure_into_success() {
        let mut session = FakeSession::new(8);
        let failure = json!({"content":[{"type":"text","text":"operation rejected"}],"isError":true,"structuredContent":{"reason":"conflict"}});
        session.reply = Some(failure.clone());
        let tools = registry(declaration("inventory/read", "none", "read"));
        let result =
            invoke_operations(&session, ALPHA, &tools, "mcp/call", &json!({"tool":"inspect","arguments":{}}), None)
                .await
                .unwrap();
        assert_eq!(result, failure);
        assert_eq!(session.calls().len(), 1);
    }

    #[tokio::test]
    async fn unrelated_plugins_use_the_same_dispatch_and_none_needs_no_lifecycle() {
        for (plugin_id, method, mode) in [(ALPHA, "inventory/list", "none"), (BETA, "jobs/status", "id")] {
            let tools = registry(declaration(method, mode, "read"));
            let session = FakeSession::new(8);
            let input = json!({
                "connectionId": "attacker", "lifecycle": { "connection": { "id": "attacker" } },
                "config": {}, "runtime": {}, "password": "attacker-secret",
            });
            let result =
                run(&session, plugin_id, &tools, input, (mode != "none").then(lifecycle), Some(Duration::from_secs(3)))
                    .await
                    .unwrap();
            assert_eq!(result["structuredContent"]["method"], method);
            let calls = session.calls();
            assert_eq!(calls.len(), 1);
            assert_eq!(calls[0].timeout, Some(Duration::from_secs(3)));
            assert_eq!(calls[0].args, if mode == "none" { json!({}) } else { json!({ "connectionId": "managed" }) });
        }
        assert!(resolve_tools("unregistered.plugin", "1.0.0", &BTreeMap::new(), &BTreeMap::new(), None)
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn connection_modes_inject_only_host_values_and_reject_missing_binding() {
        for mode in ["id", "lifecycle", "both"] {
            let tools = registry(declaration("jobs/status", mode, "read"));
            let session = FakeSession::new(8);
            assert!(run(&session, BETA, &tools, json!({ "connectionId": "injected" }), None, None).await.is_err());
            run(&session, BETA, &tools, json!({ "lifecycle": {} }), Some(lifecycle()), None).await.unwrap();
            let args = &session.calls()[0].args;
            assert_eq!(args.get("connectionId").is_some(), matches!(mode, "id" | "both"));
            assert_eq!(args.get("lifecycle").is_some(), matches!(mode, "lifecycle" | "both"));
            if mode != "id" {
                assert_eq!(args["lifecycle"], lifecycle());
            }
            if mode != "lifecycle" {
                assert_eq!(args["connectionId"], "managed");
            }
        }
    }

    #[tokio::test]
    async fn discovery_connection_markers_and_access_annotations_are_explicit() {
        for mode in ["none", "id", "lifecycle", "both"] {
            for access in ["read", "write", "full"] {
                let tool = declaration("inventory/list", mode, access);
                let definition = definition("inspect", &tool);
                assert_eq!(definition["inputSchema"]["x-dbx-connection"], mode);
                assert_eq!(definition["inputSchema"]["properties"].get("connectionId").is_some(), mode != "none");
                assert_eq!(definition["annotations"]["readOnlyHint"], access == "read");
                assert_eq!(definition["annotations"]["destructiveHint"], access == "full");
                if access != "read" && mode != "none" {
                    let mut host = lifecycle();
                    host["connection"]["read_only"] = json!(true);
                    assert!(run(&FakeSession::new(8), ALPHA, &registry(tool), json!({}), Some(host), None)
                        .await
                        .unwrap_err()
                        .contains("read-only"));
                }
            }
        }
    }

    #[test]
    fn top_level_automation_precedes_local_and_legacy_is_an_exclusive_alternate() {
        let tools = registry(declaration("inventory/list", "none", "read"));
        let empty = BTreeMap::new();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("broken.json");
        std::fs::write(&path, b"not json").unwrap();
        assert_eq!(resolve_tools(ALPHA, "1.2.0", &tools, &empty, Some(&path)).unwrap().unwrap(), tools);
        assert_eq!(resolve_tools(ALPHA, "1.2.0", &empty, &tools, Some(&path)).unwrap().unwrap(), tools);
        assert!(resolve_tools(ALPHA, "1.2.0", &tools, &tools, None).unwrap_err().contains("not both"));
        let invalid = registry(declaration("host/eval", "none", "read"));
        assert!(resolve_tools("com.astergaze.nats", "0.1.0", &invalid, &empty, None).is_err());
    }

    #[test]
    fn local_descriptors_are_bound_to_exact_identity_and_semver_range() {
        let empty = BTreeMap::new();
        let dir = tempfile::tempdir().unwrap();
        for (plugin_id, method) in [(ALPHA, "inventory/list"), (BETA, "jobs/status")] {
            let tools = registry(declaration(method, "none", "read"));
            let path = dir.path().join(format!("{plugin_id}.json"));
            std::fs::write(&path, descriptor(plugin_id, ">=1.2.0, <2.0.0", &tools).to_string()).unwrap();
            assert_eq!(resolve_tools(plugin_id, "1.8.0", &empty, &empty, Some(&path)).unwrap().unwrap(), tools);
            assert!(resolve_tools(plugin_id, "2.0.0", &empty, &empty, Some(&path))
                .unwrap_err()
                .contains("plugin_version"));
            assert!(resolve_tools("different.plugin", "1.8.0", &empty, &empty, Some(&path))
                .unwrap_err()
                .contains("plugin_id"));
        }
        assert!(resolve_tools("com.astergaze.nats", "0.2.0", &empty, &empty, None).unwrap().is_none());
        let path = dir.path().join("explicit-empty.json");
        std::fs::write(&path, descriptor("com.astergaze.nats", "=0.1.0", &empty).to_string()).unwrap();
        assert!(resolve_tools("com.astergaze.nats", "0.1.0", &empty, &empty, Some(&path)).unwrap().unwrap().is_empty());
    }

    #[test]
    fn descriptor_accepts_utf8_bom_without_relaxing_validation() {
        let tools = registry(declaration("inventory/list", "none", "read"));
        let mut bytes = vec![0xef, 0xbb, 0xbf];
        bytes.extend_from_slice(descriptor(ALPHA, "^1.0", &tools).to_string().as_bytes());
        assert_eq!(parse_descriptor(&bytes).unwrap().rpc_tools, tools);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("profile.json");
        std::fs::write(&path, &bytes).unwrap();
        assert!(resolve_tools(ALPHA, "1.3.0", &BTreeMap::new(), &BTreeMap::new(), Some(&path)).unwrap().is_some());
        bytes.extend_from_slice(b" trailing garbage");
        assert!(parse_descriptor(&bytes).is_err());
    }

    #[test]
    fn descriptor_and_registry_limits_fail_instead_of_falling_through() {
        let tools = registry(declaration("inventory/list", "none", "read"));
        for patch in [
            json!({ "schema_version": 2 }),
            json!({ "plugin_version": "invalid" }),
            json!({ "unexpected": true }),
            json!({ "rpc_tools": { "bad": { "method": "inventory/list" } } }),
        ] {
            let mut value = descriptor(ALPHA, "^1.0", &tools);
            for (key, value_patch) in patch.as_object().unwrap() {
                value[key] = value_patch.clone();
            }
            assert!(parse_descriptor(value.to_string().as_bytes()).is_err());
        }
        assert!(parse_descriptor(&vec![b' '; MAX_DESCRIPTOR_BYTES + 1]).unwrap_err().contains("exceeds"));
        let mut too_many = BTreeMap::new();
        for index in 0..=MAX_OPERATIONS {
            too_many.insert(format!("operation_{index}"), tools["inspect"].clone());
        }
        assert!(validate_tools(&too_many).unwrap_err().contains("4096"));
        let mut large = tools["inspect"].clone();
        large.description = "x".repeat(16_000);
        let oversized = (0..150).map(|index| (format!("operation_{index}"), large.clone())).collect();
        assert!(validate_tools(&oversized).unwrap_err().contains("bytes"));
    }

    #[tokio::test]
    async fn cli_registry_returns_more_than_surface_caps_without_truncation() {
        let tools = (0..513)
            .map(|index| (format!("operation_{index}"), declaration("inventory/list", "none", "read")))
            .collect();
        validate_tools(&tools).unwrap();
        let listing =
            invoke_operations(&FakeSession::new(8), ALPHA, &tools, "mcp/tools", &json!({}), None).await.unwrap();
        assert_eq!(listing["tools"].as_array().unwrap().len(), 513);
    }

    #[test]
    fn reserved_namespaces_and_invalid_snapshot_contracts_are_rejected() {
        for namespace in ["plugin", "connection", "mcp", "host", "driver", "automation", "AuToMaTiOn"] {
            for separator in ["/", ":", "."] {
                let tool = declaration(&format!("{namespace}{separator}call"), "none", "read");
                assert!(validate_tools(&registry(tool)).unwrap_err().contains("reserved"));
            }
        }
        let mut tool = snapshot_registry("id").remove("inspect").unwrap();
        tool.snapshot.as_mut().unwrap().stop_method = "automation/call".to_string();
        assert!(validate_tools(&registry(tool)).is_err());
        let mut tool = snapshot_registry("id").remove("inspect").unwrap();
        tool.snapshot.as_mut().unwrap().max_messages = MAX_CAPTURE_EVENTS + 1;
        assert!(validate_tools(&registry(tool)).is_err());
        let mut tool = snapshot_registry("id").remove("inspect").unwrap();
        tool.snapshot.as_mut().unwrap().stop_feed_field = "connectionId".to_string();
        assert!(validate_tools(&registry(tool)).is_err());
    }

    #[tokio::test]
    async fn generic_schema_enforces_defaults_types_bounds_and_decoded_bytes() {
        let mut tool = declaration("inventory/update", "none", "write");
        tool.input_schema = json!({
            "type": "object", "additionalProperties": false, "required": ["items", "data"],
            "properties": {
                "items": { "type": "array", "minItems": 1, "maxItems": 2, "uniqueItems": true, "items": { "type": "integer", "minimum": 1, "maximum": 10 } },
                "label": { "type": ["string", "null"], "maxLength": 4, "default": "demo" },
                "data": { "type": "string", "contentEncoding": "base64", "x-dbx-maxDecodedBytes": 2 },
            },
        });
        let tools = registry(tool);
        let session = FakeSession::new(8);
        for input in [
            json!({}),
            json!({ "items": [], "data": "" }),
            json!({ "items": [1,1], "data": "" }),
            json!({ "items": [11], "data": "" }),
            json!({ "items": [1], "data": "AQID" }),
            json!({ "items": [1], "data": "not base64" }),
            json!({ "items": [1], "data": "", "label": "too-long" }),
        ] {
            assert!(run(&session, ALPHA, &tools, input, None, None).await.is_err());
        }
        assert!(session.calls().is_empty());
        run(&session, ALPHA, &tools, json!({ "items": [1,2], "data": "AP8=" }), None, None).await.unwrap();
        assert_eq!(session.calls()[0].args["label"], "demo");
        let mut invalid = tools["inspect"].clone();
        invalid.input_schema["properties"]["label"]["default"] = json!("too-long");
        assert!(validate_tools(&registry(invalid)).is_err());
        let mut unsupported = tools["inspect"].clone();
        unsupported.input_schema["properties"]["label"]["pattern"] = json!(".*");
        assert!(validate_tools(&registry(unsupported)).unwrap_err().contains("Unsupported"));
    }

    #[tokio::test]
    async fn generic_snapshot_filters_identity_binding_handle_and_methods_then_stops() {
        let tools = snapshot_registry("both");
        let session = FakeSession::new(16);
        *session.early.lock().unwrap() = vec![
            change(ALPHA, "jobs/changed", json!({ "scope": "managed", "ticket": 7, "value": "wrong-plugin" })),
            change(BETA, "jobs/changed", json!({ "scope": "other", "ticket": 7, "value": "wrong-connection" })),
            change(BETA, "jobs/changed", json!({ "scope": "managed", "ticket": 8, "value": "wrong-feed" })),
            change(BETA, "jobs/other", json!({ "scope": "managed", "ticket": 7, "value": "wrong-method" })),
            change(BETA, "jobs/changed", json!({ "scope": "managed", "ticket": 7, "value": "accepted", "dropped": 2 })),
        ];
        let result = run(&session, BETA, &tools, json!({}), Some(lifecycle()), None).await.unwrap();
        assert_eq!(result["structuredContent"]["events"][0]["params"]["value"], "accepted");
        assert_eq!(result["structuredContent"]["eventCount"], 1);
        assert_eq!(result["structuredContent"]["stopped"], true);
        let calls = session.calls();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].args, json!({ "connectionId": "managed", "lifecycle": lifecycle() }));
        assert_eq!(calls[1].method, "jobs/stop");
        assert_eq!(calls[1].args, json!({ "token": 7, "connectionId": "managed", "lifecycle": lifecycle() }));
        assert_eq!(calls[1].timeout, Some(FEED_STOP_TIMEOUT));
    }

    #[tokio::test(start_paused = true)]
    async fn generic_snapshot_duration_and_caller_timeout_always_clean_up() {
        let tools = snapshot_registry("lifecycle");
        let session = FakeSession::new(8);
        let result = run(&session, BETA, &tools, json!({ "window": 25 }), Some(lifecycle()), None).await.unwrap();
        assert_eq!(result["structuredContent"]["stopReason"], "duration");
        assert_eq!(session.calls()[1].args, json!({ "token": 7, "lifecycle": lifecycle() }));
        let mut session = FakeSession::new(8);
        session.start_delay = Duration::from_millis(8);
        let error = run(&session, BETA, &tools, json!({}), Some(lifecycle()), Some(Duration::from_millis(10)))
            .await
            .unwrap_err();
        assert!(error.contains("timeout"));
        assert_eq!(session.calls().len(), 2);
        assert_eq!(session.calls()[1].timeout, Some(FEED_STOP_TIMEOUT));
    }

    #[tokio::test]
    async fn connectionless_snapshot_accepts_no_lifecycle_and_closed_event() {
        let tools = snapshot_registry("none");
        let session = FakeSession::new(8);
        *session.early.lock().unwrap() = vec![
            change(ALPHA, "jobs/closed", json!({ "ticket": 7 })),
            change(BETA, "jobs/closed", json!({ "ticket": 7, "reason": "completed" })),
        ];
        let result = run(&session, BETA, &tools, json!({}), None, None).await.unwrap();
        assert_eq!(result["structuredContent"]["stopReason"], "feedClosed");
        assert_eq!(session.calls()[0].args, json!({}));
        assert_eq!(session.calls()[1].args, json!({ "token": 7 }));
    }

    #[tokio::test]
    async fn snapshot_lag_channel_and_cleanup_errors_are_not_silently_ignored() {
        for closed in [false, true] {
            let mut session = FakeSession::new(1);
            session.close_events = closed;
            if !closed {
                *session.early.lock().unwrap() = vec![
                    change(BETA, "jobs/changed", json!({ "scope": "managed", "ticket": 7 })),
                    change(BETA, "jobs/changed", json!({ "scope": "managed", "ticket": 7 })),
                ];
            }
            session.stop = Err("cleanup transport failed".to_string());
            let error =
                run(&session, BETA, &snapshot_registry("id"), json!({}), Some(lifecycle()), None).await.unwrap_err();
            assert!(error.contains(if closed { "channel closed" } else { "buffer lost" }));
            assert!(error.contains("cleanup transport failed"));
            assert_eq!(session.calls().len(), 2);
        }
    }

    #[cfg(test)]
    mod nats_profile {
        use std::sync::Mutex;

        use super::*;

        const NATS_PLUGIN_ID: &str = "com.astergaze.nats";
        const MAX_OBJECT_BYTES: usize = 4 * 1024 * 1024;
        const MAX_SNAPSHOT_MESSAGES: u64 = MAX_CAPTURE_EVENTS;
        const MAX_DURATION_SECS: i64 = i64::MAX / 1_000_000_000;

        fn profile_tools() -> BTreeMap<String, PluginRpcToolDeclaration> {
            resolve_tools(NATS_PLUGIN_ID, "0.1.0", &BTreeMap::new(), &BTreeMap::new(), None).unwrap().unwrap()
        }

        async fn invoke_adapter(
            mock: &impl RpcSession,
            plugin_id: &str,
            method: &str,
            params: &Value,
            timeout: Option<Duration>,
        ) -> Result<Option<Value>, String> {
            if !matches!(method, "mcp/tools" | "mcp/call") {
                return Ok(None);
            }
            let Some(tools) = resolve_tools(plugin_id, "0.1.0", &BTreeMap::new(), &BTreeMap::new(), None)? else {
                return Ok(None);
            };
            invoke_operations(mock, plugin_id, &tools, method, params, timeout).await.map(Some)
        }

        // Kept independent of the generated catalog: additions or accidental RPC
        // renames must update an explicit review of their read/write semantics.
        const OPERATIONS: &[(&str, &str, bool, bool)] = &[
            ("nats_overview", "nats/overview", true, false),
            ("nats_services_list", "nats/services", true, false),
            ("nats_streams_list", "nats/streams", true, false),
            ("nats_stream_get", "nats/stream", true, false),
            ("nats_stream_save", "nats/streamSave", false, true),
            ("nats_stream_purge", "nats/streamPurge", false, true),
            ("nats_stream_delete", "nats/streamDelete", false, true),
            ("nats_stream_messages", "nats/streamMessages", true, false),
            ("nats_message_delete", "nats/messageDelete", false, true),
            ("nats_consumers_list", "nats/consumers", true, false),
            ("nats_consumer_delete", "nats/consumerDelete", false, true),
            ("nats_kv_buckets_list", "nats/kvBuckets", true, false),
            ("nats_kv_bucket_create", "nats/kvBucketCreate", false, false),
            ("nats_kv_bucket_delete", "nats/kvBucketDelete", false, true),
            ("nats_kv_keys_list", "nats/kvKeys", true, false),
            ("nats_kv_get", "nats/kvGet", true, false),
            ("nats_kv_history", "nats/kvHistory", true, false),
            ("nats_kv_put", "nats/kvPut", false, true),
            ("nats_kv_delete", "nats/kvDelete", false, true),
            ("nats_kv_watch", "nats/kvWatch", true, false),
            ("nats_object_stores_list", "nats/objectStores", true, false),
            ("nats_object_store_create", "nats/objectStoreCreate", false, false),
            ("nats_object_store_delete", "nats/objectStoreDelete", false, true),
            ("nats_objects_list", "nats/objects", true, false),
            ("nats_object_get", "nats/objectGet", true, false),
            ("nats_object_put", "nats/objectPut", false, true),
            ("nats_object_delete", "nats/objectDelete", false, true),
            ("nats_publish", "nats/publish", false, true),
            ("nats_request", "nats/request", false, true),
            ("nats_subscribe", "nats/subscribe", false, true),
            ("nats_feed_stop", "nats/feedStop", false, true),
        ];

        #[derive(Clone, Debug)]
        struct Call {
            method: String,
            args: Value,
            timeout: Option<Duration>,
        }

        struct MockRpc {
            calls: Mutex<Vec<Call>>,
            sender: Mutex<Option<broadcast::Sender<PluginEvent>>>,
            early_events: Mutex<Vec<PluginEvent>>,
            start: Result<Value, String>,
            stop: Result<Value, String>,
            start_delay: Duration,
            close_events_on_start: bool,
        }

        impl MockRpc {
            fn new(capacity: usize) -> Self {
                let (sender, _) = broadcast::channel(capacity);
                Self {
                    calls: Mutex::new(Vec::new()),
                    sender: Mutex::new(Some(sender)),
                    early_events: Mutex::new(vec![
                        event("nats/message", "bound", "owned", "message"),
                        event("nats/kvChange", "bound", "owned", "value"),
                    ]),
                    start: Ok(json!({ "feedId": "owned" })),
                    stop: Ok(json!({ "ok": true })),
                    start_delay: Duration::ZERO,
                    close_events_on_start: false,
                }
            }

            fn calls(&self) -> Vec<Call> {
                self.calls.lock().unwrap().clone()
            }
        }

        impl RpcSession for MockRpc {
            fn call<'a>(
                &'a self,
                method: &'a str,
                args: Value,
                timeout: Option<Duration>,
            ) -> BoxFuture<'a, Result<Value, String>> {
                Box::pin(async move {
                    self.calls.lock().unwrap().push(Call { method: method.to_string(), args: args.clone(), timeout });
                    if matches!(method, "nats/subscribe" | "nats/kvWatch") {
                        if !self.start_delay.is_zero() {
                            tokio::time::sleep(self.start_delay).await;
                        }
                        // Emit before returning feedId to exercise the response/
                        // notification race on the real JSON-RPC transport.
                        let mut sender = self.sender.lock().unwrap();
                        for event in self.early_events.lock().unwrap().drain(..) {
                            if let Some(sender) = sender.as_ref() {
                                let _ = sender.send(event);
                            }
                        }
                        if self.close_events_on_start {
                            sender.take();
                        }
                        return self.start.clone();
                    }
                    if method == "nats/feedStop" {
                        return self.stop.clone();
                    }
                    Ok(json!({ "rpc": method, "arguments": args }))
                })
            }

            fn events(&self) -> broadcast::Receiver<PluginEvent> {
                self.sender.lock().unwrap().as_ref().unwrap().subscribe()
            }
        }

        fn event(method: &str, connection: &str, feed: &str, data: &str) -> PluginEvent {
            PluginEvent {
                plugin_id: NATS_PLUGIN_ID.to_string(),
                method: method.to_string(),
                params: json!({ "connectionId": connection, "feedId": feed, "data": data }),
            }
        }

        fn bound(tool: &str, arguments: Value, read_only: bool) -> Value {
            json!({
                "tool": tool,
                "arguments": arguments,
                "connectionId": "not-the-binding",
                "lifecycle": {
                    "connection": { "id": "bound", "read_only": read_only, "password": "host-secret" },
                    "runtime": { "host": "host-tunnel", "port": 1234 },
                },
            })
        }

        fn arguments(rpc: &str) -> Value {
            match rpc {
                "nats/stream" | "nats/streamPurge" | "nats/streamDelete" | "nats/streamMessages" | "nats/consumers" => {
                    json!({ "stream": "ORDERS" })
                }
                "nats/streamSave" => json!({ "streamSpec": { "name": "ORDERS", "subjects": ["orders.>"] } }),
                "nats/messageDelete" => json!({ "stream": "ORDERS", "seq": 42 }),
                "nats/consumerDelete" => json!({ "stream": "ORDERS", "consumer": "worker" }),
                "nats/kvBucketCreate" => json!({ "bucketSpec": { "bucket": "config" } }),
                "nats/kvBucketDelete" | "nats/kvKeys" => json!({ "bucket": "config" }),
                "nats/kvGet" | "nats/kvHistory" | "nats/kvDelete" => json!({ "bucket": "config", "key": "feature" }),
                "nats/kvPut" => json!({ "bucket": "config", "key": "feature", "data": "" }),
                "nats/kvWatch" => json!({ "bucket": "config", "durationMs": 1000, "maxMessages": 1 }),
                "nats/objectStoreCreate" | "nats/objectStoreDelete" | "nats/objects" => json!({ "store": "assets" }),
                "nats/objectGet" | "nats/objectDelete" => json!({ "store": "assets", "name": "logo.png" }),
                "nats/objectPut" => json!({ "store": "assets", "name": "logo.png", "dataBase64": "AP8=" }),
                "nats/publish" | "nats/request" => json!({ "subject": "orders.created", "data": "" }),
                "nats/subscribe" => json!({ "subject": "orders.>", "maxMessages": 1, "durationMs": 1000 }),
                "nats/feedStop" => json!({ "feedId": "from-workbench" }),
                _ => json!({}),
            }
        }

        async fn call(mock: &MockRpc, params: &Value, timeout: Option<Duration>) -> Result<Value, String> {
            invoke_adapter(mock, NATS_PLUGIN_ID, "mcp/call", params, timeout).await.map(Option::unwrap)
        }

        fn assert_stopped(mock: &MockRpc) {
            let calls = mock.calls();
            assert_eq!(calls.len(), 2, "a snapshot must start and then stop exactly its own feed: {calls:?}");
            assert_eq!(calls[1].method, "nats/feedStop");
            assert_eq!(calls[1].args, json!({ "connectionId": "bound", "feedId": "owned" }));
            assert_eq!(calls[1].timeout, Some(FEED_STOP_TIMEOUT));
        }

        #[tokio::test]
        async fn only_exact_plugin_and_bridge_methods_are_adapted() {
            let mock = MockRpc::new(8);
            for plugin in ["other", "com.astergaze.nats.extra", "com.astergaze.NATS", "nats"] {
                assert!(invoke_adapter(&mock, plugin, "mcp/tools", &json!({}), None).await.unwrap().is_none());
                assert!(invoke_adapter(&mock, plugin, "mcp/call", &json!({}), None).await.unwrap().is_none());
            }
            for method in ["mcp/unknown", "nats/overview", "mcp/tools/list"] {
                assert!(invoke_adapter(&mock, NATS_PLUGIN_ID, method, &json!({}), None).await.unwrap().is_none());
            }
            let unknown = call(&mock, &bound("nats/overview", json!({}), false), None).await.unwrap_err();
            assert!(unknown.contains("Unknown automation operation"));
            assert!(mock.calls().is_empty());
        }

        #[tokio::test]
        async fn discovery_lists_all_rpc_operations_with_reviewed_annotations() {
            let mock = MockRpc::new(8);
            let listing = invoke_adapter(&mock, NATS_PLUGIN_ID, "mcp/tools", &json!({}), None).await.unwrap().unwrap();
            let tools = listing["tools"].as_array().unwrap();
            assert_eq!(tools.len(), OPERATIONS.len());
            let catalog = profile_tools();
            for (name, rpc, read_only, destructive) in OPERATIONS {
                let definition = tools.iter().find(|tool| tool["name"] == *name).unwrap();
                assert_eq!(catalog.values().filter(|tool| tool.method == *rpc).count(), 1, "{rpc}");
                assert_eq!(definition["annotations"]["readOnlyHint"], *read_only, "{name}");
                assert_eq!(definition["annotations"]["destructiveHint"], *destructive, "{name}");
                assert_eq!(definition["annotations"]["openWorldHint"], true);
                assert_eq!(definition["inputSchema"]["additionalProperties"], false);
                for reserved in ["lifecycle", "config", "password", "runtime"] {
                    assert!(definition["inputSchema"]["properties"].get(reserved).is_none());
                }
            }
            assert!(mock.calls().is_empty(), "discovery must not activate a connection or call native RPC");
        }

        #[tokio::test]
        async fn every_catalog_tool_dispatches_its_allowlisted_rpc_and_reuses_binding() {
            for (name, rpc, _, _) in OPERATIONS {
                let mock = MockRpc::new(8);
                let mut input = arguments(rpc);
                input["connectionId"] = json!("injected-connection");
                input["lifecycle"] = json!({ "connection": { "id": "injected-lifecycle" } });
                input["config"] = json!({ "password": "injected-secret" });
                input["runtime"] = json!({ "host": "injected-host" });
                input["provider"] = json!({ "id": "injected-provider" });
                input["read_only"] = json!(false);
                let result = call(&mock, &bound(name, input, false), Some(Duration::from_secs(10))).await.unwrap();
                let calls = mock.calls();
                assert_eq!(calls[0].method, *rpc, "{name}");
                assert_eq!(calls[0].timeout, Some(Duration::from_secs(10)), "{name}");
                assert_eq!(calls[0].args["connectionId"], "bound", "{name}");
                for reserved in ["lifecycle", "config", "runtime", "provider", "read_only"] {
                    assert!(calls[0].args.get(reserved).is_none(), "{name}: {reserved}");
                }
                assert_eq!(result["isError"], false);
                assert_eq!(
                    serde_json::from_str::<Value>(result["content"][0]["text"].as_str().unwrap()).unwrap(),
                    result["structuredContent"]
                );
                if matches!(*rpc, "nats/subscribe" | "nats/kvWatch") {
                    assert_stopped(&mock);
                    assert!(calls[0].args.get("durationMs").is_none());
                    assert!(calls[0].args.get("maxMessages").is_none());
                    assert_eq!(result["structuredContent"]["stopped"], true);
                } else {
                    assert_eq!(calls.len(), 1, "{name}: no reconnect or unsolicited RPC");
                }
            }
        }

        #[tokio::test]
        async fn binding_must_come_from_host_lifecycle_and_all_writes_respect_read_only() {
            let mock = MockRpc::new(8);
            for params in [
                json!({ "tool": "nats_overview", "arguments": { "connectionId": "injected" } }),
                json!({ "tool": "nats_overview", "arguments": { "lifecycle": { "connection": { "id": "injected" } } } }),
                json!({ "tool": "nats_overview", "lifecycle": { "connection": { "id": "   " } } }),
                json!({ "tool": "nats_overview", "lifecycle": { "connection": { "id": 123 } } }),
            ] {
                assert!(call(&mock, &params, None).await.unwrap_err().contains("lifecycle"));
            }
            for (name, rpc, read_only, _) in OPERATIONS {
                if !read_only {
                    let mut input = arguments(rpc);
                    input["read_only"] = json!(false);
                    assert!(
                        call(&mock, &bound(name, input, true), None).await.unwrap_err().contains("read-only"),
                        "{name}"
                    );
                }
            }
            assert!(mock.calls().is_empty());
            assert!(call(&mock, &bound("nats_overview", json!({}), true), None).await.is_ok());
            let mock = MockRpc::new(8);
            assert!(call(&mock, &bound("nats_kv_watch", arguments("nats/kvWatch"), true), None).await.is_ok());
            assert_stopped(&mock);
        }

        #[tokio::test]
        async fn validates_required_fields_native_integer_widths_and_hard_limits() {
            let mock = MockRpc::new(8);
            for (tool, input) in [
                ("nats_stream_get", json!({})),
                ("nats_stream_save", json!({ "streamSpec": {} })),
                ("nats_stream_save", json!({ "streamSpec": { "name": "S", "maxMsgSize": 2147483648_u64 } })),
                ("nats_stream_save", json!({ "streamSpec": { "name": "S", "retention": "typo" } })),
                ("nats_stream_save", json!({ "streamSpec": { "name": "S", "maxAgeSecs": MAX_DURATION_SECS + 1 } })),
                ("nats_stream_save", json!({ "streamSpec": { "name": "S", "lifecycle": {} } })),
                ("nats_stream_messages", json!({ "stream": "S", "limit": 201 })),
                ("nats_stream_messages", json!({ "stream": "S", "limit": 0 })),
                ("nats_stream_messages", json!({ "stream": "S", "before": -1 })),
                ("nats_message_delete", json!({ "stream": "S", "seq": 0 })),
                ("nats_kv_bucket_create", json!({ "bucketSpec": { "name": "wrong-field" } })),
                ("nats_kv_bucket_create", json!({ "bucketSpec": { "bucket": "B", "history": 256 } })),
                ("nats_publish", json!({ "subject": "S", "data": "", "headers": { "X-N": 1 } })),
                ("nats_publish", json!({ "subject": "S" })),
                ("nats_request", json!({ "subject": "S", "data": "", "timeoutMs": 60_001 })),
                ("nats_subscribe", json!({ "subject": "S", "durationMs": 0 })),
                ("nats_subscribe", json!({ "subject": "S", "durationMs": MAX_DURATION_MS + 1 })),
                ("nats_subscribe", json!({ "subject": "S", "maxMessages": MAX_SNAPSHOT_MESSAGES + 1 })),
                ("nats_kv_watch", json!({ "bucket": "B", "maxMessages": 0 })),
                ("nats_feed_stop", json!({ "feedId": "" })),
                ("nats_object_put", json!({ "store": "S", "name": "N", "dataBase64": "invalid%%%" })),
                ("nats_object_put", json!({ "store": "S", "name": "N", "dataBase64": [0, 1] })),
            ] {
                assert!(call(&mock, &bound(tool, input, false), None).await.is_err(), "{tool}");
            }
            assert!(mock.calls().is_empty(), "invalid arguments must fail before any side effect");
            let result = call(
                &mock,
                &bound("nats_stream_messages", json!({ "stream": "S", "before": u64::MAX, "limit": 200 }), false),
                None,
            )
            .await
            .unwrap();
            assert_eq!(result["structuredContent"]["arguments"]["before"], u64::MAX);
        }

        #[tokio::test]
        async fn forwards_complete_specs_and_base64_using_exact_go_field_names() {
            let mock = MockRpc::new(8);
            let spec = json!({
                "name": "ORDERS", "description": "orders", "subjects": ["orders.>"], "storage": "memory",
                "retention": "workqueue", "discard": "new", "replicas": 3, "maxMsgs": 1000,
                "maxBytes": 8192, "maxAgeSecs": 60, "maxMsgSize": 4096, "duplicatesSecs": 30,
            });
            call(&mock, &bound("nats_stream_save", json!({ "streamSpec": spec, "update": true }), false), None)
                .await
                .unwrap();
            assert_eq!(mock.calls()[0].args, json!({ "streamSpec": spec, "update": true, "connectionId": "bound" }));
            let spec = json!({ "bucket": "config", "description": "configuration", "history": 8, "ttlSecs": 30, "maxBytes": 1024, "storage": "memory", "replicas": 3 });
            call(&mock, &bound("nats_kv_bucket_create", json!({ "bucketSpec": spec }), false), None).await.unwrap();
            assert_eq!(mock.calls()[1].args, json!({ "bucketSpec": spec, "connectionId": "bound" }));
            call(&mock, &bound("nats_object_put", arguments("nats/objectPut"), false), None).await.unwrap();
            assert_eq!(mock.calls()[2].args["dataBase64"], "AP8=");
            let over_limit = base64::engine::general_purpose::STANDARD.encode(vec![0; MAX_OBJECT_BYTES + 1]);
            assert!(call(
                &mock,
                &bound("nats_object_put", json!({ "store": "S", "name": "N", "dataBase64": over_limit }), false),
                None
            )
            .await
            .unwrap_err()
            .contains("exceeds"));
            assert_eq!(mock.calls().len(), 3);
        }

        #[tokio::test]
        async fn snapshot_buffers_early_events_and_filters_plugin_connection_feed_and_method() {
            let mock = MockRpc::new(16);
            let mut wrong_plugin = event("nats/message", "bound", "owned", "wrong-plugin");
            wrong_plugin.plugin_id = "other.nats".to_string();
            let mut first = event("nats/message", "bound", "owned", "first");
            first.params["dropped"] = json!(3);
            *mock.early_events.lock().unwrap() = vec![
                wrong_plugin,
                event("nats/message", "other-connection", "owned", "wrong-connection"),
                event("nats/message", "bound", "other-feed", "wrong-feed"),
                event("nats/kvChange", "bound", "owned", "wrong-method"),
                event("nats/feedClosed", "bound", "other-feed", "wrong-close"),
                first,
                event("nats/message", "bound", "owned", "second"),
                event("nats/message", "bound", "owned", "over-limit"),
            ];
            let result = call(
                &mock,
                &bound("nats_subscribe", json!({ "subject": ">", "queue": "workers", "maxMessages": 2 }), false),
                None,
            )
            .await
            .unwrap();
            let snapshot = &result["structuredContent"];
            assert_eq!(snapshot["eventCount"], 2);
            assert_eq!(snapshot["events"][0]["pluginId"], NATS_PLUGIN_ID);
            assert_eq!(snapshot["events"][0]["params"]["data"], "first");
            assert_eq!(snapshot["events"][1]["params"]["data"], "second");
            assert_eq!(snapshot["dropped"], 3);
            assert_eq!(snapshot["stopReason"], "maxMessages");
            assert_eq!(mock.calls()[0].args["queue"], "workers");
            assert_stopped(&mock);
        }

        #[tokio::test(start_paused = true)]
        async fn snapshot_duration_returns_finite_empty_result_and_stops_feed() {
            let mock = MockRpc::new(8);
            mock.early_events.lock().unwrap().clear();
            let result =
                call(&mock, &bound("nats_subscribe", json!({ "subject": "idle", "durationMs": 25 }), false), None)
                    .await
                    .unwrap();
            assert_eq!(result["structuredContent"]["events"], json!([]));
            assert_eq!(result["structuredContent"]["stopReason"], "duration");
            assert_eq!(result["structuredContent"]["stopped"], true);
            assert_stopped(&mock);
        }

        #[tokio::test(start_paused = true)]
        async fn snapshot_caller_timeout_including_setup_still_stops_feed() {
            let mut mock = MockRpc::new(8);
            mock.early_events.lock().unwrap().clear();
            mock.start_delay = Duration::from_millis(8);
            let error = call(
                &mock,
                &bound("nats_kv_watch", json!({ "bucket": "B", "durationMs": 100 }), true),
                Some(Duration::from_millis(10)),
            )
            .await
            .unwrap_err();
            assert!(error.contains("timeout"));
            assert_eq!(mock.calls()[0].timeout, Some(Duration::from_millis(10)));
            assert_stopped(&mock);
        }

        #[tokio::test]
        async fn snapshot_lag_and_channel_errors_always_attempt_cleanup() {
            let lagged = MockRpc::new(1);
            let error =
                call(&lagged, &bound("nats_subscribe", arguments("nats/subscribe"), false), None).await.unwrap_err();
            assert!(error.contains("buffer lost"));
            assert_stopped(&lagged);
            let mut closed = MockRpc::new(8);
            closed.early_events.lock().unwrap().clear();
            closed.close_events_on_start = true;
            let error =
                call(&closed, &bound("nats_kv_watch", arguments("nats/kvWatch"), true), None).await.unwrap_err();
            assert!(error.contains("channel closed"));
            assert_stopped(&closed);
        }

        #[tokio::test]
        async fn snapshot_retains_matching_feed_closed_event_and_still_cleans_up() {
            let mock = MockRpc::new(8);
            let mut closed = event("nats/feedClosed", "bound", "owned", "");
            closed.params["reason"] = json!("disconnected");
            *mock.early_events.lock().unwrap() = vec![closed];
            let result = call(&mock, &bound("nats_kv_watch", arguments("nats/kvWatch"), true), None).await.unwrap();
            assert_eq!(result["structuredContent"]["stopReason"], "feedClosed");
            assert_eq!(result["structuredContent"]["events"][0]["params"]["reason"], "disconnected");
            assert_stopped(&mock);
        }

        #[tokio::test]
        async fn snapshot_reports_cleanup_failures_and_preserves_collection_errors() {
            let mut mock = MockRpc::new(8);
            mock.stop = Err("stop transport failed".to_string());
            let error =
                call(&mock, &bound("nats_subscribe", arguments("nats/subscribe"), false), None).await.unwrap_err();
            assert!(error.contains("could not stop") && error.contains("stop transport failed"));
            assert_stopped(&mock);
            let mut mock = MockRpc::new(1);
            mock.stop = Err("stop transport failed".to_string());
            let error =
                call(&mock, &bound("nats_subscribe", arguments("nats/subscribe"), false), None).await.unwrap_err();
            assert!(error.contains("buffer lost") && error.contains("stop transport failed"));
            assert_stopped(&mock);
            let mut mock = MockRpc::new(8);
            mock.stop = Ok(json!({ "ok": false }));
            assert!(call(&mock, &bound("nats_subscribe", arguments("nats/subscribe"), false), None)
                .await
                .unwrap_err()
                .contains("unsuccessful"));
            assert_stopped(&mock);
        }

        #[tokio::test]
        async fn failed_or_malformed_start_never_stops_an_unrelated_feed() {
            for response in [
                Err("start failed".to_string()),
                Err("start timed out".to_string()),
                Ok(json!({})),
                Ok(json!({ "feedId": "" })),
            ] {
                let mut mock = MockRpc::new(8);
                mock.start = response;
                assert!(call(&mock, &bound("nats_subscribe", arguments("nats/subscribe"), false), None).await.is_err());
                assert_eq!(mock.calls().len(), 1, "an unidentified feed cannot safely be stopped by guessing its id");
            }
        }
    }
}
