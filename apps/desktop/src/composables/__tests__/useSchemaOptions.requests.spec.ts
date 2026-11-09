// Prepared regression tests; UNRUN. Separate from the Node function-slice evidence.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { schemaOptionsCacheKey, useSchemaOptions } from "@/composables/useSchemaOptions";
import type { SchemaConnectionAcquisition } from "@/stores/connectionStore";

const mocks = vi.hoisted(() => ({
  acquireSchemaConnection: vi.fn(),
  assertSchemaConnectionAcquisition: vi.fn(),
  connectionStateRevision: vi.fn(),
  requestRevision: vi.fn(),
  listSchemas: vi.fn(),
}));

vi.mock("@/stores/connectionStore", () => ({
  CONNECTION_ATTEMPT_CANCELLED_MESSAGE: "Connection attempt was cancelled",
  useConnectionStore: () => ({
    getConfig: () => ({ db_type: "postgres", show_system_schemas: false }),
    acquireSchemaConnection: mocks.acquireSchemaConnection,
    assertSchemaConnectionAcquisition: mocks.assertSchemaConnectionAcquisition,
    connectionStateRevision: mocks.connectionStateRevision,
  }),
}));

vi.mock("@/lib/backend/api", () => ({ listSchemas: mocks.listSchemas }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function acquisition(connectionId: string): SchemaConnectionAcquisition {
  return Object.freeze({ connectionId, stateRevision: mocks.connectionStateRevision(), requestRevision: mocks.requestRevision() });
}

describe("useSchemaOptions request settlement", () => {
  const connectionId = "memory-connection";
  const database = "memory-database";
  const key = schemaOptionsCacheKey(connectionId, database, false);

  beforeEach(() => {
    mocks.connectionStateRevision.mockReset().mockReturnValue(1);
    mocks.requestRevision.mockReset().mockReturnValue(1);
    mocks.acquireSchemaConnection.mockReset().mockImplementation(async (id: string) => acquisition(id));
    mocks.assertSchemaConnectionAcquisition.mockReset().mockImplementation((token: SchemaConnectionAcquisition) => {
      if (token.connectionId !== connectionId || token.stateRevision !== mocks.connectionStateRevision() || token.requestRevision !== mocks.requestRevision()) {
        throw new Error("Connection attempt was cancelled");
      }
    });
    mocks.listSchemas.mockReset().mockResolvedValue(["public"]);
  });

  it.each(["connection", "schema"] as const)("retries after a rejected %s request without caching a successful empty result", async (failureAt) => {
    const failure = new Error("Synthetic request failure");
    if (failureAt === "connection") mocks.acquireSchemaConnection.mockRejectedValueOnce(failure);
    else mocks.listSchemas.mockRejectedValueOnce(failure);
    const options = useSchemaOptions();

    await expect(options.loadSchemaOptions(connectionId, database)).rejects.toBe(failure);
    expect(Object.prototype.hasOwnProperty.call(options.schemaOptions.value, key)).toBe(false);
    expect(options.isLoadingSchemas(connectionId, database)).toBe(false);

    await options.loadSchemaOptions(connectionId, database);
    expect(mocks.acquireSchemaConnection).toHaveBeenCalledTimes(2);
    expect(mocks.listSchemas).toHaveBeenCalledTimes(failureAt === "connection" ? 1 : 2);
    expect(options.getSchemaOptionsForDb(connectionId, database)).toEqual(["public"]);
    expect(options.isLoadingSchemas(connectionId, database)).toBe(false);
  });

  it.each([{ schemas: [] }, { schemas: ["public"] }])("gates even a genuinely successful cached response $schemas", async ({ schemas }) => {
    mocks.listSchemas.mockResolvedValue(schemas);
    const options = useSchemaOptions();
    await options.loadSchemaOptions(connectionId, database);
    const cached = options.schemaOptions.value[key];
    await options.loadSchemaOptions(connectionId, database, { intent: "passive" });

    expect(Object.prototype.hasOwnProperty.call(options.schemaOptions.value, key)).toBe(true);
    expect(options.getSchemaOptionsForDb(connectionId, database)).toBe(cached);
    expect(mocks.acquireSchemaConnection.mock.calls).toEqual([[connectionId], [connectionId, { activate: false, skipIfClosedByUser: true }]]);
    expect(mocks.listSchemas).toHaveBeenCalledTimes(1);
    expect(options.isLoadingSchemas(connectionId, database)).toBe(false);
  });

  it("gates both callers synchronously but shares metadata for distinct equal-value tokens", async () => {
    const response = deferred<string[]>();
    const entered = deferred<void>();
    mocks.listSchemas.mockImplementationOnce(() => { entered.resolve(); return response.promise; });
    const tokens: SchemaConnectionAcquisition[] = [];
    mocks.acquireSchemaConnection.mockImplementation(async (id: string) => {
      const token = acquisition(id);
      tokens.push(token);
      return token;
    });
    const options = useSchemaOptions();
    const first = options.loadSchemaOptions(connectionId, database, { intent: "passive" });
    const joined = options.loadSchemaOptions(connectionId, database);
    const settled = Promise.allSettled([first, joined]);
    expect(mocks.acquireSchemaConnection).toHaveBeenCalledTimes(2);
    expect(tokens[0]).not.toBe(tokens[1]);
    expect(tokens[0]).toEqual(tokens[1]);
    await entered.promise;

    expect(mocks.listSchemas).toHaveBeenCalledTimes(1);
    expect(options.isLoadingSchemas(connectionId, database)).toBe(true);
    const failure = new Error("Synthetic cancelled request");
    response.reject(failure);
    expect(await settled).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ]);
    expect(options.isLoadingSchemas(connectionId, database)).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(options.schemaOptions.value, key)).toBe(false);

    await options.loadSchemaOptions(connectionId, database);
    expect(mocks.acquireSchemaConnection).toHaveBeenCalledTimes(3);
    expect(mocks.listSchemas).toHaveBeenCalledTimes(2);
    expect(options.getSchemaOptionsForDb(connectionId, database)).toEqual(["public"]);
  });

  it.each([{ schemas: ["old-schema"] }, { schemas: [] }])("does not cache a late successful response $schemas after the issued revision changes", async ({ schemas }) => {
    const response = deferred<string[]>();
    const entered = deferred<void>();
    mocks.listSchemas.mockImplementationOnce(() => { entered.resolve(); return response.promise; });
    const options = useSchemaOptions();
    const first = options.loadSchemaOptions(connectionId, database);
    const joined = options.loadSchemaOptions(connectionId, database);
    const settled = Promise.allSettled([first, joined]);
    await entered.promise;
    expect(mocks.listSchemas).toHaveBeenCalledTimes(1);

    mocks.connectionStateRevision.mockReturnValue(2);
    response.resolve(schemas);
    expect(await settled).toEqual([
      { status: "rejected", reason: new Error("Connection attempt was cancelled") },
      { status: "rejected", reason: new Error("Connection attempt was cancelled") },
    ]);
    expect(Object.prototype.hasOwnProperty.call(options.schemaOptions.value, key)).toBe(false);
    expect(options.isLoadingSchemas(connectionId, database)).toBe(false);

    await options.loadSchemaOptions(connectionId, database);
    expect(mocks.acquireSchemaConnection.mock.calls).toEqual([[connectionId], [connectionId], [connectionId]]);
    expect(mocks.listSchemas).toHaveBeenCalledTimes(2);
    expect(options.getSchemaOptionsForDb(connectionId, database)).toEqual(["public"]);
  });

  it("uses its gate's returned token without resnapshotting a newer session", async () => {
    const delivered = deferred<SchemaConnectionAcquisition>();
    const token = acquisition(connectionId);
    mocks.acquireSchemaConnection.mockReturnValueOnce(delivered.promise);
    const options = useSchemaOptions();
    const settled = Promise.allSettled([options.loadSchemaOptions(connectionId, database)]);
    mocks.connectionStateRevision.mockReturnValue(2);
    delivered.resolve(token);
    expect(await settled).toEqual([{ status: "rejected", reason: new Error("Connection attempt was cancelled") }]);
    expect(mocks.listSchemas).not.toHaveBeenCalled();
    expect(options.isLoadingSchemas(connectionId, database)).toBe(false);
  });

  it("accepts the revision returned by its own newly completed connection", async () => {
    mocks.acquireSchemaConnection.mockImplementationOnce(async (id: string) => {
      mocks.connectionStateRevision.mockReturnValue(2);
      return acquisition(id);
    });
    const options = useSchemaOptions();
    await options.loadSchemaOptions(connectionId, database);
    expect(mocks.acquireSchemaConnection).toHaveBeenCalledExactlyOnceWith(connectionId);
    expect(options.getSchemaOptionsForDb(connectionId, database)).toEqual(["public"]);
  });

  it.each(["sync throw", "resolved"] as const)("registers and cleans the producer safely for %s metadata", async (outcome) => {
    const failure = new Error("Synthetic synchronous metadata failure");
    mocks.listSchemas.mockImplementationOnce(() => {
      if (outcome === "sync throw") throw failure;
      return Promise.resolve(["public"]);
    });
    const options = useSchemaOptions();
    const settled = await Promise.allSettled([options.loadSchemaOptions(connectionId, database), options.loadSchemaOptions(connectionId, database)]);
    expect(settled).toEqual(outcome === "sync throw"
      ? [{ status: "rejected", reason: failure }, { status: "rejected", reason: failure }]
      : [{ status: "fulfilled", value: undefined }, { status: "fulfilled", value: undefined }]);
    expect(mocks.listSchemas).toHaveBeenCalledTimes(1);
    expect(options.isLoadingSchemas(connectionId, database)).toBe(false);
    await options.loadSchemaOptions(connectionId, database);
    expect(mocks.listSchemas).toHaveBeenCalledTimes(outcome === "sync throw" ? 2 : 1);
  });

  it("does not let a rejected passive gate occupy an explicit metadata request", async () => {
    const failure = new Error("Connection was closed by the user");
    mocks.acquireSchemaConnection.mockImplementation(async (id: string, options?: { skipIfClosedByUser?: boolean }) => {
      if (options?.skipIfClosedByUser) throw failure;
      return acquisition(id);
    });
    const options = useSchemaOptions();
    const settled = Promise.allSettled([
      options.loadSchemaOptions(connectionId, database, { intent: "passive" }),
      options.loadSchemaOptions(connectionId, database, { intent: "explicit" }),
    ]);
    expect(mocks.acquireSchemaConnection).toHaveBeenCalledTimes(2);
    expect(await settled).toEqual([{ status: "rejected", reason: failure }, { status: "fulfilled", value: undefined }]);
    expect(mocks.listSchemas).toHaveBeenCalledTimes(1);
    expect(options.getSchemaOptionsForDb(connectionId, database)).toEqual(["public"]);
  });
});
