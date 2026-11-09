import { createPinia, setActivePinia } from "pinia";
import { watch } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SchemaConnectionAcquisition } from "@/stores/connectionStore";
import type { ConnectionConfig } from "@/types/database";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function observe(promise: Promise<unknown>) {
  const observation = { settled: false, outcome: Promise.resolve<unknown>(undefined) };
  observation.outcome = promise.then(
    (value) => { observation.settled = true; return value; },
    (error: unknown) => { observation.settled = true; return error; },
  );
  return observation;
}

function pgConnection(id = "conn-a"): ConnectionConfig {
  return { id, name: id, db_type: "postgres", host: "example.invalid", port: 5432, username: "synthetic", password: "", database: "app", read_only: false } as ConnectionConfig;
}

async function setup() {
  const connectionIdentifierQuote = vi.fn().mockResolvedValue('"');
  const checkConnectionHealth = vi.fn().mockResolvedValue(undefined);
  const connectDb = vi.fn(async (config: ConnectionConfig, _attempt?: number) => config.id);
  const disconnectDb = vi.fn().mockResolvedValue(undefined);
  const loadConnections = vi.fn().mockResolvedValue([pgConnection()]);
  const saveConnections = vi.fn().mockResolvedValue(undefined);
  const sessionCredentialStatus = vi.fn().mockResolvedValue(false);
  const requestPassword = vi.fn().mockResolvedValue({ password: "synthetic-only", rememberPassword: true });
  const hasTrace = vi.fn().mockReturnValue(false);
  const disposeTrace = vi.fn().mockResolvedValue(undefined);
  const flushPendingPersist = vi.fn().mockResolvedValue(undefined);
  const listSchemas = vi.fn().mockResolvedValue(["public"]);
  vi.doMock("@/lib/database/jdbcDialect", async (importOriginal) => ({
    ...await importOriginal<typeof import("@/lib/database/jdbcDialect")>(),
    connectionShouldLoadIdentifierQuote: () => true,
  }));
  vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
  vi.doMock("@/lib/sqlserver/sqlServerActivityTraceRuntime", () => ({
    hasSqlServerActivityTraceForConnection: hasTrace,
    disposeSqlServerActivityTracesForConnection: disposeTrace,
  }));
  vi.doMock("@/stores/connectionPasswordPromptStore", () => ({ useConnectionPasswordPromptStore: () => ({ requestPassword }) }));
  vi.doMock("@/stores/queryStore", () => ({ useQueryStore: () => ({
    flushPendingPersist,
    staleConnectionDataTabMetadata: vi.fn(),
    closeConnectionTabs: vi.fn(),
    releaseConnectionTabs: vi.fn(),
    rollbackConnectionTransactions: vi.fn(),
  }) }));
  vi.doMock("@/lib/backend/api", () => ({
    checkConnectionHealth, connectionIdentifierQuote, connectDb, disconnectDb,
    loadConnections, saveConnections, sessionCredentialStatus, listSchemas,
    connectionDatabaseInfo: vi.fn().mockResolvedValue(undefined),
    deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
    deleteTableVGroupsForConnection: vi.fn().mockResolvedValue(undefined),
    loadEditorSettings: vi.fn().mockResolvedValue(null),
    loadSchemaCache: vi.fn().mockResolvedValue(null),
    loadSidebarLayout: vi.fn().mockResolvedValue(null),
    loadTableVGroups: vi.fn().mockResolvedValue({}),
    loadTunnelProfiles: vi.fn().mockResolvedValue([]),
    saveEditorSettings: vi.fn().mockResolvedValue(undefined),
    saveSchemaCache: vi.fn().mockResolvedValue(undefined),
    saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
  }));
  const module = await import("@/stores/connectionStore");
  const store = module.useConnectionStore();
  store.connections = [pgConnection(), pgConnection("conn-b")];
  store.treeNodes = [{ id: "conn-a", label: "conn-a", type: "connection", connectionId: "conn-a", isLoading: false, children: [] }];
  // A real unrelated acquisition is the checkpoint for negative assertions:
  // no timers, sleeps, mocked acquire implementation, or microtask pumping.
  async function checkpoint() {
    await store.acquireSchemaConnection("conn-b", { activate: false });
  }
  const connectsA = () => connectDb.mock.calls.filter(([config]) => config.id === "conn-a").length;
  return { store, ...module, connectionIdentifierQuote, checkConnectionHealth, connectDb, disconnectDb, loadConnections, saveConnections, sessionCredentialStatus, requestPassword, hasTrace, disposeTrace, flushPendingPersist, listSchemas, checkpoint, connectsA };
}

describe("connectionStore: opt-in schema acquisition", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    const data = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key: string) => data.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => data.set(key, value)),
      removeItem: vi.fn((key: string) => data.delete(key)),
    });
    setActivePinia(createPinia());
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("rejects a user-closed passive request without mutation, then lets a fresh explicit request acquire", async () => {
    const { store, connectsA, CONNECTION_CLOSED_BY_USER_MESSAGE } = await setup();
    await store.disconnect("conn-a");
    store.connectionErrors["conn-a"] = "keep this error";
    await expect(store.acquireSchemaConnection("conn-a", { skipIfClosedByUser: true, activate: false })).rejects.toThrow(CONNECTION_CLOSED_BY_USER_MESSAGE);
    expect(connectsA()).toBe(0);
    expect(store.connectionErrors["conn-a"]).toBe("keep this error");
    expect(store.activeConnectionId).toBeNull();
    const acquired = await store.acquireSchemaConnection("conn-a");
    expect(acquired.connectionId).toBe("conn-a");
    expect(acquired.stateRevision).toBe(store.connectionStateRevision("conn-a"));
    expect(() => store.assertSchemaConnectionAcquisition(acquired)).not.toThrow();
    expect(store.activeConnectionId).toBe("conn-a");
    expect(store.isConnectionClosedByUser("conn-a")).toBe(false);
  });

  it.each(["close", "cancel"] as const)("invalidates a strict request still in config loading on %s", async (action) => {
    const { store, loadConnections, connectsA, CONNECTION_ATTEMPT_CANCELLED_MESSAGE } = await setup();
    const entered = deferred<void>();
    const configs = deferred<ConnectionConfig[]>();
    store.connections = [];
    loadConnections.mockImplementationOnce(() => { entered.resolve(); return configs.promise; });
    const pending = observe(store.acquireSchemaConnection("conn-a"));
    try {
      await entered.promise;
      if (action === "close") await store.disconnect("conn-a");
      else expect(await store.cancelConnecting("conn-a")).toBe(false);
      store.connectionErrors["conn-a"] = "newer failure";
      configs.resolve([pgConnection()]);
      expect(await pending.outcome).toEqual(new Error(CONNECTION_ATTEMPT_CANCELLED_MESSAGE));
      expect(connectsA()).toBe(0);
      expect(store.connectionErrors["conn-a"]).toBe("newer failure");
      expect(store.activeConnectionId).toBeNull();
      // A new explicit request is independently authorized after the invalidation.
      const acquired = await store.acquireSchemaConnection("conn-a", { activate: false });
      expect(() => store.assertSchemaConnectionAcquisition(acquired)).not.toThrow();
    } finally { configs.resolve([pgConnection()]); await pending.outcome; }
  });

  it.each([true, false])("waits across trace, backend and tab persistence for full close (user=%s)", async (markClosedByUser) => {
    const context = await setup();
    const { store, hasTrace, disposeTrace, disconnectDb, flushPendingPersist, listSchemas, checkpoint, connectsA, CONNECTION_CLOSED_BY_USER_MESSAGE } = context;
    const old = await store.acquireSchemaConnection("conn-a", { activate: false });
    const traceEntered = deferred<void>();
    const trace = deferred<void>();
    const backendEntered = deferred<void>();
    const backend = deferred<void>();
    const persistenceEntered = deferred<void>();
    const persistence = deferred<void>();
    hasTrace.mockReturnValueOnce(true);
    disposeTrace.mockImplementationOnce(() => { traceEntered.resolve(); return trace.promise; });
    disconnectDb.mockImplementationOnce(() => { backendEntered.resolve(); return backend.promise; });
    flushPendingPersist.mockImplementationOnce(() => { persistenceEntered.resolve(); return persistence.promise; });
    const closing = observe(store.disconnect("conn-a", { markClosedByUser }));
    await traceEntered.promise;
    expect(store.connectedIds.has("conn-a")).toBe(true);
    expect(store.hasDisconnectInFlight("conn-a")).toBe(false);
    expect(() => store.assertSchemaConnectionAcquisition(old)).toThrow();
    const explicit = observe(store.acquireSchemaConnection("conn-a").then((acquired) => {
      store.assertSchemaConnectionAcquisition(acquired);
      return listSchemas("conn-a", "app");
    }));
    const passive = observe(store.acquireSchemaConnection("conn-a", { skipIfClosedByUser: true, activate: false }));
    try {
      await checkpoint();
      expect(explicit.settled).toBe(false);
      expect(connectsA()).toBe(1);
      expect(listSchemas).not.toHaveBeenCalled();
      if (markClosedByUser) expect(await passive.outcome).toEqual(new Error(CONNECTION_CLOSED_BY_USER_MESSAGE));
      else expect(passive.settled).toBe(false);
      trace.resolve();
      await backendEntered.promise;
      await persistenceEntered.promise;
      await checkpoint();
      expect(explicit.settled).toBe(false);
      backend.resolve();
      await checkpoint();
      expect(explicit.settled).toBe(false);
      expect(listSchemas).not.toHaveBeenCalled();
      persistence.resolve();
      expect(await closing.outcome).toBeUndefined();
      expect(await explicit.outcome).toEqual(["public"]);
      if (!markClosedByUser) expect(await passive.outcome).toMatchObject({ connectionId: "conn-a" });
      expect(connectsA()).toBe(2);
    } finally {
      trace.resolve(); backend.resolve(); persistence.resolve();
      await Promise.all([closing.outcome, explicit.outcome, passive.outcome]);
    }
  });

  it("keeps a failed trace close unsafe after its barrier exits, until another full close succeeds", async () => {
    const { store, hasTrace, disposeTrace, connectsA, CONNECTION_SCHEMA_TEARDOWN_FAILED_MESSAGE } = await setup();
    await store.acquireSchemaConnection("conn-a", { activate: false });
    hasTrace.mockReturnValueOnce(true);
    disposeTrace.mockRejectedValueOnce(new Error("trace failed"));
    await expect(store.disconnect("conn-a", { markClosedByUser: false })).rejects.toThrow("trace failed");
    expect(store.connectedIds.has("conn-a")).toBe(true);
    await expect(store.acquireSchemaConnection("conn-a")).rejects.toThrow(CONNECTION_SCHEMA_TEARDOWN_FAILED_MESSAGE);
    expect(connectsA()).toBe(1);
    await store.disconnect("conn-a", { markClosedByUser: false });
    const acquired = await store.acquireSchemaConnection("conn-a");
    expect(() => store.assertSchemaConnectionAcquisition(acquired)).not.toThrow();
  });

  it.each(["older", "newer"] as const)("owns both overlapping closes when %s completes first", async (first) => {
    const { store, disconnectDb, checkpoint, connectsA, CONNECTION_ATTEMPT_CANCELLED_MESSAGE } = await setup();
    await store.acquireSchemaConnection("conn-a", { activate: false });
    const entered1 = deferred<void>(); const raw1 = deferred<void>();
    const entered2 = deferred<void>(); const raw2 = deferred<void>();
    disconnectDb.mockImplementationOnce(() => { entered1.resolve(); return raw1.promise; });
    disconnectDb.mockImplementationOnce(() => { entered2.resolve(); return raw2.promise; });
    const close1 = observe(store.disconnect("conn-a", { markClosedByUser: false }));
    await entered1.promise;
    const obsolete = observe(store.acquireSchemaConnection("conn-a"));
    const close2 = observe(store.disconnect("conn-a", { markClosedByUser: false }));
    await entered2.promise;
    const current = observe(store.acquireSchemaConnection("conn-a", { activate: false }));
    try {
      if (first === "older") { raw1.resolve(); await close1.outcome; }
      else { raw2.resolve(); await close2.outcome; }
      await checkpoint();
      expect(current.settled).toBe(false);
      expect(connectsA()).toBe(1);
      raw1.resolve(); raw2.resolve();
      await Promise.all([close1.outcome, close2.outcome]);
      expect(await obsolete.outcome).toEqual(new Error(CONNECTION_ATTEMPT_CANCELLED_MESSAGE));
      const acquired = await current.outcome;
      expect(acquired).toMatchObject({ connectionId: "conn-a" });
      expect(store.activeConnectionId).toBeNull();
      expect(connectsA()).toBe(2);
    } finally { raw1.resolve(); raw2.resolve(); await Promise.all([close1.outcome, close2.outcome, obsolete.outcome, current.outcome]); }
  });

  it("does not let an older successful close acknowledge a newer failed close", async () => {
    const { store, disconnectDb, hasTrace, disposeTrace, CONNECTION_SCHEMA_TEARDOWN_FAILED_MESSAGE } = await setup();
    await store.acquireSchemaConnection("conn-a", { activate: false });
    const entered = deferred<void>(); const raw = deferred<void>();
    disconnectDb.mockImplementationOnce(() => { entered.resolve(); return raw.promise; });
    const older = observe(store.disconnect("conn-a", { markClosedByUser: false }));
    try {
      await entered.promise;
      hasTrace.mockReturnValueOnce(true);
      disposeTrace.mockRejectedValueOnce(new Error("new close failed"));
      await expect(store.disconnect("conn-a", { markClosedByUser: false })).rejects.toThrow("new close failed");
      raw.resolve(); await older.outcome;
      await expect(store.acquireSchemaConnection("conn-a")).rejects.toThrow(CONNECTION_SCHEMA_TEARDOWN_FAILED_MESSAGE);
      await store.disconnect("conn-a", { markClosedByUser: false });
      expect(await store.acquireSchemaConnection("conn-a")).toMatchObject({ connectionId: "conn-a" });
    } finally { raw.resolve(); await older.outcome; }
  });

  it("does not equate legacy disconnect timeout with raw backend retirement", async () => {
    const { store, disconnectDb, flushPendingPersist, CONNECTION_SCHEMA_TEARDOWN_FAILED_MESSAGE } = await setup();
    await store.acquireSchemaConnection("conn-a", { activate: false });
    vi.useFakeTimers();
    const raw = deferred<void>(); const entered = deferred<void>(); const flushing = deferred<void>();
    disconnectDb.mockImplementationOnce(() => { entered.resolve(); return raw.promise; });
    flushPendingPersist.mockImplementationOnce(async () => { flushing.resolve(); });
    const close = observe(store.disconnect("conn-a", { markClosedByUser: false }));
    try {
      await entered.promise; await flushing.promise;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await close.outcome).toBeUndefined(); // unchanged legacy timeout result
      await expect(store.acquireSchemaConnection("conn-a")).rejects.toThrow(CONNECTION_SCHEMA_TEARDOWN_FAILED_MESSAGE);
      // A newer successful bounded close cannot release the still-pending older raw request.
      await store.disconnect("conn-a", { markClosedByUser: false });
      await expect(store.acquireSchemaConnection("conn-a")).rejects.toThrow(CONNECTION_SCHEMA_TEARDOWN_FAILED_MESSAGE);
      raw.resolve(); await raw.promise;
      await expect(store.acquireSchemaConnection("conn-a")).rejects.toThrow(CONNECTION_SCHEMA_TEARDOWN_FAILED_MESSAGE);
      await store.disconnect("conn-a", { markClosedByUser: false });
      expect(await store.acquireSchemaConnection("conn-a")).toMatchObject({ connectionId: "conn-a" });
    } finally { raw.resolve(); await close.outcome; }
  });

  it.each(["legacy", "strict"] as const)("joins a %s ensure owner after connected publication but before quote readiness", async (ownerKind) => {
    const { store, connectionIdentifierQuote, checkpoint, connectsA } = await setup();
    const entered = deferred<void>(); const quote = deferred<string>();
    connectionIdentifierQuote.mockImplementationOnce(() => { entered.resolve(); return quote.promise; });
    const owner = observe(ownerKind === "legacy" ? store.ensureConnected("conn-a", { activate: false }) : store.acquireSchemaConnection("conn-a", { activate: false }));
    await entered.promise;
    expect(store.connectedIds.has("conn-a")).toBe(true);
    const ownerRevision = store.connectionStateRevision("conn-a");
    const passive = observe(store.acquireSchemaConnection("conn-a", { activate: false, skipIfClosedByUser: true }));
    const explicit = observe(store.acquireSchemaConnection("conn-a"));
    try {
      await checkpoint();
      expect(passive.settled).toBe(false); expect(explicit.settled).toBe(false);
      expect(store.activeConnectionId).toBeNull();
      expect(connectsA()).toBe(1);
      quote.resolve('"');
      const [ownerResult, passiveResult, explicitResult] = await Promise.all([owner.outcome, passive.outcome, explicit.outcome]);
      expect(passiveResult).toEqual(explicitResult);
      expect(explicitResult).toMatchObject({ connectionId: "conn-a", stateRevision: ownerRevision });
      if (ownerKind === "legacy") expect(ownerResult).toBeUndefined();
      else expect(ownerResult).toEqual(explicitResult);
      expect(store.activeConnectionId).toBe("conn-a");
    } finally { quote.resolve('"'); await Promise.all([owner.outcome, passive.outcome, explicit.outcome]); }
  });

  it("waits for remembered-password persistence before returning the ensure producer result", async () => {
    const { store, saveConnections, checkpoint, connectsA } = await setup();
    store.connections[0] = { ...pgConnection(), save_password: false };
    const entered = deferred<void>(); const persistence = deferred<void>();
    saveConnections.mockImplementationOnce(() => { entered.resolve(); return persistence.promise; });
    const owner = observe(store.ensureConnected("conn-a", { activate: false }));
    await entered.promise;
    const revision = store.connectionStateRevision("conn-a");
    const joined = observe(store.acquireSchemaConnection("conn-a"));
    try {
      await checkpoint();
      expect(joined.settled).toBe(false);
      expect(store.activeConnectionId).toBeNull();
      expect(connectsA()).toBe(1);
      persistence.resolve();
      expect(await owner.outcome).toBeUndefined();
      expect(await joined.outcome).toMatchObject({ connectionId: "conn-a", stateRevision: revision });
    } finally { persistence.resolve(); await Promise.all([owner.outcome, joined.outcome]); }
  });

  it("fails safely during direct-connect quote work, then acquires its completed revision", async () => {
    const { store, connectionIdentifierQuote, CONNECTION_SCHEMA_OWNER_PENDING_MESSAGE } = await setup();
    const entered = deferred<void>(); const quote = deferred<string>();
    connectionIdentifierQuote.mockImplementationOnce(() => { entered.resolve(); return quote.promise; });
    const direct = observe(store.connect(pgConnection()));
    try {
      await entered.promise;
      const revision = store.connectionStateRevision("conn-a");
      expect(store.connectedIds.has("conn-a")).toBe(true);
      await expect(store.acquireSchemaConnection("conn-a")).rejects.toThrow(CONNECTION_SCHEMA_OWNER_PENDING_MESSAGE);
      quote.resolve('"');
      expect(await direct.outcome).toBe("conn-a");
      expect(await store.acquireSchemaConnection("conn-a")).toMatchObject({ connectionId: "conn-a", stateRevision: revision });
    } finally { quote.resolve('"'); await direct.outcome; }
  });

  it("rejects old owner and joiner after close/new owner without clearing its error or activating", async () => {
    const { store, connectionIdentifierQuote, CONNECTION_ATTEMPT_CANCELLED_MESSAGE } = await setup();
    const entered = deferred<void>(); const quote = deferred<string>();
    connectionIdentifierQuote.mockImplementationOnce(() => { entered.resolve(); return quote.promise; });
    const owner = observe(store.acquireSchemaConnection("conn-a"));
    await entered.promise;
    const joined = observe(store.acquireSchemaConnection("conn-a"));
    try {
      await store.disconnect("conn-a");
      const current = await store.acquireSchemaConnection("conn-a", { activate: false });
      store.connectionErrors["conn-a"] = "newer diagnostic";
      quote.resolve('"');
      expect(await owner.outcome).toEqual(new Error(CONNECTION_ATTEMPT_CANCELLED_MESSAGE));
      expect(await joined.outcome).toBeInstanceOf(Error);
      expect(store.connectionErrors["conn-a"]).toBe("newer diagnostic");
      expect(store.activeConnectionId).toBeNull();
      expect(() => store.assertSchemaConnectionAcquisition(current)).not.toThrow();
    } finally { quote.resolve('"'); await Promise.all([owner.outcome, joined.outcome]); }
  });

  it.each(["owner", "join", "ready", "health"] as const)("returns an exact %s token which cannot adopt a later reconnect", async (branch) => {
    const { store, connectionIdentifierQuote, checkConnectionHealth } = await setup();
    let acquired: SchemaConnectionAcquisition;
    if (branch === "join") {
      const entered = deferred<void>(); const quote = deferred<string>();
      connectionIdentifierQuote.mockImplementationOnce(() => { entered.resolve(); return quote.promise; });
      const owner = observe(store.ensureConnected("conn-a", { activate: false }));
      await entered.promise;
      const joined = store.acquireSchemaConnection("conn-a", { activate: false });
      quote.resolve('"');
      acquired = await joined; await owner.outcome;
    } else if (branch === "ready" || branch === "health") {
      store.connectedIds.add("conn-a");
      acquired = await store.acquireSchemaConnection("conn-a", { activate: false, verifyHealth: branch === "health" });
      expect(checkConnectionHealth).toHaveBeenCalledTimes(branch === "health" ? 1 : 0);
    } else acquired = await store.acquireSchemaConnection("conn-a", { activate: false });
    const oldRevision = acquired.stateRevision;
    await store.disconnect("conn-a");
    const current = await store.acquireSchemaConnection("conn-a", { activate: false });
    expect(current.stateRevision).toBeGreaterThan(oldRevision);
    expect(acquired.stateRevision).toBe(oldRevision);
    expect(() => store.assertSchemaConnectionAcquisition(acquired)).toThrow();
    expect(() => store.assertSchemaConnectionAcquisition(current)).not.toThrow();
    await store.disconnect("conn-b");
    expect(() => store.assertSchemaConnectionAcquisition(current)).not.toThrow();
  });

  it("cancels an older health probe without clearing a newer active attempt or its error", async () => {
    const { store, checkConnectionHealth, connectionIdentifierQuote } = await setup();
    store.connectedIds.add("conn-a");
    const healthEntered = deferred<void>(); const health = deferred<void>();
    checkConnectionHealth.mockImplementationOnce(() => { healthEntered.resolve(); return health.promise; });
    const old = observe(store.acquireSchemaConnection("conn-a"));
    await healthEntered.promise;
    await store.disconnect("conn-a");
    const quoteEntered = deferred<void>(); const quote = deferred<string>();
    connectionIdentifierQuote.mockImplementationOnce(() => { quoteEntered.resolve(); return quote.promise; });
    const current = observe(store.acquireSchemaConnection("conn-a", { activate: false }));
    try {
      await quoteEntered.promise;
      store.connectionErrors["conn-a"] = "newer error";
      health.reject(new Error("old health failed"));
      expect(await old.outcome).toBeInstanceOf(Error);
      expect(store.connectingIds.has("conn-a")).toBe(true);
      expect(store.treeNodes.find((node) => node.connectionId === "conn-a")?.isLoading).toBe(true);
      expect(store.connectionErrors["conn-a"]).toBe("newer error");
      expect(store.activeConnectionId).toBeNull();
      quote.resolve('"'); await current.outcome;
    } finally { health.resolve(); quote.resolve('"'); await Promise.all([old.outcome, current.outcome]); }
  });

  it("does not open a prompt after cancellation during session credential lookup", async () => {
    const { store, sessionCredentialStatus, requestPassword, connectsA } = await setup();
    store.connections[0] = { ...pgConnection(), save_password: false };
    const entered = deferred<void>(); const credential = deferred<boolean>();
    sessionCredentialStatus.mockImplementationOnce(() => { entered.resolve(); return credential.promise; });
    const pending = observe(store.acquireSchemaConnection("conn-a"));
    try {
      await entered.promise;
      expect(await store.cancelConnecting("conn-a")).toBe(true);
      store.connectionErrors["conn-a"] = "newer error";
      credential.resolve(false);
      expect(await pending.outcome).toBeInstanceOf(Error);
      expect(requestPassword).not.toHaveBeenCalled();
      expect(connectsA()).toBe(0);
      expect(store.connectionErrors["conn-a"]).toBe("newer error");
    } finally { credential.resolve(false); await pending.outcome; }
  });

  it("does not revive an older pre-attempt gate after a newer reconnect cleared the close marker", async () => {
    const { store, loadConnections, connectsA, CONNECTION_ATTEMPT_CANCELLED_MESSAGE } = await setup();
    const entered = deferred<void>(); const configs = deferred<ConnectionConfig[]>();
    store.connections = [];
    loadConnections.mockImplementationOnce(() => { entered.resolve(); return configs.promise; });
    const old = observe(store.acquireSchemaConnection("conn-a"));
    try {
      await entered.promise;
      await store.disconnect("conn-a");
      store.connections = [pgConnection()];
      const current = await store.acquireSchemaConnection("conn-a", { activate: false });
      expect(store.isConnectionClosedByUser("conn-a")).toBe(false);
      store.connectionErrors["conn-a"] = "new diagnostic";
      configs.resolve([pgConnection()]);
      expect(await old.outcome).toEqual(new Error(CONNECTION_ATTEMPT_CANCELLED_MESSAGE));
      expect(connectsA()).toBe(1);
      expect(store.connectionErrors["conn-a"]).toBe("new diagnostic");
      expect(store.activeConnectionId).toBeNull();
      expect(() => store.assertSchemaConnectionAcquisition(current)).not.toThrow();
    } finally { configs.resolve([pgConnection()]); await old.outcome; }
  });

  it("does not bless a connected flag left by an incomplete superseded owner", async () => {
    const { store, connectionIdentifierQuote, connectDb, connectsA } = await setup();
    const entered = deferred<void>(); const quote = deferred<string>();
    connectionIdentifierQuote.mockImplementationOnce(() => { entered.resolve(); return quote.promise; });
    const old = observe(store.connect(pgConnection()));
    try {
      await entered.promise;
      connectDb.mockRejectedValueOnce(new Error("replacement failed"));
      await expect(store.connect(pgConnection())).rejects.toThrow("replacement failed");
      expect(store.connectedIds.has("conn-a")).toBe(true);
      quote.resolve('"'); await old.outcome;
      const failedRevision = store.connectionStateRevision("conn-a");
      const current = await store.acquireSchemaConnection("conn-a", { activate: false });
      expect(current.stateRevision).toBeGreaterThan(failedRevision);
      expect(connectsA()).toBe(3);
    } finally { quote.resolve('"'); await old.outcome; }
  });

  it.each(["owner", "join", "ready", "health"] as const)("rejects %s settlement when synchronous publication closes before the acquiring continuation", async (branch) => {
    const { store, connectionIdentifierQuote, checkConnectionHealth, CONNECTION_ATTEMPT_CANCELLED_MESSAGE } = await setup();
    const entered = deferred<void>(); const quote = deferred<string>(); const health = deferred<void>();
    let armed = true;
    let replacement: ReturnType<typeof observe> | undefined;
    const replace = () => {
      if (!armed) return;
      armed = false;
      replacement = observe(store.disconnect("conn-a").then(() => store.acquireSchemaConnection("conn-a", { activate: false })));
    };
    let owner: ReturnType<typeof observe> | undefined;
    let pending: ReturnType<typeof observe>;
    let stop: () => void;
    if (branch === "owner" || branch === "join") {
      connectionIdentifierQuote.mockImplementationOnce(() => { entered.resolve(); return quote.promise; });
      owner = observe(branch === "owner" ? store.acquireSchemaConnection("conn-a", { activate: false }) : store.ensureConnected("conn-a", { activate: false }));
      await entered.promise;
      pending = branch === "owner" ? owner : observe(store.acquireSchemaConnection("conn-a", { activate: false }));
      // finishLocalConnectionAttempt publishes retirement after the exact
      // producer has settled, before the acquisition wrapper can resume.
      stop = watch(() => store.connectingIds.has("conn-a"), (connecting, previous) => {
        if (!connecting && previous) replace();
      }, { flush: "sync" });
      quote.resolve('"');
    } else {
      store.connectedIds.add("conn-a");
      stop = watch(() => store.activeConnectionId, (active) => { if (active === "conn-a") replace(); }, { flush: "sync" });
      if (branch === "health") checkConnectionHealth.mockImplementationOnce(() => { entered.resolve(); return health.promise; });
      pending = observe(store.acquireSchemaConnection("conn-a", { verifyHealth: branch === "health" }));
      if (branch === "health") { await entered.promise; health.resolve(); }
    }
    try {
      expect(await pending.outcome).toEqual(new Error(CONNECTION_ATTEMPT_CANCELLED_MESSAGE));
      expect(replacement).toBeDefined();
      expect(await replacement!.outcome).toMatchObject({ connectionId: "conn-a" });
      expect(store.activeConnectionId).toBeNull();
      expect(store.connectedIds.has("conn-a")).toBe(true);
    } finally {
      stop(); quote.resolve('"'); health.resolve();
      await Promise.all([pending.outcome, owner?.outcome, replacement?.outcome]);
    }
  });

  it.each(["current", "replaced"] as const)("classifies a joined backend rejection against its %s owner", async (state) => {
    const { store, connectDb, CONNECTION_ATTEMPT_CANCELLED_MESSAGE } = await setup();
    const entered = deferred<void>(); const raw = deferred<string>();
    connectDb.mockImplementationOnce(() => { entered.resolve(); return raw.promise; });
    const owner = observe(store.ensureConnected("conn-a", { activate: false }));
    await entered.promise;
    const joined = observe(store.acquireSchemaConnection("conn-a"));
    try {
      if (state === "replaced") await store.connect(pgConnection());
      const before = store.connectionErrors["conn-a"];
      raw.reject(new Error("owner network failure"));
      expect(await joined.outcome).toEqual(new Error(state === "replaced" ? CONNECTION_ATTEMPT_CANCELLED_MESSAGE : "owner network failure"));
      await owner.outcome;
      if (state === "replaced") expect(store.connectionErrors["conn-a"]).toBe(before);
      else expect(store.connectionErrors["conn-a"]).toContain("owner network failure");
    } finally { raw.resolve("conn-a"); await Promise.all([owner.outcome, joined.outcome]); }
  });

  it.each(["strict", "legacy"] as const)("keeps %s late timeout cleanup attempt ownership explicit", async (kind) => {
    const { store, connectDb, disconnectDb } = await setup();
    vi.useFakeTimers();
    const oldEntered = deferred<void>(); const oldRaw = deferred<string>();
    const newEntered = deferred<void>(); const newRaw = deferred<string>();
    connectDb.mockImplementationOnce(() => { oldEntered.resolve(); return oldRaw.promise; });
    const old = observe(kind === "strict" ? store.acquireSchemaConnection("conn-a") : store.ensureConnected("conn-a"));
    await oldEntered.promise;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await old.outcome).toBeInstanceOf(Error);
    const oldAttempt = connectDb.mock.calls[0][1];
    expect(oldAttempt).toBeTypeOf("number");
    connectDb.mockImplementationOnce(() => { newEntered.resolve(); return newRaw.promise; });
    const current = observe(store.acquireSchemaConnection("conn-a", { activate: false }));
    try {
      await newEntered.promise;
      oldRaw.resolve("conn-a"); await oldRaw.promise;
      if (kind === "strict") expect(disconnectDb).toHaveBeenCalledWith("conn-a", oldAttempt);
      else expect(disconnectDb).toHaveBeenCalledWith("conn-a");
      expect(store.connectingIds.has("conn-a")).toBe(true);
      newRaw.resolve("conn-a");
      expect(await current.outcome).toMatchObject({ connectionId: "conn-a" });
    } finally { oldRaw.resolve("conn-a"); newRaw.resolve("conn-a"); await current.outcome; }
  });

  it.each(["strict", "legacy"] as const)("preserves %s late timeout error behavior without changing the other API", async (kind) => {
    const { store, connectDb } = await setup();
    vi.useFakeTimers();
    const oldEntered = deferred<void>(); const oldRaw = deferred<string>();
    const newEntered = deferred<void>(); const newRaw = deferred<string>();
    connectDb.mockImplementationOnce(() => { oldEntered.resolve(); return oldRaw.promise; });
    const old = observe(kind === "strict" ? store.acquireSchemaConnection("conn-a") : store.ensureConnected("conn-a"));
    await oldEntered.promise;
    await vi.advanceTimersByTimeAsync(120_000);
    const timeout = await old.outcome;
    expect(timeout).toBeInstanceOf(Error);
    connectDb.mockImplementationOnce(() => { newEntered.resolve(); return newRaw.promise; });
    const current = observe(store.acquireSchemaConnection("conn-a", { activate: false }));
    try {
      await newEntered.promise;
      const sameMessage = (timeout as Error).message;
      store.connectionErrors["conn-a"] = sameMessage;
      oldRaw.reject(new Error("old backend failure")); await oldRaw.promise.catch(() => undefined);
      if (kind === "strict") expect(store.connectionErrors["conn-a"]).toBe(sameMessage);
      else expect(store.connectionErrors["conn-a"]).toContain("old backend failure");
      expect(store.connectingIds.has("conn-a")).toBe(true);
      newRaw.resolve("conn-a"); await current.outcome;
    } finally { oldRaw.resolve("conn-a"); newRaw.resolve("conn-a"); await current.outcome; }
  });
});
