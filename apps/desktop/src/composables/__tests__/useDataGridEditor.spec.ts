// @vitest-environment happy-dom
import { computed, nextTick, ref, toRaw, type Ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearDataGridPendingSnapshot, DATA_GRID_QUICK_ENTRY_DRAFT_ROW_ID, useDataGridEditor, type CustomSaveHandler } from "@/composables/useDataGridEditor";
import { clearDataGridClipboardCopy, parseDataGridClipboard, rememberDataGridClipboardCopy } from "@/lib/dataGrid/dataGridClipboard";
import { buildMongoUpdateDocument, MONGO_DOCUMENT_GRID_NULL, mongoDocumentGridInputValue, mongoDocumentGridValue } from "@/lib/mongo/mongoDocumentValues";
import type { CellValue } from "@/lib/dataGrid/cellValue";
import { canInsertTableRows, supportsDataGridTransaction } from "@/lib/table/tableEditing";

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  ensureReadOnlyWriteAccess: vi.fn(),
  isWriteUnlockActive: vi.fn(),
  requestProductionConfirmation: vi.fn(),
  prepareDataGridSave: vi.fn(),
  executeBatch: vi.fn(),
  executeConditionalUpdate: vi.fn(),
  cancelConditionalUpdate: vi.fn(),
  executeInTransaction: vi.fn(),
  executeInManualTransaction: vi.fn(),
  executeQuery: vi.fn(),
  addHistory: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  prepareDataGridSave: mocks.prepareDataGridSave,
  executeBatch: mocks.executeBatch,
  executeConditionalUpdate: mocks.executeConditionalUpdate,
  cancelConditionalUpdate: mocks.cancelConditionalUpdate,
  executeInTransaction: mocks.executeInTransaction,
  executeInManualTransaction: mocks.executeInManualTransaction,
  executeQuery: mocks.executeQuery,
  unlockConnectionWrites: vi.fn(),
  lockConnectionWrites: vi.fn(),
  connectionWriteUnlockState: vi.fn().mockResolvedValue(0),
}));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({ getConfig: mocks.getConfig }),
}));
vi.mock("@/stores/historyStore", () => ({
  useHistoryStore: () => ({ add: mocks.addHistory }),
}));
vi.mock("@/stores/productionSafetyStore", () => ({
  useProductionSafetyStore: () => ({ requestConfirmation: mocks.requestProductionConfirmation }),
}));


vi.mock("@/lib/database/readOnlyWriteAccess", () => ({
  ensureReadOnlyWriteAccess: mocks.ensureReadOnlyWriteAccess,
  isWriteUnlockActive: mocks.isWriteUnlockActive,
}));

beforeEach(() => {
  mocks.ensureReadOnlyWriteAccess.mockReset().mockResolvedValue(true);
  mocks.isWriteUnlockActive.mockReset().mockReturnValue(true);
  mocks.requestProductionConfirmation.mockReset().mockResolvedValue(true);
});

function createEditorWithResult(
  sourceColumns?: Array<string | undefined>,
  confirmDangerousRowDeletion = true,
  cacheKey?: string,
  readonlyColumnIndexes?: number[],
  existingRows: CellValue[][] = [],
  onCellValueChanged?: (rowId: number, columnIndex: number) => void,
  tableColumns?: Array<{ name: string; data_type: string; extra?: string; column_default?: string }>,
  mongoCollectionGrid = false,
  quickEntry = false,
  editable = ref(true),
  resultColumnTypes?: string[],
) {
  let editor: ReturnType<typeof useDataGridEditor>;
  const result = ref<{ columns: string[]; rows: CellValue[][]; column_types?: string[] }>({
    columns: ["first", "hidden", "last"],
    rows: existingRows,
    column_types: resultColumnTypes,
  });

  editor = useDataGridEditor({
    result: computed(() => result.value),
    editable: computed(() => editable.value),
    databaseType: computed(() => (mongoCollectionGrid ? "mongodb" : "postgres")),
    normalizeEditorInput: mongoCollectionGrid ? mongoDocumentGridInputValue : undefined,
    connectionId: computed(() => "connection-1"),
    database: computed(() => "app"),
    tableMeta: computed(() => ({
      tableName: "people",
      columns: tableColumns ?? [
        { name: "first", data_type: "varchar" },
        { name: "hidden", data_type: "varchar" },
        { name: "last", data_type: "varchar" },
      ],
      primaryKeys: [],
    })),
    sourceColumns: computed(() => sourceColumns),
    readonlyColumnIndexes: computed(() => (readonlyColumnIndexes ? new Set(readonlyColumnIndexes) : undefined)),
    onExecuteSql: computed(() => undefined),
    sql: computed(() => undefined),
    searchText: ref(""),
    dataGridQuickEntryEnabled: computed(() => quickEntry),
    whereFilterInput: ref(""),
    currentWhereInput: computed(() => undefined),
    orderByInput: ref(""),
    rowStatusFilter: ref("all"),
    confirmDangerousRowDeletion: computed(() => confirmDangerousRowDeletion),
    pageSize: ref(100),
    currentPage: ref(1),
    cacheKey: computed(() => cacheKey),
    onCellValueChanged,
    getRowItem: (rowId) => {
      if (rowId === DATA_GRID_QUICK_ENTRY_DRAFT_ROW_ID) {
        return {
          id: rowId,
          data: editor.quickEntryDraftRow.value,
          isNew: false,
          isDraft: true,
          isDeleted: false,
          isDirtyCol: [false, false, false],
          status: "draft",
        };
      }
      if (rowId >= 0) {
        const row = result.value.rows[rowId];
        if (!row) return undefined;
        const changes = editor.dirtyRows.value.get(rowId);
        return {
          id: rowId,
          sourceIndex: rowId,
          data: row.map((value, columnIndex) => (changes?.has(columnIndex) ? (changes.get(columnIndex) ?? null) : value)),
          isNew: false,
          isDeleted: false,
          isDirtyCol: row.map((_, columnIndex) => changes?.has(columnIndex) ?? false),
          status: changes?.size ? "edited" : "normal",
        };
      }
      const newIndex = -rowId - 1;
      const row = editor.newRows.value[newIndex];
      if (!row) return undefined;
      return {
        id: rowId,
        newIndex,
        data: row,
        isNew: true,
        isDeleted: false,
        isDirtyCol: [false, false, false],
        status: "new",
      };
    },
    emit: vi.fn(),
  });

  editor.newRows.value = [[null, null, null]];
  return { editor, result };
}

function createEditor(...args: Parameters<typeof createEditorWithResult>) {
  return createEditorWithResult(...args).editor;
}

describe("useDataGridEditor searched replacements", () => {
  beforeEach(() => {
    mocks.prepareDataGridSave.mockReset();
    mocks.executeBatch.mockReset();
    mocks.getConfig.mockReturnValue(undefined);
  });

  it.each([true, false])("blocks queued saves while row identity is pending (autoSave=%s)", async (autoSave) => {
    const editable = ref(true);
    const editor = createEditor(undefined, true, undefined, undefined, [["old", "keep", "last"]], undefined, undefined, false, false, editable);
    editor.newRows.value = [];
    editor.applyCellValue(0, 0, "new");
    editable.value = false;

    await editor.saveChanges({ autoSave });

    expect(mocks.prepareDataGridSave).not.toHaveBeenCalled();
    expect(mocks.executeBatch).not.toHaveBeenCalled();
    expect(editor.hasPendingChanges.value).toBe(true);
    editable.value = true;
    mocks.prepareDataGridSave.mockResolvedValue({ statements: ["UPDATE people SET first='new'"], rollbackStatements: [] });
    mocks.executeBatch.mockResolvedValue([]);
    await editor.saveChanges();
    expect(mocks.executeBatch).toHaveBeenCalledOnce();
  });

  it("rechecks row identity readiness after asynchronous save preparation", async () => {
    const editable = ref(true);
    const editor = createEditor(undefined, true, undefined, undefined, [["old", "keep", "last"]], undefined, undefined, false, false, editable);
    editor.newRows.value = [];
    editor.applyCellValue(0, 0, "new");
    let finishPreparation!: (value: { statements: string[]; rollbackStatements: string[] }) => void;
    mocks.prepareDataGridSave.mockReturnValueOnce(
      new Promise((resolve) => {
        finishPreparation = resolve;
      }),
    );
    const save = editor.saveChanges();
    expect(mocks.prepareDataGridSave).toHaveBeenCalledOnce();
    editable.value = false;
    finishPreparation({ statements: ["UPDATE people SET first='new'"], rollbackStatements: [] });
    await save;
    expect(mocks.executeBatch).not.toHaveBeenCalled();
    expect(editor.hasPendingChanges.value).toBe(true);
    expect(editor.isSaving.value).toBe(false);
  });

  it("stages one undoable batch, keeps empty strings and preserves prior pending edits", () => {
    const editor = createEditor(undefined, true, undefined, undefined, [["hit", "keep", "hit"]]);
    editor.newRows.value = [];
    editor.applyCellValue(0, 1, "draft");
    expect(
      editor.stageCellReplacements([
        { rowId: 0, col: 0, previousValue: "hit", value: "" },
        { rowId: 0, col: 2, previousValue: "hit", value: "new" },
      ]),
    ).toBe(2);
    expect(editor.dirtyRows.value.get(0)).toEqual(
      new Map([
        [1, "draft"],
        [0, ""],
        [2, "new"],
      ]),
    );
    expect(editor.manualSaveRequired.value).toBe(true);
    editor.undoPendingChange();
    expect(editor.dirtyRows.value.get(0)).toEqual(new Map([[1, "draft"]]));
    expect(editor.manualSaveRequired.value).toBe(false);
    editor.redoPendingChange();
    expect(editor.dirtyRows.value.get(0)?.get(0)).toBe("");
    expect(editor.manualSaveRequired.value).toBe(true);
    expect(mocks.executeBatch).not.toHaveBeenCalled();
  });

  it("stages a resolved large-value replacement while the source row still contains its preview", () => {
    const editor = createEditor(undefined, true, undefined, undefined, [["prefix hit…"]]);
    editor.newRows.value = [];

    expect(
      editor.stageCellReplacements([
        {
          rowId: 0,
          col: 0,
          sourceValue: "prefix hit…",
          previousValue: "prefix hit suffix",
          value: "prefix done suffix",
        },
      ]),
    ).toBe(1);
    expect(editor.dirtyRows.value.get(0)?.get(0)).toBe("prefix done suffix");
  });

  it("rejects readonly, stale, deleted, non-string and out-of-range targets", () => {
    const editor = createEditor(
      ["first", undefined, "last"],
      true,
      undefined,
      [2],
      [
        ["hit", "hit", "hit"],
        [123, null, false],
      ],
    );
    editor.newRows.value = [];
    editor.deletedRows.value.add(0);
    const changes = [
      { rowId: 0, col: 0, previousValue: "hit", value: "x" },
      { rowId: 1, col: 0, previousValue: "123", value: "x" },
      { rowId: 9, col: 0, previousValue: "hit", value: "x" },
    ];
    expect(editor.stageCellReplacements(changes)).toBe(0);
    editor.deletedRows.value.clear();
    expect(
      editor.stageCellReplacements([
        { rowId: 0, col: 0, previousValue: "stale", value: "x" },
        { rowId: 0, col: 1, previousValue: "hit", value: "x" },
        { rowId: 0, col: 2, previousValue: "hit", value: "x" },
        { rowId: -1, col: 0, previousValue: "hit", value: "x" },
      ]),
    ).toBe(0);
    expect(editor.dirtyRows.value.size).toBe(0);
    expect(editor.manualSaveRequired.value).toBe(false);
  });

  it("blocks later quick-entry autosaves until explicit save or discard", async () => {
    const editor = createEditor(undefined, true, undefined, undefined, [["hit", "keep", "hit"]], undefined, undefined, false, true);
    editor.newRows.value = [];
    editor.stageCellReplacements([{ rowId: 0, col: 0, previousValue: "hit", value: "new" }]);
    editor.applyCellValue(0, 1, "later edit");
    await editor.saveChanges({ autoSave: true });
    expect(mocks.prepareDataGridSave).not.toHaveBeenCalled();
    expect(mocks.executeBatch).not.toHaveBeenCalled();
    expect(editor.hasPendingChanges.value).toBe(true);
    mocks.prepareDataGridSave.mockResolvedValue({ statements: ["UPDATE people SET first='new',hidden='later edit' WHERE last='hit'"], rollbackStatements: [] });
    mocks.executeBatch.mockResolvedValue([]);
    await editor.saveChanges();
    expect(mocks.executeBatch).toHaveBeenCalledOnce();
    expect(editor.manualSaveRequired.value).toBe(false);
    editor.stageCellReplacements([{ rowId: 0, col: 0, previousValue: "new", value: "other" }]);
    editor.discardChanges();
    expect(editor.manualSaveRequired.value).toBe(false);
  });

  it("persists the manual-save interlock across a tab remount", async () => {
    const key = "replace-remount";
    const rows: CellValue[][] = [["hit", "keep", "hit"]];
    const first = createEditor(undefined, true, key, undefined, rows);
    first.newRows.value = [];
    first.stageCellReplacements([{ rowId: 0, col: 0, previousValue: "hit", value: "new" }]);
    first.savePendingSnapshot();
    const second = createEditor(undefined, true, key, undefined, rows);
    second.newRows.value = [];
    expect(second.manualSaveRequired.value).toBe(true);
    await second.saveChanges({ autoSave: true });
    expect(mocks.executeBatch).not.toHaveBeenCalled();
    second.discardChanges();
    clearDataGridPendingSnapshot(key);
  });

  it("clears the manual-save interlock when replacement restores all original values", () => {
    const editor = createEditor(undefined, true, undefined, undefined, [["hit", "keep", "hit"]]);
    editor.newRows.value = [];
    editor.stageCellReplacements([{ rowId: 0, col: 0, previousValue: "hit", value: "new" }]);
    editor.stageCellReplacements([{ rowId: 0, col: 0, previousValue: "new", value: "hit" }]);
    expect(editor.hasPendingChanges.value).toBe(false);
    expect(editor.manualSaveRequired.value).toBe(false);
    editor.undoPendingChange();
    expect(editor.dirtyRows.value.get(0)?.get(0)).toBe("new");
    expect(editor.manualSaveRequired.value).toBe(true);
    editor.redoPendingChange();
    expect(editor.manualSaveRequired.value).toBe(false);
  });
});

function beforeTabSwitchEvent(fromTabId: string, tabId = "next-tab") {
  return new CustomEvent("dbx:before-tab-switch", { detail: { tabId, fromTabId } });
}

function setupTabSwitchScrollFixture() {
  class TestScroller {
    scrollTop = 0;
    scrollLeft = 0;
    scrollTo({ top, left }: ScrollToOptions) {
      if (typeof top === "number") this.scrollTop = top;
      if (typeof left === "number") this.scrollLeft = left;
    }
  }
  vi.stubGlobal("HTMLElement", TestScroller);
  const rows: CellValue[][] = [
    ["a", null, 1],
    ["b", null, 2],
    ["c", null, 3],
  ];
  return { TestScroller, rows };
}

describe("useDataGridEditor result snapshots", () => {
  it("does not restore scroll or editing state into a replacement result identity", () => {
    class TestScroller {
      scrollTop = 0;
      scrollLeft = 0;
      scrollTo({ top, left }: ScrollToOptions) {
        if (typeof top === "number") this.scrollTop = top;
        if (typeof left === "number") this.scrollLeft = left;
      }
    }
    vi.stubGlobal("HTMLElement", TestScroller);
    const oldKey = "tab-current-0-execution-1";
    const previous = createEditor(undefined, true, oldKey);
    const previousScroller = new TestScroller();
    previousScroller.scrollTop = 6_400;
    previousScroller.scrollLeft = 24;
    previous.scrollerRef.value = previousScroller as unknown as NonNullable<typeof previous.scrollerRef.value>;
    previous.editingCell.value = { rowId: -1, col: 0 };
    previous.editValue.value = "Ada";
    previous.savePendingSnapshot(true, true);

    const replacement = createEditor(undefined, true, "tab-current-0-execution-2");
    const replacementScroller = new TestScroller();
    replacement.scrollerRef.value = replacementScroller as unknown as NonNullable<typeof replacement.scrollerRef.value>;
    replacement.restorePendingSnapshotFocus();
    expect(replacement.editingCell.value).toBeNull();
    expect(replacementScroller.scrollTop).toBe(0);
    expect(replacementScroller.scrollLeft).toBe(0);

    clearDataGridPendingSnapshot(oldKey);
    const oldIdentity = createEditor(undefined, true, oldKey);
    const oldIdentityScroller = new TestScroller();
    oldIdentity.scrollerRef.value = oldIdentityScroller as unknown as NonNullable<typeof oldIdentity.scrollerRef.value>;
    oldIdentity.restorePendingSnapshotFocus();
    expect(oldIdentity.editingCell.value).toBeNull();
    expect(oldIdentityScroller.scrollTop).toBe(0);
    expect(oldIdentityScroller.scrollLeft).toBe(0);
  });

  it("does not adopt a scroll-only snapshot when remounting with a same-shape result (#7341)", () => {
    class TestScroller {
      scrollTop = 0;
      scrollLeft = 0;
      scrollTo({ top, left }: ScrollToOptions) {
        if (typeof top === "number") this.scrollTop = top;
        if (typeof left === "number") this.scrollLeft = left;
      }
    }
    vi.stubGlobal("HTMLElement", TestScroller);
    const rows: CellValue[][] = [
      ["a", null, 1],
      ["b", null, 2],
      ["c", null, 3],
    ];
    const key = "table-tab-scroll-only-snapshot";
    const previous = createEditor(undefined, true, key, undefined, rows);
    previous.newRows.value = [];
    const previousScroller = new TestScroller();
    previousScroller.scrollTop = 6_400;
    previousScroller.scrollLeft = 24;
    previous.scrollerRef.value = previousScroller as unknown as NonNullable<typeof previous.scrollerRef.value>;
    // Unmount path: saves a pure scroll snapshot even without pending edits.
    previous.savePendingSnapshot(true, true);

    const remounted = createEditor(undefined, true, key, undefined, rows);
    const remountedScroller = new TestScroller();
    remounted.scrollerRef.value = remountedScroller as unknown as NonNullable<typeof remounted.scrollerRef.value>;
    remounted.restorePendingSnapshotFocus();
    expect(remountedScroller.scrollTop).toBe(0);
    expect(remountedScroller.scrollLeft).toBe(0);
  });

  it("adopts a scroll-only snapshot when the previous instance was torn down by a tab switch (#8524)", () => {
    const { TestScroller, rows } = setupTabSwitchScrollFixture();
    const key = "table-tab-8524";
    const previous = createEditor(undefined, true, key, undefined, rows);
    previous.newRows.value = [];
    const previousScroller = new TestScroller();
    previousScroller.scrollTop = 6_400;
    previousScroller.scrollLeft = 24;
    previous.scrollerRef.value = previousScroller as unknown as NonNullable<typeof previous.scrollerRef.value>;
    previous.onBeforeTabSwitch(beforeTabSwitchEvent(key));
    // Unmount path runs right after the switch and must not clobber the provenance.
    previous.savePendingSnapshot(true, true);

    const remounted = createEditor(undefined, true, key, undefined, rows);
    const remountedScroller = new TestScroller();
    remounted.scrollerRef.value = remountedScroller as unknown as NonNullable<typeof remounted.scrollerRef.value>;
    remounted.restorePendingSnapshotFocus();
    expect(remountedScroller.scrollTop).toBe(6_400);
    expect(remountedScroller.scrollLeft).toBe(24);
  });

  it("ignores a tab switch that names a different tab", () => {
    const { TestScroller, rows } = setupTabSwitchScrollFixture();
    const key = "table-tab-other-group";
    const previous = createEditor(undefined, true, key, undefined, rows);
    previous.newRows.value = [];
    const previousScroller = new TestScroller();
    previousScroller.scrollTop = 6_400;
    previousScroller.scrollLeft = 24;
    previous.scrollerRef.value = previousScroller as unknown as NonNullable<typeof previous.scrollerRef.value>;
    // Split groups keep several grids mounted; this one did not change tabs.
    previous.onBeforeTabSwitch(beforeTabSwitchEvent("some-other-tab"));
    previous.savePendingSnapshot(true, true);

    const remounted = createEditor(undefined, true, key, undefined, rows);
    const remountedScroller = new TestScroller();
    remounted.scrollerRef.value = remountedScroller as unknown as NonNullable<typeof remounted.scrollerRef.value>;
    remounted.restorePendingSnapshotFocus();
    expect(remountedScroller.scrollTop).toBe(0);
    expect(remountedScroller.scrollLeft).toBe(0);
  });

  it("ignores a tab switch event without a fromTabId", () => {
    const { TestScroller, rows } = setupTabSwitchScrollFixture();
    const key = "table-tab-no-origin";
    const previous = createEditor(undefined, true, key, undefined, rows);
    previous.newRows.value = [];
    const previousScroller = new TestScroller();
    previousScroller.scrollTop = 6_400;
    previousScroller.scrollLeft = 24;
    previous.scrollerRef.value = previousScroller as unknown as NonNullable<typeof previous.scrollerRef.value>;
    previous.onBeforeTabSwitch(new CustomEvent("dbx:before-tab-switch", { detail: { tabId: "next-tab" } }));
    previous.savePendingSnapshot(true, true);

    const remounted = createEditor(undefined, true, key, undefined, rows);
    const remountedScroller = new TestScroller();
    remounted.scrollerRef.value = remountedScroller as unknown as NonNullable<typeof remounted.scrollerRef.value>;
    remounted.restorePendingSnapshotFocus();
    expect(remountedScroller.scrollTop).toBe(0);
  });

  it("drops the tab-switch scroll once the result identity changes", async () => {
    const { TestScroller, rows } = setupTabSwitchScrollFixture();
    const key = "table-tab-reloaded";
    const { editor: previous, result } = createEditorWithResult(undefined, true, key, undefined, rows);
    previous.newRows.value = [];
    const previousScroller = new TestScroller();
    previousScroller.scrollTop = 6_400;
    previousScroller.scrollLeft = 24;
    previous.scrollerRef.value = previousScroller as unknown as NonNullable<typeof previous.scrollerRef.value>;
    previous.onBeforeTabSwitch(beforeTabSwitchEvent(key));
    previous.savePendingSnapshot(true, true);

    // A reload lands a new row array: the grid must start at the first row (#7341).
    result.value = { columns: ["first", "hidden", "last"], rows: rows.map((row) => [...row]) };
    await nextTick();
    previous.savePendingSnapshot(true, true);

    const remounted = createEditor(undefined, true, key, undefined, rows);
    const remountedScroller = new TestScroller();
    remounted.scrollerRef.value = remountedScroller as unknown as NonNullable<typeof remounted.scrollerRef.value>;
    remounted.restorePendingSnapshotFocus();
    expect(remountedScroller.scrollTop).toBe(0);
  });

  it("clears the tab-switch provenance when the grid is explicitly scrolled to the top", () => {
    const { TestScroller, rows } = setupTabSwitchScrollFixture();
    const key = "table-tab-reset-scroll";
    const previous = createEditor(undefined, true, key, undefined, rows);
    previous.newRows.value = [];
    const previousScroller = new TestScroller();
    previousScroller.scrollTop = 6_400;
    previousScroller.scrollLeft = 24;
    previous.scrollerRef.value = previousScroller as unknown as NonNullable<typeof previous.scrollerRef.value>;
    previous.onBeforeTabSwitch(beforeTabSwitchEvent(key));
    // Sort/filter/paginate/refresh all route through here and mean "new viewport".
    previous.resetGridVerticalScroll(true);
    previous.savePendingSnapshot(true, true);

    const remounted = createEditor(undefined, true, key, undefined, rows);
    const remountedScroller = new TestScroller();
    remounted.scrollerRef.value = remountedScroller as unknown as NonNullable<typeof remounted.scrollerRef.value>;
    remounted.restorePendingSnapshotFocus();
    expect(remountedScroller.scrollTop).toBe(0);
  });

  it("still adopts the cached scroll when the snapshot carries pending edits", () => {
    class TestScroller {
      scrollTop = 0;
      scrollLeft = 0;
      scrollTo({ top, left }: ScrollToOptions) {
        if (typeof top === "number") this.scrollTop = top;
        if (typeof left === "number") this.scrollLeft = left;
      }
    }
    vi.stubGlobal("HTMLElement", TestScroller);
    const rows: CellValue[][] = [
      ["a", null, 1],
      ["b", null, 2],
      ["c", null, 3],
    ];
    const key = "table-tab-edit-snapshot";
    const previous = createEditor(undefined, true, key, undefined, rows);
    previous.newRows.value = [];
    previous.dirtyRows.value.set(1, new Map([[0, "edited"]]));
    const previousScroller = new TestScroller();
    previousScroller.scrollTop = 6_400;
    previousScroller.scrollLeft = 24;
    previous.scrollerRef.value = previousScroller as unknown as NonNullable<typeof previous.scrollerRef.value>;
    previous.savePendingSnapshot(true, true);

    const remounted = createEditor(undefined, true, key, undefined, rows);
    const remountedScroller = new TestScroller();
    remounted.scrollerRef.value = remountedScroller as unknown as NonNullable<typeof remounted.scrollerRef.value>;
    remounted.restorePendingSnapshotFocus();
    expect(remounted.dirtyRows.value.get(1)?.get(0)).toBe("edited");
    expect(remountedScroller.scrollTop).toBe(6_400);
    expect(remountedScroller.scrollLeft).toBe(24);
  });

  it("keeps pure scroll restore for the KeepAlive reactivate path", () => {
    class TestScroller {
      scrollTop = 0;
      scrollLeft = 0;
      scrollTo({ top, left }: ScrollToOptions) {
        if (typeof top === "number") this.scrollTop = top;
        if (typeof left === "number") this.scrollLeft = left;
      }
    }
    vi.stubGlobal("HTMLElement", TestScroller);
    const rows: CellValue[][] = [
      ["a", null, 1],
      ["b", null, 2],
      ["c", null, 3],
    ];
    const editor = createEditor(undefined, true, "table-tab-activate-path", undefined, rows);
    editor.newRows.value = [];
    const scroller = new TestScroller();
    scroller.scrollTop = 6_400;
    scroller.scrollLeft = 24;
    editor.scrollerRef.value = scroller as unknown as NonNullable<typeof editor.scrollerRef.value>;
    // Deactivate path: snapshot keeps the scroll for the same instance.
    editor.savePendingSnapshot(true, true);
    // Detaching the DOM resets the element's scroll offsets.
    scroller.scrollTop = 0;
    scroller.scrollLeft = 0;
    editor.restorePendingSnapshotFocus();
    expect(scroller.scrollTop).toBe(6_400);
    expect(scroller.scrollLeft).toBe(24);
  });
});

describe("useDataGridEditor row deletion confirmation", () => {
  it("keeps the row pending until confirmation when confirmation is enabled", () => {
    const editor = createEditor(undefined, true);

    editor.requestDeleteRow(-1);

    expect(editor.showDeleteRowConfirm.value).toBe(true);
    expect(editor.newRows.value).toHaveLength(1);

    editor.confirmDeleteRow();
    expect(editor.newRows.value).toHaveLength(0);
  });

  it("applies row deletion immediately when confirmation is disabled", () => {
    const editor = createEditor(undefined, false);

    editor.requestDeleteRow(-1);

    expect(editor.showDeleteRowConfirm.value).toBe(false);
    expect(editor.newRows.value).toHaveLength(0);
  });

  it("populates pendingDeleteRowIds for a single-row delete request", () => {
    const editor = createEditor(undefined, true);

    editor.requestDeleteRow(-1);

    expect(editor.pendingDeleteRowIds.value).toEqual([-1]);
  });

  it("populates pendingDeleteRowIds for a multi-row delete request and clears it on confirm", () => {
    const editor = createEditor(undefined, true);
    editor.newRows.value = [
      [null, null, null],
      [null, null, null],
    ];

    editor.requestDeleteRows([-1, -2]);

    expect(editor.pendingDeleteRowIds.value).toEqual([-1, -2]);

    editor.confirmDeleteRow();

    expect(editor.pendingDeleteRowIds.value).toEqual([]);
    expect(editor.newRows.value).toHaveLength(0);
  });

  it("clears pendingDeleteRowIds when the confirmation dialog is closed without confirming", () => {
    const editor = createEditor(undefined, true);

    editor.requestDeleteRow(-1);
    expect(editor.pendingDeleteRowIds.value).toEqual([-1]);

    editor.showDeleteRowConfirm.value = false;

    expect(editor.pendingDeleteRowIds.value).toEqual([]);
    expect(editor.newRows.value).toHaveLength(1); // row itself was never actually deleted
  });

  it("confirmDeleteRow deletes the row and closes the dialog itself, without racing the cancel watcher", () => {
    const editor = createEditor(undefined, true);

    editor.requestDeleteRow(-1);
    expect(editor.newRows.value).toHaveLength(1);

    editor.confirmDeleteRow();

    expect(editor.newRows.value).toHaveLength(0); // the row must actually be deleted
    expect(editor.showDeleteRowConfirm.value).toBe(false); // and the dialog closes on its own
    expect(editor.pendingDeleteRowIds.value).toEqual([]);
  });
});

describe("useDataGridEditor cell mutation notifications", () => {
  it("notifies cache owners for batched paste, NULL, and restore changes", () => {
    const onCellValueChanged = vi.fn();
    const editor = createEditor(undefined, true, undefined, undefined, [["Ada", "original", "Lovelace"]], onCellValueChanged);

    editor.beginBatch();
    editor.applyCellValue(0, 1, "pasted");
    editor.applyCellValue(0, 1, null);
    editor.commitBatch();
    editor.restoreCellValue(0, 1);

    expect(onCellValueChanged.mock.calls).toEqual([
      [0, 1],
      [0, 1],
      [0, 1],
    ]);
  });

  it("notifies cache owners when undo and redo replace dirty cells", () => {
    const onCellValueChanged = vi.fn();
    const editor = createEditor(undefined, true, undefined, undefined, [["Ada", "original", "Lovelace"]], onCellValueChanged);

    editor.applyCellValue(0, 1, "edited");
    onCellValueChanged.mockClear();
    editor.undoPendingChange();
    editor.redoPendingChange();

    expect(onCellValueChanged.mock.calls).toEqual([
      [0, 1],
      [0, 1],
    ]);
  });
});

describe("useDataGridEditor appendPastedRowsToNewRow", () => {
  beforeEach(() => {
    mocks.getConfig.mockReturnValue({ id: "connection-1", db_type: "postgres" });
  });

  it("fills the selected blank new row and appends remaining rows using visible columns", () => {
    const editor = createEditor();

    const result = editor.appendPastedRowsToNewRow(
      -1,
      [
        ["Ada", "Lovelace"],
        ["Grace", "Hopper"],
      ],
      [0, 2],
    );

    expect(result).toEqual({ ok: true, rowCount: 2 });
    expect(editor.newRows.value).toEqual([
      ["Ada", null, "Lovelace"],
      ["Grace", null, "Hopper"],
    ]);
    expect(editor.hasPendingChanges.value).toBe(true);
  });

  it("aligns pasted INSERT values by column name regardless of visible order", () => {
    const editor = createEditor(["first", "hidden", "last"]);

    // Visible columns are [2, 0]: "last" first, "first" second. The INSERT
    // column names must map values to the real grid columns, not positions.
    const result = editor.appendPastedRowsToNewRow(-1, [["Lovelace", "Ada"]], [2, 0], ["last", "first"]);

    expect(result).toEqual({ ok: true, rowCount: 1 });
    expect(editor.newRows.value).toEqual([["Ada", null, "Lovelace"]]);
  });

  it("matches INSERT column names case-insensitively and ignores unknown names", () => {
    const editor = createEditor(["first", "hidden", "last"]);

    const result = editor.appendPastedRowsToNewRow(-1, [["Ada", "extra", "Lovelace"]], [0, 1, 2], ["FIRST", "not_here", "Last"]);

    expect(result).toEqual({ ok: true, rowCount: 1 });
    expect(editor.newRows.value).toEqual([["Ada", null, "Lovelace"]]);
  });

  it("rejects an INSERT paste when no column names match", () => {
    const editor = createEditor(["first", "hidden", "last"]);

    const result = editor.appendPastedRowsToNewRow(-1, [["x"]], [0, 1, 2], ["nope"]);

    expect(result).toEqual({ ok: false, reason: "no-matching-columns" });
    // The pre-seeded blank new row stays untouched.
    expect(editor.newRows.value).toEqual([[null, null, null]]);
  });

  it("clears generated key columns instead of pasting the copied value", () => {
    const editor = createEditor(undefined, true, undefined, undefined, [], undefined, [
      { name: "first", data_type: "integer", extra: "autoincrement" },
      { name: "hidden", data_type: "varchar" },
      { name: "last", data_type: "varchar" },
    ]);

    const result = editor.appendPastedRowsToNewRow(
      -1,
      [
        ["1", "Lovelace"],
        ["2", "Hopper"],
      ],
      [0, 2],
    );

    expect(result).toEqual({ ok: true, rowCount: 2 });
    expect(editor.newRows.value).toEqual([
      [null, null, "Lovelace"],
      [null, null, "Hopper"],
    ]);
  });

  it("preserves ordinary read-only values when cloning while still blocking edits and paste", () => {
    const editor = createEditor(["first", "hidden", "last"], true, undefined, [0], [["Ada", "hidden", "Lovelace"]]);

    expect(editor.canEditColumn(0)).toBe(false);
    expect(editor.canEditColumn(2)).toBe(true);
    expect(editor.appendPastedRowsToNewRow(-1, [["Ada"]], [0])).toEqual({ ok: false, reason: "readonly-column" });
    editor.applyCellValue(0, 0, null);
    expect(editor.dirtyRows.value.size).toBe(0);
    editor.cloneRow(0);
    expect(editor.newRows.value.at(-1)).toEqual(["Ada", "hidden", "Lovelace"]);
  });

  it("clears opaque aggregate states when cloning and prefers the result type over metadata", () => {
    const opaque = createEditor(
      ["first", "hidden", "last"],
      true,
      undefined,
      [1],
      [["Ada", "0x00ff", "Lovelace"]],
      undefined,
      [
        { name: "first", data_type: "varchar" },
        { name: "hidden", data_type: "varchar" },
        { name: "last", data_type: "varchar" },
      ],
      false,
      false,
      ref(true),
      ["varchar", "agg_state<sum(int)>", "varchar"],
    );
    opaque.cloneRow(0);
    expect(opaque.newRows.value.at(-1)).toEqual(["Ada", null, "Lovelace"]);

    const metadataFallback = createEditor(["first", "hidden", "last"], true, undefined, [1], [["Ada", "0x00ff", "Lovelace"]], undefined, [
      { name: "first", data_type: "varchar" },
      { name: "hidden", data_type: "agg_state<sum(int)>" },
      { name: "last", data_type: "varchar" },
    ]);
    metadataFallback.cloneRow(0);
    expect(metadataFallback.newRows.value.at(-1)).toEqual(["Ada", null, "Lovelace"]);

    const resultTypeWins = createEditor(
      ["first", "hidden", "last"],
      true,
      undefined,
      [1],
      [["Ada", "ordinary", "Lovelace"]],
      undefined,
      [
        { name: "first", data_type: "varchar" },
        { name: "hidden", data_type: "agg_state<sum(int)>" },
        { name: "last", data_type: "varchar" },
      ],
      false,
      false,
      ref(true),
      ["varchar", "varchar", "varchar"],
    );
    resultTypeWins.cloneRow(0);
    expect(resultTypeWins.newRows.value.at(-1)).toEqual(["Ada", "ordinary", "Lovelace"]);
  });

  it("fills following blank new rows before adding more rows", () => {
    const editor = createEditor();
    editor.newRows.value = [
      [null, null, null],
      [null, null, null],
    ];

    const result = editor.appendPastedRowsToNewRow(-1, [["Ada"], ["Grace"]], [0, 2]);

    expect(result).toEqual({ ok: true, rowCount: 2 });
    expect(editor.newRows.value).toEqual([
      ["Ada", null, null],
      ["Grace", null, null],
    ]);
  });

  it("turns rows pasted into the terminal new-row draft into pending rows", () => {
    const editor = createEditor();
    editor.newRows.value = [];

    const result = editor.appendPastedRowsToNewRow(
      DATA_GRID_QUICK_ENTRY_DRAFT_ROW_ID,
      [
        ["Ada", "Lovelace"],
        ["Grace", "Hopper"],
      ],
      [0, 2],
    );

    expect(result).toEqual({ ok: true, rowCount: 2 });
    expect(editor.newRows.value).toEqual([
      ["Ada", null, "Lovelace"],
      ["Grace", null, "Hopper"],
    ]);
    expect(editor.quickEntryDraftRow.value).toEqual([null, null, null]);
    expect(editor.hasPendingChanges.value).toBe(true);

    editor.undoPendingChange();
    expect(editor.newRows.value).toEqual([]);
    expect(editor.quickEntryDraftRow.value).toEqual([null, null, null]);

    editor.redoPendingChange();
    expect(editor.newRows.value).toEqual([
      ["Ada", null, "Lovelace"],
      ["Grace", null, "Hopper"],
    ]);
  });

  it("rejects a non-empty terminal new-row draft", () => {
    const editor = createEditor();
    editor.newRows.value = [];
    editor.quickEntryDraftRow.value = ["already", null, null];

    const result = editor.appendPastedRowsToNewRow(DATA_GRID_QUICK_ENTRY_DRAFT_ROW_ID, [["Ada"]], [0, 2]);

    expect(result).toEqual({ ok: false, reason: "target-not-empty" });
    expect(editor.newRows.value).toEqual([]);
    expect(editor.quickEntryDraftRow.value).toEqual(["already", null, null]);
  });

  it("truncates pasted columns that exceed the visible table columns", () => {
    const editor = createEditor();

    const result = editor.appendPastedRowsToNewRow(-1, [["Ada", "Byron", "Lovelace"]], [0, 2]);

    expect(result).toEqual({ ok: true, rowCount: 1 });
    expect(editor.newRows.value).toEqual([["Ada", null, "Byron"]]);
    expect(editor.canUndoPendingChange.value).toBe(true);
  });

  it("rejects an empty textual clipboard payload without changing pending rows", () => {
    const editor = createEditor();

    const result = editor.appendPastedRowsToNewRow(-1, [[""]], [0, 2]);

    expect(result).toEqual({ ok: false, reason: "empty-paste" });
    expect(editor.newRows.value).toEqual([[null, null, null]]);
    expect(editor.canUndoPendingChange.value).toBe(false);
  });

  it("rejects a paste that targets a read-only visible column", () => {
    const editor = createEditor(["first", undefined, "last"]);

    const result = editor.appendPastedRowsToNewRow(-1, [["Ada"]], [1]);

    expect(result).toEqual({ ok: false, reason: "readonly-column" });
    expect(editor.newRows.value).toEqual([[null, null, null]]);
  });

  it("does not overwrite an existing new row selected as the append target", () => {
    const editor = createEditor();
    editor.newRows.value = [["already", null, null]];

    const result = editor.appendPastedRowsToNewRow(-1, [["Ada"]], [0, 2]);

    expect(result).toEqual({ ok: false, reason: "target-not-empty" });
    expect(editor.newRows.value).toEqual([["already", null, null]]);
  });

  it("treats a batch append as one undoable change", () => {
    const editor = createEditor();

    editor.appendPastedRowsToNewRow(-1, [["Ada"], ["Grace"]], [0, 2]);
    editor.undoPendingChange();
    expect(editor.newRows.value).toEqual([[null, null, null]]);

    editor.redoPendingChange();
    expect(editor.newRows.value).toEqual([
      ["Ada", null, null],
      ["Grace", null, null],
    ]);
  });

  it("uses resolved full values instead of preview values when cloning", () => {
    const editor = createEditor();
    editor.newRows.value = [["Ada", "preview...", "Lovelace"]];

    editor.cloneRow(-1, new Map([[1, "full payload"]]));

    expect(editor.newRows.value[1]).toEqual(["Ada", "full payload", "Lovelace"]);
  });

  it("places a cloned source row below its source row", () => {
    const editor = createEditor(undefined, true, undefined, undefined, [
      ["Ada", null, "Lovelace"],
      ["Grace", null, "Hopper"],
    ]);
    editor.newRows.value = [];
    editor.newRowMeta.value = [];

    editor.cloneRow(1);

    expect(editor.newRowMeta.value[0]?.placement).toEqual({ anchorId: 1, position: "below" });
  });

  it("keeps the scroll position when the cloned row anchors below its source row", async () => {
    class ScrollerStub {
      scrollTop = 0;
      scrollHeight = 4_000;
    }
    vi.stubGlobal("HTMLElement", ScrollerStub);
    const editor = createEditor(undefined, true, undefined, undefined, [
      ["Ada", null, "Lovelace"],
      ["Grace", null, "Hopper"],
    ]);
    editor.newRows.value = [];
    editor.newRowMeta.value = [];
    const scroller = new ScrollerStub();
    editor.scrollerRef.value = scroller as unknown as NonNullable<typeof editor.scrollerRef.value>;

    editor.cloneRow(1);
    await nextTick();
    vi.unstubAllGlobals();

    expect(editor.newRowMeta.value[0]?.placement).toEqual({ anchorId: 1, position: "below" });
    expect(scroller.scrollTop).toBe(0);
  });

  it("places a cloned pending row below the pending source row", () => {
    const editor = createEditor();
    editor.newRows.value = [];
    editor.newRowMeta.value = [];
    editor.addRows(1);

    editor.cloneRow(-1);

    expect(editor.newRowMeta.value[1]?.placement).toEqual({ anchorId: -1, position: "below" });
  });

  it("places each multi-row clone below its corresponding source row", () => {
    const editor = createEditor(undefined, true, undefined, undefined, [
      ["Ada", null, "Lovelace"],
      ["Grace", null, "Hopper"],
    ]);
    editor.newRows.value = [];
    editor.newRowMeta.value = [];

    editor.cloneRows([1, 0]);

    expect(editor.newRowMeta.value.map((meta) => meta.placement)).toEqual([
      { anchorId: 1, position: "below" },
      { anchorId: 0, position: "below" },
    ]);
  });
});

describe("useDataGridEditor saveChanges reload", () => {
  beforeEach(() => {
    mocks.prepareDataGridSave.mockReset();
    mocks.executeBatch.mockReset();
    mocks.executeConditionalUpdate.mockReset();
    mocks.cancelConditionalUpdate.mockReset();
    mocks.executeInTransaction.mockReset();
    mocks.executeInManualTransaction.mockReset();
    mocks.executeQuery.mockReset();
    mocks.addHistory.mockReset();
    mocks.getConfig.mockReset();
  });

  function createSaveTestEditor(
    options: {
      joinedWriteTargets?: import("@/types/database").QueryTab["queryWriteTargets"];
      queryResult?: { columns: string[]; rows: CellValue[][] };
      currentPage?: Ref<number>;
      prepareFullReload?: () => void;
      customSaveHandler?: CustomSaveHandler;
      confirmSaveRequest?: (request: import("@/composables/useDataGridEditor").DataGridSaveConfirmationRequest) => Promise<boolean>;
      confirmSaveRequestRef?: Ref<((request: import("@/composables/useDataGridEditor").DataGridSaveConfirmationRequest) => Promise<boolean>) | undefined>;
      manualTransactionSessionId?: string;
      manualTransactionSessionIdRef?: Ref<string | undefined>;
      ensureManualTransactionSession?: () => Promise<string>;
      refreshSavedRows?: ReturnType<typeof vi.fn>;
      onManualTransactionMutation?: ReturnType<typeof vi.fn>;
      connectionId?: string;
      databaseRef?: Ref<string | undefined>;
      databaseType?: import("@/types/database").DatabaseType;
      quickEntry?: boolean;
      editable?: Ref<boolean>;
      resolveNewRowItems?: boolean;
      resolveExistingRowItems?: boolean;
      cacheKey?: string;
      primaryKeys?: string[];
      onExecuteSql?: (sql: string) => Promise<void>;
    } = {},
  ) {
    const emit = vi.fn();
    const currentPage = options.currentPage ?? ref(1);
    const ensureManualTransactionSession = ref(options.ensureManualTransactionSession);
    const result = ref<{ columns: string[]; rows: CellValue[][] }>({
      columns: ["id", "status"],
      rows: [
        [1, "pending"],
        [2, "pending"],
      ],
    });
    if (options.queryResult) result.value = options.queryResult;
    let editor: ReturnType<typeof useDataGridEditor>;
    editor = useDataGridEditor({
      result: computed(() => result.value),
      editable: computed(() => options.editable?.value ?? true),
      databaseType: computed(() => options.databaseType ?? "mysql"),
      connectionId: computed(() => ("connectionId" in options ? options.connectionId : "connection-1")),
      database: computed(() => options.databaseRef ? options.databaseRef.value : "app"),
      tableMeta: computed(() => ({
        tableName: "orders_test",
        columns: [
          { name: "id", data_type: "int" },
          { name: "status", data_type: "varchar" },
        ],
        primaryKeys: options.primaryKeys ?? ["id"],
      })),
      sourceColumns: computed(() => undefined),
      joinedWriteTargets: computed(() => options.joinedWriteTargets),
      onExecuteSql: computed(() => options.onExecuteSql),
      customSaveHandler: computed(() => options.customSaveHandler),
      confirmSaveRequest: computed(() => options.confirmSaveRequestRef ? options.confirmSaveRequestRef.value : options.confirmSaveRequest),
      manualTransactionSessionId: computed(() => options.manualTransactionSessionIdRef ? options.manualTransactionSessionIdRef.value : options.manualTransactionSessionId),
      ensureManualTransactionSession: computed(() => ensureManualTransactionSession.value),
      onManualTransactionMutation: options.onManualTransactionMutation,
      sql: computed(() => undefined),
      searchText: ref(""),
      whereFilterInput: ref(""),
      currentWhereInput: computed(() => undefined),
      orderByInput: ref(""),
      rowStatusFilter: ref("all"),
      confirmDangerousRowDeletion: computed(() => true),
      dataGridQuickEntryEnabled: computed(() => options.quickEntry ?? false),
      pageSize: ref(100),
      currentPage,
      cacheKey: computed(() => options.cacheKey),
      getRowItem: (rowId) => {
        if (rowId >= 0 && options.resolveExistingRowItems) {
          // Same unfiltered source-index and live dirty overlay as the existing
          // createEditorWithResult fixture, not a mounted DataGrid resolver.
          const row = result.value.rows[rowId];
          if (!row) return undefined;
          const changes = editor.dirtyRows.value.get(rowId);
          return {
            id: rowId,
            sourceIndex: rowId,
            data: editor.rowDataWithChanges(row, rowId),
            isNew: false,
            isDeleted: editor.deletedRows.value.has(rowId),
            isDirtyCol: row.map((_, col) => changes?.has(col) ?? false),
            status: editor.deletedRows.value.has(rowId) ? "deleted" : changes?.size ? "edited" : "clean",
          };
        }
        if (!options.resolveNewRowItems || rowId >= 0) return undefined;
        // Minimal injected resolver: DataGrid uses -(newIndex + 1) and the live
        // newRows entry. This is not the full resolver or a mounted UI fixture.
        const newIndex = -rowId - 1;
        const row = editor.newRows.value[newIndex];
        if (!row) return undefined;
        return {
          id: rowId,
          newIndex,
          data: row,
          isNew: true,
          isDeleted: false,
          isDirtyCol: result.value.columns.map(() => false),
          status: "new",
        };
      },
      prepareFullReload: options.prepareFullReload,
      refreshSavedRows: options.refreshSavedRows,
      emit,
    });
    return { editor, emit, currentPage, ensureManualTransactionSession, result };
  }

  describe("pre-dispatch snapshot retirement", () => {
    // SOURCE ONLY / UNRUN. These gates exercise the composable, not a model of it.
    const boundaries = ["custom-preview", "custom-confirm", "sql-prepare", "manual-session", "keyless", "sql-production", "sql-confirm"] as const;
    type Boundary = typeof boundaries[number];
    const statement = "UPDATE orders_test SET status='P' WHERE id=1";

    function fixture(boundary: Boundary) {
      let release!: () => void;
      let reject!: (reason: unknown) => void;
      let enter!: () => void;
      const entered = new Promise<void>((done) => { enter = done; });
      const gate = new Promise<void>((yes, no) => { release = yes; reject = no; });
      // Observe even a gate whose boundary is unexpectedly not reached.
      const gateObserved = gate.then(() => undefined, () => undefined);
      const pause = () => { enter(); return gate; };
      const prepared = { statements: [statement], rollbackStatements: [], keylessGuards: boundary === "keyless" ? [keylessGuard] : [] };
      const save = vi.fn().mockResolvedValue(undefined);
      const preview = vi.fn(() => boundary === "custom-preview" ? pause().then(() => [statement]) : Promise.resolve([statement]));
      const confirm = vi.fn(() => boundary === "custom-confirm" || boundary === "sql-confirm" ? pause().then(() => true) : Promise.resolve(true));
      mocks.getConfig.mockReturnValue(boundary === "sql-production" ? { id: "connection-1", db_type: "mysql", is_production: true } : undefined);
      mocks.prepareDataGridSave.mockResolvedValue(prepared);
      if (boundary === "sql-prepare") mocks.prepareDataGridSave.mockImplementationOnce(() => pause().then(() => prepared));
      if (boundary === "sql-production") mocks.requestProductionConfirmation.mockImplementationOnce(() => pause().then(() => true));
      mocks.executeQuery.mockImplementationOnce(() => pause().then(() => ({ columns: ["matches"], rows: [[1]] })));
      mocks.executeBatch.mockResolvedValue({ affected_rows: 1 });
      mocks.executeInManualTransaction.mockResolvedValue([{ affected_rows: 1 }]);
      mocks.addHistory.mockResolvedValue(undefined);
      const created = createSaveTestEditor({
        customSaveHandler: boundary.startsWith("custom") ? { save, preview, supportsInsert: true } : undefined,
        confirmSaveRequest: boundary.startsWith("custom") || boundary === "sql-confirm" ? confirm : undefined,
        ensureManualTransactionSession: boundary === "manual-session" ? () => pause().then(() => "txn-1") : undefined,
        quickEntry: true, resolveExistingRowItems: true, resolveNewRowItems: true,
      });
      return { ...created, save, release, reject, entered, gateObserved };
    }

    async function waitForGate(entered: Promise<void>, settled: Promise<unknown>) {
      const winner = await Promise.race([entered.then(() => "entered"), settled.then(() => "settled", () => "settled")]);
      if (winner !== "entered") throw new Error("Dispatch fence boundary not reached before save settled");
    }

    for (const boundary of boundaries) {
      it.each(["replace-P", "reverse-P", "append-Q", "replace-rows", "reactive-rows", "replace-columns", "open-batch"] as const)(`retires accepted ${boundary} without dispatch/replay after %s`, async (change) => {
        const f = fixture(boundary);
        f.editor.applyCellValue(0, 1, "P");
        const observed = f.editor.saveChanges().then(() => undefined, (error) => error);
        try {
          await waitForGate(f.entered, observed);
          // Raw identity seam avoids the separate reactive rows watcher, whose
          // established policy is to discard edits on an actual replacement.
          if (change === "replace-rows") toRaw(f.result.value).rows = [[1, "replacement"], [2, "pending"]];
          else if (change === "reactive-rows") {
            f.result.value.rows = [[1, "replacement"], [2, "pending"]];
            await nextTick();
            expect(f.editor.hasPendingChanges.value).toBe(false);
          }
          else if (change === "replace-columns") f.result.value.columns = ["id", "replacement"];
          else if (change === "open-batch") {
            f.editor.beginBatch();
            f.editor.applyCellValue(0, 1, "R");
          } else if (change === "append-Q") f.editor.addRows(1);
          else {
            f.editor.startEdit(0, 1);
            f.editor.editValue.value = "Q";
            await f.editor.commitEditFromBlur();
            f.editor.applyCellValue(0, 1, change === "reverse-P" ? "pending" : "R");
          }
          await f.editor.saveChanges({ autoSave: true });
          f.release();
          expect(await observed).toBeUndefined();
          expect(f.save).not.toHaveBeenCalled();
          expect(mocks.executeBatch).not.toHaveBeenCalled();
          expect(mocks.executeInTransaction).not.toHaveBeenCalled();
          expect(mocks.executeInManualTransaction).not.toHaveBeenCalled();
          expect(mocks.addHistory).not.toHaveBeenCalled();
          expect(f.emit).not.toHaveBeenCalled();
          expect(f.editor.isSaving.value).toBe(false);
          expect(f.editor.dirtyRows.value.get(0)?.get(1)).toBe(change === "reverse-P" || change === "reactive-rows" ? undefined : change === "replace-P" || change === "open-batch" ? "R" : "P");
          if (change === "append-Q") expect(f.editor.newRows.value).toHaveLength(1);
        } finally {
          f.release();
          await observed;
          await f.gateObserved;
          f.editor.commitBatch();
        }
      });

      it(`preserves unchanged accepted ${boundary} dispatch`, async () => {
        const f = fixture(boundary);
        f.editor.applyCellValue(0, 1, "P");
        const observed = f.editor.saveChanges().then(() => undefined, (error) => error);
        try {
          await waitForGate(f.entered, observed);
          f.release();
          expect(await observed).toBeUndefined();
          expect(boundary.startsWith("custom") ? f.save : boundary === "manual-session" ? mocks.executeInManualTransaction : mocks.executeBatch).toHaveBeenCalledOnce();
          expect(f.editor.hasPendingChanges.value).toBe(false);
          expect(f.editor.isSaving.value).toBe(false);
        } finally {
          f.release();
          await observed;
          await f.gateObserved;
        }
      });
    }

    it.each(["returned-session", "unrelated-session"] as const)("handles initializer publication of %s", async (published) => {
      let release!: () => void;
      let enter!: () => void;
      const gate = new Promise<void>((done) => { release = done; });
      const entered = new Promise<void>((done) => { enter = done; });
      const session = ref<string | undefined>(undefined);
      mocks.prepareDataGridSave.mockResolvedValue({ statements: [statement], rollbackStatements: [] });
      mocks.executeInManualTransaction.mockResolvedValue([{ affected_rows: 1 }]);
      mocks.addHistory.mockResolvedValue(undefined);
      const f = createSaveTestEditor({
        manualTransactionSessionIdRef: session,
        ensureManualTransactionSession: () => {
          enter();
          return gate.then(() => { session.value = published; return "returned-session"; });
        },
        resolveExistingRowItems: true,
      });
      f.editor.applyCellValue(0, 1, "P");
      const observed = f.editor.saveChanges().then(() => undefined, (error) => error);
      try {
        await waitForGate(entered, observed);
        release();
        expect(await observed).toBeUndefined();
        expect(session.value).toBe(published);
        expect(mocks.executeBatch).not.toHaveBeenCalled();
        expect(f.editor.isSaving.value).toBe(false);
        if (published === "returned-session") {
          expect(mocks.executeInManualTransaction).toHaveBeenCalledWith("returned-session", statement, "app", undefined);
          expect(f.editor.hasPendingChanges.value).toBe(false);
        } else {
          expect(mocks.executeInManualTransaction).not.toHaveBeenCalled();
          expect(mocks.addHistory).not.toHaveBeenCalled();
          expect(f.editor.dirtyRows.value.get(0)?.get(1)).toBe("P");
        }
      } finally {
        release();
        await observed;
      }
    });

    for (const restoreTarget of [false, true]) {
      it.each(["joined-prepare", "keyless-guards"] as const)(`stops subsequent %s calls after helper invalidation (restore target: ${restoreTarget})`, async (boundary) => {
        let release!: () => void;
        let enter!: () => void;
        const gate = new Promise<void>((done) => { release = done; });
        const entered = new Promise<void>((done) => { enter = done; });
        const targets = [
          { tableMeta: { tableName: "users", primaryKeys: ["id"], columns: [] }, sourceColumns: ["id", "name", undefined, undefined] },
          { tableMeta: { tableName: "papers", primaryKeys: ["id"], columns: [] }, sourceColumns: [undefined, undefined, "id", "title"] },
        ];
        const prepared = { statements: [statement], rollbackStatements: [], keylessGuards: boundary === "keyless-guards" ? [keylessGuard, keylessGuard] : [] };
        mocks.prepareDataGridSave.mockResolvedValue(prepared);
        if (boundary === "joined-prepare") mocks.prepareDataGridSave.mockResolvedValueOnce(prepared).mockImplementationOnce(() => { enter(); return gate.then(() => prepared); });
        if (boundary === "keyless-guards") mocks.executeQuery.mockImplementationOnce(() => { enter(); return gate.then(() => ({ columns: ["matches"], rows: [[1]] })); });
        const f = createSaveTestEditor({
          joinedWriteTargets: boundary === "joined-prepare" ? targets : undefined,
          queryResult: { columns: ["id", "name", "paper_id", "title"], rows: [[1, "old", 20, "old"]] },
        });
        f.editor.dirtyRows.value.set(0, new Map([[1, "P"], [3, "P"]]));
        const observed = f.editor.saveChanges().then(() => undefined, (error) => error);
        let restoration: Promise<void> | undefined;
        try {
          await waitForGate(entered, observed);
          const originalRows = toRaw(f.result.value).rows;
          // Raw identity seam isolates the fence from the normal discard watcher.
          toRaw(f.result.value).rows = [[2, "replacement", 21, "replacement"]];
          release();
          if (restoreTarget) {
            // Gate reaction resolves the API promise; helper then observes stale
            // identity. Restore in the following microtask, before outer await
            // continuation. A non-sticky outer recheck would accept partial work.
            restoration = Promise.resolve().then(() => Promise.resolve().then(() => {
              toRaw(f.result.value).rows = originalRows;
            }));
          }
          expect(await observed).toBeUndefined();
          await restoration;
          if (restoreTarget) expect(toRaw(f.result.value).rows).toBe(originalRows);
          expect(boundary === "joined-prepare" ? mocks.prepareDataGridSave : mocks.executeQuery).toHaveBeenCalledTimes(boundary === "joined-prepare" ? 2 : 1);
          expect(mocks.executeBatch).not.toHaveBeenCalled();
          expect(mocks.executeInTransaction).not.toHaveBeenCalled();
          expect(mocks.addHistory).not.toHaveBeenCalled();
          expect(f.editor.dirtyRows.value.get(0)?.size).toBe(2);
          expect(f.editor.isSaving.value).toBe(false);
        } finally {
          release();
          await observed;
          await restoration;
        }
      });
    }

    it.each(["custom-confirm", "sql-confirm"] as const)("releases saved-insert locks when accepted %s becomes stale", async (boundary) => {
      const f = fixture(boundary);
      f.editor.newRows.value = [[3, "P"]];
      const observed = f.editor.saveChanges().then(() => undefined, (error) => error);
      try {
        await waitForGate(f.entered, observed);
        f.editor.applyCellValue(-1, 1, "blocked");
        expect(f.editor.newRows.value[0]).toEqual([3, "P"]);
        f.result.value.columns = ["id", "replacement"];
        f.release();
        expect(await observed).toBeUndefined();
        expect(f.save).not.toHaveBeenCalled();
        expect(mocks.executeBatch).not.toHaveBeenCalled();
        expect(f.editor.newRows.value[0]).toEqual([3, "P"]);
        f.editor.applyCellValue(-1, 1, "fresh");
        expect(f.editor.newRows.value[0]).toEqual([3, "fresh"]);
        expect(f.editor.isSaving.value).toBe(false);
      } finally {
        f.release();
        await observed;
        await f.gateObserved;
      }
    });

    it.each(["custom-preview", "sql-prepare", "manual-session", "keyless"] as const)("retires %s rejection without replaying queued Q over R", async (boundary) => {
      const f = fixture(boundary);
      f.editor.applyCellValue(0, 1, "P");
      const observed = f.editor.saveChanges().then(() => undefined, (error) => error);
      try {
        await waitForGate(f.entered, observed);
        f.editor.startEdit(0, 1);
        f.editor.editValue.value = "Q";
        await f.editor.commitEditFromBlur();
        f.editor.applyCellValue(0, 1, "R");
        f.reject(new Error("synthetic preparation failure"));
        expect(await observed).toBeUndefined();
        expect(f.editor.saveError.value).toContain("synthetic preparation failure");
        expect(f.editor.dirtyRows.value.get(0)?.get(1)).toBe("R");
        expect(f.editor.isSaving.value).toBe(false);
        expect(f.save).not.toHaveBeenCalled();
        expect(mocks.executeBatch).not.toHaveBeenCalled();
        expect(mocks.addHistory).not.toHaveBeenCalled();
      } finally {
        f.release();
        await observed;
        await f.gateObserved;
      }
    });
  });

  describe("later approval interruption cleanup", () => {
    // SOURCE ONLY: none of these regressions has been executed.
    const boundaries = ["custom-confirm", "sql-production", "sql-confirm"] as const;
    type Boundary = typeof boundaries[number];
    const statement = "UPDATE orders_test SET status='P' WHERE id=1";

    async function waitForApproval(started: Promise<void>, settledSave: Promise<unknown>) {
      const winner = await Promise.race([
        started.then(() => "approval"),
        settledSave.then(() => "settled", () => "settled"),
      ]);
      if (winner !== "approval") throw new Error("Approval not reached before save settled");
    }

    function approvalFixture(boundary: Boundary) {
      let resolve!: (value: boolean) => void;
      let reject!: (reason: unknown) => void;
      let entered!: () => void;
      const started = new Promise<void>((done) => { entered = done; });
      const gate = new Promise<boolean>((yes, no) => { resolve = yes; reject = no; });
      const approve = vi.fn(() => { entered(); return gate; });
      const callback = ref<((request: import("@/composables/useDataGridEditor").DataGridSaveConfirmationRequest) => Promise<boolean>) | undefined>(boundary === "sql-production" ? undefined : approve);
      const customSave = vi.fn().mockResolvedValue(undefined);
      const preview = vi.fn().mockResolvedValue([statement]);
      mocks.prepareDataGridSave.mockResolvedValue({ statements: [statement], rollbackStatements: [] });
      mocks.executeBatch.mockResolvedValue({ affected_rows: 1 });
      mocks.addHistory.mockResolvedValue(undefined);
      mocks.getConfig.mockReturnValue(boundary === "sql-production" ? { id: "connection-1", db_type: "mysql", is_production: true } : undefined);
      if (boundary === "sql-production") mocks.requestProductionConfirmation.mockImplementation(approve);
      const fixture = createSaveTestEditor({
        confirmSaveRequestRef: callback,
        customSaveHandler: boundary === "custom-confirm" ? { save: customSave, preview, supportsInsert: true } : undefined,
        quickEntry: true,
        resolveExistingRowItems: true,
        resolveNewRowItems: true,
      });
      const disableApproval = () => {
        callback.value = undefined;
        mocks.getConfig.mockReturnValue(undefined);
      };
      return { ...fixture, resolve, reject, started, approve, callback, customSave, disableApproval };
    }

    for (const boundary of boundaries) {
      it.each(["reject", "decline"] as const)(`releases ${boundary} inserts without retrying after %s`, async (outcome) => {
        const f = approvalFixture(boundary);
        f.editor.newRows.value = [[3, "P"]];
        const failure = { reason: "synthetic approval rejection" };
        const save = f.editor.saveChanges();
        // Observe rejection immediately, including non-Error rejection identity.
        const observed = save.then(() => undefined, (error) => error);
        try {
          await waitForApproval(f.started, observed);
          expect(f.editor.isSaving.value).toBe(true);
          f.editor.applyCellValue(-1, 1, "blocked");
          expect(f.editor.newRows.value).toEqual([[3, "P"]]);
          await f.editor.saveChanges({ autoSave: true });
          f.disableApproval();
          if (outcome === "reject") f.reject(failure);
          else f.resolve(false);
          expect(await observed).toBe(outcome === "reject" ? failure : undefined);
          expect(f.editor.isSaving.value).toBe(false);
          expect(f.editor.newRows.value).toEqual([[3, "P"]]);
          expect(f.customSave).not.toHaveBeenCalled();
          expect(mocks.executeBatch).not.toHaveBeenCalled();
          expect(mocks.addHistory).not.toHaveBeenCalled();
          expect(f.emit).not.toHaveBeenCalled();
          f.editor.applyCellValue(-1, 1, "fresh");
          expect(f.editor.newRows.value).toEqual([[3, "fresh"]]);
          await f.editor.saveChanges();
          expect(boundary === "custom-confirm" ? f.customSave : mocks.executeBatch).toHaveBeenCalledOnce();
          expect(f.editor.newRows.value).toEqual([]);
          expect(f.editor.isSaving.value).toBe(false);
        } finally {
          f.resolve(false);
          await observed;
        }
      });

      for (const outcome of ["reject", "decline"] as const) {
        it.each(["R", "pending"])(`preserves live Q then R/reversal after ${boundary} ${outcome} without replaying stale Q (%s)`, async (latest) => {
          const f = approvalFixture(boundary);
          f.editor.applyCellValue(0, 1, "P");
          const failure = new Error("approval unavailable");
          const observed = f.editor.saveChanges().then(() => undefined, (error) => error);
          try {
            await waitForApproval(f.started, observed);
            f.editor.startEdit(0, 1);
            f.editor.editValue.value = "Q";
            await f.editor.commitEditFromBlur();
            // applyCellValue updates live intent but does not refresh the blur shadow.
            f.editor.applyCellValue(0, 1, latest);
            f.disableApproval();
            if (outcome === "reject") f.reject(failure);
            else f.resolve(false);
            expect(await observed).toBe(outcome === "reject" ? failure : undefined);
            expect(f.editor.isSaving.value).toBe(false);
            expect(f.editor.dirtyRows.value.get(0)?.get(1)).toBe(latest === "pending" ? undefined : latest);
            expect(f.editor.canUndoPendingChange.value).toBe(true);
            expect(f.customSave).not.toHaveBeenCalled();
            expect(mocks.executeBatch).not.toHaveBeenCalled();
            expect(mocks.addHistory).not.toHaveBeenCalled();
            // A fresh manual save sees current live intent, not the rejected P or Q.
            await f.editor.saveChanges();
            const writer = boundary === "custom-confirm" ? f.customSave : mocks.executeBatch;
            expect(writer).toHaveBeenCalledTimes(latest === "pending" ? 0 : 1);
            if (latest !== "pending") {
              if (boundary === "custom-confirm") expect(f.customSave.mock.calls[0]?.[0].dirtyRows.get(0)?.get(1)).toBe("R");
              else expect(mocks.prepareDataGridSave.mock.calls.at(-1)?.[0].dirtyRows).toEqual([[0, [[1, "R"]]]]);
            }
            expect(f.editor.hasPendingChanges.value).toBe(false);
          } finally {
            f.resolve(false);
            await observed;
          }
        });
      }

      it(`preserves ordinary accepted ${boundary} saving`, async () => {
        const f = approvalFixture(boundary);
        f.editor.applyCellValue(0, 1, "P");
        const save = f.editor.saveChanges();
        const observed = save.then(() => undefined, (error) => error);
        try {
          await waitForApproval(f.started, observed);
          f.resolve(true);
          await save;
          expect(boundary === "custom-confirm" ? f.customSave : mocks.executeBatch).toHaveBeenCalledOnce();
          expect(f.editor.hasPendingChanges.value).toBe(false);
          expect(f.editor.isSaving.value).toBe(false);
        } finally {
          f.resolve(false);
          await observed;
        }
      });
    }

    it.each(["sql-production", "sql-confirm"] as const)("preserves F after rejected %s during explicit batch retry", async (boundary) => {
      const f = approvalFixture(boundary);
      // First establish F via an actual mocked non-transactional batch failure.
      const approval = f.callback.value;
      f.disableApproval();
      mocks.executeBatch.mockRejectedValueOnce(new Error("synthetic partial batch failure"));
      f.editor.applyCellValue(0, 1, "P");
      await f.editor.saveChanges();
      expect(f.editor.manualSaveRequired.value).toBe(true);
      if (boundary === "sql-confirm") f.callback.value = approval;
      else mocks.getConfig.mockReturnValue({ id: "connection-1", db_type: "mysql", is_production: true });
      const failure = new Error("retry approval rejected");
      const observed = f.editor.saveChanges().then(() => undefined, (error) => error);
      try {
        await waitForApproval(f.started, observed);
        f.editor.startEdit(0, 1);
        f.editor.editValue.value = "pending";
        await f.editor.commitEditFromBlur();
        f.disableApproval();
        f.reject(failure);
        expect(await observed).toBe(failure);
        expect(f.editor.hasPendingChanges.value).toBe(false);
        expect(f.editor.manualSaveRequired.value).toBe(true);
        expect(f.editor.isSaving.value).toBe(false);
        f.editor.applyCellValue(0, 1, "fresh");
        await f.editor.saveChanges({ autoSave: true });
        expect(mocks.executeBatch).toHaveBeenCalledOnce();
        expect(f.editor.dirtyRows.value.get(0)?.get(1)).toBe("fresh");
        await f.editor.saveChanges();
        expect(mocks.executeBatch).toHaveBeenCalledTimes(2);
        expect(f.editor.manualSaveRequired.value).toBe(false);
      } finally {
        f.resolve(false);
        await observed;
      }
    });
    it.each(["sql-production", "sql-confirm"] as const)("preserves F after accepted stale %s during explicit batch retry", async (boundary) => {
      const f = approvalFixture(boundary);
      // First establish F via an actual mocked non-transactional batch failure.
      const approval = f.callback.value;
      f.disableApproval();
      mocks.executeBatch.mockRejectedValueOnce(new Error("synthetic partial batch failure"));
      f.editor.applyCellValue(0, 1, "P");
      await f.editor.saveChanges();
      expect(f.editor.manualSaveRequired.value).toBe(true);
      if (boundary === "sql-confirm") f.callback.value = approval;
      else mocks.getConfig.mockReturnValue({ id: "connection-1", db_type: "mysql", is_production: true });
      const observed = f.editor.saveChanges().then(() => undefined, (error) => error);
      try {
        await waitForApproval(f.started, observed);
        f.editor.startEdit(0, 1);
        f.editor.editValue.value = "pending";
        await f.editor.commitEditFromBlur();
        f.disableApproval();
        f.resolve(true);
        expect(await observed).toBeUndefined();
        expect(f.editor.hasPendingChanges.value).toBe(false);
        expect(f.editor.manualSaveRequired.value).toBe(true);
        expect(f.editor.isSaving.value).toBe(false);
        f.editor.applyCellValue(0, 1, "fresh");
        await f.editor.saveChanges({ autoSave: true });
        expect(mocks.executeBatch).toHaveBeenCalledOnce();
        expect(f.editor.dirtyRows.value.get(0)?.get(1)).toBe("fresh");
        await f.editor.saveChanges();
        expect(mocks.executeBatch).toHaveBeenCalledTimes(2);
        expect(f.editor.manualSaveRequired.value).toBe(false);
      } finally {
        f.resolve(false);
        await observed;
      }
    });
  });

  describe("same-instance preflight reservation requirements", () => {
    // These are source-only regressions against the actual composable. Only
    // external unlock/confirmation/API boundaries are deferred or mocked.
    // No private reservation state or replacement save implementation is used.
    const updateSql = "UPDATE orders_test SET status='changed' WHERE id=1";
    const conditionalSql = "UPDATE orders_test SET status='conditional' WHERE id=2";

    function deferredBoolean() {
      let resolve!: (value: boolean) => void;
      let reject!: (reason: Error) => void;
      const promise = new Promise<boolean>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      return { promise, resolve, reject };
    }

    beforeEach(() => {
      mocks.getConfig.mockReturnValue({ id: "connection-1", name: "Read-only fixture", db_type: "mysql", read_only: true });
      mocks.prepareDataGridSave.mockResolvedValue({ statements: [updateSql], rollbackStatements: [] });
      mocks.executeBatch.mockResolvedValue({ affected_rows: 1 });
      mocks.executeConditionalUpdate.mockResolvedValue({ affected_rows: 1 });
      mocks.addHistory.mockResolvedValue(undefined);
    });

    describe("initial approval target context", () => {
      // SOURCE ONLY / UNRUN: real composable entry points with synthetic targets.
      const paths = ["conditional", "custom"] as const;
      function fixture(path: typeof paths[number], production = true) {
        const database = ref<string | undefined>("fixture_a");
        const save = vi.fn().mockResolvedValue(undefined);
        mocks.getConfig.mockReturnValue({ id: "connection-1", name: "Synthetic initial approval", db_type: "mysql", read_only: true, is_production: production });
        const { editor, emit } = createSaveTestEditor({ databaseRef: database, resolveExistingRowItems: true, customSaveHandler: path === "custom" ? { save } : undefined });
        if (path === "custom") editor.applyCellValue(0, 1, "changed");
        const run = () => path === "conditional" ? editor.executeConditionalUpdate(conditionalSql) : editor.saveChanges();
        return { editor, emit, database, run, dispatch: path === "conditional" ? mocks.executeConditionalUpdate : save };
      }

      it.each(paths)("retires %s before a second approval can use B and later dispatch A", async (path) => {
        const { editor, emit, database, run, dispatch } = fixture(path);
        const unlock = deferredBoolean();
        const production = deferredBoolean();
        const entered = deferredBoolean();
        mocks.ensureReadOnlyWriteAccess.mockReturnValueOnce(unlock.promise);
        mocks.requestProductionConfirmation.mockImplementationOnce(() => {
          entered.resolve(true);
          return production.promise;
        });
        // Attach both outcomes immediately, including on the broken baseline.
        const observed = run().then(() => ({ kind: "settled" as const }), (error: unknown) => ({ kind: "rejected" as const, error }));
        try {
          database.value = "fixture_b";
          unlock.resolve(true);
          // A fixed save settles without entering the second prompt. Waiting
          // only for that prompt would deadlock the very behavior being tested.
          const first = await Promise.race([entered.promise.then(() => ({ kind: "entered" as const })), observed]);
          expect.soft(first.kind).toBe("settled");
          expect.soft(mocks.requestProductionConfirmation).not.toHaveBeenCalled();
          database.value = "fixture_a";
          production.resolve(true);
          expect.soft((await observed).kind).toBe("settled");
          expect.soft(dispatch).not.toHaveBeenCalled();
          expect.soft(editor.isSaving.value).toBe(false);
          expect.soft(mocks.addHistory).not.toHaveBeenCalled();
          expect.soft(emit.mock.calls.some(([event]) => event === "reload")).toBe(false);
          expect.soft(editor.isConditionalUpdateActive.value).toBe(false);
          expect.soft(editor.conditionalUpdateExecution.value).toBeUndefined();
          if (path === "custom") expect.soft(editor.dirtyRows.value.get(0)?.get(1)).toBe("changed");
        } finally {
          unlock.resolve(true);
          production.resolve(true);
          await observed;
        }
        // Retirement releases the reservation; only a fresh action may save A.
        await run();
        expect(dispatch).toHaveBeenCalledOnce();
        expect(mocks.requestProductionConfirmation).toHaveBeenLastCalledWith(expect.objectContaining({ database: "fixture_a" }));
      });

      it.each(paths)("accepts both initial approvals for unchanged %s target A", async (path) => {
        const { run, dispatch } = fixture(path);
        const unlock = deferredBoolean();
        const production = deferredBoolean();
        const entered = deferredBoolean();
        mocks.ensureReadOnlyWriteAccess.mockReturnValueOnce(unlock.promise);
        mocks.requestProductionConfirmation.mockImplementationOnce(() => {
          entered.resolve(true);
          return production.promise;
        });
        const observed = run().then(() => ({ kind: "settled" as const }), (error: unknown) => ({ kind: "rejected" as const, error }));
        try {
          expect(dispatch).not.toHaveBeenCalled();
          unlock.resolve(true);
          const first = await Promise.race([entered.promise.then(() => ({ kind: "entered" as const })), observed]);
          expect(first.kind).toBe("entered");
          expect(mocks.requestProductionConfirmation).toHaveBeenCalledWith(expect.objectContaining({ database: "fixture_a" }));
          expect(dispatch).not.toHaveBeenCalled();
          production.resolve(true);
          expect((await observed).kind).toBe("settled");
          expect(dispatch).toHaveBeenCalledOnce();
        } finally {
          unlock.resolve(true);
          production.resolve(true);
          await observed;
        }
      });

      it.each(paths)("keeps non-production %s approval behavior", async (path) => {
        const { run, dispatch } = fixture(path, false);
        await run();
        expect(mocks.ensureReadOnlyWriteAccess).toHaveBeenCalledOnce();
        expect(mocks.requestProductionConfirmation).not.toHaveBeenCalled();
        expect(dispatch).toHaveBeenCalledOnce();
      });

      for (const path of paths) {
        it.each(["unlock", "production"] as const)(`preserves declined and rejected ${path} %s approvals`, async (boundary) => {
          const { editor, run, dispatch } = fixture(path);
          const approval = boundary === "unlock" ? mocks.ensureReadOnlyWriteAccess : mocks.requestProductionConfirmation;
          approval.mockResolvedValueOnce(false);
          await run();
          expect(dispatch).not.toHaveBeenCalled();
          expect(editor.isSaving.value).toBe(false);
          const failure = new Error("synthetic initial approval rejection");
          approval.mockRejectedValueOnce(failure);
          await expect(run()).rejects.toBe(failure);
          expect(dispatch).not.toHaveBeenCalled();
          expect(editor.isSaving.value).toBe(false);
          if (path === "custom") expect(editor.hasPendingChanges.value).toBe(true);
          await run();
          expect(dispatch).toHaveBeenCalledOnce();
        });
      }
    });

    it.each([false, true])("does not recapture P while read-only unlock is pending (second autoSave=%s)", async (autoSave) => {
      const unlock = deferredBoolean();
      mocks.ensureReadOnlyWriteAccess.mockReturnValueOnce(unlock.promise);
      const { editor } = createSaveTestEditor();
      editor.dirtyRows.value.set(0, new Map([[1, "changed"]]));
      const first = editor.saveChanges();
      let competing: Promise<void> | undefined;
      try {
        competing = editor.saveChanges({ autoSave });
        await nextTick();
        expect.soft(mocks.ensureReadOnlyWriteAccess).toHaveBeenCalledOnce();
        expect.soft(mocks.prepareDataGridSave).not.toHaveBeenCalled();
        expect.soft(mocks.executeBatch).not.toHaveBeenCalled();
      } finally {
        unlock.resolve(true);
        await Promise.all([first, competing]);
      }
      expect(mocks.executeBatch).toHaveBeenCalledOnce();
      expect(editor.isSaving.value).toBe(false);
    });

    it("does not recapture custom inserts while production confirmation is pending", async () => {
      mocks.getConfig.mockReturnValue({ id: "connection-1", name: "Production fixture", db_type: "mysql", is_production: true });
      const confirmation = deferredBoolean();
      mocks.requestProductionConfirmation.mockReturnValueOnce(confirmation.promise);
      const save = vi.fn().mockResolvedValue(undefined);
      const { editor } = createSaveTestEditor({ customSaveHandler: { save, supportsInsert: true } });
      editor.newRows.value = [[3, "P"]];
      const first = editor.saveChanges();
      let competing: Promise<void> | undefined;
      try {
        competing = editor.saveChanges();
        await nextTick();
        expect.soft(mocks.requestProductionConfirmation).toHaveBeenCalledOnce();
        expect.soft(save).not.toHaveBeenCalled();
      } finally {
        confirmation.resolve(true);
        await Promise.all([first, competing]);
      }
      expect(save).toHaveBeenCalledOnce();
      expect(save.mock.calls[0]?.[0].newRows).toEqual([[3, "P"]]);
      expect(editor.isSaving.value).toBe(false);
    });

    it("shares the reservation with conditional-update preflight before a competing save", async () => {
      const unlock = deferredBoolean();
      mocks.ensureReadOnlyWriteAccess.mockReturnValueOnce(unlock.promise);
      const { editor } = createSaveTestEditor();
      const conditional = editor.executeConditionalUpdate(conditionalSql);
      let competing: Promise<void> | undefined;
      try {
        editor.dirtyRows.value.set(0, new Map([[1, "changed"]]));
        competing = editor.saveChanges();
        await nextTick();
        expect.soft(mocks.ensureReadOnlyWriteAccess).toHaveBeenCalledOnce();
        expect.soft(mocks.executeBatch).not.toHaveBeenCalled();
      } finally {
        // Declining the first request leaves only the later explicit save eligible.
        unlock.resolve(false);
        await Promise.all([conditional, competing]);
      }
      expect(editor.hasPendingChanges.value).toBe(true);
      await editor.saveChanges();
      expect(mocks.executeBatch).toHaveBeenCalledOnce();
      expect(mocks.executeConditionalUpdate).not.toHaveBeenCalled();
    });

    it("excludes conditional update while a save owns unlock preflight", async () => {
      const gate = deferredBoolean();
      mocks.ensureReadOnlyWriteAccess.mockReturnValueOnce(gate.promise);
      const { editor } = createSaveTestEditor();
      editor.newRows.value = [[3, "P"]];
      const first = editor.saveChanges();
      try {
        // Even if the live edits are discarded, the first approval still owns entry.
        editor.discardChanges();
        await expect(editor.executeConditionalUpdate(conditionalSql)).resolves.toBeNull();
        expect(mocks.ensureReadOnlyWriteAccess).toHaveBeenCalledOnce();
      } finally {
        gate.resolve(true);
        await first;
      }
      expect(mocks.executeBatch).not.toHaveBeenCalled();
      expect(mocks.executeConditionalUpdate).not.toHaveBeenCalled();
      await editor.executeConditionalUpdate(conditionalSql);
      expect(mocks.executeConditionalUpdate).toHaveBeenCalledOnce();
    });

    it("retires an accepted conditional approval when a new edit is pending", async () => {
      const gate = deferredBoolean();
      mocks.ensureReadOnlyWriteAccess.mockReturnValueOnce(gate.promise);
      const { editor, emit } = createSaveTestEditor({ resolveExistingRowItems: true });
      const first = editor.executeConditionalUpdate(conditionalSql);
      try {
        editor.applyCellValue(0, 1, "new intent");
      } finally {
        gate.resolve(true);
        await first;
      }
      expect(mocks.executeConditionalUpdate).not.toHaveBeenCalled();
      expect(emit.mock.calls.some(([event]) => event === "reload")).toBe(false);
      expect(editor.dirtyRows.value.get(0)?.get(1)).toBe("new intent");
      expect(editor.isSaving.value).toBe(false);
      await editor.saveChanges();
      expect(mocks.executeBatch).toHaveBeenCalledOnce();
    });

    it.each(["paste", "undo"] as const)("retires an insert approval after %s replaces row references", async (mutation) => {
      const gate = deferredBoolean();
      mocks.ensureReadOnlyWriteAccess.mockReturnValueOnce(gate.promise);
      const save = vi.fn().mockResolvedValue(undefined);
      const { editor } = createSaveTestEditor({ customSaveHandler: { save, supportsInsert: true }, resolveNewRowItems: true });
      editor.newRows.value = [[3, "P"], [null, null]];
      if (mutation === "undo") editor.applyCellValue(-1, 1, "before approval");
      const previousRow = editor.newRows.value[0];
      const first = editor.saveChanges();
      try {
        if (mutation === "paste") {
          expect(editor.appendPastedRowsToNewRow(-2, [["4", "Q"]], [0, 1]).ok).toBe(true);
        } else {
          editor.undoPendingChange();
        }
        expect(editor.newRows.value[0]).not.toBe(previousRow);
      } finally {
        gate.resolve(true);
        await first;
      }
      expect(save).not.toHaveBeenCalled();
      expect(editor.newRows.value[0]).toEqual([3, "P"]);
      if (mutation === "paste") expect(editor.newRows.value[1]?.[1]).toBe("Q");
      expect(editor.hasPendingChanges.value).toBe(true);
      expect(editor.isSaving.value).toBe(false);
      await editor.saveChanges();
      expect(save).toHaveBeenCalledOnce();
      expect(save.mock.calls[0]?.[0].newRows[0]).toEqual([3, "P"]);
      expect(editor.hasPendingChanges.value).toBe(false);
    });

    it.each(["save-rows", "save-columns", "conditional-rows", "conditional-columns"] as const)("retires initial approval when result identity changes (%s)", async (boundary) => {
      const gate = deferredBoolean();
      mocks.ensureReadOnlyWriteAccess.mockReturnValueOnce(gate.promise);
      const queryResult: { columns: string[]; rows: CellValue[][] } = {
        columns: ["id", "status"],
        rows: [[1, "pending"], [2, "pending"]],
      };
      const { editor } = createSaveTestEditor({ queryResult, resolveExistingRowItems: true });
      if (boundary.startsWith("save")) editor.applyCellValue(0, 1, "changed");
      const first = boundary.startsWith("save") ? editor.saveChanges() : editor.executeConditionalUpdate(conditionalSql);
      try {
        // Replace the backing object's identity without relying on a watcher
        // flush to invalidate edits before the approval promise resumes.
        if (boundary.endsWith("rows")) queryResult.rows = queryResult.rows.map((row) => [...row]);
        else queryResult.columns = [...queryResult.columns];
      } finally {
        gate.resolve(true);
        await first;
      }
      expect(mocks.executeBatch).not.toHaveBeenCalled();
      expect(mocks.executeConditionalUpdate).not.toHaveBeenCalled();
      expect(editor.isSaving.value).toBe(false);
      if (boundary.startsWith("save")) await editor.saveChanges();
      else await editor.executeConditionalUpdate(conditionalSql);
      expect(boundary.startsWith("save") ? mocks.executeBatch : mocks.executeConditionalUpdate).toHaveBeenCalledOnce();
    });

    it("retires conditional approval when editing becomes unavailable", async () => {
      const editable = ref(true);
      const gate = deferredBoolean();
      mocks.ensureReadOnlyWriteAccess.mockReturnValueOnce(gate.promise);
      const { editor } = createSaveTestEditor({ editable });
      const first = editor.executeConditionalUpdate(conditionalSql);
      editable.value = false;
      gate.resolve(true);
      await first;
      expect(mocks.executeConditionalUpdate).not.toHaveBeenCalled();
      expect(editor.isSaving.value).toBe(false);
      editable.value = true;
      await editor.executeConditionalUpdate(conditionalSql);
      expect(mocks.executeConditionalUpdate).toHaveBeenCalledOnce();
    });

    it("does not start a second conditional update during the first unlock", async () => {
      const unlock = deferredBoolean();
      mocks.ensureReadOnlyWriteAccess.mockReturnValueOnce(unlock.promise);
      const { editor } = createSaveTestEditor();
      const first = editor.executeConditionalUpdate(conditionalSql);
      let competing: ReturnType<typeof editor.executeConditionalUpdate> | undefined;
      try {
        competing = editor.executeConditionalUpdate(conditionalSql);
        await nextTick();
        expect.soft(mocks.ensureReadOnlyWriteAccess).toHaveBeenCalledOnce();
        expect.soft(mocks.executeConditionalUpdate).not.toHaveBeenCalled();
      } finally {
        unlock.resolve(true);
        await Promise.all([first, competing]);
      }
      expect(mocks.executeConditionalUpdate).toHaveBeenCalledOnce();
      expect(editor.isSaving.value).toBe(false);
    });

    it.each(["unlock", "custom-production"] as const)("releases a declined %s preflight without dispatching", async (boundary) => {
      const gate = deferredBoolean();
      const save = vi.fn().mockResolvedValue(undefined);
      const { editor } = createSaveTestEditor({ customSaveHandler: boundary === "custom-production" ? { save } : undefined });
      if (boundary === "unlock") mocks.ensureReadOnlyWriteAccess.mockReturnValueOnce(gate.promise);
      else {
        mocks.getConfig.mockReturnValue({ id: "connection-1", name: "Production fixture", db_type: "mysql", is_production: true });
        mocks.requestProductionConfirmation.mockReturnValueOnce(gate.promise);
      }
      editor.dirtyRows.value.set(0, new Map([[1, "changed"]]));
      const first = editor.saveChanges();
      gate.resolve(false);
      await first;
      expect(mocks.executeBatch).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
      expect(editor.hasPendingChanges.value).toBe(true);
      expect(editor.isSaving.value).toBe(false);
      await editor.saveChanges();
      expect(boundary === "unlock" ? mocks.executeBatch : save).toHaveBeenCalledOnce();
    });

    it.each(["unlock", "custom-production"] as const)("releases a rejected %s preflight while preserving its thrown error", async (boundary) => {
      const failure = new Error("synthetic preflight rejection");
      const gate = deferredBoolean();
      const save = vi.fn().mockResolvedValue(undefined);
      const { editor } = createSaveTestEditor({ customSaveHandler: boundary === "custom-production" ? { save } : undefined });
      if (boundary === "unlock") mocks.ensureReadOnlyWriteAccess.mockReturnValueOnce(gate.promise);
      else {
        mocks.getConfig.mockReturnValue({ id: "connection-1", name: "Production fixture", db_type: "mysql", is_production: true });
        mocks.requestProductionConfirmation.mockReturnValueOnce(gate.promise);
      }
      editor.dirtyRows.value.set(0, new Map([[1, "changed"]]));
      const first = editor.saveChanges();
      const rejection = expect(first).rejects.toBe(failure);
      gate.reject(failure);
      await rejection;
      expect(mocks.executeBatch).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
      expect(editor.isSaving.value).toBe(false);
      expect(editor.hasPendingChanges.value).toBe(true);
      await editor.saveChanges();
      expect(boundary === "unlock" ? mocks.executeBatch : save).toHaveBeenCalledOnce();
    });

    it.each([false, true])("releases conditional preflight on decline or rejection (throws=%s)", async (throws) => {
      const gate = deferredBoolean();
      mocks.ensureReadOnlyWriteAccess.mockReturnValueOnce(gate.promise);
      const { editor } = createSaveTestEditor();
      const first = editor.executeConditionalUpdate(conditionalSql);
      if (throws) {
        const error = new Error("synthetic conditional unlock rejection");
        const rejection = expect(first).rejects.toBe(error);
        gate.reject(error);
        await rejection;
      } else {
        gate.resolve(false);
        await expect(first).resolves.toBeNull();
      }
      expect(mocks.executeConditionalUpdate).not.toHaveBeenCalled();
      expect(editor.isSaving.value).toBe(false);
      await editor.executeConditionalUpdate(conditionalSql);
      expect(mocks.executeConditionalUpdate).toHaveBeenCalledOnce();
    });

    it("releases preflight when editing becomes unavailable during unlock", async () => {
      const editable = ref(true);
      const gate = deferredBoolean();
      mocks.ensureReadOnlyWriteAccess.mockReturnValueOnce(gate.promise);
      const { editor } = createSaveTestEditor({ editable });
      editor.dirtyRows.value.set(0, new Map([[1, "changed"]]));
      const first = editor.saveChanges();
      editable.value = false;
      gate.resolve(true);
      await first;
      expect(mocks.executeBatch).not.toHaveBeenCalled();
      expect(editor.isSaving.value).toBe(false);
      expect(editor.hasPendingChanges.value).toBe(true);
      editable.value = true;
      await editor.saveChanges();
      expect(mocks.executeBatch).toHaveBeenCalledOnce();
    });

    it("keeps the failure floor and a reversal made during explicit retry unlock", async () => {
      const failure = new Error("synthetic unknown batch outcome");
      mocks.getConfig.mockReturnValue(undefined);
      mocks.executeBatch.mockRejectedValueOnce(failure);
      const queryResult: { columns: string[]; rows: CellValue[][] } = {
        columns: ["id", "status"],
        rows: [[1, "pending"], [2, "pending"]],
      };
      const { editor } = createSaveTestEditor({ queryResult, quickEntry: true, resolveExistingRowItems: true });
      editor.applyCellValue(0, 1, "changed");
      await editor.saveChanges();
      expect(editor.manualSaveRequired.value).toBe(true);
      const unlock = deferredBoolean();
      mocks.getConfig.mockReturnValue({ id: "connection-1", name: "Read-only fixture", db_type: "mysql", read_only: true });
      mocks.ensureReadOnlyWriteAccess.mockReturnValueOnce(unlock.promise);
      const retry = editor.saveChanges();
      let blur: ReturnType<typeof editor.commitEditFromBlur> | undefined;
      try {
        editor.startEdit(0, 1);
        editor.editValue.value = "pending";
        blur = editor.commitEditFromBlur();
        await nextTick();
        expect(mocks.executeBatch).toHaveBeenCalledOnce();
      } finally {
        unlock.resolve(true);
        await Promise.all([retry, blur]);
      }
      // A safe preflight may retire undispatched stale P, or dispatch one retry
      // and retain the reversal. Neither strategy may erase the newer intent
      // or lift the failure floor merely because the old snapshot drained.
      const batchAttemptsAfterRetry = mocks.executeBatch.mock.calls.length;
      expect([1, 2]).toContain(batchAttemptsAfterRetry);
      expect.soft(editor.rowDataWithChanges(queryResult.rows[0]!, 0)[1]).toBe("pending");
      expect.soft(editor.manualSaveRequired.value).toBe(true);
      await editor.saveChanges({ autoSave: true });
      expect(mocks.executeBatch).toHaveBeenCalledTimes(batchAttemptsAfterRetry);
      expect.soft(editor.rowDataWithChanges(queryResult.rows[0]!, 0)[1]).toBe("pending");
      expect(editor.manualSaveRequired.value).toBe(true);
    });

    it("does not erase a newer insert value committed from an editor already open before preflight", async () => {
      const unlock = deferredBoolean();
      mocks.ensureReadOnlyWriteAccess.mockReturnValueOnce(unlock.promise);
      const savedRows: CellValue[][] = [];
      const save = vi.fn(async (changes: Parameters<CustomSaveHandler["save"]>[0]) => {
        savedRows.push(...changes.newRows.map((row) => [...row]));
      });
      const { editor } = createSaveTestEditor({ customSaveHandler: { save, supportsInsert: true }, resolveNewRowItems: true });
      editor.newRows.value = [[3, "P"]];
      editor.startEdit(-1, 1);
      editor.editValue.value = "newer intent";
      const first = editor.saveChanges();
      try {
        await editor.commitEditFromBlur();
      } finally {
        unlock.resolve(true);
        await first;
      }
      // Do not prescribe whether a future fix retires/rebuilds P or retains the
      // editor/pending Q. It must not acknowledge a value it never dispatched.
      const newerValueWasSent = savedRows.some((row) => row[1] === "newer intent");
      const newerValueIsPending = editor.newRows.value.some((row) => row[1] === "newer intent");
      const newerValueRemainsInEditor = editor.editingCell.value !== null && editor.editValue.value === "newer intent";
      expect(newerValueWasSent || newerValueIsPending || newerValueRemainsInEditor).toBe(true);
    });

    it("preserves a separately appended Q insert while P awaits unlock", async () => {
      const unlock = deferredBoolean();
      mocks.ensureReadOnlyWriteAccess.mockReturnValueOnce(unlock.promise);
      const { editor } = createSaveTestEditor();
      editor.newRows.value = [[3, "P"]];
      const first = editor.saveChanges();
      editor.newRows.value.push([4, "Q"]);
      unlock.resolve(true);
      await first;
      expect(editor.newRows.value).toEqual([[4, "Q"]]);
      expect(editor.hasPendingChanges.value).toBe(true);
      expect(mocks.executeBatch).toHaveBeenCalledOnce();
    });

    it("keeps autosave blocked by locked read-only access and custom production confirmation", async () => {
      mocks.isWriteUnlockActive.mockReturnValue(false);
      const { editor } = createSaveTestEditor();
      editor.dirtyRows.value.set(0, new Map([[1, "changed"]]));
      await editor.saveChanges({ autoSave: true });
      expect(mocks.ensureReadOnlyWriteAccess).not.toHaveBeenCalled();
      expect(mocks.executeBatch).not.toHaveBeenCalled();
      mocks.getConfig.mockReturnValue({ id: "connection-1", name: "Production fixture", db_type: "mysql", is_production: true });
      const save = vi.fn();
      const custom = createSaveTestEditor({ customSaveHandler: { save } }).editor;
      custom.dirtyRows.value.set(0, new Map([[1, "changed"]]));
      await custom.saveChanges({ autoSave: true });
      expect(mocks.requestProductionConfirmation).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
    });

    it("does not enable unsupported custom inserts and permits a later supported save", async () => {
      const save = vi.fn().mockResolvedValue(undefined);
      const handler: CustomSaveHandler = { save };
      const { editor } = createSaveTestEditor({ customSaveHandler: handler });
      editor.newRows.value = [[3, "P"]];
      await editor.saveChanges();
      expect(save).not.toHaveBeenCalled();
      expect(editor.hasPendingChanges.value).toBe(true);
      expect(editor.isSaving.value).toBe(false);
      handler.supportsInsert = true;
      await editor.saveChanges();
      expect(save).toHaveBeenCalledOnce();
    });

    it("allows ordinary autosave again after a successful preflight and settlement", async () => {
      const { editor } = createSaveTestEditor({ quickEntry: true });
      editor.dirtyRows.value.set(0, new Map([[1, "changed"]]));
      await editor.saveChanges();
      editor.dirtyRows.value.set(1, new Map([[1, "later"]]));
      await editor.saveChanges({ autoSave: true });
      expect(mocks.executeBatch).toHaveBeenCalledTimes(2);
      expect(editor.isSaving.value).toBe(false);
      expect(editor.hasPendingChanges.value).toBe(false);
    });
  });

  describe("failed batch manual-save lifetime", () => {
    const insertSql = "INSERT INTO orders_test VALUES (3, 'first')";
    const updateSql = "UPDATE orders_test SET status='changed' WHERE id=1";
    const failure = "Batch outcome is unknown.";
    type Editor = ReturnType<typeof useDataGridEditor>;

    beforeEach(() => {
      mocks.addHistory.mockResolvedValue(undefined);
      // Finite fallback responses let an erroneous replay settle and be counted.
      mocks.prepareDataGridSave.mockResolvedValue({ statements: [insertSql], rollbackStatements: [] });
      mocks.executeBatch.mockResolvedValue({ affected_rows: 1 });
      mocks.executeBatch.mockRejectedValueOnce(new Error(failure));
    });

    async function addInsert(editor: Editor, id = "3", status = "first") {
      const rowId = editor.addRows(1)!;
      await nextTick();
      editor.startEdit(rowId, 0);
      editor.editValue.value = id;
      expect(editor.commitEdit()).toEqual({ changed: true, rowKind: "new" });
      editor.startEdit(rowId, 1);
      editor.editValue.value = status;
      expect(editor.commitEdit()).toEqual({ changed: true, rowKind: "new" });
      return rowId;
    }

    function stageUpdate(editor: Editor, value = "changed") {
      editor.startEdit(0, 1);
      editor.editValue.value = value;
      expect(editor.commitEdit()).toEqual({ changed: true, rowKind: "existing" });
    }

    function insertEditor(cacheKey?: string, customSaveHandler?: CustomSaveHandler) {
      expect(canInsertTableRows("hive")).toBe(true);
      expect(supportsDataGridTransaction("hive")).toBe(false);
      return createSaveTestEditor({ databaseType: "hive", quickEntry: true, resolveNewRowItems: true, cacheKey, customSaveHandler }).editor;
    }

    function updateEditor(confirmSaveRequest?: (request: import("@/composables/useDataGridEditor").DataGridSaveConfirmationRequest) => Promise<boolean>) {
      mocks.prepareDataGridSave.mockResolvedValue({ statements: [updateSql], rollbackStatements: [] });
      return createSaveTestEditor({ databaseType: "mysql", quickEntry: true, resolveExistingRowItems: true, confirmSaveRequest }).editor;
    }

    it("keeps the failure gate through undo to empty, an empty save, and redo", async () => {
      const editor = insertEditor();
      await addInsert(editor);
      await editor.saveChanges();
      expect(mocks.executeBatch).toHaveBeenCalledOnce();
      expect(editor.saveError.value).toBe(failure);
      // Exactly the add and two cell edits; no unbounded history traversal.
      for (let i = 0; i < 3; i++) editor.undoPendingChange();
      expect(editor.newRows.value).toEqual([]);
      expect(editor.hasPendingChanges.value).toBe(false);
      expect(editor.canUndoPendingChange.value).toBe(false);
      expect.soft(editor.manualSaveRequired.value).toBe(true);
      await editor.saveChanges();
      for (let i = 0; i < 3; i++) editor.redoPendingChange();
      expect(editor.newRows.value).toEqual([[3, "first"]]);
      expect.soft(editor.manualSaveRequired.value).toBe(true);
      await editor.saveChanges({ autoSave: true });
      expect(mocks.prepareDataGridSave).toHaveBeenCalledOnce();
      expect(mocks.executeBatch).toHaveBeenCalledOnce();
      expect(editor.newRows.value).toEqual([[3, "first"]]);
    });

    it.each([false, true])("restores a settled failure from the tab cache (failure-only=%s)", async (failureOnly) => {
      const key = `failure-lifetime-settled-${failureOnly}`;
      clearDataGridPendingSnapshot(key);
      try {
        const first = insertEditor(key);
        await addInsert(first);
        await first.saveChanges();
        expect(mocks.executeBatch).toHaveBeenCalledOnce();
        expect(first.saveError.value).toBe(failure);
        if (failureOnly) {
          for (let i = 0; i < 3; i++) first.undoPendingChange();
          expect(first.hasPendingChanges.value).toBe(false);
        }
        if (failureOnly) first.savePendingSnapshot();
        else first.onBeforeTabSwitch();
        const restored = insertEditor(key);
        expect(restored.canUndoPendingChange.value).toBe(false);
        expect(restored.canRedoPendingChange.value).toBe(false);
        expect.soft(restored.manualSaveRequired.value).toBe(true);
        if (failureOnly) await addInsert(restored, "4", "later");
        restored.startEdit(-1, 1);
        restored.editValue.value = "after restore";
        await restored.commitEditFromBlur();
        expect(mocks.prepareDataGridSave).toHaveBeenCalledOnce();
        expect(mocks.executeBatch).toHaveBeenCalledOnce();
        expect(restored.newRows.value).toEqual([[failureOnly ? 4 : 3, "after restore"]]);
        // Only this instance's new edits supply Undo history. The separate
        // failure-only and custom-success cases distinguish the failure reason.
        restored.undoPendingChange();
        expect(restored.manualSaveRequired.value).toBe(true);
      } finally {
        clearDataGridPendingSnapshot(key);
      }
    });

    it("caches the failure gate before failed-history recording settles", async () => {
      const key = "failure-lifetime-deferred-history";
      clearDataGridPendingSnapshot(key);
      let historyStarted!: () => void;
      let releaseHistory!: () => void;
      const started = new Promise<void>((resolve) => { historyStarted = resolve; });
      const blocked = new Promise<void>((resolve) => { releaseHistory = resolve; });
      mocks.addHistory.mockImplementationOnce(async () => {
        historyStarted();
        await blocked;
      });
      const first = insertEditor(key);
      await addInsert(first);
      const firstSave = first.saveChanges();
      try {
        await started;
        expect(first.isSaving.value).toBe(true);
        expect(mocks.prepareDataGridSave).toHaveBeenCalledOnce();
        expect(mocks.executeBatch).toHaveBeenCalledOnce();
        expect(mocks.executeBatch).toHaveBeenCalledWith("connection-1", "app", [insertSql], undefined);
        expect(mocks.addHistory).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
        first.savePendingSnapshot();
        const restored = insertEditor(key);
        expect.soft(restored.manualSaveRequired.value).toBe(true);
        restored.startEdit(-1, 1);
        restored.editValue.value = "while history waits";
        await restored.commitEditFromBlur();
        expect(mocks.prepareDataGridSave).toHaveBeenCalledOnce();
        expect(mocks.executeBatch).toHaveBeenCalledOnce();
        expect(restored.newRows.value).toEqual([[3, "while history waits"]]);
      } finally {
        releaseHistory();
        await firstSave;
        clearDataGridPendingSnapshot(key);
      }
    });

    it.each([false, true])("releases the gate only after an explicit batch retry drains pending work (new pending=%s)", async (newPending) => {
      const editor = insertEditor();
      await addInsert(editor);
      await editor.saveChanges();
      expect(mocks.prepareDataGridSave).toHaveBeenCalledOnce();
      expect(mocks.executeBatch).toHaveBeenCalledOnce();
      expect(mocks.executeBatch).toHaveBeenCalledWith("connection-1", "app", [insertSql], undefined);
      expect(editor.manualSaveRequired.value).toBe(true);
      let retryStarted!: () => void;
      let releaseRetry!: () => void;
      const started = new Promise<void>((resolve) => { retryStarted = resolve; });
      const blocked = new Promise<void>((resolve) => { releaseRetry = resolve; });
      mocks.executeBatch.mockImplementationOnce(async () => {
        retryStarted();
        await blocked;
        return { affected_rows: 1 };
      });
      const retry = editor.saveChanges();
      try {
        await started;
        expect(mocks.executeBatch).toHaveBeenCalledTimes(2);
        if (newPending) {
          const rowId = await addInsert(editor, "4", "queued");
          editor.startEdit(rowId, 1);
          editor.editValue.value = "queued during retry";
          await editor.commitEditFromBlur();
        }
      } finally {
        releaseRetry();
        await retry;
      }
      expect(editor.isSaving.value).toBe(false);
      expect(mocks.executeBatch).toHaveBeenCalledTimes(2);
      expect(editor.canUndoPendingChange.value).toBe(false);
      expect(editor.canRedoPendingChange.value).toBe(false);
      expect(editor.hasPendingChanges.value).toBe(newPending);
      expect(editor.manualSaveRequired.value).toBe(newPending);
      if (newPending) {
        expect(editor.newRows.value).toEqual([[4, "queued during retry"]]);
        await editor.saveChanges({ autoSave: true });
        expect(mocks.executeBatch).toHaveBeenCalledTimes(2);
      } else {
        expect(editor.newRows.value).toEqual([]);
        const rowId = await addInsert(editor, "5", "fresh");
        editor.startEdit(rowId, 1);
        editor.editValue.value = "fresh auto-save";
        await editor.commitEditFromBlur();
        expect(mocks.executeBatch).toHaveBeenCalledTimes(3);
        expect(editor.hasPendingChanges.value).toBe(false);
      }
      expect(mocks.executeInTransaction).not.toHaveBeenCalled();
      expect(mocks.executeInManualTransaction).not.toHaveBeenCalled();
    });

    it("retains an existing-row reversal to the old result while an explicit retry is in flight", async () => {
      const editor = updateEditor();
      stageUpdate(editor);
      await editor.saveChanges();
      expect(editor.saveError.value).toBe(failure);
      expect(editor.manualSaveRequired.value).toBe(true);
      expect(mocks.executeBatch).toHaveBeenNthCalledWith(1, "connection-1", "app", [updateSql], undefined);
      let retryStarted!: () => void;
      let releaseRetry!: () => void;
      const started = new Promise<void>((resolve) => { retryStarted = resolve; });
      const blocked = new Promise<void>((resolve) => { releaseRetry = resolve; });
      mocks.executeBatch.mockImplementationOnce(async () => {
        retryStarted();
        await blocked;
        return { affected_rows: 1 };
      });
      const retry = editor.saveChanges();
      try {
        await started;
        editor.startEdit(0, 1);
        editor.editValue.value = "pending";
        await editor.commitEditFromBlur();
        // Equal to the OLD result now, but different from the retry's saved value.
        expect(editor.dirtyRows.value.size).toBe(0);
        expect(mocks.executeBatch).toHaveBeenCalledTimes(2);
      } finally {
        releaseRetry();
        await retry;
      }
      expect.soft(editor.dirtyRows.value.get(0)).toEqual(new Map([[1, "pending"]]));
      expect.soft(editor.hasPendingChanges.value).toBe(true);
      expect.soft(editor.manualSaveRequired.value).toBe(true);
      await editor.saveChanges({ autoSave: true });
      expect(mocks.prepareDataGridSave).toHaveBeenCalledTimes(2);
      expect(mocks.executeBatch).toHaveBeenCalledTimes(2);
      expect(mocks.executeInTransaction).not.toHaveBeenCalled();
      expect(mocks.executeInManualTransaction).not.toHaveBeenCalled();
    });

    it.each(["preparation failure", "no statements", "declined confirmation"] as const)("does not clear the failure gate after %s", async (interruption) => {
      const confirmSaveRequest = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
      const editor = updateEditor(interruption === "declined confirmation" ? confirmSaveRequest : undefined);
      stageUpdate(editor);
      await editor.saveChanges();
      expect(editor.saveError.value).toBe(failure);
      if (interruption === "preparation failure") mocks.prepareDataGridSave.mockRejectedValueOnce(new Error("Preparation failed."));
      if (interruption === "no statements") mocks.prepareDataGridSave.mockResolvedValueOnce({ statements: [], rollbackStatements: [] });
      await editor.saveChanges();
      // This is past preparation, not an auto-save early-guard-only assertion.
      expect(mocks.prepareDataGridSave).toHaveBeenCalledTimes(2);
      expect(mocks.executeBatch).toHaveBeenCalledOnce();
      if (interruption === "declined confirmation") expect(confirmSaveRequest).toHaveBeenCalledTimes(2);
      expect(editor.isSaving.value).toBe(false);
      editor.undoPendingChange();
      expect(editor.hasPendingChanges.value).toBe(false);
      expect.soft(editor.manualSaveRequired.value).toBe(true);
      stageUpdate(editor, "after interruption");
      await editor.saveChanges({ autoSave: true });
      expect(mocks.prepareDataGridSave).toHaveBeenCalledTimes(2);
      expect(mocks.executeBatch).toHaveBeenCalledOnce();
      expect(editor.dirtyRows.value.get(0)?.get(1)).toBe("after interruption");
    });

    it("does not treat successful custom saving as recovery from a cached batch failure", async () => {
      const key = "failure-lifetime-custom-save";
      clearDataGridPendingSnapshot(key);
      try {
        const first = insertEditor(key);
        await addInsert(first);
        await first.saveChanges();
        expect(mocks.executeBatch).toHaveBeenCalledOnce();
        first.savePendingSnapshot();
        const customSave = vi.fn().mockResolvedValue(undefined);
        const restored = insertEditor(key, { save: customSave, supportsInsert: true });
        await restored.saveChanges();
        expect(customSave).toHaveBeenCalledOnce();
        expect(restored.hasPendingChanges.value).toBe(false);
        expect.soft(restored.manualSaveRequired.value).toBe(true);
        const rowId = await addInsert(restored, "4", "later");
        restored.startEdit(rowId, 1);
        restored.editValue.value = "must stay pending";
        await restored.commitEditFromBlur();
        expect(customSave).toHaveBeenCalledOnce();
        expect(mocks.executeBatch).toHaveBeenCalledOnce();
        expect(restored.newRows.value).toEqual([[4, "must stay pending"]]);
      } finally {
        clearDataGridPendingSnapshot(key);
      }
    });

    it("allows fresh auto-save after explicit discard of the failed batch", async () => {
      const editor = insertEditor();
      await addInsert(editor);
      await editor.saveChanges();
      expect(mocks.prepareDataGridSave).toHaveBeenCalledOnce();
      expect(mocks.executeBatch).toHaveBeenCalledOnce();
      expect(mocks.executeBatch).toHaveBeenCalledWith("connection-1", "app", [insertSql], undefined);
      expect(editor.manualSaveRequired.value).toBe(true);
      editor.discardChanges();
      expect(editor.manualSaveRequired.value).toBe(false);
      expect(editor.hasPendingChanges.value).toBe(false);
      const rowId = await addInsert(editor, "4", "fresh");
      editor.startEdit(rowId, 1);
      editor.editValue.value = "fresh after discard";
      await editor.commitEditFromBlur();
      expect(mocks.executeBatch).toHaveBeenCalledTimes(2);
      expect(editor.hasPendingChanges.value).toBe(false);
    });
  });

  describe("non-transactional insert batch failures", () => {
    const initialRows: CellValue[][] = [
      [3, "first"],
      [4, "second"],
    ];
    const queuedRow: CellValue[] = [5, "queued"];
    const initialStatements = ["INSERT INTO orders_test VALUES (3, 'first')", "INSERT INTO orders_test VALUES (4, 'second')"];
    const queuedStatement = "INSERT INTO orders_test VALUES (5, 'queued')";
    const partialFailure = "Statement 2 failed; previous 1 statement(s) may have been committed.";

    beforeEach(() => {
      // Hive already supports INSERT without grid transactions. Do not enable
      // generic JDBC INSERT or mock the capability that selects executeBatch.
      expect(canInsertTableRows("hive")).toBe(true);
      expect(supportsDataGridTransaction("hive")).toBe(false);
      mocks.prepareDataGridSave.mockResolvedValueOnce({ statements: initialStatements, rollbackStatements: [] });
      mocks.addHistory.mockResolvedValue(undefined);
    });

    it.each([false, true])("retains inserts after partial failure without replaying the batch (queued auto-save=%s)", async (queueAutoSave) => {
      let firstBatchStarted!: () => void;
      let releaseFirstBatch!: () => void;
      const started = new Promise<void>((resolve) => {
        firstBatchStarted = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        releaseFirstBatch = resolve;
      });
      const committedStatements: string[] = [];
      mocks.executeBatch.mockImplementation(async (_connectionId, _database, statements: string[]) => {
        if (mocks.executeBatch.mock.calls.length === 1) {
          // Synthetic external-boundary result: statement 1 committed, then
          // statement 2 failed. This is not evidence about a real driver.
          committedStatements.push(statements[0]!);
          firstBatchStarted();
          await blocked;
          throw new Error(partialFailure);
        }
        committedStatements.push(...statements);
        return { affected_rows: statements.length };
      });
      // If the regression re-enters preparation, model the still-pending rows.
      // The test must fail on that replay, not on an incomplete mock response.
      mocks.prepareDataGridSave.mockResolvedValue({
        statements: queueAutoSave ? [...initialStatements, queuedStatement] : initialStatements,
        rollbackStatements: [],
      });
      const { editor } = createSaveTestEditor({ databaseType: "hive", quickEntry: true });
      editor.newRows.value = initialRows.map((row) => [...row]);

      expect(editor.manualSaveRequired.value).toBe(false);
      expect(editor.useTransaction.value).toBe(false);
      expect(editor.hasPendingChanges.value).toBe(true);
      const firstSave = editor.saveChanges({ autoSave: true });
      try {
        await started;
        expect(editor.isSaving.value).toBe(true);
        expect(committedStatements).toEqual([initialStatements[0]]);
        if (queueAutoSave) {
          editor.newRows.value.push([...queuedRow]);
          await editor.saveChanges({ autoSave: true });
        }
        expect(mocks.executeBatch).toHaveBeenCalledOnce();
      } finally {
        releaseFirstBatch();
        await firstSave;
      }
      await nextTick();

      expect.soft(mocks.executeBatch).toHaveBeenCalledOnce();
      expect.soft(mocks.prepareDataGridSave).toHaveBeenCalledOnce();
      expect.soft(committedStatements).toEqual([initialStatements[0]]);
      expect.soft(editor.newRows.value).toEqual(queueAutoSave ? [...initialRows, queuedRow] : initialRows);
      expect.soft(editor.hasPendingChanges.value).toBe(true);
      expect.soft(editor.saveError.value).toBe(partialFailure);
      expect(editor.isSaving.value).toBe(false);
      expect(mocks.executeInTransaction).not.toHaveBeenCalled();
      expect(mocks.executeInManualTransaction).not.toHaveBeenCalled();
      expect(mocks.addHistory).toHaveBeenCalledWith(expect.objectContaining({ success: false, error: partialFailure }));

      // Exercise the public auto-save entry again, including when no request
      // was queued during the failure. This does not simulate a mounted blur.
      expect.soft(editor.manualSaveRequired.value).toBe(true);
      await editor.saveChanges({ autoSave: true });
      await nextTick();
      expect(mocks.executeBatch).toHaveBeenCalledOnce();
      expect(mocks.prepareDataGridSave).toHaveBeenCalledOnce();
      expect(committedStatements).toEqual([initialStatements[0]]);
      expect(editor.newRows.value).toEqual(queueAutoSave ? [...initialRows, queuedRow] : initialRows);
      expect(editor.hasPendingChanges.value).toBe(true);
      expect(editor.saveError.value).toBe(partialFailure);
      expect(editor.isSaving.value).toBe(false);
    });

    it.each(["undo then edit", "undo then redo", "edit without undo"] as const)("does not replay a failed insert after %s", async (transition) => {
      const rowA: CellValue[] = [3, "first"];
      const rowB: CellValue[] = [4, "queued"];
      const changedRowB: CellValue[] = [4, "changed"];
      const statementA = "INSERT INTO orders_test VALUES (3, 'first')";
      const changedStatementB = "INSERT INTO orders_test VALUES (4, 'changed')";
      const failure = "Insert batch outcome is unknown.";
      let firstBatchStarted!: () => void;
      let releaseFirstBatch!: () => void;
      const started = new Promise<void>((resolve) => {
        firstBatchStarted = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        releaseFirstBatch = resolve;
      });
      mocks.prepareDataGridSave.mockReset();
      mocks.prepareDataGridSave.mockResolvedValueOnce({ statements: [statementA], rollbackStatements: [] });
      // A complete, finite fallback makes any forbidden replay observable and
      // lets the awaited public blur save settle even on the unfixed product.
      mocks.prepareDataGridSave.mockResolvedValue({ statements: [statementA, changedStatementB], rollbackStatements: [] });
      mocks.executeBatch.mockResolvedValue({ affected_rows: 2 });
      mocks.executeBatch.mockImplementationOnce(async () => {
        firstBatchStarted();
        await blocked;
        // Synthetic unknown outcome only; no real commit or duplication is proven.
        throw new Error(failure);
      });
      const { editor } = createSaveTestEditor({ databaseType: "hive", quickEntry: true, resolveNewRowItems: true });
      const rowAId = editor.addRows(1)!;
      await nextTick();
      editor.startEdit(rowAId, 0);
      editor.editValue.value = "3";
      expect(editor.commitEdit()).toEqual({ changed: true, rowKind: "new" });
      editor.startEdit(rowAId, 1);
      editor.editValue.value = "first";
      expect(editor.commitEdit()).toEqual({ changed: true, rowKind: "new" });
      expect(editor.newRows.value).toEqual([rowA]);
      expect(editor.manualSaveRequired.value).toBe(false);
      expect(editor.useTransaction.value).toBe(false);

      let rowBId!: number;
      const firstSave = editor.saveChanges({ autoSave: true });
      try {
        await started;
        expect(editor.isSaving.value).toBe(true);
        expect(mocks.prepareDataGridSave).toHaveBeenCalledOnce();
        expect(mocks.prepareDataGridSave.mock.calls[0]![0]).toMatchObject({ databaseType: "hive", newRows: [rowA] });
        expect(mocks.executeBatch).toHaveBeenCalledWith("connection-1", "app", [statementA], undefined);
        rowBId = editor.addRows(1)!;
        await nextTick();
        expect(rowBId).toBe(-2);
        expect(editor.newRowMeta.value.map((meta) => meta.token)).toEqual([1, 2]);
        editor.startEdit(rowBId, 0);
        editor.editValue.value = "4";
        expect(editor.commitEdit()).toEqual({ changed: true, rowKind: "new" });
        editor.startEdit(rowBId, 1);
        editor.editValue.value = "queued";
        await editor.commitEditFromBlur();
        expect(editor.newRows.value).toEqual([rowA, rowB]);
        expect(editor.editingCell.value).toBeNull();
        expect(editor.manualSaveRequired.value).toBe(false);
        expect(mocks.executeBatch).toHaveBeenCalledOnce();
      } finally {
        releaseFirstBatch();
        await firstSave;
      }

      expect(mocks.prepareDataGridSave).toHaveBeenCalledOnce();
      expect(mocks.executeBatch).toHaveBeenCalledOnce();
      expect(editor.isSaving.value).toBe(false);
      expect(editor.manualSaveRequired.value).toBe(true);
      expect(editor.saveError.value).toBe(failure);
      expect(editor.newRows.value).toEqual([rowA, rowB]);
      expect(editor.canUndoPendingChange.value).toBe(true);

      if (transition !== "edit without undo") {
        editor.undoPendingChange();
        expect(editor.newRows.value).toEqual([rowA, [4, null]]);
        expect(editor.canRedoPendingChange.value).toBe(true);
        expect(editor.editingCell.value).toBeNull();
        // Undo changes B locally. It must not prepare or dispatch SQL itself.
        expect(mocks.prepareDataGridSave).toHaveBeenCalledOnce();
        expect(mocks.executeBatch).toHaveBeenCalledOnce();
      }

      if (transition === "undo then redo") {
        editor.redoPendingChange();
        expect(editor.newRows.value).toEqual([rowA, rowB]);
        expect(editor.manualSaveRequired.value).toBe(true);
        expect(editor.canRedoPendingChange.value).toBe(false);
        await editor.saveChanges({ autoSave: true });
      } else {
        editor.startEdit(rowBId, 1);
        expect(editor.editingCell.value).toEqual({ rowId: rowBId, col: 1 });
        editor.editValue.value = "changed";
        // This awaits the whole commit -> auto-save chain, not just a Vue tick.
        await editor.commitEditFromBlur();
        expect(editor.canRedoPendingChange.value).toBe(false);
        if (transition === "edit without undo") {
          expect(editor.manualSaveRequired.value).toBe(true);
        }
      }

      expect.soft(mocks.prepareDataGridSave).toHaveBeenCalledOnce();
      expect.soft(mocks.executeBatch).toHaveBeenCalledOnce();
      expect.soft(editor.newRows.value).toEqual([rowA, transition === "undo then redo" ? rowB : changedRowB]);
      expect.soft(editor.hasPendingChanges.value).toBe(true);
      expect(editor.isSaving.value).toBe(false);
      expect(editor.editingCell.value).toBeNull();
      expect(mocks.executeInTransaction).not.toHaveBeenCalled();
      expect(mocks.executeInManualTransaction).not.toHaveBeenCalled();
    });

    it("saves only the queued new row once after a successful non-transactional batch", async () => {
      let firstBatchStarted!: () => void;
      let releaseFirstBatch!: () => void;
      const started = new Promise<void>((resolve) => {
        firstBatchStarted = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        releaseFirstBatch = resolve;
      });
      mocks.executeBatch.mockResolvedValue({ affected_rows: 1 });
      mocks.executeBatch.mockImplementationOnce(async () => {
        firstBatchStarted();
        await blocked;
        return { affected_rows: 2 };
      });
      mocks.prepareDataGridSave.mockResolvedValue({ statements: [queuedStatement], rollbackStatements: [] });
      const { editor } = createSaveTestEditor({ databaseType: "hive", quickEntry: true });
      editor.newRows.value = initialRows.map((row) => [...row]);

      expect(editor.manualSaveRequired.value).toBe(false);
      expect(editor.useTransaction.value).toBe(false);
      expect(editor.hasPendingChanges.value).toBe(true);
      const firstSave = editor.saveChanges({ autoSave: true });
      try {
        await started;
        editor.newRows.value.push([...queuedRow]);
        await editor.saveChanges({ autoSave: true });
        await editor.saveChanges({ autoSave: true });
        expect(mocks.executeBatch).toHaveBeenCalledOnce();
      } finally {
        releaseFirstBatch();
        await firstSave;
      }
      await nextTick();

      expect(mocks.executeBatch).toHaveBeenCalledTimes(2);
      expect(mocks.executeBatch).toHaveBeenNthCalledWith(1, "connection-1", "app", initialStatements, undefined);
      expect(mocks.executeBatch).toHaveBeenNthCalledWith(2, "connection-1", "app", [queuedStatement], undefined);
      expect(mocks.prepareDataGridSave).toHaveBeenCalledTimes(2);
      expect(mocks.prepareDataGridSave.mock.calls[0]![0]).toMatchObject({ databaseType: "hive", newRows: initialRows });
      expect(mocks.prepareDataGridSave.mock.calls[1]![0]).toMatchObject({ databaseType: "hive", newRows: [queuedRow] });
      expect(editor.newRows.value).toEqual([]);
      expect(editor.hasPendingChanges.value).toBe(false);
      expect(editor.saveError.value).toBe("");
      expect(editor.isSaving.value).toBe(false);
      expect(mocks.executeInTransaction).not.toHaveBeenCalled();
      expect(mocks.executeInManualTransaction).not.toHaveBeenCalled();
    });
  });

  // https://github.com/t8y2/dbx/issues/8321: without a primary key the row is
  // addressed by matching every column value, and the loaded page cannot show
  // whether another physical row matches the same condition.
  const keylessGuard = {
    sql: "SELECT COUNT(*) AS dbx_keyless_row_matches FROM orders_test WHERE (status = 'pending')",
    maxMatchedRows: 1,
    message: "Cannot safely update or delete this row: more than one row matches.",
  };

  it("refuses a keyless save when the server counts more than one row matching the predicate the save sends", async () => {
    mocks.prepareDataGridSave.mockResolvedValue({
      statements: ["UPDATE orders_test SET status='shipped' WHERE status = 'pending'"],
      rollbackStatements: [],
      keylessGuards: [keylessGuard],
    });
    mocks.executeQuery.mockResolvedValue({ columns: ["dbx_keyless_row_matches"], rows: [[2]] });

    const { editor } = createSaveTestEditor({ primaryKeys: [] });
    editor.dirtyRows.value.set(0, new Map([[1, "shipped"]]));

    await editor.saveChanges();

    expect(mocks.executeQuery).toHaveBeenCalledWith("connection-1", "app", keylessGuard.sql, undefined);
    expect(mocks.executeBatch).not.toHaveBeenCalled();
    expect(editor.saveError.value).toBe(keylessGuard.message);
  });

  it("runs a keyless save once the server confirms the predicate matches a single row", async () => {
    mocks.prepareDataGridSave.mockResolvedValue({
      statements: ["UPDATE orders_test SET status='shipped' WHERE status = 'pending'"],
      rollbackStatements: [],
      keylessGuards: [keylessGuard],
    });
    mocks.executeQuery.mockResolvedValue({ columns: ["dbx_keyless_row_matches"], rows: [[1]] });
    mocks.executeBatch.mockResolvedValue({ affected_rows: 1 });

    const { editor } = createSaveTestEditor({ primaryKeys: [] });
    editor.dirtyRows.value.set(0, new Map([[1, "shipped"]]));

    await editor.saveChanges();

    expect(mocks.executeBatch).toHaveBeenCalledTimes(1);
    expect(editor.saveError.value).toBeFalsy();
  });

  it("refuses a keyless save when the guard cannot be counted on the server at all", async () => {
    const onExecuteSql = vi.fn().mockResolvedValue(undefined);
    mocks.prepareDataGridSave.mockResolvedValue({
      statements: ["UPDATE orders_test SET status='shipped' WHERE status = 'pending'"],
      rollbackStatements: [],
      keylessGuards: [keylessGuard],
    });

    const { editor } = createSaveTestEditor({ primaryKeys: [], connectionId: undefined, onExecuteSql });
    editor.dirtyRows.value.set(0, new Map([[1, "shipped"]]));

    await editor.saveChanges();

    expect(onExecuteSql).not.toHaveBeenCalled();
    expect(mocks.executeQuery).not.toHaveBeenCalled();
    expect(editor.saveError.value).toContain("could not check on the server");
  });

  it("reloads after a pure row update, so database-computed columns (e.g. ON UPDATE CURRENT_TIMESTAMP) refresh without a manual page reload", async () => {
    mocks.prepareDataGridSave.mockResolvedValue({ statements: ["UPDATE orders_test SET status='shipped' WHERE id=1"], rollbackStatements: [] });
    mocks.executeBatch.mockResolvedValue({ affected_rows: 1 });

    const { editor, emit } = createSaveTestEditor();
    editor.dirtyRows.value.set(0, new Map([[1, "shipped"]]));

    await editor.saveChanges();

    expect(mocks.executeBatch).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("reload", undefined, "", undefined, undefined, 100, 0);
  });

  it("previews and saves edits to both joined tables in a single transaction", async () => {
    const refreshSavedRows = vi.fn();
    const targets = [
      { tableMeta: { tableName: "users", primaryKeys: ["id"], columns: [] }, sourceColumns: ["id", "name", undefined, undefined] },
      { tableMeta: { tableName: "papers", primaryKeys: ["id"], columns: [] }, sourceColumns: [undefined, undefined, "id", "title"] },
    ];
    mocks.prepareDataGridSave.mockImplementation(async (options) => ({ statements: ["update " + options.tableMeta.tableName], rollbackStatements: ["undo " + options.tableMeta.tableName] }));
    mocks.executeInTransaction.mockResolvedValue({ affected_rows: 2 });
    const { editor, emit } = createSaveTestEditor({ joinedWriteTargets: targets, queryResult: { columns: ["id", "name", "paper_id", "title"], rows: [[1, "old", 20, "old"]] }, refreshSavedRows });
    editor.dirtyRows.value.set(
      0,
      new Map([
        [1, "new name"],
        [3, "new title"],
      ]),
    );
    expect(await editor.previewChanges()).toEqual(["update users", "update papers"]);
    expect(mocks.executeInTransaction).not.toHaveBeenCalled();
    await editor.saveChanges();
    expect(mocks.executeInTransaction).toHaveBeenCalledWith("connection-1", "app", ["update users", "update papers"], undefined);
    expect(mocks.executeBatch).not.toHaveBeenCalled();
    expect(refreshSavedRows).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith("reload", undefined, "", undefined, undefined, 100, 0);
    expect(mocks.prepareDataGridSave.mock.calls[0]![0].dirtyRows).toEqual([[0, [[1, "new name"]]]]);
    expect(mocks.prepareDataGridSave.mock.calls[1]![0].dirtyRows).toEqual([[0, [[3, "new title"]]]]);
  });

  it("keeps both joined edits pending if the transaction fails", async () => {
    const targets = [
      { tableMeta: { tableName: "users", primaryKeys: ["id"], columns: [] }, sourceColumns: ["id", "name", undefined, undefined] },
      { tableMeta: { tableName: "papers", primaryKeys: ["id"], columns: [] }, sourceColumns: [undefined, undefined, "id", "title"] },
    ];
    mocks.prepareDataGridSave.mockImplementation(async (options) => ({ statements: ["update " + options.tableMeta.tableName], rollbackStatements: [] }));
    mocks.executeInTransaction.mockRejectedValue(new Error("second update failed"));
    const { editor, emit } = createSaveTestEditor({ joinedWriteTargets: targets, queryResult: { columns: ["id", "name", "paper_id", "title"], rows: [[1, "old", 20, "old"]] } });
    editor.dirtyRows.value.set(
      0,
      new Map([
        [1, "new name"],
        [3, "new title"],
      ]),
    );
    await editor.saveChanges();
    expect(editor.dirtyRows.value.get(0)?.size).toBe(2);
    expect(editor.saveError.value).toContain("second update failed");
    expect(mocks.executeBatch).not.toHaveBeenCalled();
    expect(emit.mock.calls.some(([event]) => event === "reload")).toBe(false);
  });

  it("saves query-result edits through the active manual transaction session", async () => {
    const statement = "UPDATE orders_test SET status='shipped' WHERE id=1";
    const refreshSavedRows = vi.fn().mockResolvedValue(true);
    const onManualTransactionMutation = vi.fn();
    mocks.prepareDataGridSave.mockResolvedValue({ statements: [statement], rollbackStatements: [] });
    mocks.executeInManualTransaction.mockResolvedValue([{ affected_rows: 1 }]);

    const { editor, emit } = createSaveTestEditor({ manualTransactionSessionId: "txn-session-1", refreshSavedRows, onManualTransactionMutation });
    editor.dirtyRows.value.set(0, new Map([[1, "shipped"]]));

    await editor.saveChanges();

    expect(mocks.executeInManualTransaction).toHaveBeenCalledWith("txn-session-1", statement, "app", undefined);
    expect(onManualTransactionMutation).toHaveBeenCalledTimes(1);
    expect(mocks.executeBatch).not.toHaveBeenCalled();
    expect(refreshSavedRows).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith("reload", undefined, "", undefined, undefined, 100, 0);
  });

  it("starts a manual transaction before saving an existing result grid", async () => {
    const statement = "UPDATE orders_test SET status='shipped' WHERE id=1";
    const ensureManualTransactionSession = vi.fn().mockResolvedValue("txn-grid-1");
    mocks.prepareDataGridSave.mockResolvedValue({ statements: [statement], rollbackStatements: [] });
    mocks.executeInManualTransaction.mockResolvedValue([{ affected_rows: 1 }]);

    const { editor, ensureManualTransactionSession: transactionMode } = createSaveTestEditor();
    transactionMode.value = ensureManualTransactionSession;
    editor.dirtyRows.value.set(0, new Map([[1, "shipped"]]));
    await editor.saveChanges();

    expect(ensureManualTransactionSession).toHaveBeenCalledOnce();
    expect(mocks.executeInManualTransaction).toHaveBeenCalledWith("txn-grid-1", statement, "app", undefined);
    expect(mocks.executeBatch).not.toHaveBeenCalled();
  });

  it("checks a keyless edit on the newly opened manual transaction session", async () => {
    mocks.prepareDataGridSave.mockResolvedValue({
      statements: ["UPDATE orders_test SET status='shipped' WHERE status = 'pending'"],
      rollbackStatements: [],
      keylessGuards: [keylessGuard],
    });
    mocks.executeInManualTransaction.mockResolvedValueOnce([{ columns: ["matches"], rows: [[1]] }]).mockResolvedValueOnce([{ affected_rows: 1 }]);
    const { editor } = createSaveTestEditor({ primaryKeys: [], ensureManualTransactionSession: vi.fn().mockResolvedValue("txn-grid-2") });
    editor.dirtyRows.value.set(0, new Map([[1, "shipped"]]));
    await editor.saveChanges();

    expect(mocks.executeInManualTransaction.mock.calls[0]?.[0]).toBe("txn-grid-2");
    expect(mocks.executeInManualTransaction.mock.calls[0]?.[1]).toBe(keylessGuard.sql);
    expect(mocks.executeInManualTransaction.mock.calls[1]?.[0]).toBe("txn-grid-2");
    expect(mocks.executeQuery).not.toHaveBeenCalled();
    expect(mocks.executeBatch).not.toHaveBeenCalled();
  });

  it("keeps edits pending if a manual transaction cannot start", async () => {
    mocks.prepareDataGridSave.mockResolvedValue({ statements: ["UPDATE orders_test SET status='shipped' WHERE id=1"], rollbackStatements: [] });
    const ensureManualTransactionSession = vi.fn().mockRejectedValue(new Error("BEGIN failed"));
    const { editor } = createSaveTestEditor({ ensureManualTransactionSession });
    editor.dirtyRows.value.set(0, new Map([[1, "shipped"]]));
    await editor.saveChanges();

    expect(editor.saveError.value).toContain("BEGIN failed");
    expect(editor.dirtyRows.value.get(0)?.get(1)).toBe("shipped");
    expect(mocks.executeBatch).not.toHaveBeenCalled();
    expect(mocks.executeInManualTransaction).not.toHaveBeenCalled();
  });

  it("marks the manual transaction dirty before a result-grid mutation can fail", async () => {
    const onManualTransactionMutation = vi.fn();
    mocks.prepareDataGridSave.mockResolvedValue({ statements: ["UPDATE orders_test SET status='shipped' WHERE id=1"], rollbackStatements: [] });
    mocks.executeInManualTransaction.mockRejectedValue(new Error("Query timed out"));

    const { editor } = createSaveTestEditor({ manualTransactionSessionId: "txn-session-1", onManualTransactionMutation });
    editor.dirtyRows.value.set(0, new Map([[1, "shipped"]]));

    await editor.saveChanges();

    expect(onManualTransactionMutation).toHaveBeenCalledTimes(1);
    expect(editor.saveError.value).toContain("Query timed out");
  });

  it("executes a conditional update immediately, records affected rows, and reloads", async () => {
    mocks.getConfig.mockReturnValue({ id: "connection-1", name: "Local MySQL", db_type: "mysql" });
    mocks.executeConditionalUpdate.mockResolvedValue({ affected_rows: 7 });
    const prepareFullReload = vi.fn();
    const { editor, emit } = createSaveTestEditor({ prepareFullReload });
    const statement = "UPDATE `app`.`orders_test` SET `status` = 'shipped' WHERE (`status` = 'pending');";

    await expect(editor.executeConditionalUpdate(statement)).resolves.toEqual({ affectedRows: 7 });

    expect(mocks.executeConditionalUpdate).toHaveBeenCalledWith("connection-1", "app", statement, undefined, expect.any(String));
    expect(mocks.addHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        connection_id: "connection-1",
        connection_name: "Local MySQL",
        sql: statement,
        success: true,
        operation: "UPDATE",
        affected_rows: 7,
      }),
    );
    expect(JSON.parse(mocks.addHistory.mock.calls[0][0].details_json)).toMatchObject({ conditional_update: true, statement_count: 1 });
    expect(prepareFullReload).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("reload", undefined, "", undefined, undefined, 100, 0);
  });

  it("unlocks, records, and reloads after a terminal conditional update failure", async () => {
    const sqlError = Object.assign(new Error("Duplicate entry '1' for key 'PRIMARY'"), {
      backendError: {
        version: 1,
        code: "DBX-JDBC-4001",
        messageKey: "backendErrors.jdbc.sqlFailed",
        messageParams: { stage: "execute" },
        source: "jdbc_agent",
        operationOutcome: "unknown",
        diagnostics: { category: "sql", stage: "execute" },
      },
    });
    mocks.executeConditionalUpdate.mockRejectedValue(sqlError);
    const prepareFullReload = vi.fn();
    const { editor, emit } = createSaveTestEditor({ prepareFullReload });
    const statement = "UPDATE `app`.`orders_test` SET `id` = 1 WHERE (`status` = 'pending');";

    await expect(editor.executeConditionalUpdate(statement)).resolves.toBeNull();

    expect(editor.isConditionalUpdateActive.value).toBe(false);
    expect(editor.saveError.value).toBe("Duplicate entry '1' for key 'PRIMARY'");
    expect(mocks.cancelConditionalUpdate).not.toHaveBeenCalled();
    expect(mocks.addHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: statement,
        success: false,
        error: "Duplicate entry '1' for key 'PRIMARY'",
        affected_rows: undefined,
      }),
    );
    expect(JSON.parse(mocks.addHistory.mock.calls[0][0].details_json)).toMatchObject({ conditional_update: true, execution_outcome: "failed" });
    expect(prepareFullReload).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("reload", undefined, "", undefined, undefined, 100, 0);
  });

  it("refuses a conditional update while row edits are pending", async () => {
    const { editor, emit } = createSaveTestEditor();
    editor.dirtyRows.value = new Map([[0, new Map([[1, "shipped"]])]]);

    await expect(editor.executeConditionalUpdate("UPDATE orders_test SET status = 'shipped' WHERE id > 0;")).resolves.toBeNull();

    expect(mocks.executeConditionalUpdate).not.toHaveBeenCalled();
    expect(mocks.addHistory).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(editor.saveError.value).not.toBe("");
  });

  it("keeps a timed-out conditional update cancellable without recording a failed update", async () => {
    mocks.executeConditionalUpdate.mockRejectedValue(new Error("Query timed out after 30 seconds"));
    mocks.cancelConditionalUpdate.mockResolvedValue({ requested: true, terminal: true });
    const { editor, emit } = createSaveTestEditor();

    await expect(editor.executeConditionalUpdate("UPDATE orders_test SET status = 'shipped' WHERE id > 0;")).resolves.toBeNull();

    expect(editor.isConditionalUpdateActive.value).toBe(true);
    expect(mocks.addHistory).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    await expect(editor.cancelConditionalUpdate()).resolves.toBe(true);
    expect(editor.isConditionalUpdateActive.value).toBe(false);
    expect(mocks.cancelConditionalUpdate).toHaveBeenCalledWith(expect.any(String));
    expect(emit).toHaveBeenCalledWith("reload", undefined, "", undefined, undefined, 100, 0);
  });

  it("keeps a timed-out conditional update locked until cancellation reports a terminal state", async () => {
    vi.useFakeTimers();
    mocks.executeConditionalUpdate.mockRejectedValue(new Error("Query timed out after 30 seconds"));
    mocks.cancelConditionalUpdate.mockResolvedValue({ requested: true, terminal: false });
    const { editor, emit } = createSaveTestEditor();

    try {
      await expect(editor.executeConditionalUpdate("UPDATE orders_test SET status = 'shipped' WHERE id > 0;")).resolves.toBeNull();
      await expect(editor.cancelConditionalUpdate()).resolves.toBe(false);

      expect(editor.isConditionalUpdateActive.value).toBe(true);
      expect(emit).not.toHaveBeenCalled();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("reloads a timed-out conditional update after a later terminal confirmation", async () => {
    vi.useFakeTimers();
    mocks.executeConditionalUpdate.mockRejectedValue(new Error("Query timed out after 30 seconds"));
    mocks.cancelConditionalUpdate.mockResolvedValueOnce({ requested: true, terminal: false }).mockResolvedValueOnce({ requested: false, terminal: true });
    const { editor, emit } = createSaveTestEditor();

    try {
      await expect(editor.executeConditionalUpdate("UPDATE orders_test SET status = 'shipped' WHERE id > 0;")).resolves.toBeNull();
      await expect(editor.cancelConditionalUpdate()).resolves.toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(editor.isConditionalUpdateActive.value).toBe(false);
      expect(mocks.cancelConditionalUpdate).toHaveBeenCalledTimes(2);
      expect(emit).toHaveBeenCalledWith("reload", undefined, "", undefined, undefined, 100, 0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("does not reload when there are no pending changes to save", async () => {
    const { editor, emit } = createSaveTestEditor();

    await editor.saveChanges();

    expect(mocks.prepareDataGridSave).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalledWith("reload", expect.anything());
  });

  it("prepares one first-page reload after saving edits from three accumulated infinite-scroll pages", async () => {
    mocks.prepareDataGridSave.mockResolvedValue({
      statements: ["UPDATE orders_test SET status='shipped' WHERE id=1", "UPDATE orders_test SET status='cancelled' WHERE id=2"],
      rollbackStatements: [],
    });
    mocks.executeInTransaction.mockResolvedValue({ affected_rows: 2 });
    const infiniteScrollState = {
      lastPage: 3,
      requestedOffset: 200 as number | undefined,
      requestedLimit: 100 as number | undefined,
    };
    const currentPage = ref(3);
    const prepareFullReload = vi.fn(() => {
      currentPage.value = 1;
      infiniteScrollState.lastPage = 0;
      infiniteScrollState.requestedOffset = undefined;
      infiniteScrollState.requestedLimit = undefined;
    });
    const created = createSaveTestEditor({ currentPage, prepareFullReload });
    created.editor.dirtyRows.value.set(0, new Map([[1, "shipped"]]));
    created.editor.dirtyRows.value.set(1, new Map([[1, "cancelled"]]));

    await created.editor.saveChanges();

    expect(mocks.executeInTransaction).toHaveBeenCalledTimes(1);
    expect(prepareFullReload).toHaveBeenCalledTimes(1);
    expect(infiniteScrollState).toEqual({ lastPage: 0, requestedOffset: undefined, requestedLimit: undefined });
    expect(created.emit).toHaveBeenCalledTimes(1);
    expect(created.emit).toHaveBeenCalledWith("reload", undefined, "", undefined, undefined, 100, 0);
  });

  it("keeps the custom save path from reloading after a pure update", async () => {
    const customSave = vi.fn().mockResolvedValue(undefined);
    const prepareFullReload = vi.fn();
    const { editor, emit } = createSaveTestEditor({ customSaveHandler: { save: customSave }, prepareFullReload });
    editor.dirtyRows.value.set(0, new Map([[1, "shipped"]]));

    await editor.saveChanges();

    expect(customSave).toHaveBeenCalledTimes(1);
    expect(prepareFullReload).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalledWith("reload", expect.anything());
  });

  it("previews and confirms a guarded custom delete before execution, then reloads", async () => {
    const customSave = vi.fn().mockResolvedValue(undefined);
    const preview = vi.fn().mockResolvedValue(["DELETE FROM guarded WHERE exact_identity"]);
    const confirmSaveRequest = vi.fn().mockResolvedValue(true);
    const prepareFullReload = vi.fn();
    const { editor, emit } = createSaveTestEditor({
      customSaveHandler: { save: customSave, preview, confirmation: "influxdb-v1-delete", canDelete: true },
      confirmSaveRequest,
      prepareFullReload,
      databaseType: "influxdb",
    });
    editor.deletedRows.value.add(0);

    await editor.saveChanges();

    expect(preview).toHaveBeenCalledTimes(1);
    expect(confirmSaveRequest).toHaveBeenCalledWith({ updates: 0, inserts: 0, deletes: 1, targetLabel: undefined, statements: ["DELETE FROM guarded WHERE exact_identity"] });
    expect(customSave).toHaveBeenCalledTimes(1);
    expect(editor.deletedRows.value.size).toBe(0);
    expect(prepareFullReload).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("reload", undefined, "", undefined, undefined, 100, 0);
  });

  it("keeps a guarded delete staged when declined and refreshes after an execution failure", async () => {
    const preview = vi.fn().mockResolvedValue(["DELETE FROM guarded WHERE exact_identity"]);
    const declinedSave = vi.fn();
    const declined = createSaveTestEditor({
      customSaveHandler: { save: declinedSave, preview, confirmation: "influxdb-v1-delete", canDelete: true },
      confirmSaveRequest: vi.fn().mockResolvedValue(false),
      databaseType: "influxdb",
    });
    declined.editor.deletedRows.value.add(0);

    await declined.editor.saveChanges();

    expect(declinedSave).not.toHaveBeenCalled();
    expect(declined.editor.deletedRows.value).toEqual(new Set([0]));
    expect(declined.emit).not.toHaveBeenCalledWith("reload", expect.anything());

    const failedSave = vi.fn().mockRejectedValue(new Error("server rejected delete"));
    const failed = createSaveTestEditor({
      customSaveHandler: { save: failedSave, preview, confirmation: "influxdb-v1-delete", reloadOnFailure: true, canDelete: true },
      confirmSaveRequest: vi.fn().mockResolvedValue(true),
      databaseType: "influxdb",
    });
    failed.editor.deletedRows.value.add(1);

    await failed.editor.saveChanges();

    expect(failed.editor.saveError.value).toContain("server rejected delete");
    expect(failed.editor.deletedRows.value).toEqual(new Set([1]));
    expect(failed.emit).toHaveBeenCalledWith("reload", undefined, "", undefined, undefined, 100, 0);
  });

  // Engines that cannot roll a partial batch back (Salesforce: one REST call per
  // record) hand the operation list to the host for review before it is written.
  it("summarizes inserts, updates and deletes for the host save confirmation and writes once accepted", async () => {
    mocks.prepareDataGridSave.mockResolvedValue({ statements: ["stmt-1", "stmt-2", "stmt-3"], rollbackStatements: [] });
    mocks.executeBatch.mockResolvedValue({ affected_rows: 1 });
    const confirmSaveRequest = vi.fn().mockResolvedValue(true);

    const { editor } = createSaveTestEditor({ confirmSaveRequest, databaseType: "salesforce" });
    editor.dirtyRows.value.set(0, new Map([[1, "shipped"]]));
    editor.addRows(1);
    editor.deletedRows.value.add(1);

    await editor.saveChanges();

    expect(confirmSaveRequest).toHaveBeenCalledTimes(1);
    expect(confirmSaveRequest.mock.calls[0]?.[0]).toMatchObject({
      updates: 1,
      inserts: 1,
      deletes: 1,
      targetLabel: "orders_test",
      statements: ["stmt-1", "stmt-2", "stmt-3"],
    });
    expect(mocks.executeBatch).toHaveBeenCalledTimes(1);
    expect(editor.saveError.value).toBeFalsy();
  });

  it("keeps every edit staged and reports no error when the host declines the save", async () => {
    mocks.prepareDataGridSave.mockResolvedValue({ statements: ["stmt-1"], rollbackStatements: [] });
    const confirmSaveRequest = vi.fn().mockResolvedValue(false);

    const { editor } = createSaveTestEditor({ confirmSaveRequest, databaseType: "salesforce" });
    editor.dirtyRows.value.set(0, new Map([[1, "shipped"]]));

    await editor.saveChanges();

    expect(confirmSaveRequest).toHaveBeenCalledTimes(1);
    expect(mocks.executeBatch).not.toHaveBeenCalled();
    expect(editor.dirtyRows.value.get(0)?.get(1)).toBe("shipped");
    expect(editor.isSaving.value).toBe(false);
    expect(editor.saveError.value).toBeFalsy();
  });

  it("never writes an auto-save past a required confirmation", async () => {
    mocks.prepareDataGridSave.mockResolvedValue({ statements: ["stmt-1"], rollbackStatements: [] });
    const confirmSaveRequest = vi.fn().mockResolvedValue(true);

    const { editor } = createSaveTestEditor({ confirmSaveRequest, databaseType: "salesforce" });
    editor.dirtyRows.value.set(0, new Map([[1, "shipped"]]));

    await editor.saveChanges({ autoSave: true });

    expect(confirmSaveRequest).not.toHaveBeenCalled();
    expect(mocks.executeBatch).not.toHaveBeenCalled();
    expect(editor.dirtyRows.value.get(0)?.get(1)).toBe("shipped");
  });
});

describe("useDataGridEditor cell edit focus", () => {
  it("selects the editor value only on the first frame so fast typing is not clobbered (#7336)", async () => {
    const editor = createEditor(undefined, true, undefined, undefined, [["long json value", "hidden", "last"]]);
    const select = vi.fn();
    const setSelectionRange = vi.fn();
    const focus = vi.fn();
    const input = { focus, select, setSelectionRange, dataset: {}, value: "long json value" };
    const rafCallbacks: Array<(time: number) => void> = [];
    vi.stubGlobal("document", { querySelector: () => input });
    vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
      rafCallbacks.push(callback);
      return rafCallbacks.length;
    });

    editor.startEdit(0, 0);
    await nextTick();
    for (let frame = 0; frame < 3; frame += 1) {
      const callbacks = rafCallbacks.splice(0);
      callbacks.forEach((callback) => callback(0));
      await nextTick();
    }

    expect(select).toHaveBeenCalledTimes(1);
    expect(setSelectionRange).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});

describe("Mongo collection-grid clipboard round-trip", () => {
  it.each([null, MONGO_DOCUMENT_GRID_NULL, "\u0000dbx:mongo-document-grid:string:literal", "NULL"])("preserves BSON value %j through paste and save", (bsonValue) => {
    const encoded = mongoDocumentGridValue(bsonValue) as string;
    const editor = createEditor(undefined, true, undefined, undefined, [["before", "", ""]], undefined, undefined, true);
    try {
      // The OS clipboard is display text; the internal matrix retains encoding.
      rememberDataGridClipboardCopy("copied text", [[encoded]]);
      const pasted = parseDataGridClipboard("copied text")[0]![0]!;
      editor.applyCellValue(0, 0, pasted);
      const changes = editor.dirtyRows.value.get(0)!;
      expect(changes.get(0)).toBe(encoded);
      expect(buildMongoUpdateDocument(changes, ["value"], { value: "before" })).toEqual({ $set: { value: bsonValue } });
    } finally {
      clearDataGridClipboardCopy();
    }
  });
});
