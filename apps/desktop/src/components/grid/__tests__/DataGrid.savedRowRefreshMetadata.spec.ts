// @vitest-environment happy-dom
// SOURCE-ONLY CANDIDATE: UNRUN. Do not execute until dependency and module-
// initialization closure is restored/audited; function stubs are not an import audit.
// Calls DataGrid's actual callback captured at the editor boundary, not a model.
import { createApp, h, nextTick, reactive } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { QueryResult } from "@/types/database";
import type { useDataGridEditor } from "@/composables/useDataGridEditor";
import DataGrid from "../DataGrid.vue";
import { useSettingsStore } from "@/stores/settingsStore";
import { useConnectionStore } from "@/stores/connectionStore";

type Refresh = NonNullable<Parameters<typeof useDataGridEditor>[0]["refreshSavedRows"]>;
const mocks = vi.hoisted(() => ({
  refresh: undefined as Refresh | undefined,
  filter: vi.fn(),
  select: vi.fn(),
  execute: vi.fn(),
  unexpectedBackendCalls: [] as string[],
  // Includes module initialization; never cleared by beforeEach.
  allUnexpectedBackendCalls: [] as string[],
}));
const storageFixture = vi.hoisted(() => {
  // The declared happy-dom environment is synthetic. Explicit storage makes
  // locale and store initialization deterministic, not a claim of host leakage.
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() { return values.size; },
    clear() { values.clear(); },
    getItem(key: string) { return values.get(String(key)) ?? null; },
    key(index: number) { return Array.from(values.keys())[index] ?? null; },
    removeItem(key: string) { values.delete(String(key)); },
    setItem(key: string, value: string) { values.set(String(key), String(value)); },
  };
  const reset = () => {
    values.clear();
    values.set("dbx-locale", "en");
  };
  reset();
  if (typeof window === "undefined") throw new Error("Refresh fixture requires happy-dom");
  // Capture both descriptors before either write. Do not assume Vitest makes
  // window and globalThis aliases; avoid restoring the same object twice.
  const targets: object[] = [globalThis];
  if (!targets.includes(window)) targets.push(window);
  const originals = targets.map((target) => ({
    target,
    descriptor: Object.getOwnPropertyDescriptor(target, "localStorage"),
  }));
  for (const { descriptor } of originals) {
    if (descriptor && !descriptor.configurable) {
      throw new Error("Refresh fixture cannot replace non-configurable localStorage");
    }
  }
  const restore = () => {
    const failures: unknown[] = [];
    for (const { target, descriptor } of [...originals].reverse()) {
      try {
        if (descriptor) Object.defineProperty(target, "localStorage", descriptor);
        else if (!Reflect.deleteProperty(target, "localStorage")) {
          throw new Error("Refresh fixture could not remove its localStorage property");
        }
      } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new Error("Refresh fixture could not restore all localStorage descriptors");
  };
  try {
    for (const { target, descriptor } of originals) {
      Object.defineProperty(target, "localStorage", {
        configurable: true,
        enumerable: descriptor?.enumerable ?? true,
        value: storage,
        writable: false,
      });
    }
    if (globalThis.localStorage !== storage || window.localStorage !== storage) {
      throw new Error("Refresh fixture storage boundary was not installed on both globals");
    }
  } catch (error) {
    restore();
    throw error;
  }
  return { reset, restore };
});
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
vi.mock("@/composables/useDataGridEditor", async (original) => {
  const actual = await original<typeof import("@/composables/useDataGridEditor")>();
  return { ...actual, useDataGridEditor: (options: Parameters<typeof actual.useDataGridEditor>[0]) => {
    mocks.refresh = options.refreshSavedRows;
    return actual.useDataGridEditor(options);
  } };
});
vi.mock("@/lib/dataGrid/dataGridSql", async (original) => ({
  ...(await original<typeof import("@/lib/dataGrid/dataGridSql")>()),
  buildDataGridContextFilterCondition: mocks.filter,
}));
vi.mock("@/lib/table/tableSelectSql", async (original) => ({
  ...(await original<typeof import("@/lib/table/tableSelectSql")>()),
  buildTableSelectSql: mocks.select,
}));
vi.mock("@/lib/backend/api", async (original) => {
  // Keep the pinned API export surface, but never pass through backend functions.
  // Its direct initialization is statically audited: tauri/http are lazy;
  // tauriRuntime/debugLog have no eager I/O. Wider import closure is still gated.
  const actual = await original<typeof import("@/lib/backend/api")>();
  const blocked = Object.fromEntries(Object.entries(actual).map(([name, value]) => [name,
    typeof value === "function" ? vi.fn(() => {
      mocks.unexpectedBackendCalls.push(name);
      mocks.allUnexpectedBackendCalls.push(name);
      throw new Error(`Unexpected backend call in synthetic refresh fixture: ${name}`);
    }) : value,
  ]));
  return {
    ...blocked,
    executeQuery: mocks.execute,
    loadEditorSettings: vi.fn().mockResolvedValue({}),
    saveEditorSettings: vi.fn().mockResolvedValue(undefined),
  };
});

function payload(name = "saved"): QueryResult {
  return { columns: ["id", "name"], rows: [[1, name]], affected_rows: 0, execution_time_ms: 1 };
}
const cleanup: Array<() => void> = [];
afterEach(() => {
  try {
    cleanup.splice(0).forEach((fn) => fn());
    expect(mocks.unexpectedBackendCalls).toEqual([]);
    expect(mocks.allUnexpectedBackendCalls).toEqual([]);
  } finally {
    vi.restoreAllMocks();
  }
});
afterAll(() => {
  try {
    expect(mocks.allUnexpectedBackendCalls).toEqual([]);
  } finally {
    // Keep the fake through every test and teardown, then restore exact originals.
    storageFixture.restore();
  }
});
beforeEach(() => {
  storageFixture.reset();
  mocks.refresh = undefined;
  mocks.unexpectedBackendCalls.length = 0;
  mocks.filter.mockReset().mockResolvedValue('"id" = 1');
  mocks.select.mockReset().mockResolvedValue("SELECT id, name FROM orders WHERE id = 1");
  mocks.execute.mockReset().mockResolvedValue(payload("server"));
});
async function mountGrid() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const settings = useSettingsStore();
  // This action applies immediately; only persistence is queued while unloaded.
  settings.updateEditorSettings({ dataGridRenderMode: "canvas", infiniteScroll: false });
  expect(settings.editorSettings.dataGridRenderMode).toBe("canvas");
  expect(settings.editorSettings.infiniteScroll).toBe(false);
  const config = reactive({ db_type: "postgres", driver_profile: "postgres", database_info: { productVersion: "16" } });
  const store = useConnectionStore();
  vi.spyOn(store, "getConfig").mockReturnValue(config as ReturnType<typeof store.getConfig>);
  vi.spyOn(store, "connectionIdentifierQuote").mockReturnValue('"');
  const context = new Proxy({ font: "13px sans-serif", measureText: (text: string) => ({ width: text.length * 7 }) }, { get: (target, key) => Reflect.get(target, key) ?? (() => {}) });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
  const props = reactive({
    result: payload(), connectionId: "connection-a", database: "db-a", executionDatabase: "execute-a", schema: "public",
    databaseType: "postgres" as const, context: "table-data" as const,
    viewGeneration: "generation-a", sourceColumns: ["id", "name"],
    tableMeta: { catalog: "catalog-a", database: "db-a", schema: "public", tableName: "orders", tableType: "TABLE", primaryKeys: ["id"], columns: [{ name: "id", data_type: "integer" }, { name: "name", data_type: "text" }] },
  });
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ render: () => h(TooltipProvider, {}, { default: () => h(DataGrid, props) }) });
  app.use(pinia); app.use(i18n); app.mount(host);
  let mounted = true;
  const unmount = () => { if (mounted) { mounted = false; app.unmount(); host.remove(); } };
  cleanup.push(unmount);
  await nextTick();
  mocks.filter.mockClear();
  mocks.select.mockClear();
  mocks.execute.mockClear();
  const refresh = mocks.refresh!;
  expect(refresh).toBeTypeOf("function");
  const start = () => refresh({ dirtyRows: new Map([[0, new Map([[1, "saved"]])]]), columns: props.result.columns, rows: props.result.rows });
  return { props, start };
}
// ALL_UNRUN: column-metadata regressions use the actual captured callback.
describe("DataGrid saved-row refresh column metadata", () => {
  it("refreshes an unchanged target and preserves untouched row metadata", async () => {
    const fixture = await mountGrid();
    fixture.props.result.rows.push([2, "untouched"]);
    fixture.props.result.spatial_values = [[], []];
    fixture.props.result.large_value_cells = [];
    const oldLargeValues = fixture.props.result.large_value_cells;
    const untouched = fixture.props.result.rows[1];
    expect(await fixture.start()).toBe(true);
    expect(fixture.props.result.rows).toEqual([[1, "server"], [2, "untouched"]]);
    expect(fixture.props.result.rows[1]).toBe(untouched);
    expect(fixture.props.result.spatial_values).toEqual([[], []]);
    expect(fixture.props.result.large_value_cells).toEqual([]);
    expect(fixture.props.result.large_value_cells).not.toBe(oldLargeValues);
    expect(mocks.filter).toHaveBeenCalledWith(expect.objectContaining({ databaseType: "postgres", identifierQuote: '"', value: 1 }));
    expect(mocks.select).toHaveBeenCalledWith(expect.objectContaining({ driverProfile: "postgres", serverVersion: "16", catalog: "catalog-a", database: "db-a", schema: "public", tableName: "orders" }));
  });


  it("remaps both row and column indexes and leaves untouched metadata intact", async () => {
    const fixture = await mountGrid();
    fixture.props.result.rows.push([2, "untouched"], [3, "saved-third"]);
    fixture.props.result.spatial_values = [[null, 1001], [null, 4326], [null, 1003]];
    fixture.props.result.large_value_cells = [
      { row_index: 0, column_index: 1, original_bytes: 101 },
      { row_index: 1, column_index: 1, original_bytes: 202 },
      { row_index: 2, column_index: 1, original_bytes: 303 },
    ];
    const untouchedRow = fixture.props.result.rows[1];
    const untouchedSpatial = fixture.props.result.spatial_values[1];
    const untouchedLarge = fixture.props.result.large_value_cells[1];
    const response: QueryResult = {
      ...payload(), columns: ["name", "id"], rows: [["server-third", 3], ["server-first", 1]],
      spatial_values: [[3857, null], [4269, null]],
      large_value_cells: [{ row_index: 0, column_index: 0, original_bytes: 909 }],
    };
    const responseBefore = JSON.stringify(response);
    mocks.execute.mockResolvedValueOnce(response);
    expect(await mocks.refresh!({
      dirtyRows: new Map([[0, new Map([[1, "saved"]])], [2, new Map([[1, "saved-third"]])]]),
      columns: fixture.props.result.columns, rows: fixture.props.result.rows,
    })).toBe(true);
    expect(fixture.props.result.rows).toEqual([[1, "server-first"], [2, "untouched"], [3, "server-third"]]);
    expect(fixture.props.result.spatial_values).toEqual([[null, 4269], [null, 4326], [null, 3857]]);
    expect(fixture.props.result.large_value_cells).toEqual([
      { row_index: 1, column_index: 1, original_bytes: 202 },
      { row_index: 2, column_index: 1, original_bytes: 909 },
    ]);
    expect(fixture.props.result.rows[1]).toBe(untouchedRow);
    expect(fixture.props.result.spatial_values[1]).toBe(untouchedSpatial);
    expect(fixture.props.result.large_value_cells[0]).toBe(untouchedLarge);
    expect(JSON.stringify(response)).toBe(responseBefore);
  });

  it("projects a target subset and discards extra or invalid column metadata", async () => {
    const fixture = await mountGrid();
    const response: QueryResult = {
      ...payload(), columns: ["extra", "name", "id"], rows: [["hidden", "server", 1]],
      spatial_values: [[9999, 4326, null]],
      large_value_cells: [0, 1, -1, 3, 1.5].map((column_index) => ({ row_index: 0, column_index, original_bytes: 700 })),
    };
    const before = JSON.stringify(response);
    mocks.execute.mockResolvedValueOnce(response);
    expect(await fixture.start()).toBe(true);
    expect(fixture.props.result.rows).toEqual([[1, "server"]]);
    expect(fixture.props.result.spatial_values).toEqual([[null, 4326]]);
    expect(fixture.props.result.large_value_cells).toEqual([{ row_index: 0, column_index: 1, original_bytes: 700 }]);
    expect(JSON.stringify(response)).toBe(before);
  });

  it("uses source aliases and distinct duplicate matches for metadata as for values", async () => {
    const fixture = await mountGrid();
    // Component/helper contract; ordinary table-data UI alias routing is not asserted.
    fixture.props.result.columns = ["identifier", "first_name", "second_name"];
    fixture.props.sourceColumns = ["id", "name", "name"];
    fixture.props.result.rows = [[1, "saved", "other"]];
    await nextTick();
    mocks.execute.mockResolvedValueOnce({
      ...payload(), columns: [" NAME ", "id", "name"], rows: [["first", 1, "second"]],
      spatial_values: [[4326, null, 3857]],
      large_value_cells: [{ row_index: 0, column_index: 0, original_bytes: 800 }, { row_index: 0, column_index: 2, original_bytes: 900 }],
    });
    expect(await fixture.start()).toBe(true);
    expect(fixture.props.result.rows).toEqual([[1, "first", "second"]]);
    expect(fixture.props.result.spatial_values).toEqual([[null, 4326, 3857]]);
    expect(fixture.props.result.large_value_cells).toEqual([{ row_index: 0, column_index: 1, original_bytes: 800 }, { row_index: 0, column_index: 2, original_bytes: 900 }]);
  });

  it("rejects missing target columns without mutating rows or metadata", async () => {
    const fixture = await mountGrid();
    fixture.props.result.spatial_values = [[null, 4326]];
    fixture.props.result.large_value_cells = [{ row_index: 0, column_index: 1, original_bytes: 101 }];
    const before = JSON.stringify(fixture.props.result);
    const rows = fixture.props.result.rows;
    const spatial = fixture.props.result.spatial_values;
    const large = fixture.props.result.large_value_cells;
    mocks.execute.mockResolvedValueOnce({ ...payload(), columns: ["id"], rows: [[1]], spatial_values: [[null]], large_value_cells: [] });
    expect(await fixture.start()).toBe(false);
    expect(JSON.stringify(fixture.props.result)).toBe(before);
    expect(fixture.props.result.rows).toBe(rows);
    expect(fixture.props.result.spatial_values).toBe(spatial);
    expect(fixture.props.result.large_value_cells).toBe(large);
  });

  it.each(["absent", "missing-row", "empty-row"] as const)("preserves the empty spatial sentinel for %s metadata with reordered columns", async (kind) => {
    const fixture = await mountGrid();
    fixture.props.result.spatial_values = [[null, 4326]];
    const response: QueryResult = { ...payload(), columns: ["name", "id"], rows: [["server", 1]] };
    if (kind === "missing-row") response.spatial_values = [];
    if (kind === "empty-row") response.spatial_values = [[]];
    mocks.execute.mockResolvedValueOnce(response);
    expect(await fixture.start()).toBe(true);
    expect(fixture.props.result.spatial_values).toEqual([[]]);
  });

  it("pads a short nonempty SRID row in target order", async () => {
    const fixture = await mountGrid();
    const spatialRow: Array<number | null> = [4326];
    const response: QueryResult = {
      ...payload(), columns: ["name", "id"], rows: [["server", 1]],
      spatial_values: [spatialRow],
    };
    const before = JSON.stringify(response);
    const keysBefore = Object.keys(spatialRow);
    mocks.execute.mockResolvedValueOnce(response);
    expect(await fixture.start()).toBe(true);
    expect(fixture.props.result.rows).toEqual([[1, "server"]]);
    expect(fixture.props.result.spatial_values).toEqual([[null, 4326]]);
    expect(JSON.stringify(response)).toBe(before);
    expect(Object.keys(spatialRow)).toEqual(keysBefore);
  });

  it("preserves zero SRID in a short nonempty row", async () => {
    const fixture = await mountGrid();
    const spatialRow: Array<number | null> = [0];
    const response: QueryResult = {
      ...payload(), columns: ["name", "id"], rows: [["server", 1]],
      spatial_values: [spatialRow],
    };
    const before = JSON.stringify(response);
    const keysBefore = Object.keys(spatialRow);
    mocks.execute.mockResolvedValueOnce(response);
    expect(await fixture.start()).toBe(true);
    expect(fixture.props.result.rows).toEqual([[1, "server"]]);
    expect(fixture.props.result.spatial_values).toEqual([[null, 0]]);
    expect(JSON.stringify(response)).toBe(before);
    expect(Object.keys(spatialRow)).toEqual(keysBefore);
  });

  it("pads a sparse nonempty SRID row while preserving zero", async () => {
    const fixture = await mountGrid();
    const spatialRow = new Array<number | null>(2);
    spatialRow[1] = 0;
    const response: QueryResult = {
      ...payload(), columns: ["name", "id"], rows: [["server", 1]],
      spatial_values: [spatialRow],
    };
    const before = JSON.stringify(response);
    const keysBefore = Object.keys(spatialRow);
    mocks.execute.mockResolvedValueOnce(response);
    expect(await fixture.start()).toBe(true);
    expect(fixture.props.result.rows).toEqual([[1, "server"]]);
    expect(fixture.props.result.spatial_values).toEqual([[0, null]]);
    expect(JSON.stringify(response)).toBe(before);
    expect(Object.keys(spatialRow)).toEqual(keysBefore);
  });
});
