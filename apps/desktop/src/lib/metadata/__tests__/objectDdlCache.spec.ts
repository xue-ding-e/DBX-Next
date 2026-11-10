import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTableDisplayDdl: vi.fn(),
  saveSchemaCache: vi.fn(),
  loadSchemaCache: vi.fn(),
  deleteSchemaCachePrefix: vi.fn(),
  persisted: new Map<string, unknown>(),
}));

vi.mock("@/lib/backend/api", () => mocks);

import { cancelObjectDdlLoadsForConnection, cancelObjectDdlLoadsForDatabase, getObjectDdlCacheDebugStateForTests, invalidateObjectDdl, invalidateObjectDdlCache, loadObjectDdl, objectDdlCacheKey } from "@/lib/metadata/objectDdlCache";
import { isObjectCacheInvalidationError } from "@/lib/metadata/objectCacheInvalidationError";
import { clearMetadataRuntimeCache } from "@/lib/metadata/metadataRuntimeCache";

const request = { connectionId: "c1", database: "app", schema: "public", tableName: "users", catalog: "analytics" } as const;

describe("objectDdlCache", () => {
  beforeEach(() => {
    clearMetadataRuntimeCache();
    vi.clearAllMocks();
    mocks.persisted.clear();
    mocks.loadSchemaCache.mockImplementation(async (cacheKey: string) => mocks.persisted.get(cacheKey) ?? null);
    mocks.saveSchemaCache.mockImplementation(async (cacheKey: string, payload: unknown) => {
      mocks.persisted.set(cacheKey, payload);
    });
    mocks.deleteSchemaCachePrefix.mockImplementation(async (prefix: string) => {
      for (const cacheKey of mocks.persisted.keys()) {
        if (cacheKey === prefix || cacheKey.startsWith(prefix)) mocks.persisted.delete(cacheKey);
      }
    });
  });

  it("returns persisted DDL without querying the database", async () => {
    mocks.loadSchemaCache.mockResolvedValue({ version: 1, cachedAt: new Date().toISOString(), ddl: "CREATE TABLE users (id int)" });

    await expect(loadObjectDdl(request)).resolves.toEqual({ ddl: "CREATE TABLE users (id int)", cacheStatus: "disk" });
    expect(mocks.getTableDisplayDdl).not.toHaveBeenCalled();
  });

  it("backfills memory after a disk hit", async () => {
    mocks.loadSchemaCache.mockResolvedValue({ version: 1, cachedAt: new Date().toISOString(), ddl: "CREATE TABLE users (id int)" });

    await expect(loadObjectDdl(request)).resolves.toMatchObject({ cacheStatus: "disk" });
    await expect(loadObjectDdl(request)).resolves.toMatchObject({ cacheStatus: "memory" });
    expect(mocks.loadSchemaCache).toHaveBeenCalledTimes(1);
    expect(mocks.getTableDisplayDdl).not.toHaveBeenCalled();
  });

  it("caches an empty DDL string in memory", async () => {
    mocks.getTableDisplayDdl.mockResolvedValue("");

    await expect(loadObjectDdl(request)).resolves.toEqual({ ddl: "", cacheStatus: "remote" });
    await expect(loadObjectDdl(request)).resolves.toEqual({ ddl: "", cacheStatus: "memory" });
    expect(mocks.getTableDisplayDdl).toHaveBeenCalledTimes(1);
  });

  it("persists a remote cache miss", async () => {
    mocks.getTableDisplayDdl.mockResolvedValue("CREATE TABLE users (id bigint)");

    await expect(loadObjectDdl(request)).resolves.toEqual({ ddl: "CREATE TABLE users (id bigint)", cacheStatus: "remote" });
    expect(mocks.saveSchemaCache).toHaveBeenCalledWith(objectDdlCacheKey(request), expect.objectContaining({ version: 1, ddl: "CREATE TABLE users (id bigint)" }));
  });

  it("does not wait for a slow SQLite write before returning the remote result", async () => {
    let releaseWrite: () => void = () => {};
    mocks.saveSchemaCache.mockReturnValue(
      new Promise<void>((resolve) => {
        releaseWrite = resolve;
      }),
    );
    mocks.getTableDisplayDdl.mockResolvedValue("CREATE TABLE users (id bigint)");

    await expect(loadObjectDdl(request)).resolves.toMatchObject({ ddl: "CREATE TABLE users (id bigint)", cacheStatus: "remote" });
    expect(mocks.saveSchemaCache).toHaveBeenCalledTimes(1);
    releaseWrite();
    await Promise.resolve();
    await Promise.resolve();
  });

  it("waits for a pending SQLite write before deleting an invalidated entry", async () => {
    let releaseWrite: () => void = () => {};
    mocks.saveSchemaCache.mockReturnValue(
      new Promise<void>((resolve) => {
        releaseWrite = resolve;
      }),
    );
    mocks.getTableDisplayDdl.mockResolvedValue("stale ddl");

    await loadObjectDdl(request);
    const invalidation = invalidateObjectDdl(request);
    await Promise.resolve();
    expect(mocks.deleteSchemaCachePrefix).not.toHaveBeenCalledWith(objectDdlCacheKey(request));

    releaseWrite();
    await invalidation;
    expect(mocks.deleteSchemaCachePrefix).toHaveBeenCalledWith(objectDdlCacheKey(request));
  });

  it("deduplicates concurrent remote loads", async () => {
    let release: (ddl: string) => void = () => {};
    mocks.getTableDisplayDdl.mockReturnValue(
      new Promise<string>((resolve) => {
        release = resolve;
      }),
    );

    const first = loadObjectDdl(request);
    const second = loadObjectDdl(request);
    await vi.waitFor(() => expect(mocks.getTableDisplayDdl).toHaveBeenCalledTimes(1));

    release("CREATE TABLE users (id int)");
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it("force refresh bypasses disk and overwrites it", async () => {
    mocks.loadSchemaCache.mockResolvedValue({ version: 1, cachedAt: new Date().toISOString(), ddl: "old ddl" });
    mocks.getTableDisplayDdl.mockResolvedValue("new ddl");

    await expect(loadObjectDdl(request, { force: true })).resolves.toEqual({ ddl: "new ddl", cacheStatus: "remote" });
    expect(mocks.loadSchemaCache).not.toHaveBeenCalled();
    expect(mocks.saveSchemaCache).toHaveBeenCalledWith(objectDdlCacheKey(request), expect.objectContaining({ ddl: "new ddl" }));
  });

  it("force refresh bypasses memory and replaces it", async () => {
    mocks.getTableDisplayDdl.mockResolvedValueOnce("old ddl").mockResolvedValueOnce("new ddl");

    await expect(loadObjectDdl(request)).resolves.toEqual({ ddl: "old ddl", cacheStatus: "remote" });
    await expect(loadObjectDdl(request, { force: true })).resolves.toEqual({ ddl: "new ddl", cacheStatus: "remote" });
    await expect(loadObjectDdl(request)).resolves.toEqual({ ddl: "new ddl", cacheStatus: "memory" });
    expect(mocks.getTableDisplayDdl).toHaveBeenCalledTimes(2);
  });

  it("ignores an expired persisted DDL", async () => {
    mocks.loadSchemaCache.mockResolvedValue({ version: 1, cachedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), ddl: "stale ddl" });
    mocks.getTableDisplayDdl.mockResolvedValue("fresh ddl");

    await expect(loadObjectDdl(request)).resolves.toEqual({ ddl: "fresh ddl", cacheStatus: "remote" });
    expect(mocks.getTableDisplayDdl).toHaveBeenCalledTimes(1);
  });

  it("deletes the exact persisted entry", async () => {
    await invalidateObjectDdl(request);
    expect(mocks.deleteSchemaCachePrefix).toHaveBeenCalledWith(objectDdlCacheKey(request));
  });

  it("reloads from the database after table-level persisted cache invalidation", async () => {
    mocks.getTableDisplayDdl.mockResolvedValueOnce("old ddl").mockResolvedValueOnce("new ddl");

    await expect(loadObjectDdl(request)).resolves.toEqual({ ddl: "old ddl", cacheStatus: "remote" });
    await invalidateObjectDdlCache({ connectionId: request.connectionId, database: request.database, schema: request.schema, tableName: request.tableName });
    await expect(loadObjectDdl(request)).resolves.toEqual({ ddl: "new ddl", cacheStatus: "remote" });
    expect(mocks.getTableDisplayDdl).toHaveBeenCalledTimes(2);
  });

  it("does not persist an in-flight result across invalidation", async () => {
    let release: (ddl: string) => void = () => {};
    mocks.getTableDisplayDdl.mockReturnValue(
      new Promise<string>((resolve) => {
        release = resolve;
      }),
    );
    const load = loadObjectDdl(request);
    await vi.waitFor(() => expect(mocks.getTableDisplayDdl).toHaveBeenCalledTimes(1));

    await invalidateObjectDdlCache({ connectionId: request.connectionId, database: request.database, schema: request.schema });
    release("stale ddl");
    await expect(load).resolves.toEqual({ ddl: "stale ddl", cacheStatus: "remote" });
    expect(mocks.saveSchemaCache).not.toHaveBeenCalled();
  });

  it("does not resurrect a stale disk result when invalidated during the read", async () => {
    let releaseDiskRead: (value: unknown) => void = () => {};
    mocks.loadSchemaCache.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseDiskRead = resolve;
      }),
    );
    mocks.getTableDisplayDdl.mockResolvedValue("fresh ddl");

    const load = loadObjectDdl(request);
    await vi.waitFor(() => expect(mocks.loadSchemaCache).toHaveBeenCalledTimes(1));
    const invalidation = invalidateObjectDdl(request);
    releaseDiskRead({ version: 1, cachedAt: new Date().toISOString(), ddl: "stale ddl" });

    await expect(load).resolves.toEqual({ ddl: "fresh ddl", cacheStatus: "remote" });
    await invalidation;
    expect(mocks.getTableDisplayDdl).toHaveBeenCalledTimes(1);
    expect(mocks.saveSchemaCache).toHaveBeenCalledWith(objectDdlCacheKey(request), expect.objectContaining({ ddl: "fresh ddl" }));
  });

  it("refreshing object B does not invalidate object A's concurrent disk read", async () => {
    const requestA = { ...request, tableName: "accounts" };
    const requestB = { ...request, tableName: "billing" };
    let releaseA: (value: unknown) => void = () => {};
    let releaseB: (value: unknown) => void = () => {};
    mocks.loadSchemaCache.mockImplementation((cacheKey: string) => {
      return new Promise((resolve) => {
        if (cacheKey === objectDdlCacheKey(requestA)) releaseA = resolve;
        if (cacheKey === objectDdlCacheKey(requestB)) releaseB = resolve;
      });
    });
    mocks.getTableDisplayDdl.mockImplementation(async (_connectionId: string, _database: string, _schema: string, tableName: string) => `remote ${tableName}`);

    const loadA = loadObjectDdl(requestA);
    const loadB = loadObjectDdl(requestB);
    await vi.waitFor(() => expect(mocks.loadSchemaCache).toHaveBeenCalledTimes(2));
    const invalidation = invalidateObjectDdl(requestB);
    releaseA({ version: 1, cachedAt: new Date().toISOString(), ddl: "cached accounts" });
    releaseB({ version: 1, cachedAt: new Date().toISOString(), ddl: "stale billing" });

    await expect(loadA).resolves.toEqual({ ddl: "cached accounts", cacheStatus: "disk" });
    await expect(loadB).resolves.toEqual({ ddl: "remote billing", cacheStatus: "remote" });
    await invalidation;
    expect(mocks.getTableDisplayDdl).toHaveBeenCalledTimes(1);
  });

  it("reclaims invalidation state after long-running multi-object refreshes", async () => {
    for (let index = 0; index < 2_000; index += 1) {
      await invalidateObjectDdlCache({ ...request, tableName: `history_${index}` });
    }

    expect(getObjectDdlCacheDebugStateForTests()).toEqual({ activeReads: 0, activeLoads: 0 });
  });

  it("makes a concurrent normal read wait for a force refresh", async () => {
    mocks.getTableDisplayDdl.mockResolvedValueOnce("old ddl");
    await loadObjectDdl(request);

    let releaseRemote: (value: string) => void = () => {};
    mocks.getTableDisplayDdl.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseRemote = resolve;
      }),
    );
    const force = loadObjectDdl(request, { force: true });
    const normal = loadObjectDdl(request);
    await vi.waitFor(() => expect(mocks.getTableDisplayDdl).toHaveBeenCalledTimes(2));
    releaseRemote("new ddl");

    await expect(Promise.all([force, normal])).resolves.toEqual([
      { ddl: "new ddl", cacheStatus: "remote" },
      { ddl: "new ddl", cacheStatus: "remote" },
    ]);
    expect(mocks.getTableDisplayDdl).toHaveBeenCalledTimes(2);
  });

  it("cancels an old connection load without repopulating the new session cache", async () => {
    let releaseOld: (value: string) => void = () => {};
    mocks.getTableDisplayDdl.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseOld = resolve;
      }),
    );
    const oldLoad = loadObjectDdl(request);
    await vi.waitFor(() => expect(mocks.getTableDisplayDdl).toHaveBeenCalledTimes(1));
    cancelObjectDdlLoadsForConnection(request.connectionId);
    releaseOld("old session ddl");
    await expect(oldLoad).resolves.toMatchObject({ ddl: "old session ddl" });

    mocks.getTableDisplayDdl.mockResolvedValueOnce("new session ddl");
    await expect(loadObjectDdl(request)).resolves.toMatchObject({ ddl: "new session ddl", cacheStatus: "remote" });
    expect(mocks.getTableDisplayDdl).toHaveBeenCalledTimes(2);
    expect(mocks.deleteSchemaCachePrefix).not.toHaveBeenCalledWith("object-ddl:v1:c1:");
  });

  describe("strict connection-level invalidation", () => {
    const connectionMatch = { connectionId: "c1" };

    it.each(["object-ddl:v1:c1:", "object-meta:v1:c1:"])("waits for the other namespace when %s fails", async (failedPrefix) => {
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      mocks.deleteSchemaCachePrefix.mockImplementation((prefix: string) => (prefix === failedPrefix ? Promise.reject(new Error("locked")) : pending));
      let settled = false;
      const outcome = invalidateObjectDdlCache(connectionMatch, { strict: true }).then(
        () => {
          settled = true;
          return undefined;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      await vi.waitFor(() => expect(mocks.deleteSchemaCachePrefix).toHaveBeenCalledTimes(2));
      // Drain the rejection handlers, without releasing the other deletion.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      release();
      const failure = await outcome;
      expect(isObjectCacheInvalidationError(failure)).toBe(true);
      expect(failure).toMatchObject({ scope: failedPrefix, message: "locked" });
    });

    function objectPrefixes(): string[] {
      return mocks.deleteSchemaCachePrefix.mock.calls.map(([prefix]) => prefix as string);
    }

    function rejectAllDeletions(error: Error) {
      let rejectGate: (reason: Error) => void = () => {};
      const gate = new Promise<void>((_resolve, reject) => {
        rejectGate = reject;
      });
      mocks.deleteSchemaCachePrefix.mockImplementation(() =>
        gate.then(
          () => undefined,
          () => {
            throw error;
          },
        ),
      );
      return () => rejectGate(error);
    }

    it("rejects with a marked object cache error when the persisted deletion fails", async () => {
      mocks.deleteSchemaCachePrefix.mockRejectedValue(new Error("sqlite locked"));

      const failure = await invalidateObjectDdlCache(connectionMatch, { strict: true }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect(isObjectCacheInvalidationError(failure)).toBe(true);
      expect((failure as Error).message).toBe("sqlite locked");
      // Both the DDL and the object-metadata namespace deletions were attempted.
      expect(objectPrefixes()).toContain("object-ddl:v1:c1:");
      expect(objectPrefixes()).toContain("object-meta:v1:c1:");
    });

    it("keeps default invalidation best-effort when the persisted deletion fails", async () => {
      mocks.deleteSchemaCachePrefix.mockRejectedValue(new Error("sqlite locked"));

      await expect(invalidateObjectDdlCache(connectionMatch)).resolves.toBeUndefined();
      expect(objectPrefixes()).toEqual(["object-ddl:v1:c1:", "object-meta:v1:c1:"]);
    });

    it("still rejects in strict mode when a deletion rejects without a reason", async () => {
      // A bare Promise.reject() has reason undefined; settled status, not the
      // reason's value, must decide failure.
      mocks.deleteSchemaCachePrefix.mockRejectedValue(undefined as never);

      const failure = await invalidateObjectDdlCache(connectionMatch, { strict: true }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(isObjectCacheInvalidationError(failure)).toBe(true);
    });

    it("lets a strict call sharing a pending best-effort deletion observe the failure", async () => {
      const failAll = rejectAllDeletions(new Error("disk full"));

      const bestEffort = invalidateObjectDdlCache(connectionMatch);
      const strict = invalidateObjectDdlCache(connectionMatch, { strict: true });
      // The strict call must reuse the in-flight deletions instead of starting new ones.
      await vi.waitFor(() => expect(objectPrefixes()).toEqual(["object-ddl:v1:c1:", "object-meta:v1:c1:"]));

      failAll();
      await expect(bestEffort).resolves.toBeUndefined();
      const failure = await strict.then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(isObjectCacheInvalidationError(failure)).toBe(true);
      expect((failure as Error).message).toBe("disk full");
    });

    it("retries the persisted deletion on the next strict invalidation after a failure", async () => {
      mocks.deleteSchemaCachePrefix.mockRejectedValueOnce(new Error("locked")).mockRejectedValueOnce(new Error("locked"));

      await expect(invalidateObjectDdlCache(connectionMatch, { strict: true })).rejects.toThrow("locked");

      await expect(invalidateObjectDdlCache(connectionMatch, { strict: true })).resolves.toBeUndefined();
      const prefixes = objectPrefixes();
      expect(prefixes.filter((prefix) => prefix === "object-ddl:v1:c1:")).toHaveLength(2);
      expect(prefixes.filter((prefix) => prefix === "object-meta:v1:c1:")).toHaveLength(2);
    });

    it("keeps non-force reads working when a concurrent deletion fails", async () => {
      const failAll = rejectAllDeletions(new Error("locked"));
      mocks.getTableDisplayDdl.mockResolvedValue("fresh ddl");

      const invalidation = invalidateObjectDdlCache({ connectionId: request.connectionId, database: request.database, schema: request.schema, tableName: request.tableName });
      const read = loadObjectDdl(request);
      failAll();
      await expect(read).resolves.toEqual({ ddl: "fresh ddl", cacheStatus: "remote" });
      await expect(invalidation).resolves.toBeUndefined();
    });

    it("force refresh proceeds when the persisted deletion fails", async () => {
      mocks.deleteSchemaCachePrefix.mockRejectedValue(new Error("locked"));
      mocks.getTableDisplayDdl.mockResolvedValue("new ddl");

      await expect(loadObjectDdl(request, { force: true })).resolves.toEqual({ ddl: "new ddl", cacheStatus: "remote" });
    });

    it("keeps object-level invalidation best-effort when the deletion fails", async () => {
      mocks.deleteSchemaCachePrefix.mockRejectedValue(new Error("locked"));

      await expect(invalidateObjectDdl(request)).resolves.toBeUndefined();
    });

    it("encodes connection ids and isolates similar ids in persisted deletions", async () => {
      mocks.persisted.set("object-ddl:v1:conn10:db:public:t::TABLE:", { version: 1, cachedAt: new Date().toISOString(), ddl: "conn10 ddl" });

      await invalidateObjectDdlCache({ connectionId: "conn1" });

      expect(objectPrefixes()).toContain("object-ddl:v1:conn1:");
      expect(objectPrefixes()).toContain("object-meta:v1:conn1:");
      expect([...mocks.persisted.keys()]).toContain("object-ddl:v1:conn10:db:public:t::TABLE:");

      await invalidateObjectDdlCache({ connectionId: "a:b c%中" });
      expect(mocks.deleteSchemaCachePrefix).toHaveBeenCalledWith("object-ddl:v1:a%3Ab%20c%25%E4%B8%AD:");
      expect(mocks.deleteSchemaCachePrefix).toHaveBeenCalledWith("object-meta:v1:a%3Ab%20c%25%E4%B8%AD:");
    });
  });
  describe("local cancellation lifecycle", () => {
    function deferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((done) => { resolve = done; });
      return { promise, resolve };
    }

    it.each([true, false])("stops a held L2 read (hit=%s), preserves disk and permits a fresh load", async (hit) => {
      const loader = mocks.getTableDisplayDdl;
      const disk = deferred<unknown>();
      mocks.loadSchemaCache.mockReturnValueOnce(disk.promise);
      const pending = loadObjectDdl(request);
      const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError", code: "OBJECT_CACHE_LOAD_CANCELLED" });
      await vi.waitFor(() => expect(mocks.loadSchemaCache).toHaveBeenCalledTimes(1));
      cancelObjectDdlLoadsForConnection(request.connectionId);
      disk.resolve(hit ? { version: 1, cachedAt: new Date().toISOString(), ddl: "old" } : null);
      await rejected;
      expect(loader).not.toHaveBeenCalled();
      expect(mocks.saveSchemaCache).not.toHaveBeenCalled();
      expect(mocks.deleteSchemaCachePrefix).not.toHaveBeenCalled();
      expect(getObjectDdlCacheDebugStateForTests()).toEqual({ activeReads: 0, activeLoads: 0 });
      mocks.loadSchemaCache.mockResolvedValue({ version: 1, cachedAt: new Date().toISOString(), ddl: "fresh" });
      await expect(loadObjectDdl(request)).resolves.toMatchObject({ ddl: "fresh", cacheStatus: "disk" });
    });

    it.each([false, true])("does not start work after cancellation during deletion preflight (force=%s)", async (force) => {
      const loader = mocks.getTableDisplayDdl;
      const deletion = deferred<void>();
      mocks.deleteSchemaCachePrefix.mockReturnValue(deletion.promise);
      const invalidation = force ? Promise.resolve() : invalidateObjectDdlCache({ connectionId: request.connectionId });
      const pending = loadObjectDdl(request, { force });
      const rejected = expect(pending).rejects.toMatchObject({ code: "OBJECT_CACHE_LOAD_CANCELLED" });
      await vi.waitFor(() => expect(mocks.deleteSchemaCachePrefix).toHaveBeenCalled());
      cancelObjectDdlLoadsForConnection(request.connectionId);
      deletion.resolve(undefined);
      await rejected;
      await invalidation;
      expect(mocks.loadSchemaCache).not.toHaveBeenCalled();
      expect(loader).not.toHaveBeenCalled();
      expect(mocks.saveSchemaCache).not.toHaveBeenCalled();
      expect(getObjectDdlCacheDebugStateForTests()).toEqual({ activeReads: 0, activeLoads: 0 });
    });


    it("retains cancellation identity after an invalidated read enters its retry wait", async () => {
      const loader = mocks.getTableDisplayDdl;
      const disk = deferred<unknown>();
      const deletion = deferred<void>();
      mocks.loadSchemaCache.mockReturnValueOnce(disk.promise);
      const pending = loadObjectDdl(request);
      const rejected = expect(pending).rejects.toMatchObject({ code: "OBJECT_CACHE_LOAD_CANCELLED" });
      await vi.waitFor(() => expect(mocks.loadSchemaCache).toHaveBeenCalledTimes(1));
      mocks.deleteSchemaCachePrefix.mockReturnValue(deletion.promise);
      const invalidation = invalidateObjectDdlCache({ connectionId: request.connectionId });
      disk.resolve({ version: 1, cachedAt: new Date().toISOString(), ddl: "stale" });
      await vi.waitFor(() => expect(getObjectDdlCacheDebugStateForTests()).toEqual({ activeReads: 0, activeLoads: 1 }));
      cancelObjectDdlLoadsForDatabase(request.connectionId, request.database);
      deletion.resolve(undefined);
      await rejected;
      await invalidation;
      expect(mocks.loadSchemaCache).toHaveBeenCalledTimes(1);
      expect(loader).not.toHaveBeenCalled();
      expect(mocks.saveSchemaCache).not.toHaveBeenCalled();
      expect(getObjectDdlCacheDebugStateForTests()).toEqual({ activeReads: 0, activeLoads: 0 });
    });
    it("does not cancel another database's held read", async () => {
      const loader = mocks.getTableDisplayDdl;
      const disk = deferred<unknown>();
      mocks.loadSchemaCache.mockReturnValueOnce(disk.promise);
      const pending = loadObjectDdl(request);
      await vi.waitFor(() => expect(mocks.loadSchemaCache).toHaveBeenCalledTimes(1));
      cancelObjectDdlLoadsForDatabase(request.connectionId, request.database + "2");
      disk.resolve({ version: 1, cachedAt: new Date().toISOString(), ddl: "kept" });
      await expect(pending).resolves.toMatchObject({ ddl: "kept", cacheStatus: "disk" });
      expect(loader).not.toHaveBeenCalled();
      expect(getObjectDdlCacheDebugStateForTests()).toEqual({ activeReads: 0, activeLoads: 0 });
    });

    it("keeps a newer remote owner when the cancelled old remote completes", async () => {
      const loader = mocks.getTableDisplayDdl;
      const oldRemote = deferred<string>();
      const newRemote = deferred<string>();
      loader.mockReturnValueOnce(oldRemote.promise).mockReturnValueOnce(newRemote.promise);
      const oldLoad = loadObjectDdl(request);
      await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
      cancelObjectDdlLoadsForConnection(request.connectionId);
      const newLoad = loadObjectDdl(request);
      await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
      oldRemote.resolve("old");
      await expect(oldLoad).resolves.toMatchObject({ ddl: "old" });
      expect(mocks.saveSchemaCache).not.toHaveBeenCalled();
      const joined = loadObjectDdl(request);
      await vi.waitFor(() => expect(mocks.loadSchemaCache).toHaveBeenCalledTimes(3));
      newRemote.resolve("new");
      await expect(newLoad).resolves.toMatchObject({ ddl: "new" });
      await expect(joined).resolves.toMatchObject({ ddl: "new" });
      expect(loader).toHaveBeenCalledTimes(2);
      expect(mocks.saveSchemaCache).toHaveBeenCalledTimes(1);
      expect(getObjectDdlCacheDebugStateForTests()).toEqual({ activeReads: 0, activeLoads: 0 });
    });

    it("does not register a remote cancelled synchronously inside its loader", async () => {
      const loader = mocks.getTableDisplayDdl;
      const oldRemote = deferred<string>();
      loader.mockImplementationOnce(() => {
        cancelObjectDdlLoadsForConnection(request.connectionId);
        return oldRemote.promise;
      }).mockResolvedValueOnce("new");
      const oldLoad = loadObjectDdl(request);
      await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
      await expect(loadObjectDdl(request)).resolves.toMatchObject({ ddl: "new" });
      oldRemote.resolve("old");
      await expect(oldLoad).resolves.toMatchObject({ ddl: "old" });
      await expect(loadObjectDdl(request)).resolves.toMatchObject({ ddl: "new", cacheStatus: "memory" });
      expect(loader).toHaveBeenCalledTimes(2);
      expect(mocks.saveSchemaCache).toHaveBeenCalledTimes(1);
      expect(getObjectDdlCacheDebugStateForTests()).toEqual({ activeReads: 0, activeLoads: 0 });
    });
  });

});

