// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import SidebarTreeItemDialogs from "../SidebarTreeItemDialogs.vue";
import { connectionDeleteTargetSnapshot, resetSidebarTreeDialogState, showDeleteConfirm } from "../sidebarTreeDialogState";

const mountedApps: ReturnType<typeof createApp>[] = [];

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
  resetSidebarTreeDialogState();
});

function closedDialogState() {
  return {
    showDeleteConfirm: false,
    showMoveToNewGroupDialog: false,
    showDeleteGroupConfirm: false,
    showRenameObjectDialog: false,
    showStructurePreviewDialog: false,
    showStructureDocCopyDialog: false,
    showDuplicateDialog: false,
    showPasteDialog: false,
    showCreateDatabaseDialog: false,
    showCreateDatabasePreviewDialog: false,
    showEditDatabasePropertiesDialog: false,
    showCreateNacosNamespaceDialog: false,
    showEditNacosNamespaceDialog: false,
    showDeleteNacosNamespaceConfirm: false,
    showRenameMongoCollectionDialog: false,
    showCloneMongoCollectionDialog: false,
    showCreateMongoIndexDialog: false,
    showCreateMeilisearchIndexDialog: false,
    showMongoIndexManagerDialog: false,
    showRedisDatabaseAliasDialog: false,
    showCreateSchemaDialog: false,
    showEditSchemaCommentDialog: false,
    showCompileErrorDialog: false,
  };
}

describe("SidebarTreeItemDialogs connection deletion cancellation", () => {
  it.each(["cancel", "close", "escape", "outside"])("clears the captured targets when dismissed using %s", async (dismissal) => {
    const node = { id: "conn-1", label: "Connection", type: "connection" as const, connectionId: "conn-1" };
    const confirmDelete = vi.fn();
    connectionDeleteTargetSnapshot.value = [node];
    showDeleteConfirm.value = true;
    const controller = reactive({
      ...closedDialogState(),
      node,
      t: (key: string) => key,
      highlight: (value: string) => value,
      showDeleteConfirm,
      connectionDeleteConfirmMessage: () => "confirm",
      connectionDeleteMenuLabel: () => "delete",
      confirmDelete,
    });
    const app = createApp(defineComponent({ setup: () => () => h(SidebarTreeItemDialogs, { controller }) }));
    mountedApps.push(app);
    app.use(i18n);
    app.mount(document.createElement("div"));
    await nextTick();

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    if (dismissal === "cancel") {
      Array.from(dialog!.querySelectorAll("button"))
        .find((button) => button.textContent?.trim() === "dangerDialog.cancel")!
        .click();
    } else if (dismissal === "close") {
      dialog!.querySelector<HTMLButtonElement>('[data-slot="dialog-close"]')!.click();
    } else if (dismissal === "escape") {
      dialog!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    } else {
      // DismissableLayer registers its document listener after mounting.
      await new Promise((resolve) => setTimeout(resolve, 0));
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", button: 0 }));
    }

    await vi.waitFor(() => {
      expect(showDeleteConfirm.value).toBe(false);
      expect(connectionDeleteTargetSnapshot.value).toEqual([]);
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    });
    expect(confirmDelete).not.toHaveBeenCalled();
  });

  it.each(["success", "failure"])("retains the dialog controller until asynchronous confirmation settles with %s", async (outcome) => {
    const node = { id: "conn-1", label: "Connection", type: "connection" as const, connectionId: "conn-1" };
    let finishRemoval!: () => void;
    let failRemoval!: (error: Error) => void;
    const removal = new Promise<void>((resolve, reject) => {
      finishRemoval = resolve;
      failRemoval = reject;
    });
    const controller = reactive({
      ...closedDialogState(),
      node,
      t: (key: string) => key,
      highlight: (value: string) => value,
      showDeleteConfirm,
      connectionDeleteConfirmMessage: () => "confirm",
      connectionDeleteMenuLabel: () => "delete",
      confirmDelete: async () => {
        showDeleteConfirm.value = false;
        connectionDeleteTargetSnapshot.value = [];
        try {
          await removal;
        } catch {
          connectionDeleteTargetSnapshot.value = [node];
          showDeleteConfirm.value = true;
        }
      },
    });
    connectionDeleteTargetSnapshot.value = [node];
    showDeleteConfirm.value = true;
    const mounted = ref(true);
    const closed = vi.fn(() => (mounted.value = false));
    // ConnectionTree drops the controller when the dialog emits `closed`.
    const app = createApp(defineComponent({ setup: () => () => (mounted.value ? h(SidebarTreeItemDialogs, { controller, onClosed: closed }) : null) }));
    mountedApps.push(app);
    app.use(i18n);
    app.mount(document.createElement("div"));
    await nextTick();
    Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "delete")!
      .click();

    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    expect(closed).not.toHaveBeenCalled();
    if (outcome === "failure") {
      failRemoval(new Error("persist failed"));
      await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
      expect(connectionDeleteTargetSnapshot.value.map((target) => target.connectionId)).toEqual([node.connectionId]);
      Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent?.trim() === "dangerDialog.cancel")!
        .click();
    } else {
      finishRemoval();
    }
    await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
  });
});

describe("SidebarTreeItemDialogs MongoDB index form", () => {
  it("keeps the group deletion dialog locked while deletion is running", async () => {
    const controller = reactive({
      ...closedDialogState(),
      node: { id: "group-parent", label: "Parent", type: "connection-group" },
      t: (key: string) => key,
      highlight: (value: string) => value,
      showDeleteConfirm: false,
      showMoveToNewGroupDialog: false,
      showDeleteGroupConfirm: true,
      deleteConnectionsWithGroup: true,
      connectionGroupDeleteConfirmMessage: () => "confirm",
      connectionGroupDeleteMenuLabel: () => "delete",
      deletingConnectionGroups: true,
      confirmDeleteGroup: vi.fn(),
      showRenameObjectDialog: false,
      showStructurePreviewDialog: false,
      showStructureDocCopyDialog: false,
      showDuplicateDialog: false,
      showPasteDialog: false,
      showCreateDatabaseDialog: false,
      showCreateDatabasePreviewDialog: false,
      showEditDatabasePropertiesDialog: false,
      showCreateNacosNamespaceDialog: false,
      showEditNacosNamespaceDialog: false,
      showRenameMongoCollectionDialog: false,
      showCloneMongoCollectionDialog: false,
      showCreateMongoIndexDialog: false,
      showMongoIndexManagerDialog: false,
      showRedisDatabaseAliasDialog: false,
      showCreateSchemaDialog: false,
      showEditSchemaCommentDialog: false,
    });
    const app = createApp(
      defineComponent({
        setup: () => () => h(SidebarTreeItemDialogs, { controller }),
      }),
    );
    mountedApps.push(app);
    app.use(i18n);
    app.mount(document.createElement("div"));
    await nextTick();

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const checkbox = dialog?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox?.disabled).toBe(true);
    expect(dialog?.querySelector('[data-slot="dialog-close"]')).toBeNull();

    dialog?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await nextTick();
    expect(controller.showDeleteGroupConfirm).toBe(true);

    controller.deletingConnectionGroups = false;
    await nextTick();
    expect(checkbox?.disabled).toBe(false);
    const closeButton = dialog?.querySelector<HTMLButtonElement>('[data-slot="dialog-close"]');
    expect(closeButton).not.toBeNull();
    closeButton?.click();
    await vi.waitFor(() => expect(controller.showDeleteGroupConfirm).toBe(false));
  });

  it("mounts the form and overlay from the same controlled dialog state", async () => {
    const confirmCreateMongoIndex = vi.fn();
    const closed = vi.fn();
    const controller = reactive({
      ...closedDialogState(),
      node: { id: "mongo:app:users:__indexes", label: "索引", type: "group-indexes", database: "app", tableName: "users" },
      t: (key: string) => key,
      highlight: (value: string) => value,
      showDeleteConfirm: false,
      showMoveToNewGroupDialog: false,
      showDeleteGroupConfirm: false,
      showRenameObjectDialog: false,
      showStructurePreviewDialog: false,
      showStructureDocCopyDialog: false,
      showDuplicateDialog: false,
      showPasteDialog: false,
      showCreateDatabaseDialog: false,
      showCreateDatabasePreviewDialog: false,
      showEditDatabasePropertiesDialog: false,
      showCreateNacosNamespaceDialog: false,
      showEditNacosNamespaceDialog: false,
      showRenameMongoCollectionDialog: false,
      showCreateMongoIndexDialog: false,
      mongoCreateIndexForm: { name: "", fields: [{ id: 1, path: "", type: "1" }], unique: false, sparse: false },
      mongoCreateIndexFieldOptions: ["email", "createdAt"],
      mongoCreateIndexError: `Kind: Command failed: Error code 11000 (DuplicateKey): ${"a".repeat(400)}`,
      mongoCreateIndexLoading: false,
      mongoIndexKeyTypes: ["1", "-1", "text", "hashed", "2dsphere", "2d"],
      mongoCreateIndexCanSubmit: false,
      mongoCreateIndexCanAddField: false,
      addMongoCreateIndexField: vi.fn(),
      removeMongoCreateIndexField: vi.fn(),
      confirmCreateMongoIndex,
      showRedisDatabaseAliasDialog: false,
      showCreateSchemaDialog: false,
      showEditSchemaCommentDialog: false,
    });
    const app = createApp(
      defineComponent({
        setup: () => () => h(SidebarTreeItemDialogs, { controller, onClosed: closed }),
      }),
    );
    mountedApps.push(app);
    app.use(i18n);
    app.mount(document.createElement("div"));
    await nextTick();

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('[data-slot="dialog-overlay"]')).toBeNull();

    controller.showCreateMongoIndexDialog = true;
    await nextTick();

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const name = document.querySelector<HTMLInputElement>('[aria-label="structureEditor.indexName"]');
    const type = document.querySelector<HTMLElement>('[aria-label="structureEditor.indexType"]');
    const unique = document.querySelector<HTMLElement>('[aria-label="structureEditor.unique"]');
    expect(dialog?.getAttribute("data-state")).toBe("open");
    expect(document.querySelectorAll('[data-slot="dialog-overlay"]')).toHaveLength(1);
    expect(dialog?.contains(name!)).toBe(true);
    expect(dialog?.contains(type!)).toBe(true);
    expect(dialog?.contains(unique!)).toBe(true);
    expect(dialog?.textContent).not.toContain("JSON");
    const error = dialog?.querySelector<HTMLElement>(".text-destructive");
    expect(error?.classList.contains("min-w-0")).toBe(true);
    expect(error?.classList.contains("max-w-full")).toBe(true);
    expect(error?.classList.contains("whitespace-pre-wrap")).toBe(true);
    expect(error?.classList.contains("break-all")).toBe(true);

    unique?.click();
    await nextTick();
    expect(controller.mongoCreateIndexForm.unique).toBe(true);

    controller.mongoCreateIndexForm.fields[0].path = "email";
    controller.mongoCreateIndexForm.name = "codex_e2e_email_1";
    controller.mongoCreateIndexCanSubmit = true;
    await nextTick();
    const createButton = Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.trim() === "contextMenu.createMongoIndex");
    expect(createButton?.disabled).toBe(false);
    createButton?.click();
    expect(confirmCreateMongoIndex).toHaveBeenCalledOnce();

    controller.showCreateMongoIndexDialog = false;
    await vi.waitFor(() => {
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(document.querySelector('[data-slot="dialog-overlay"]')).toBeNull();
    });
    expect(closed).toHaveBeenCalledOnce();
  });
});
