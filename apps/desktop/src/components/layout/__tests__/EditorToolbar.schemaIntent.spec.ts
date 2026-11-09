// @vitest-environment happy-dom
// Prepared integration regressions; UNRUN. Real toolbar, schema composable,
// capability helpers and Pinia store; all persistence/backend calls stay in memory.
// Isolated from EditorToolbar.mount.spec.ts so its QueryEditor tests retain their fixtures.
import { createApp, h, nextTick, ref, type PropType } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig, QueryTab } from "@/types/database";

vi.mock("@/components/ui/button", () => ({ Button: { template: `<button><slot /></button>` } }));
vi.mock("@/components/ui/searchable-select", () => ({
  SearchableSelect: {
    name: "SearchableSelectStub",
    props: {
      placeholder: String,
      options: { type: Array as PropType<string[]>, default: () => [] },
      loading: Boolean,
      modelValue: String,
    },
    emits: ["update:open", "update:modelValue"],
    // Emit the actual public event. The placeholder identifies the schema
    // selector, so a database or catalog control cannot satisfy these tests.
    template: `<div :data-selector="placeholder" :data-options="JSON.stringify(options)" :data-loading="String(loading)">
      <button data-open @click="$emit('update:open', true)">Open</button>
      <button data-close @click="$emit('update:open', false)">Close</button>
    </div>`,
  },
}));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: { template: `<span><slot /></span>` },
  TooltipTrigger: { template: `<span><slot /></span>` },
  TooltipContent: { template: `<span><slot /></span>` },
}));
vi.mock("@/components/ui/TruncatedTextTooltip.vue", () => ({ default: { template: `<span />` } }));
vi.mock("@/components/icons/DatabaseIcon.vue", () => ({ default: { template: `<span />` } }));
vi.mock("@/components/connection/ConnectionTreeSelect.vue", () => ({ default: { template: `<div />` } }));
vi.mock("@/components/common/ProductionContextBadge.vue", () => ({ default: { template: `<span />` } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function connection(id: string): ConnectionConfig {
  return { id, name: id, db_type: "postgres", host: "toolbar-memory.example.invalid", port: 5432, username: "synthetic", password: "", database: "app", read_only: false } as ConnectionConfig;
}

async function setup() {
  const connectDb = vi.fn(async (config: ConnectionConfig) => config.id);
  const listSchemas = vi.fn().mockResolvedValue(["public"]);
  vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
  vi.doMock("@/lib/backend/api", () => ({
    checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
    connectionIdentifierQuote: vi.fn().mockResolvedValue('"'),
    connectionDatabaseInfo: vi.fn().mockResolvedValue(null),
    connectDb,
    disconnectDb: vi.fn().mockResolvedValue(undefined),
    listSchemas,
    listDatabases: vi.fn().mockResolvedValue([{ name: "app" }]),
    deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
    deleteTableVGroupsForConnection: vi.fn().mockResolvedValue(undefined),
    loadConnections: vi.fn().mockResolvedValue([]),
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
      isTabDirty: vi.fn().mockReturnValue(false),
      refreshObjectSourceTab: vi.fn(),
    }),
  }));
  const { useConnectionStore } = await import("@/stores/connectionStore");
  const { default: EditorToolbar } = await import("../EditorToolbar.vue");
  const store = useConnectionStore();
  store.connections = [connection("conn-a"), connection("conn-b")];
  store.activeConnectionId = "conn-b";
  const acquire = vi.spyOn(store, "acquireSchemaConnection");
  const activeConnection = ref<ConnectionConfig | undefined>(store.getConfig("conn-a"));
  const activeTab = ref<QueryTab>({ id: "schema-tab", title: "SQL", connectionId: "conn-a", database: "app", sql: "SELECT 1", mode: "query", isExecuting: false, isCancelling: false, isExplaining: false } as QueryTab);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const errors: unknown[] = [];
  const unhandled: unknown[] = [];
  const observeRejection = (event: PromiseRejectionEvent) => { unhandled.push(event.reason); };
  window.addEventListener("unhandledrejection", observeRejection);
  let mounts = 0;
  const app = createApp({
    setup: () => () => h(EditorToolbar, {
      activeTab: activeTab.value,
      activeConnection: activeConnection.value,
      executableSql: "SELECT 1",
      sqlKeywordCase: "preserve",
      autoCommit: true,
      onVnodeMounted: () => { mounts += 1; },
    }),
  });
  app.config.errorHandler = (error) => { errors.push(error); };
  app.use(pinia!);
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} } }));
  const mount = () => app.mount(host);
  const selector = () => host.querySelector<HTMLElement>('[data-selector="editor.selectSchema"]');
  const waitForOptions = async (schemas: string[]) => {
    await vi.waitFor(() => {
      expect(selector()?.dataset.options).toBe(JSON.stringify(schemas));
      expect(selector()?.dataset.loading).toBe("false");
    });
  };
  const cleanup = () => {
    app.unmount();
    host.remove();
    window.removeEventListener("unhandledrejection", observeRejection);
    expect(errors).toEqual([]);
    expect(unhandled).toEqual([]);
  };
  return { store, connectDb, listSchemas, acquire, activeConnection, activeTab, mount, selector, waitForOptions, cleanup, mounts: () => mounts };
}

let pinia: ReturnType<typeof createPinia>;
describe("EditorToolbar schema acquisition intent", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.body.innerHTML = "";
    const data = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key: string) => data.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => data.set(key, value)),
      removeItem: vi.fn((key: string) => data.delete(key)),
    });
    // Layout measurement is not under test; do not enqueue animation work.
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    pinia = createPinia();
    setActivePinia(pinia);
  });

  it.each([{ schemas: ["public"] }, { schemas: [] }])("keeps a long-lived toolbar closed after away/back with cached $schemas, then opens explicitly", async ({ schemas }) => {
    const fixture = await setup();
    const { store, connectDb, listSchemas, acquire, activeConnection, selector, waitForOptions } = fixture;
    listSchemas.mockResolvedValueOnce(schemas);
    fixture.mount();
    try {
      await waitForOptions(schemas);
      expect(store.activeConnectionId).toBe("conn-b");
      expect(acquire.mock.calls).toEqual([["conn-a", { activate: false, skipIfClosedByUser: true }]]);
      await store.disconnect("conn-a", { skipTabHandling: true });
      activeConnection.value = undefined;
      await nextTick();
      activeConnection.value = store.getConfig("conn-a");
      await nextTick();
      await Promise.allSettled(acquire.mock.results.map((result) => result.value));
      await waitForOptions([]);
      expect(fixture.mounts()).toBe(1);
      expect(store.isConnectionClosedByUser("conn-a")).toBe(true);
      expect(store.connectedIds.has("conn-a")).toBe(false);
      expect(connectDb).toHaveBeenCalledTimes(1);
      expect(listSchemas).toHaveBeenCalledTimes(1);
      expect(acquire).toHaveBeenCalledTimes(2);

      selector()!.querySelector<HTMLButtonElement>("[data-close]")!.click();
      await nextTick();
      expect(acquire).toHaveBeenCalledTimes(2);
      selector()!.querySelector<HTMLButtonElement>("[data-open]")!.click();
      await waitForOptions(["public"]);
      expect(acquire.mock.calls[2]).toEqual(["conn-a"]);
      expect(connectDb).toHaveBeenCalledTimes(2);
      expect(listSchemas).toHaveBeenCalledTimes(2);
      expect(store.activeConnectionId).toBe("conn-a");
      expect(store.isConnectionClosedByUser("conn-a")).toBe(false);
      expect(fixture.mounts()).toBe(1);
    } finally {
      fixture.cleanup();
    }
  }, 20_000);

  it("watches schema inputs without feeding loading/cache/error/close changes back into the loader", async () => {
    const fixture = await setup();
    const { store, acquire, listSchemas, activeConnection, activeTab, waitForOptions } = fixture;
    fixture.mount();
    try {
      await waitForOptions(["public"]);
      expect(acquire).toHaveBeenCalledTimes(1);
      store.connectionErrors["conn-b"] = "unrelated synthetic error";
      store.getConfig("conn-a")!.name = "renamed";
      await nextTick();
      expect(acquire).toHaveBeenCalledTimes(1);

      const replacement = { ...store.getConfig("conn-a")!, name: "replacement" };
      store.connections = [replacement, store.getConfig("conn-b")!];
      await nextTick();
      await Promise.allSettled(acquire.mock.results.map((result) => result.value));
      expect(acquire).toHaveBeenCalledTimes(2);
      expect(listSchemas).toHaveBeenCalledTimes(1);
      // Keep the prop object stable: the watcher must also track store config.
      store.getConfig("conn-a")!.show_system_schemas = true;
      await nextTick();
      await waitForOptions(["public"]);
      expect(acquire).toHaveBeenCalledTimes(3);
      expect(listSchemas).toHaveBeenCalledTimes(2);

      activeTab.value.database = "other";
      await nextTick();
      await waitForOptions(["public"]);
      expect(acquire).toHaveBeenCalledTimes(4);
      expect(listSchemas).toHaveBeenLastCalledWith("conn-a", "other");
      expect(acquire.mock.calls.every((args) => args[1]?.activate === false && args[1]?.skipIfClosedByUser === true)).toBe(true);
      await store.disconnect("conn-a", { skipTabHandling: true });
      await nextTick();
      expect(acquire).toHaveBeenCalledTimes(4);
      expect(activeConnection.value?.id).toBe("conn-a");
    } finally {
      fixture.cleanup();
    }
  }, 20_000);

  it("opens explicitly while the initial passive gate is pending, sharing only ready metadata", async () => {
    const fixture = await setup();
    const response = deferred<string>();
    const entered = deferred<void>();
    fixture.connectDb.mockImplementationOnce(() => { entered.resolve(); return response.promise; });
    fixture.mount();
    try {
      await entered.promise;
      expect(fixture.listSchemas).not.toHaveBeenCalled();
      fixture.selector()!.querySelector<HTMLButtonElement>("[data-open]")!.click();
      expect(fixture.acquire.mock.calls).toEqual([["conn-a", { activate: false, skipIfClosedByUser: true }], ["conn-a"]]);
      expect(fixture.connectDb).toHaveBeenCalledTimes(1);
      response.resolve("conn-a");
      await fixture.waitForOptions(["public"]);
      expect(fixture.listSchemas).toHaveBeenCalledTimes(1);
      expect(fixture.store.activeConnectionId).toBe("conn-a");
    } finally {
      response.resolve("conn-a");
      await Promise.allSettled(fixture.acquire.mock.results.map((result) => result.value));
      fixture.cleanup();
    }
  }, 20_000);

  it("handles current metadata failure at its UI entry and retries on the real open event", async () => {
    const fixture = await setup();
    fixture.listSchemas.mockRejectedValueOnce(new Error("Synthetic toolbar metadata failure"));
    fixture.mount();
    try {
      await fixture.waitForOptions([]);
      expect(fixture.listSchemas).toHaveBeenCalledTimes(1);
      fixture.selector()!.querySelector<HTMLButtonElement>("[data-open]")!.click();
      await fixture.waitForOptions(["public"]);
      expect(fixture.listSchemas).toHaveBeenCalledTimes(2);
      expect(fixture.acquire).toHaveBeenCalledTimes(2);
    } finally {
      fixture.cleanup();
    }
  }, 20_000);
});
