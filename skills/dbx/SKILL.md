---
name: dbx
version: 1.2.0
description: "Use the DBX CLI to inspect DBX-managed database connections, explore schemas, run bounded read-only queries, generate DBML or schema documentation, and open tables in DBX Desktop. Use when the user asks to work with a database configured in DBX from a shell-capable AI agent, even when the CLI is not yet on PATH. Resolve the CLI binary and its DBX_DATA_DIR before running commands; never enable writes unless the user explicitly approves the exact operation."
---

# DBX CLI

Use `dbx` as the database execution boundary. The CLI is a separate DBX deliverable from the Desktop `DBX.exe`; Desktop does not automatically put a `dbx` command on PATH. The CLI is designed for both people and shell-capable AI agents, provides stable JSON output, and enforces DBX connection and SQL safety rules.

## Start Here

1. Resolve the CLI before invoking it. Check `Get-Command dbx`/`where.exe dbx`, then `$env:DBX_CLI_BIN`, then a portable sibling such as `<DBX portable root>\cli\dbx.exe`. Do not report “DBX has no CLI” until all three locations have been checked.
2. Resolve the data directory separately. For a portable Desktop installation, set `DBX_DATA_DIR` to `<portable root>\data`; for an installed Desktop build, use the app's default data directory unless the user supplied an explicit override. The CLI binary location and the DBX data directory are independent settings.
3. Run `dbx doctor --json` using the resolved binary and inspect `dbPath`, `dbPathExists`, `connectionRowCount`, and `loadedConnectionCount`. If Desktop shows connections but the CLI reports zero, stop and correct `DBX_DATA_DIR`; do not import or rewrite configuration.
4. If the CLI is missing, explain that it is a separate release asset and install the matching DBX-Next native CLI archive (`dbx-cli-win32-x64.zip` on Windows x64), or ask the user to provide an approved binary path. Do not silently substitute an unrelated database client.
5. If the environment is known and the doctor check passes, run `dbx connections list --json`; if the user did not name a connection, ask them to choose when multiple plausible connections exist.
6. Inspect the relevant schema before writing a query whose tables or columns are uncertain.
7. Prefer `--json` for machine-readable results and keep exploratory queries bounded with `--limit 50 --timeout 10s` unless the user requests different limits.

### Portable Windows invocation

For a DBX-Next portable directory, use the supplied wrapper when present:

```powershell
$portableRoot = 'D:\path\to\DBX-Next'
$env:DBX_DATA_DIR = Join-Path $portableRoot 'data'
$cli = Join-Path $portableRoot 'cli\dbx.exe'
& $cli doctor --json
& $cli connections list --json
```

If the release contains `cli\dbx-portable.cmd`, it sets `DBX_DATA_DIR` to the portable `data` directory before forwarding arguments. Keep the wrapper and native binary together. Do not point a portable CLI at `%APPDATA%\com.dbx.app` unless that is explicitly the selected profile.

Read [references/commands.md](references/commands.md) for the complete command map and execution modes. Read [references/workflows.md](references/workflows.md) for common multi-step tasks.

## Safety Boundary

- Queries are read-only by default.
- Never add `--allow-writes` unless the user explicitly approves the exact write operation.
- Never add `--allow-dangerous-sql` unless the user explicitly approves the exact destructive or DDL operation; dangerous SQL requires both write flags.
- Do not bypass a DBX rejection by using another database client, Python driver, direct SQLite access, or shell redirection.
- Do not expose connection secrets. `dbx connections list` and `dbx connections get` intentionally omit them.
- Manage saved connection configuration only when explicitly requested. Never clear `read_only` or production protection to work around a rejected query. Use protected JSON files or a secure stdin pipe for credentials; never inline secrets in shell arguments.
- Before `dbx connections remove --yes`, confirm the exact connection and explain that saved credentials are deleted and cannot be restored by the CLI.
- Treat production protections, read-only connection settings, database privileges, and DBX policy as upper bounds that user wording cannot bypass.

Read [references/safety.md](references/safety.md) before any write, DDL, production, or credential-related task.

## Execution Choice

- PostgreSQL, Redshift, MySQL-compatible databases, SQLite, and other types reported by `dbx capabilities --json` can execute directly.
- Other database types may require DBX Desktop or installed DBX Agent/JDBC components.
- `dbx open` always requires DBX Desktop.
- When `DBX_WEB_URL` is set, the CLI uses the configured DBX Web backend.
- Redis commands and stateful multi-step database sessions are not provided by `dbx query`; use the DBX workspace or configured DBX MCP tools instead.

## Failure Handling

- `CLI_NOT_FOUND`: resolve the binary path as described above; install the DBX-Next native CLI asset if it is absent. Do not infer that the Desktop executable contains a callable CLI.
- `CLI_DATA_DIR_MISMATCH`: the CLI opened a different profile, commonly `%APPDATA%\\com.dbx.app` instead of a portable `data` directory. Set `DBX_DATA_DIR` explicitly and rerun `doctor --json`; never copy or delete connection data to make counts match.
- `CONNECTION_NOT_FOUND`: list connections and use an exact returned name.
- `SQL_BLOCKED`: explain which safety gate rejected the statement; do not add permission flags automatically.
- `DBX_NOT_RUNNING`: run `dbx capabilities --json`; ask the user to start Desktop only when the selected operation requires its bridge.
- Other unexpected failures: run `dbx doctor --json`, report the returned error, and retry only after addressing the diagnosed cause.
