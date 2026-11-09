// Prepared project regressions; UNRUN. Store and composable are real, backend I/O is synthetic.
import { createPinia, setActivePinia } from "pinia";
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

describe("useSchemaOptions: issued-response ownership", () => {
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
});
