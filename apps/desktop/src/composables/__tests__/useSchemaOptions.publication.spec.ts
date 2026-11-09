// Prepared project regressions; UNRUN. Store and composable are real, backend I/O is synthetic.
import { createPinia, setActivePinia } from "pinia";
import { computed, watch } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig } from "@/types/database";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function pgConnection(id: string): ConnectionConfig {
  return { id, name: id, db_type: "postgres", host: "schema-memory.example.invalid", port: 5432, username: "synthetic", password: "", database: "app", read_only: false } as ConnectionConfig;
}

async function setup() {
  const connectDb = vi.fn(async (config: ConnectionConfig) => config.id);
  const disconnectDb = vi.fn().mockResolvedValue(undefined);
  const listSchemas = vi.fn().mockResolvedValue(["public"]);
  vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
  vi.doMock("@/lib/backend/api", () => ({
    checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
    connectionIdentifierQuote: vi.fn().mockResolvedValue('"'),
    connectionDatabaseInfo: vi.fn().mockResolvedValue(null),
    connectDb,
    disconnectDb,
    listSchemas,
    deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
    deleteTableVGroupsForConnection: vi.fn().mockResolvedValue(undefined),
    loadConnections: vi.fn().mockResolvedValue([pgConnection("conn-a")]),
    loadEditorSettings: vi.fn().mockResolvedValue(null),
    loadSchemaCache: vi.fn().mockResolvedValue(null),
    loadSidebarLayout: vi.fn().mockResolvedValue(null),
    loadTableVGroups: vi.fn().mockResolvedValue({}),
    loadTunnelProfiles: vi.fn().mockResolvedValue([]),
    saveConnections: vi.fn().mockResolvedValue(undefined),
    saveEditorSettings: vi.fn().mockResolvedValue(undefined),
    saveSchemaCache: vi.fn().mockResolvedValue(undefined),
    saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock("@/stores/queryStore", () => ({
    useQueryStore: () => ({
      staleConnectionDataTabMetadata: vi.fn(),
      flushPendingPersist: vi.fn().mockResolvedValue(undefined),
    }),
  }));

  const { useConnectionStore, CONNECTION_ATTEMPT_CANCELLED_MESSAGE } = await import("@/stores/connectionStore");
  const { useSchemaOptions, schemaOptionsCacheKey } = await import("@/composables/useSchemaOptions");
  const store = useConnectionStore();
  store.connections = [pgConnection("conn-a"), pgConnection("conn-b")];
  const options = useSchemaOptions();
  const key = schemaOptionsCacheKey("conn-a", "app", false);
  const started = deferred<void>();
  const response = deferred<string[]>();
  listSchemas.mockImplementationOnce(() => { started.resolve(); return response.promise; });
  return { store, options, key, connectDb, disconnectDb, listSchemas, started, response, CONNECTION_ATTEMPT_CANCELLED_MESSAGE };
}

describe("useSchemaOptions: connection revision ownership", () => {
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

  it.each([true, false])("rejects owner and joined responses after repeated close (markClosedByUser: %s), then retries explicitly", async (markClosedByUser) => {
    const { store, options, key, connectDb, listSchemas, started, response, CONNECTION_ATTEMPT_CANCELLED_MESSAGE } = await setup();
    const first = options.loadSchemaOptions("conn-a", "app");
    const joined = options.loadSchemaOptions("conn-a", "app");
    const settled = Promise.allSettled([first, joined]);
    try {
      await started.promise;
      const issuedRevision = store.connectionStateRevision("conn-a");
      const firstClose = store.disconnect("conn-a", { skipTabHandling: true, markClosedByUser });
      // Entry must invalidate before asynchronous cleanup, even for a system close.
      expect(store.connectionStateRevision("conn-a")).toBeGreaterThan(issuedRevision);
      await firstClose;
      const closedRevision = store.connectionStateRevision("conn-a");
      await store.disconnect("conn-a", { skipTabHandling: true, markClosedByUser });
      expect(store.connectionStateRevision("conn-a")).toBeGreaterThan(closedRevision);
      expect(store.isConnectionClosedByUser("conn-a")).toBe(markClosedByUser);

      response.resolve(["old-schema"]);
      expect(await settled).toEqual([
        { status: "rejected", reason: new Error(CONNECTION_ATTEMPT_CANCELLED_MESSAGE) },
        { status: "rejected", reason: new Error(CONNECTION_ATTEMPT_CANCELLED_MESSAGE) },
      ]);
      expect(Object.prototype.hasOwnProperty.call(options.schemaOptions.value, key)).toBe(false);
      expect(options.isLoadingSchemas("conn-a", "app")).toBe(false);
      expect(store.connectedIds.has("conn-a")).toBe(false);

      // Two-argument schema loads keep the existing explicit reconnect behavior.
      await options.loadSchemaOptions("conn-a", "app");
      expect(options.getSchemaOptionsForDb("conn-a", "app")).toEqual(["public"]);
      expect(connectDb).toHaveBeenCalledTimes(2);
      expect(listSchemas).toHaveBeenCalledTimes(2);
      expect(store.connectedIds.has("conn-a")).toBe(true);
      expect(store.isConnectionClosedByUser("conn-a")).toBe(false);
    } finally {
      response.resolve([]);
      await settled;
    }
  }, 20_000);

  it("rejects a late response after a new explicit attempt without a metadata-generation change", async () => {
    const { store, options, key, connectDb, listSchemas, started, response, CONNECTION_ATTEMPT_CANCELLED_MESSAGE } = await setup();
    const pending = options.loadSchemaOptions("conn-a", "app").then(() => null, (error: unknown) => error);
    try {
      await started.promise;
      const issuedRevision = store.connectionStateRevision("conn-a");
      const metadataGeneration = store.metadataGenerationFor("conn-a", "app");
      await store.ensureConnected("conn-a", { activate: false, forceReconnect: true });
      expect(store.connectionStateRevision("conn-a")).toBeGreaterThan(issuedRevision);
      expect(store.metadataGenerationFor("conn-a", "app")).toBe(metadataGeneration);
      store.connectionErrors["conn-a"] = "synthetic newer-owner error";
      const active = store.activeConnectionId;

      response.resolve(["old-schema"]);
      expect(await pending).toEqual(new Error(CONNECTION_ATTEMPT_CANCELLED_MESSAGE));
      expect(Object.prototype.hasOwnProperty.call(options.schemaOptions.value, key)).toBe(false);
      expect(options.isLoadingSchemas("conn-a", "app")).toBe(false);
      expect(store.connectedIds.has("conn-a")).toBe(true);
      expect(store.activeConnectionId).toBe(active);
      expect(store.connectionErrors["conn-a"]).toBe("synthetic newer-owner error");

      await options.loadSchemaOptions("conn-a", "app");
      expect(options.getSchemaOptionsForDb("conn-a", "app")).toEqual(["public"]);
      expect(connectDb).toHaveBeenCalledTimes(2);
      expect(listSchemas).toHaveBeenCalledTimes(2);
    } finally {
      response.resolve([]);
      await pending;
    }
  }, 20_000);

  it("keeps a successful empty response when only another connection closes", async () => {
    const { store, options, key, listSchemas, started, response } = await setup();
    const pending = options.loadSchemaOptions("conn-a", "app");
    const settled = Promise.allSettled([pending]);
    try {
      await started.promise;
      const issuedRevision = store.connectionStateRevision("conn-a");
      await store.disconnect("conn-b", { skipTabHandling: true });
      expect(store.connectionStateRevision("conn-a")).toBe(issuedRevision);
      response.resolve([]);
      expect(await settled).toEqual([{ status: "fulfilled", value: undefined }]);
      await options.loadSchemaOptions("conn-a", "app");
      expect(Object.prototype.hasOwnProperty.call(options.schemaOptions.value, key)).toBe(true);
      expect(options.getSchemaOptionsForDb("conn-a", "app")).toEqual([]);
      expect(options.isLoadingSchemas("conn-a", "app")).toBe(false);
      expect(listSchemas).toHaveBeenCalledTimes(1);
    } finally {
      response.resolve([]);
      await settled;
    }
  }, 20_000);

  const cachedResults = [{ kind: "nonempty", schemas: ["old-schema"] }, { kind: "empty", schemas: [] }];
  const cacheLifetimeCases = cachedResults.flatMap(({ kind, schemas }) =>
    (["user disconnect", "system disconnect", "close/reconnect", "force reconnect"] as const).flatMap((boundary) =>
      (["lookup", "load"] as const).map((firstRead) => ({ kind, schemas, boundary, firstRead })),
    ),
  );

  it.each(cacheLifetimeCases)("retires cached $kind after $boundary with $firstRead first, then dedupes a fresh explicit load", async ({ schemas, boundary, firstRead }) => {
    const { store, options, key, connectDb, listSchemas, response } = await setup();
    const acquireSchemaConnection = vi.spyOn(store, "acquireSchemaConnection");
    response.resolve(schemas);
    await options.loadSchemaOptions("conn-a", "app");
    const cachedRevision = store.connectionStateRevision("conn-a");
    const metadataGeneration = store.metadataGenerationFor("conn-a", "app");
    expect(options.schemaOptions.value[key]).toEqual(schemas);
    const cachedOptions = options.schemaOptions.value[key];
    expect(options.getSchemaOptionsForDb("conn-a", "app")).toBe(cachedOptions);
    await options.loadSchemaOptions("conn-a", "app");
    expect(acquireSchemaConnection.mock.calls).toEqual([["conn-a"], ["conn-a"]]);
    expect(listSchemas).toHaveBeenCalledTimes(1);

    if (boundary === "force reconnect") {
      await store.ensureConnected("conn-a", { activate: false, forceReconnect: true });
      expect(store.metadataGenerationFor("conn-a", "app")).toBe(metadataGeneration);
    } else {
      await store.disconnect("conn-a", { skipTabHandling: true, markClosedByUser: boundary !== "system disconnect" });
      if (boundary === "close/reconnect") await store.ensureConnected("conn-a", { activate: false });
    }
    expect(store.connectionStateRevision("conn-a")).toBeGreaterThan(cachedRevision);
    // Raw ref compatibility is retained; only load/get validate the nonreactive revision.
    expect(options.schemaOptions.value[key]).toEqual(schemas);
    if (firstRead === "lookup") {
      const currentOptions = options.getSchemaOptionsForDb("conn-a", "app");
      expect(currentOptions).toEqual([]);
      expect(currentOptions).not.toBe(cachedOptions);
      expect(options.schemaOptions.value[key]).toBe(cachedOptions);
    }

    acquireSchemaConnection.mockClear();
    const refreshStarted = deferred<void>();
    const refreshResponse = deferred<string[]>();
    listSchemas.mockImplementationOnce(() => { refreshStarted.resolve(); return refreshResponse.promise; });
    const first = options.loadSchemaOptions("conn-a", "app");
    const joined = options.loadSchemaOptions("conn-a", "app");
    const settled = Promise.allSettled([first, joined]);
    try {
      // Gates must allow the loads before either retires raw data. A getter
      // never mutates the cache, including while those gates are unsettled.
      expect(options.schemaOptions.value[key]).toBe(cachedOptions);
      expect(options.getSchemaOptionsForDb("conn-a", "app")).toEqual([]);
      await refreshStarted.promise;
      expect(Object.prototype.hasOwnProperty.call(options.schemaOptions.value, key)).toBe(false);
      expect(acquireSchemaConnection.mock.calls).toEqual([["conn-a"], ["conn-a"]]);
      expect(connectDb).toHaveBeenCalledTimes(2);
      expect(listSchemas).toHaveBeenCalledTimes(2);
      expect(options.isLoadingSchemas("conn-a", "app")).toBe(true);

      refreshResponse.resolve(["new-schema"]);
      expect(await settled).toEqual([{ status: "fulfilled", value: undefined }, { status: "fulfilled", value: undefined }]);
      expect(options.getSchemaOptionsForDb("conn-a", "app")).toEqual(["new-schema"]);
      expect(options.isLoadingSchemas("conn-a", "app")).toBe(false);
      expect(store.connectedIds.has("conn-a")).toBe(true);
      expect(store.isConnectionClosedByUser("conn-a")).toBe(false);
      await options.loadSchemaOptions("conn-a", "app");
      expect(acquireSchemaConnection).toHaveBeenCalledTimes(3);
      expect(listSchemas).toHaveBeenCalledTimes(2);
    } finally {
      refreshResponse.resolve([]);
      await settled;
    }
  }, 20_000);

  it("keeps cached success when only another connection changes lifetime", async () => {
    const { store, options, key, connectDb, listSchemas, response } = await setup();
    response.resolve([]);
    await options.loadSchemaOptions("conn-a", "app");
    const cachedRevision = store.connectionStateRevision("conn-a");
    await store.disconnect("conn-b", { skipTabHandling: true });
    expect(store.connectionStateRevision("conn-a")).toBe(cachedRevision);
    expect(options.getSchemaOptionsForDb("conn-a", "app")).toEqual([]);
    expect(Object.prototype.hasOwnProperty.call(options.schemaOptions.value, key)).toBe(true);
    await options.loadSchemaOptions("conn-a", "app");
    expect(listSchemas).toHaveBeenCalledTimes(1);
    expect(connectDb).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("does not replace an invalid cache with successful empty data when refresh rejects, and allows retry", async () => {
    const { store, options, key, listSchemas, response } = await setup();
    response.resolve(["old-schema"]);
    await options.loadSchemaOptions("conn-a", "app");
    await store.disconnect("conn-a", { skipTabHandling: true });
    const failure = new Error("Synthetic refresh failure");
    listSchemas.mockRejectedValueOnce(failure);
    const first = options.loadSchemaOptions("conn-a", "app");
    const joined = options.loadSchemaOptions("conn-a", "app");
    expect(await Promise.allSettled([first, joined])).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ]);
    expect(Object.prototype.hasOwnProperty.call(options.schemaOptions.value, key)).toBe(false);
    expect(options.getSchemaOptionsForDb("conn-a", "app")).toEqual([]);
    expect(options.isLoadingSchemas("conn-a", "app")).toBe(false);
    await options.loadSchemaOptions("conn-a", "app");
    expect(options.getSchemaOptionsForDb("conn-a", "app")).toEqual(["public"]);
    expect(listSchemas).toHaveBeenCalledTimes(3);
  }, 20_000);

  it.each(["lookup", "load"] as const)("does not trust an untagged raw-ref entry with %s first", async (firstRead) => {
    const { options, key, listSchemas, response } = await setup();
    options.schemaOptions.value[key] = ["external"];
    if (firstRead === "lookup") {
      expect(options.getSchemaOptionsForDb("conn-a", "app")).toEqual([]);
      expect(options.schemaOptions.value[key]).toEqual(["external"]);
    }
    response.resolve(["public"]);
    const loaded = options.loadSchemaOptions("conn-a", "app");
    expect(options.schemaOptions.value[key]).toEqual(["external"]);
    await loaded;
    expect(options.getSchemaOptionsForDb("conn-a", "app")).toEqual(["public"]);
    expect(listSchemas).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("keeps stale lookup pure and lets synchronous readers observe load retirement and publication", async () => {
    const { store, options, key, listSchemas, response } = await setup();
    response.resolve(["old-schema"]);
    await options.loadSchemaOptions("conn-a", "app");
    const acquireSchemaConnection = vi.spyOn(store, "acquireSchemaConnection");
    const observations: string[][] = [];
    const stop = watch(() => options.schemaOptions.value[key], () => {
      observations.push(options.getSchemaOptionsForDb("conn-a", "app"));
    }, { flush: "sync" });
    try {
      await store.disconnect("conn-a", { skipTabHandling: true });
      expect(observations).toEqual([]);
      expect(options.getSchemaOptionsForDb("conn-a", "app")).toEqual([]);
      expect(observations).toEqual([]);
      expect(options.schemaOptions.value[key]).toEqual(["old-schema"]);
      expect(acquireSchemaConnection).not.toHaveBeenCalled();
      expect(listSchemas).toHaveBeenCalledTimes(1);

      const loaded = options.loadSchemaOptions("conn-a", "app");
      expect(observations).toEqual([]);
      expect(options.schemaOptions.value[key]).toEqual(["old-schema"]);
      await loaded;
      expect(observations).toEqual([[], ["public"]]);
      expect(acquireSchemaConnection).toHaveBeenCalledExactlyOnceWith("conn-a");
      expect(listSchemas).toHaveBeenCalledTimes(2);
    } finally {
      stop();
    }
  }, 20_000);

  it("allows an initial passive connection without activating it, and gates cached explicit use", async () => {
    const { store, options, connectDb, listSchemas, response } = await setup();
    const acquire = vi.spyOn(store, "acquireSchemaConnection");
    store.activeConnectionId = "conn-b";
    response.resolve([]);
    await options.loadSchemaOptions("conn-a", "app", { intent: "passive" });
    expect(store.connectedIds.has("conn-a")).toBe(true);
    expect(store.activeConnectionId).toBe("conn-b");
    await options.loadSchemaOptions("conn-a", "app");
    expect(acquire.mock.calls).toEqual([["conn-a", { activate: false, skipIfClosedByUser: true }], ["conn-a"]]);
    expect(store.activeConnectionId).toBe("conn-a");
    expect(connectDb).toHaveBeenCalledTimes(1);
    expect(listSchemas).toHaveBeenCalledTimes(1);
  }, 20_000);

  it.each(cachedResults)("rejects a passive gate after close without clearing cached $kind, then reconnects explicitly", async ({ schemas }) => {
    const { store, options, key, connectDb, listSchemas, response } = await setup();
    response.resolve(schemas);
    await options.loadSchemaOptions("conn-a", "app");
    const cached = options.schemaOptions.value[key];
    await store.disconnect("conn-a", { skipTabHandling: true });
    await expect(options.loadSchemaOptions("conn-a", "app", { intent: "passive" })).rejects.toThrow("Connection was closed by the user");
    expect(options.schemaOptions.value[key]).toBe(cached);
    expect(options.getSchemaOptionsForDb("conn-a", "app")).toEqual([]);
    expect(connectDb).toHaveBeenCalledTimes(1);
    expect(listSchemas).toHaveBeenCalledTimes(1);
    expect(options.isLoadingSchemas("conn-a", "app")).toBe(false);
    await options.loadSchemaOptions("conn-a", "app", { intent: "explicit" });
    expect(options.getSchemaOptionsForDb("conn-a", "app")).toEqual(["public"]);
    expect(connectDb).toHaveBeenCalledTimes(2);
  }, 20_000);

  const replacementCases = (["success", "empty", "failure"] as const).flatMap((outcome) =>
    (["old first", "new first"] as const).map((order) => ({ outcome, order })),
  );
  it.each(replacementCases)("preserves replacement ownership after request-only cancellation: $outcome, $order", async ({ outcome, order }) => {
    const { store, options, key, connectDb, listSchemas, started, response, CONNECTION_ATTEMPT_CANCELLED_MESSAGE } = await setup();
    const old = options.loadSchemaOptions("conn-a", "app").then(() => null, (error: unknown) => error);
    const nextStarted = deferred<void>();
    const nextResponse = deferred<string[]>();
    let current: Promise<void> | undefined;
    let joined: Promise<void> | undefined;
    try {
      await started.promise;
      const revision = store.connectionStateRevision("conn-a");
      expect(await store.cancelConnecting("conn-a")).toBe(false);
      expect(store.connectionStateRevision("conn-a")).toBe(revision);
      listSchemas.mockImplementationOnce(() => { nextStarted.resolve(); return nextResponse.promise; });
      current = options.loadSchemaOptions("conn-a", "app");
      await nextStarted.promise;
      expect(listSchemas).toHaveBeenCalledTimes(2);
      store.connectionErrors["conn-a"] = "synthetic newer-owner error";
      const active = store.activeConnectionId;
      const settleOld = () => outcome === "failure" ? response.reject(new Error("Synthetic stale backend failure")) : response.resolve(outcome === "empty" ? [] : ["old-schema"]);
      if (order === "old first") {
        settleOld();
        expect(await old).toEqual(new Error(CONNECTION_ATTEMPT_CANCELLED_MESSAGE));
        expect(options.isLoadingSchemas("conn-a", "app")).toBe(true);
        joined = options.loadSchemaOptions("conn-a", "app");
        nextResponse.resolve(["new-schema"]);
        await Promise.all([current, joined]);
        expect(listSchemas).toHaveBeenCalledTimes(2);
      } else {
        nextResponse.resolve(["new-schema"]);
        await current;
        const published = options.schemaOptions.value[key];
        // A revoked backend await still owns an unsettled loading ticket.
        expect(options.isLoadingSchemas("conn-a", "app")).toBe(true);
        settleOld();
        expect(await old).toEqual(new Error(CONNECTION_ATTEMPT_CANCELLED_MESSAGE));
        expect(options.schemaOptions.value[key]).toBe(published);
      }
      expect(options.getSchemaOptionsForDb("conn-a", "app")).toEqual(["new-schema"]);
      expect(options.isLoadingSchemas("conn-a", "app")).toBe(false);
      expect(store.activeConnectionId).toBe(active);
      expect(store.connectionErrors["conn-a"]).toBe("synthetic newer-owner error");
      expect(connectDb).toHaveBeenCalledTimes(1);
    } finally {
      response.resolve([]);
      nextResponse.resolve([]);
      await Promise.allSettled([old, current, joined]);
    }
  }, 20_000);

  it("keeps successful cache lifetime separate from pending request identity", async () => {
    const { store, options, key, listSchemas, response } = await setup();
    response.resolve([]);
    await options.loadSchemaOptions("conn-a", "app");
    const cached = options.schemaOptions.value[key];
    const revision = store.connectionStateRevision("conn-a");
    expect(await store.cancelConnecting("conn-a")).toBe(false);
    expect(store.connectionStateRevision("conn-a")).toBe(revision);
    const acquire = vi.spyOn(store, "acquireSchemaConnection");
    await options.loadSchemaOptions("conn-a", "app");
    expect(acquire).toHaveBeenCalledExactlyOnceWith("conn-a");
    expect(options.getSchemaOptionsForDb("conn-a", "app")).toBe(cached);
    expect(listSchemas).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("does not promise that a nonreactive revision invalidates an already evaluated computed", async () => {
    const { store, options, response } = await setup();
    response.resolve(["old-schema"]);
    await options.loadSchemaOptions("conn-a", "app");
    const view = computed(() => options.getSchemaOptionsForDb("conn-a", "app"));
    const cached = view.value;
    await store.disconnect("conn-a", { skipTabHandling: true });
    expect(options.getSchemaOptionsForDb("conn-a", "app")).toEqual([]);
    // No reactive schema ref was changed by close or the pure getter.
    expect(view.value).toBe(cached);
  }, 20_000);

  it("captures intent before a synchronous busy observer closes the connection", async () => {
    const { store, options, listSchemas, response, CONNECTION_ATTEMPT_CANCELLED_MESSAGE } = await setup();
    await store.ensureConnected("conn-a");
    let close: Promise<void> | undefined;
    const stop = watch(() => options.isLoadingSchemas("conn-a", "app"), (busy) => {
      if (busy && !close) close = store.disconnect("conn-a", { skipTabHandling: true });
    }, { flush: "sync" });
    try {
      await expect(options.loadSchemaOptions("conn-a", "app")).rejects.toThrow(CONNECTION_ATTEMPT_CANCELLED_MESSAGE);
      await close;
      expect(listSchemas).not.toHaveBeenCalled();
      expect(store.connectedIds.has("conn-a")).toBe(false);
      expect(store.isConnectionClosedByUser("conn-a")).toBe(true);
      expect(options.isLoadingSchemas("conn-a", "app")).toBe(false);
    } finally {
      stop();
      response.resolve([]);
      await close;
    }
  }, 20_000);

  it.each(["metadata", "cache"] as const)("rechecks a %s success after a synchronous idle observer closes", async (path) => {
    const { store, options, response, CONNECTION_ATTEMPT_CANCELLED_MESSAGE } = await setup();
    response.resolve(["public"]);
    if (path === "cache") await options.loadSchemaOptions("conn-a", "app");
    let close: Promise<void> | undefined;
    const stop = watch(() => options.isLoadingSchemas("conn-a", "app"), (busy) => {
      if (!busy && !close) close = store.disconnect("conn-a", { skipTabHandling: true });
    }, { flush: "sync" });
    try {
      await expect(options.loadSchemaOptions("conn-a", "app")).rejects.toThrow(CONNECTION_ATTEMPT_CANCELLED_MESSAGE);
      await close;
      expect(store.connectedIds.has("conn-a")).toBe(false);
      expect(options.getSchemaOptionsForDb("conn-a", "app")).toEqual([]);
      expect(options.isLoadingSchemas("conn-a", "app")).toBe(false);
    } finally {
      stop();
      await close;
    }
  }, 20_000);

  it.each(["connection", "metadata", "cancelled", "empty"] as const)("keeps the real multi-target adapter honest for %s, then retries explicitly", async (outcome) => {
    const { store, connectDb, listSchemas, response, started } = await setup();
    const { useMultiDbTargetSelection } = await import("@/composables/useMultiDbTargetSelection");
    const selection = useMultiDbTargetSelection("postgres");
    const target = { connectionId: "conn-a", database: "app", schema: "public" };
    const acquire = vi.spyOn(store, "acquireSchemaConnection");
    if (outcome === "connection") connectDb.mockRejectedValueOnce(new Error("Synthetic connect failure"));
    const first = selection.loadSchemas(target).then(() => null, (error: unknown) => error);
    try {
      if (outcome !== "connection") {
        await started.promise;
        if (outcome === "cancelled") await store.disconnect("conn-a", { skipTabHandling: true });
        if (outcome === "metadata") response.reject(new Error("Synthetic metadata failure"));
        else response.resolve([]);
      }
      const error = await first;
      if (outcome === "empty") {
        expect(error).toBeNull();
        expect(selection.schemaState(target).status).toBe("loaded");
      } else {
        expect(error).toBeInstanceOf(Error);
        expect(selection.schemaState(target)).toMatchObject({ status: "error", loaded: false, loading: false });
        expect(selection.schemaNamesForTarget(target)).toEqual([]);
        // setup's first metadata response has not been used after gate failure.
        if (outcome === "connection") response.resolve(["public"]);
        await selection.loadSchemas(target);
        expect(selection.schemaState(target).status).toBe("loaded");
        expect(selection.schemaNamesForTarget(target)).toEqual(["public"]);
      }
      expect(acquire.mock.calls.every((args) => args.length === 1 && args[0] === "conn-a")).toBe(true);
      expect(listSchemas).toHaveBeenCalledTimes(outcome === "metadata" || outcome === "cancelled" ? 2 : 1);
    } finally {
      response.resolve([]);
      await first;
    }
  }, 20_000);
});
