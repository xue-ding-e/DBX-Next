//! Actual LocalBackend -> AppState pool -> JSONL sidecar lifecycle regressions.
//! All executables, manifests, control sockets and RPC logs are test-owned.

use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
    time::Duration,
};

use dbx_core::{connection::AppState, models::connection::ConnectionConfig, persistence::test_storage};
use dbx_mcp::{DbxBackend, LocalBackend};
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
};

const PLUGIN: &str = "org.example.pool.lifecycle";
const WAIT: Duration = Duration::from_secs(10);

fn compile_sidecar(directory: &Path) -> PathBuf {
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/plugin_lifecycle_sidecar.rs");
    let binary = directory.join(format!("lifecycle-sidecar{}", std::env::consts::EXE_SUFFIX));
    let compiler = std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into());
    let mut command = Command::new(&compiler);
    command.args(["--edition=2021", "--crate-name", "dbx_plugin_lifecycle_fixture"]).arg(source).arg("-o").arg(&binary);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    #[cfg(all(windows, target_env = "msvc"))]
    {
        use std::os::windows::process::CommandExt;
        // Direct rustc does not inherit .cargo/config.toml's rust-lld choice.
        let library =
            Command::new(&compiler).creation_flags(0x0800_0000).args(["--print", "target-libdir"]).output().unwrap();
        assert!(library.status.success(), "{}", String::from_utf8_lossy(&library.stderr));
        let library = PathBuf::from(String::from_utf8(library.stdout).unwrap().trim());
        let linker = library.parent().unwrap().join("bin/rust-lld.exe");
        if linker.is_file() {
            command.arg("-C").arg(format!("linker={}", linker.display()));
        }
    }
    let output = command.output().expect("rustc must be available for the integration fixture");
    assert!(output.status.success(), "sidecar compilation failed: {}", String::from_utf8_lossy(&output.stderr));
    binary
}

struct Fixture {
    _directory: tempfile::TempDir,
    backend: Arc<LocalBackend>,
    control: TcpListener,
    log: PathBuf,
}

impl Fixture {
    async fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let compilation_dir = directory.path().to_path_buf();
        let binary = tokio::task::spawn_blocking(move || compile_sidecar(&compilation_dir)).await.unwrap();
        let plugin_root = directory.path().join("plugins");
        let plugin_dir = plugin_root.join(PLUGIN);
        std::fs::create_dir_all(&plugin_dir).unwrap();
        let executable = format!("sidecar{}", std::env::consts::EXE_SUFFIX);
        std::fs::copy(binary, plugin_dir.join(&executable)).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(plugin_dir.join(&executable), std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let control = TcpListener::bind("127.0.0.1:0").await.unwrap();
        std::fs::write(plugin_dir.join("control.addr"), control.local_addr().unwrap().to_string()).unwrap();
        std::fs::write(
            plugin_dir.join("manifest.json"),
            json!({
                "manifest_version": 1, "id": PLUGIN, "name": "Pool lifecycle fixture", "version": "1.0.0",
                "publisher": "fixture", "engines": { "host_api": "^1.0" },
                "entrypoints": { "backend": { "protocol_versions": [1], "transport": "stdio-jsonl", "executable": executable } },
                "contributions": [{ "type": "connection-provider", "id": "fixture.connection", "database_type": "fixture",
                    "fields": [], "capabilities": ["connect", "disconnect"] }],
            })
            .to_string(),
        )
        .unwrap();
        let storage = test_storage::open(&directory.path().join("storage.db")).await.unwrap();
        let state = Arc::new(AppState::new_with_plugin_and_agent_dir_and_app_version(
            storage,
            plugin_root,
            directory.path().join("agents"),
            "0.6.0",
        ));
        let configs = ["first", "second"].map(|id| {
            serde_json::from_value::<ConnectionConfig>(json!({
                "id": id, "name": id, "db_type": "plugin", "plugin_id": PLUGIN,
                "plugin_connection_provider": "fixture.connection", "plugin_connection_type": "fixture",
                "host": "127.0.0.1", "port": 49001, "username": "", "password": "",
                "connect_timeout_secs": 10, "keepalive_interval_secs": 0, "idle_timeout_secs": 0,
            }))
            .unwrap()
        });
        state.storage.save_connections(&configs).await.unwrap();
        *state.configs.write().await = configs.into_iter().map(|config| (config.id.clone(), config)).collect();
        // Warm only the sidecar. Both saved connections must still have cold
        // pools, so activation serialization cannot accidentally hide the race.
        state.plugin_host.activate(PLUGIN).await.unwrap();
        let backend = Arc::new(LocalBackend::from_app_state(state, directory.path().to_path_buf()));
        Self { _directory: directory, backend, control, log: plugin_dir.join("rpc.log") }
    }

    async fn connecting(&self) -> (String, TcpStream) {
        tokio::time::timeout(WAIT, async {
            let (stream, _) = self.control.accept().await.unwrap();
            let mut reader = BufReader::new(stream);
            let mut connection_id = String::new();
            reader.read_line(&mut connection_id).await.unwrap();
            (connection_id.trim().to_string(), reader.into_inner())
        })
        .await
        .expect("sidecar must reach connection/connect without another ID blocking it")
    }

    async fn rpc(&self, method: &str) -> Value {
        self.backend.state().plugin_host.invoke(PLUGIN, method, json!({}), None, Some(WAIT)).await.unwrap()
    }

    fn requests(&self, method: &str) -> usize {
        std::fs::read_to_string(&self.log)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .filter(|request| request["method"] == method)
            .count()
    }

    async fn close(self) {
        self.backend.shutdown_cli().await;
    }
}

async fn inspect(backend: &LocalBackend, connection_id: &str) -> Result<Value, String> {
    backend.call_plugin_cli_tool(PLUGIN, "inspect", Some(connection_id), &json!({}), false, false).await
}

#[tokio::test]
async fn concurrent_cold_plugin_pool_creation_connects_once_through_publication() {
    let fixture = Fixture::new().await;
    let backend = Arc::clone(&fixture.backend);
    let first = tokio::spawn(async move { inspect(&backend, "first").await });
    let (id, mut response_gate) = fixture.connecting().await;
    assert_eq!(id, "first");

    let state = Arc::clone(fixture.backend.state());
    let mut second_pool = Box::pin(state.get_or_create_pool("first", None));
    // Poll the actual second pool function before sending a protocol barrier.
    // Without creation serialization it writes a second connect; its stdin
    // write/flush holds the FIFO writer mutex ahead of the barrier. The fixture
    // logs input before dispatch, so this checks contention without sleeps.
    {
        let barrier = fixture.rpc("fixture/barrier");
        tokio::pin!(barrier);
        tokio::time::timeout(WAIT, async {
            tokio::select! {
                biased;
                result = second_pool.as_mut() => panic!("second pool must wait for the held connect: {result:?}"),
                response = &mut barrier => assert_eq!(response["ok"], true),
            }
        })
        .await
        .unwrap();
    }
    assert_eq!(fixture.requests("connection/connect"), 1, "concurrent creators must share the pending connection");
    response_gate.write_all(b"continue\n").await.unwrap();
    let (first_result, second_result) =
        tokio::time::timeout(WAIT, async { tokio::join!(first, second_pool) }).await.unwrap();
    assert_eq!(first_result.unwrap().unwrap()["structuredContent"]["connectionId"], "first");
    assert_eq!(second_result.unwrap(), "first");
    assert_eq!(state.get_or_create_pool("first", None).await.unwrap(), "first");
    let status = fixture.rpc("fixture/status").await;
    assert_eq!(status["connects"], 1);
    assert_eq!(status["disconnects"], 0, "retiring a duplicate pool must never disconnect the published session");
    assert_eq!(status["calls"], 1);
    assert_eq!(status["live"], 1);
    fixture.close().await;
}

#[tokio::test]
async fn different_plugin_connection_ids_do_not_block_each_other() {
    let fixture = Fixture::new().await;
    let backend = Arc::clone(&fixture.backend);
    let first = tokio::spawn(async move { inspect(&backend, "first").await });
    let (id, mut first_gate) = fixture.connecting().await;
    assert_eq!(id, "first");
    let state = Arc::clone(fixture.backend.state());
    let mut second_pool = Box::pin(state.get_or_create_pool("second", None));
    let (id, mut second_gate) = tokio::select! {
        biased;
        result = second_pool.as_mut() => panic!("second connect must reach its response gate: {result:?}"),
        connecting = fixture.connecting() => connecting,
    };
    assert_eq!(id, "second");
    second_gate.write_all(b"continue\n").await.unwrap();
    assert_eq!(tokio::time::timeout(WAIT, second_pool).await.unwrap().unwrap(), "second");
    assert!(!first.is_finished(), "a distinct connection must publish while the first connect is still held");
    first_gate.write_all(b"continue\n").await.unwrap();
    tokio::time::timeout(WAIT, first).await.unwrap().unwrap().unwrap();
    let status = fixture.rpc("fixture/status").await;
    assert_eq!(status["connects"], 2);
    assert_eq!(status["disconnects"], 0);
    assert_eq!(status["live"], 2);
    fixture.close().await;
}

#[tokio::test]
async fn cancelled_cli_cold_connect_publishes_without_business_rpc_and_is_reused() {
    let fixture = Fixture::new().await;
    let backend = Arc::clone(&fixture.backend);
    let caller = tokio::spawn(async move { inspect(&backend, "first").await });
    let (id, mut response_gate) = fixture.connecting().await;
    assert_eq!(id, "first");
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    response_gate.write_all(b"continue\n").await.unwrap();
    tokio::time::timeout(WAIT, async {
        loop {
            if fixture.backend.state().pool_handle("first").await.is_some() {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("owned operation task must publish the completed connect after its caller is cancelled");
    let status = fixture.rpc("fixture/status").await;
    assert_eq!(status["connects"], 1);
    assert_eq!(status["calls"], 0, "the cancelled caller must not dispatch its business operation");
    let result = tokio::time::timeout(WAIT, inspect(&fixture.backend, "first")).await.unwrap().unwrap();
    assert_eq!(result["structuredContent"]["connectionId"], "first");
    let status = fixture.rpc("fixture/status").await;
    assert_eq!(status["connects"], 1, "a later CLI call must reuse the published connection");
    assert_eq!(status["calls"], 1);
    assert_eq!(status["disconnects"], 0);
    fixture.close().await;
}
