import { ref } from "vue";
import { CONNECTION_ATTEMPT_CANCELLED_MESSAGE, useConnectionStore } from "@/stores/connectionStore";
import { isSchemaAware as isSchemaAwareType, isSingleDatabase, usesTreeSchemaMode } from "@/lib/database/databaseCapabilities";
import { sortSidebarNames } from "@/lib/database/databaseTree";
import { filterSchemaNamesForConnection } from "@/lib/database/visibleDatabases";
import type { ConnectionConfig } from "@/types/database";
import * as api from "@/lib/backend/api";

export function hasSchemaOptionsCacheEntry(options: Record<string, string[]>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(options, key);
}

export function schemaOptionsCacheKey(connectionId: string, database: string, showSystemSchemas: boolean): string {
  return `${connectionId}:${database}:${showSystemSchemas ? "show-system" : "hide-system"}`;
}

export function schemaOptionsForConnection(schemaNames: string[], connection: Pick<ConnectionConfig, "db_type" | "driver_profile" | "visible_databases" | "visible_schemas" | "show_system_schemas"> | undefined, database = ""): string[] {
  // Keep numeric schema suffixes in human order (SCHEMA2 before SCHEMA10), matching the database tree.
  return sortSidebarNames(filterSchemaNamesForConnection(schemaNames, connection, database));
}

export function useSchemaOptions() {
  const connectionStore = useConnectionStore();

  // Raw compatibility ref; callers use load/get below to validate a cache entry's lifetime.
  const schemaOptions = ref<Record<string, string[]>>({});
  const schemaOptionsRevisions = new Map<string, number>();
  const loadingSchemaOptions = ref<Record<string, boolean>>({});
  const schemaRequests = new Map<string, Promise<void>>();

  function cacheKey(connectionId: string, database: string) {
    return schemaOptionsCacheKey(connectionId, database, connectionStore.getConfig(connectionId)?.show_system_schemas === true);
  }

  function isSchemaAware(connectionId: string): boolean {
    return isSchemaAwareType(connectionStore.getConfig(connectionId)?.db_type);
  }

  function getCachedSchemaOptions(connectionId: string, key: string): string[] | undefined {
    // Revisions are not reactive: validate on access, not with a cached computed view.
    if (!hasSchemaOptionsCacheEntry(schemaOptions.value, key)) return;
    if (schemaOptionsRevisions.get(key) === connectionStore.connectionStateRevision(connectionId)) return schemaOptions.value[key];
  }

  async function loadSchemaOptions(connectionId: string, database: string) {
    if (!isSchemaAware(connectionId)) return;
    const connection = connectionStore.getConfig(connectionId);
    const dbType = connection?.db_type;
    if (!database && !isSingleDatabase(dbType) && !usesTreeSchemaMode(dbType)) return;
    const key = cacheKey(connectionId, database);
    if (getCachedSchemaOptions(connectionId, key) !== undefined) return;
    // Only a load retires stale entries; a render-time getter must not wake load watchers.
    schemaOptionsRevisions.delete(key);
    if (hasSchemaOptionsCacheEntry(schemaOptions.value, key)) delete schemaOptions.value[key];
    const pending = schemaRequests.get(key);
    if (pending) return pending;

    const request = (async () => {
      loadingSchemaOptions.value[key] = true;
      try {
        await connectionStore.ensureConnected(connectionId);
        // Fence this backend request only; this is not a lease from ensureConnected.
        const requestRevision = connectionStore.connectionStateRevision(connectionId);
        const schemas = await api.listSchemas(connectionId, database);
        if (connectionStore.connectionStateRevision(connectionId) !== requestRevision) throw new Error(CONNECTION_ATTEMPT_CANCELLED_MESSAGE);
        const options = schemaOptionsForConnection(schemas, connection, database);
        schemaOptionsRevisions.set(key, requestRevision);
        schemaOptions.value[key] = options;
      } finally {
        loadingSchemaOptions.value[key] = false;
        schemaRequests.delete(key);
      }
    })();
    schemaRequests.set(key, request);
    return request;
  }

  function getSchemaOptionsForDb(connectionId: string, database: string): string[] {
    return getCachedSchemaOptions(connectionId, cacheKey(connectionId, database)) ?? [];
  }

  function isLoadingSchemas(connectionId: string, database: string): boolean {
    return !!loadingSchemaOptions.value[cacheKey(connectionId, database)];
  }

  return {
    schemaOptions,
    loadingSchemaOptions,
    loadSchemaOptions,
    getSchemaOptionsForDb,
    isLoadingSchemas,
    isSchemaAware,
  };
}
