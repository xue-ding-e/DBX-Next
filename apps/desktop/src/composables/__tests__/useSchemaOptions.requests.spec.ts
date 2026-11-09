// Prepared regression tests; UNRUN. Separate from the Node function-slice evidence.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { schemaOptionsCacheKey, useSchemaOptions } from "@/composables/useSchemaOptions";

const mocks = vi.hoisted(() => ({
  ensureConnected: vi.fn(),
  connectionStateRevision: vi.fn(),
  listSchemas: vi.fn(),
}));

vi.mock("@/stores/connectionStore", () => ({
  CONNECTION_ATTEMPT_CANCELLED_MESSAGE: "Connection attempt was cancelled",
  useConnectionStore: () => ({
    getConfig: () => ({ db_type: "postgres", show_system_schemas: false }),
    ensureConnected: mocks.ensureConnected,
    connectionStateRevision: mocks.connectionStateRevision,
  }),
}));

vi.mock("@/lib/backend/api", () => ({ listSchemas: mocks.listSchemas }));

describe("useSchemaOptions request settlement", () => {
  const connectionId = "memory-connection";
  const database = "memory-database";
  const key = schemaOptionsCacheKey(connectionId, database, false);

  beforeEach(() => {
    mocks.ensureConnected.mockReset().mockResolvedValue(undefined);
    mocks.connectionStateRevision.mockReset().mockReturnValue(1);
    mocks.listSchemas.mockReset().mockResolvedValue(["public"]);
  });

  it.each(["connection", "schema"] as const)("retries after a rejected %s request without caching a successful empty result", async (failureAt) => {
    const failure = new Error("Synthetic request failure");
    if (failureAt === "connection") mocks.ensureConnected.mockRejectedValueOnce(failure);
    else mocks.listSchemas.mockRejectedValueOnce(failure);
    const options = useSchemaOptions();

    await expect(options.loadSchemaOptions(connectionId, database)).rejects.toBe(failure);
    expect(Object.prototype.hasOwnProperty.call(options.schemaOptions.value, key)).toBe(false);
    expect(options.isLoadingSchemas(connectionId, database)).toBe(false);

    await options.loadSchemaOptions(connectionId, database);
    expect(mocks.ensureConnected).toHaveBeenCalledTimes(2);
    expect(mocks.listSchemas).toHaveBeenCalledTimes(failureAt === "connection" ? 1 : 2);
    expect(options.getSchemaOptionsForDb(connectionId, database)).toEqual(["public"]);
    expect(options.isLoadingSchemas(connectionId, database)).toBe(false);
  });

  it("caches a genuinely successful empty response", async () => {
    mocks.listSchemas.mockResolvedValue([]);
    const options = useSchemaOptions();
    await options.loadSchemaOptions(connectionId, database);
    await options.loadSchemaOptions(connectionId, database);

    expect(Object.prototype.hasOwnProperty.call(options.schemaOptions.value, key)).toBe(true);
    expect(options.getSchemaOptionsForDb(connectionId, database)).toEqual([]);
    expect(mocks.ensureConnected).toHaveBeenCalledTimes(1);
    expect(mocks.listSchemas).toHaveBeenCalledTimes(1);
    expect(options.isLoadingSchemas(connectionId, database)).toBe(false);
  });

  it("dedupes the same key and rejects every waiter before allowing a retry", async () => {
    let rejectRequest!: (error: Error) => void;
    const request = new Promise<string[]>((_resolve, reject) => {
      rejectRequest = reject;
    });
    mocks.listSchemas.mockReturnValueOnce(request);
    const options = useSchemaOptions();
    const first = options.loadSchemaOptions(connectionId, database);
    const joined = options.loadSchemaOptions(connectionId, database);
    const settled = Promise.allSettled([first, joined]);
    await Promise.resolve();

    expect(mocks.ensureConnected).toHaveBeenCalledTimes(1);
    expect(mocks.listSchemas).toHaveBeenCalledTimes(1);
    expect(options.isLoadingSchemas(connectionId, database)).toBe(true);
    const failure = new Error("Synthetic cancelled request");
    rejectRequest(failure);
    expect(await settled).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ]);
    expect(options.isLoadingSchemas(connectionId, database)).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(options.schemaOptions.value, key)).toBe(false);

    await options.loadSchemaOptions(connectionId, database);
    expect(mocks.ensureConnected).toHaveBeenCalledTimes(2);
    expect(mocks.listSchemas).toHaveBeenCalledTimes(2);
    expect(options.getSchemaOptionsForDb(connectionId, database)).toEqual(["public"]);
  });

  it.each([{ schemas: ["old-schema"] }, { schemas: [] }])("does not cache a late successful response $schemas after the issued revision changes", async ({ schemas }) => {
    let resolveRequest!: (value: string[]) => void;
    mocks.listSchemas.mockReturnValueOnce(new Promise<string[]>((resolve) => { resolveRequest = resolve; }));
    const options = useSchemaOptions();
    const first = options.loadSchemaOptions(connectionId, database);
    const joined = options.loadSchemaOptions(connectionId, database);
    const settled = Promise.allSettled([first, joined]);
    await Promise.resolve();
    expect(mocks.listSchemas).toHaveBeenCalledTimes(1);

    mocks.connectionStateRevision.mockReturnValue(2);
    resolveRequest(schemas);
    expect(await settled).toEqual([
      { status: "rejected", reason: new Error("Connection attempt was cancelled") },
      { status: "rejected", reason: new Error("Connection attempt was cancelled") },
    ]);
    expect(Object.prototype.hasOwnProperty.call(options.schemaOptions.value, key)).toBe(false);
    expect(options.isLoadingSchemas(connectionId, database)).toBe(false);

    await options.loadSchemaOptions(connectionId, database);
    expect(mocks.ensureConnected).toHaveBeenCalledTimes(2);
    expect(mocks.ensureConnected.mock.calls).toEqual([[connectionId], [connectionId]]);
    expect(mocks.listSchemas).toHaveBeenCalledTimes(2);
    expect(options.getSchemaOptionsForDb(connectionId, database)).toEqual(["public"]);
  });

  it("captures the epoch at API issue after its own successful connection attempt", async () => {
    mocks.ensureConnected.mockImplementationOnce(async () => { mocks.connectionStateRevision.mockReturnValue(2); });
    const options = useSchemaOptions();
    await options.loadSchemaOptions(connectionId, database);

    expect(mocks.ensureConnected).toHaveBeenCalledExactlyOnceWith(connectionId);
    expect(mocks.connectionStateRevision).toHaveBeenCalledTimes(2);
    expect(options.getSchemaOptionsForDb(connectionId, database)).toEqual(["public"]);
  });
});
