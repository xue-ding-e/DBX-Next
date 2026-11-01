---
name: dbx-xenterm-proxy
description: Configure, document, test, and troubleshoot DBX Desktop database connections through XenTerm/XenTerm-Next SSH proxy tunnels. Use this skill whenever a user mentions DBX plus XenTerm, SSH proxy, dynamic forwarding, SOCKS5, HTTP CONNECT, a local proxy port, selective per-connection routing, or wants to avoid duplicating SSH settings in a database client. Cover the actual DBX transport-layer UI and shared tunnel profiles; do not confuse a proxy with a single destination SSH jump port.
compatibility: Windows DBX-Next portable or installed desktop builds, XenTerm/XenTerm-Next with a connected SSH session, and optional SOCKS5-to-HTTP CONNECT adapter.
---

# DBX through a XenTerm SSH proxy

Use this skill to connect DBX Desktop to a database through a XenTerm SSH session while keeping SSH credentials and SSH session ownership in XenTerm. DBX stores only a local proxy endpoint and the connection's routing choice. This avoids configuring the same SSH login twice and lets each DBX connection opt in or out independently.

## The model to preserve

The intended path is:

```text
DBX connection (selected transport layer)
        -> 127.0.0.1:<local-proxy-port>
        -> XenTerm Dynamic SSH tunnel (-D, SOCKS5)
        -> SSH server
        -> database host:port as seen from that server
```

A XenTerm Dynamic tunnel is a local SOCKS5 proxy. It is not an SSH jump-host field inside DBX and it is not limited to one fixed destination port. One listener can route many TCP destinations; DBX decides which saved connections use it.

Keep these responsibilities separate:

- **XenTerm:** SSH host, port, user, authentication, host-key verification, session lifetime, and the Dynamic listener.
- **DBX:** database credentials, database host and port, and whether this particular connection uses a proxy layer.
- **HTTP adapter (optional):** only if a consumer requires HTTP CONNECT. XenTerm itself does not expose its Dynamic listener as an HTTP proxy.

The local listener should remain bound to `127.0.0.1`. Do not expose it to the LAN unless the user explicitly understands that every device able to reach the port can attempt to use the SSH egress.

## Trigger and first checks

Apply this workflow before changing code or asking the user to duplicate SSH settings when the request includes any of these phrases or symptoms:

- “DBX 走 XenTerm 的 SSH 代理/隧道”
- “SOCKS5/HTTP 代理填哪里”
- “只让部分连接走代理”
- “Navicat 要配两份 SSH，DBX 能不能复用 XenTerm”
- “DBX 代理端口连不上” or “数据库能 SSH 但 DBX 测试失败”

First establish the facts:

1. Confirm the DBX build has the **Transport** tab and **Settings → Tunnels**. DBX-Next has both.
2. Confirm XenTerm has an active SSH session and a Dynamic tunnel listener. A saved SSH session alone does not create a listener.
3. Record the exact local address and port. The XenTerm GUI currently binds Dynamic listeners to `127.0.0.1`; the port is chosen by the user.
4. Determine the proxy protocol required by DBX. Use SOCKS5 directly whenever possible. Choose HTTP CONNECT only when a separate adapter is already running.
5. Keep the target database host/port separate from the local proxy host/port. The proxy endpoint is local; the database endpoint is remote from the SSH server's point of view.

Do not infer that a successful SSH login proves the database is reachable. Test the full chain with the exact database host and port.

## Configure XenTerm

Use the connected XenTerm SSH session that has network access to the database. The labels can vary slightly between XenTerm and XenTerm-Next, but the operation is the same:

1. Open the session's **SFTP/Tunnels** panel.
2. Add a **Dynamic** rule. Dynamic is the GUI equivalent of OpenSSH `ssh -D`.
3. Give it a stable name such as `dbx-prod-socks` and choose an unused local port, for example `1080`.
4. Start the rule while the SSH session is connected.
5. Leave the listener bound to `127.0.0.1`. Do not enter a remote destination host or destination port for a Dynamic rule.

XenTerm's current Dynamic listener contract is:

- protocol: SOCKS5;
- bind address: `127.0.0.1`;
- authentication: no SOCKS username/password;
- commands: TCP `CONNECT` for IPv4, IPv6, and domain names;
- unsupported: SOCKS username authentication, UDP associate, and arbitrary SOCKS commands;
- lifetime: the listener stops being usable when its owning SSH session is disconnected;
- persistence: starting or stopping the rule does not rewrite the saved SSH session.

A local port is not proof that the proxy is healthy. Check the listener and then check a real destination. On Windows, use:

```powershell
Test-NetConnection 127.0.0.1 -Port 1080
```

For a TCP-capable probe that preserves the destination hostname for SOCKS5 DNS resolution, use a tool that supports `--socks5-hostname`:

```powershell
curl.exe --socks5-hostname 127.0.0.1:1080 https://example.com/ -I --max-time 15
```

Replace the destination with a non-destructive endpoint reachable from the SSH server. Do not use a database write as a proxy health test.

## Configure DBX with SOCKS5 (recommended)

DBX-Next supports a reusable shared tunnel profile and a per-connection transport-layer reference. Use the shared profile when several connections share one XenTerm listener.

### Create the shared profile

1. Open **Settings → Tunnels**.
2. Add a **Proxy** profile.
3. Set a descriptive name, such as `XenTerm prod SOCKS5 1080`.
4. Set **Proxy type** to `SOCKS5`.
5. Set **Host** to `127.0.0.1`.
6. Set **Port** to the XenTerm Dynamic listener port, for example `1080`.
7. Leave proxy username and password empty because XenTerm's Dynamic listener currently has no SOCKS authentication.
8. Save the profile.

DBX-Next's new proxy profile defaults are `SOCKS5`, `127.0.0.1`, and port `1080`. Treat these as a convenience default, not as evidence that XenTerm is listening on 1080; use the port shown by XenTerm.

### Attach it to only the intended connection

1. Edit the DBX database connection.
2. Open the **Transport** tab.
3. Add a **Proxy** layer, or select the existing proxy layer.
4. In **Tunnel profile**, select the shared XenTerm profile.
5. Leave the layer enabled for this connection and save.
6. Run DBX's connection test.

For connections that must go directly, do not attach this layer or disable that layer. The same shared profile can be attached to many selected connections without copying the XenTerm credentials. A connection may have multiple transport layers; keep the intended order visible in the transport list and test the complete path after reordering.

The database fields still describe the database target. For example, if the database listens on the SSH server itself, use the server-side address and port that the SSH server can reach; `127.0.0.1` in the database field means the SSH server's loopback only when the proxy implementation sends the connection from that server. Do not replace the database target with the local proxy endpoint.

When a multi-hop XenTerm session reaches an RDS private endpoint, keep the database field as the private DNS hostname supplied by the network (for example `pgm-...pg.rds.aliyuncs.com`). Preserve hostname based routing through SOCKS5; do not substitute the resolved private IP or a public endpoint. Verify the hostname resolves to the private address from the target jump session, then test the exact hostname and port through the local SOCKS listener.
## Configure DBX with HTTP CONNECT

DBX's Proxy layer also accepts `HTTP CONNECT`, with the same host, port, username, and password fields. XenTerm's Dynamic listener is not an HTTP proxy, so do not set DBX to HTTP merely because the transport is “over SSH.”

Use HTTP CONNECT only when a local SOCKS5-to-HTTP adapter is running, for example:

```text
XenTerm SOCKS5 127.0.0.1:1080
        -> local adapter HTTP CONNECT 127.0.0.1:8080
        -> DBX Proxy type HTTP, host 127.0.0.1, port 8080
```

The adapter may be GOST, Privoxy, or another reviewed local tool. Confirm its exact command syntax for the installed version before starting it. A typical GOST 2.x-style shape is:

```powershell
gost.exe -L=http://127.0.0.1:8080 -F=socks5://127.0.0.1:1080
```

A typical Privoxy configuration shape is:

```text
listen-address  127.0.0.1:8080
forward-socks5t / 127.0.0.1:1080 .
```

The adapter must bind to loopback, must not require remote credentials unless deliberately configured, and must be tested with a harmless HTTP CONNECT request. If the adapter is not present, use SOCKS5 directly instead of adding a fake HTTP profile.

When the adapter requires authentication, enter those adapter credentials in the DBX Proxy layer. They are not the XenTerm SSH credentials. Do not put SSH passwords, private keys, or DB passwords in the adapter command line.
## Verification checklist

Run checks in this order so each failure points to one layer:

1. **XenTerm session:** the SSH session is connected and the Dynamic rule shows running.
2. **Local listener:** `Test-NetConnection 127.0.0.1 -Port <port>` succeeds.
3. **Proxy protocol:** a SOCKS5 probe reaches a harmless endpoint. For HTTP mode, test the adapter's HTTP CONNECT endpoint, not the SOCKS port.
4. **DBX profile:** the proxy type, loopback host, and port exactly match the running listener. Credentials are empty unless an adapter explicitly requires them.
5. **DBX routing:** the intended connection has an enabled Proxy layer referencing the profile; a control connection without that layer remains direct.
6. **Database path:** DBX's connection test succeeds with the actual database host and port. Test a read-only query only after the connection test succeeds.
7. **Disconnect behavior:** stop the XenTerm Dynamic rule and confirm the proxied connection fails while a direct control connection still behaves as expected. Restart the rule and confirm recovery.

Record only non-sensitive evidence: listener address/port, proxy protocol, DBX connection name or ID, error category, and whether the SSH session was connected. Do not include passwords, private key contents, full DSNs, or connection secret fields in logs or issue reports.

## Troubleshooting matrix

| Symptom | Likely boundary | Action |
| --- | --- | --- |
| `TcpTestSucceeded: False` | XenTerm listener is stopped, port is wrong, or another process owns the port | Recheck the Dynamic rule and the exact port; inspect the owning process before changing it. |
| Listener works but DBX says proxy connection refused | DBX profile points at the wrong host/port or the layer is disabled | Use `127.0.0.1`, the actual listener port, the matching protocol, and an enabled layer. |
| SOCKS5 works with curl but DBX cannot reach the database | Database host/port is not reachable from the SSH server, or DBX's protocol driver has a separate restriction | Test the exact host and port through the same proxy with a non-writing TCP probe; verify the server-side route and DBX driver settings. |
| DBX HTTP mode fails against XenTerm port | Protocol mismatch | Change DBX to SOCKS5, or start a loopback SOCKS5-to-HTTP adapter and point DBX at the adapter port. |
| Hostname fails but IP works | DNS is being resolved on the wrong side or the remote DNS cannot resolve it | Prefer a proxy-aware hostname mode, verify remote DNS, or use a server-side resolvable name. Keep TLS server-name settings consistent. |
| Connection works until XenTerm disconnects | Expected Dynamic tunnel lifetime | Reconnect the owning SSH session and restart the Dynamic rule if needed; do not duplicate SSH credentials in DBX. |
| One connection works and another does not | Selective routing or target-specific network policy | Compare only the transport layer and target endpoint; keep direct and proxied connections separate. |
| SSH login succeeds but database test fails | SSH reachability is not database reachability | Verify the database service is listening and accessible from the SSH server's network namespace. |
| TLS or certificate error after proxying | The route works, but the database identity check does not match | Preserve the database hostname used for the certificate; do not disable TLS verification just to make the proxy test pass. |

Do not “fix” a failed proxy test by enabling `expose_lan`, turning off host-key verification, copying SSH passwords into DBX, or replacing the proxy layer with an SSH jump field. Those changes solve a different problem and weaken the boundary between XenTerm and DBX.

## DBX-Next implementation contract

The current repository implements this behavior in these places:

- `apps/desktop/src/lib/connection/tunnelProfiles.ts`: shared profile creation defaults Proxy to `proxy_type: "socks5"`, `host: "127.0.0.1"`, and `port: 1080`.
- `apps/desktop/src/components/connection/ConnectionDialog.vue`: the Transport tab supports `SSH`, `Proxy`, and `HTTP CONNECT` layers, plus selecting a shared Tunnel profile per connection.
- `src-tauri` transport code: the backend consumes the selected layer chain; a profile reference is expanded at connection time so credentials are not copied into every connection stub.
- Portable user data: `data\dbx.db` stores connections, secrets, and tunnel profiles beside `DBX.exe` when `portable.dbx` is present. Replacing the executable must not remove this directory.

The behavior is intentionally selective: a profile is reusable, but attachment to a connection is explicit. Do not make all DBX connections inherit a global proxy unless the user asks for that policy.

## Safe change and migration rules

When changing this integration in code:

1. Preserve existing connection rows and secret storage. Add or migrate fields through the project's normal migration path.
2. Keep legacy SSH fields readable while converting them to transport layers; do not delete user-configured SSH settings during a proxy change.
3. Use loopback defaults for new proxy profiles and keep `expose_lan` disabled by default.
4. Add tests for default SOCKS5 values, HTTP selection, profile references, disabled layers, and detaching a profile without losing the layer's identity.
5. Test both a direct control connection and a proxied connection. A successful proxied test alone cannot prove selective routing.
6. When replacing a portable build, back up `data\dbx.db`, `data\dbx.db-wal`, `data\dbx.db-shm`, `portable.dbx`, and any external configuration before touching only `DBX.exe`.

Never put XenTerm's private key or SSH password into this Skill, a GitHub workflow, a sample command, or a DBX issue. The GitHub release workflow needs only a protected updater signing secret; XenTerm credentials stay in its own encrypted profile.
