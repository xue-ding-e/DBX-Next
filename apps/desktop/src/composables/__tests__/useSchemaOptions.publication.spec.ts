// Prepared project regressions; UNRUN. Store and composable are real, backend I/O is synthetic.
import { createPinia, setActivePinia } from "pinia";
import { watch } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig } from "@/types/database";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
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
    const ensureConnected = vi.spyOn(store, "ensureConnected");
    response.resolve(schemas);
    await options.loadSchemaOptions("conn-a", "app");
    const cachedRevision = store.connectionStateRevision("conn-a");
    const metadataGeneration = store.metadataGenerationFor("conn-a", "app");
    expect(options.schemaOptions.value[key]).toEqual(schemas);
    const cachedOptions = options.schemaOptions.value[key];
    expect(options.getSchemaOptionsForDb("conn-a", "app")).toBe(cachedOptions);
    await options.loadSchemaOptions("conn-a", "app");
    expect(ensureConnected).toHaveBeenCalledExactlyOnceWith("conn-a");
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

    ensureConnected.mockClear();
    const refreshStarted = deferred<void>();
    const refreshResponse = deferred<string[]>();
    listSchemas.mockImplementationOnce(() => { refreshStarted.resolve(); return refreshResponse.promise; });
    const first = options.loadSchemaOptions("conn-a", "app");
    const joined = options.loadSchemaOptions("conn-a", "app");
    const settled = Promise.allSettled([first, joined]);
    try {
      // Both paths retire raw data on load; a getter never mutates the cache.
      expect(Object.prototype.hasOwnProperty.call(options.schemaOptions.value, key)).toBe(false);
      expect(options.getSchemaOptionsForDb("conn-a", "app")).toEqual([]);
      await refreshStarted.promise;
      expect(ensureConnected).toHaveBeenCalledExactlyOnceWith("conn-a");
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
      expect(ensureConnected).toHaveBeenCalledTimes(1);
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
    expect(Object.prototype.hasOwnProperty.call(options.schemaOptions.value, key)).toBe(false);
    await loaded;
    expect(options.getSchemaOptionsForDb("conn-a", "app")).toEqual(["public"]);
    expect(listSchemas).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("keeps stale lookup pure and lets synchronous readers observe load retirement and publication", async () => {
    const { store, options, key, listSchemas, response } = await setup();
    response.resolve(["old-schema"]);
    await options.loadSchemaOptions("conn-a", "app");
    const ensureConnected = vi.spyOn(store, "ensureConnected");
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
      expect(ensureConnected).not.toHaveBeenCalled();
      expect(listSchemas).toHaveBeenCalledTimes(1);

      const loaded = options.loadSchemaOptions("conn-a", "app");
      expect(observations).toEqual([[]]);
      expect(Object.prototype.hasOwnProperty.call(options.schemaOptions.value, key)).toBe(false);
      await loaded;
      expect(observations).toEqual([[], ["public"]]);
      expect(ensureConnected).toHaveBeenCalledExactlyOnceWith("conn-a");
      expect(listSchemas).toHaveBeenCalledTimes(2);
    } finally {
      stop();
    }
  }, 20_000);
});
