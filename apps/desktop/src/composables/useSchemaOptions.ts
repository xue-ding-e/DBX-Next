import { ref } from "vue";
import { CONNECTION_ATTEMPT_CANCELLED_MESSAGE, useConnectionStore, type SchemaConnectionAcquisition } from "@/stores/connectionStore";
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

export interface LoadSchemaOptionsOptions {
  intent?: "explicit" | "passive";
}

interface SchemaOptionsRequest {
  acquisition: SchemaConnectionAcquisition;
  promise: Promise<void>;
}

function sameAcquisition(left: SchemaConnectionAcquisition, right: SchemaConnectionAcquisition): boolean {
  return left.connectionId === right.connectionId && left.stateRevision === right.stateRevision && left.requestRevision === right.requestRevision;
}

export function useSchemaOptions() {
  const connectionStore = useConnectionStore();

  // Raw compatibility ref; callers use load/get below to validate a cache entry's lifetime.
  const schemaOptions = ref<Record<string, string[]>>({});
  const schemaOptionsRevisions = new Map<string, number>();
  const loadingSchemaOptions = ref<Record<string, boolean>>({});
  const schemaRequests = new Map<string, SchemaOptionsRequest>();
  // Count unsettled calls, including gates and revoked backend work. An old
  // never-settled await can keep this key busy after a newer result publishes.
  const loadingTickets = new Map<string, Set<symbol>>();

  function cacheKey(connectionId: string, database: string) {
    return schemaOptionsCacheKey(connectionId, database, connectionStore.getConfig(connectionId)?.show_system_schemas === true);
  }

  function isSchemaAware(connectionId: string): boolean {
    return isSchemaAwareType(connectionStore.getConfig(connectionId)?.db_type);
  }

  function getCachedSchemaOptions(key: string, stateRevision: number): string[] | undefined {
    // Revisions are not reactive: validate on access, not with a cached computed view.
    if (!hasSchemaOptionsCacheEntry(schemaOptions.value, key)) return;
    if (schemaOptionsRevisions.get(key) === stateRevision) return schemaOptions.value[key];
  }

  async function loadSchemaOptions(connectionId: string, database: string, options: LoadSchemaOptionsOptions = {}): Promise<void> {
    if (!isSchemaAware(connectionId)) return;
    const connection = connectionStore.getConfig(connectionId);
    if (!connection) return;
    const dbType = connection.db_type;
    if (!database && !isSingleDatabase(dbType) && !usesTreeSchemaMode(dbType)) return;
    const key = cacheKey(connectionId, database);
    const tickets = loadingTickets.get(key) ?? new Set<symbol>();
    const ticket = Symbol();
    tickets.add(ticket);
    loadingTickets.set(key, tickets);
    let acquisition: SchemaConnectionAcquisition | undefined;
    try {
      // Every call enters its own gate synchronously, even when metadata is
      // already cached or in flight. Only metadata producers may be shared.
      const acquiring = options.intent === "passive"
        ? connectionStore.acquireSchemaConnection(connectionId, { activate: false, skipIfClosedByUser: true })
        : connectionStore.acquireSchemaConnection(connectionId);
      // A synchronous loading observer may close the connection. Enter the
      // gate first so that close revokes this call instead of authorizing it.
      loadingSchemaOptions.value[key] = true;
      acquisition = await acquiring;
      connectionStore.assertSchemaConnectionAcquisition(acquisition);
      if (getCachedSchemaOptions(key, acquisition.stateRevision) !== undefined) return;
      // Only an allowed load retires stale entries; a render-time getter must
      // not wake load watchers, and a rejected gate must not clear another load.
      schemaOptionsRevisions.delete(key);
      if (hasSchemaOptionsCacheEntry(schemaOptions.value, key)) delete schemaOptions.value[key];

      let entry = schemaRequests.get(key);
      if (!entry || !sameAcquisition(entry.acquisition, acquisition)) {
        const producerAcquisition = acquisition;
        const producer: SchemaOptionsRequest = {
          acquisition: producerAcquisition,
          // Register the entry before invoking metadata, including a backend
          // that throws synchronously or returns an already-resolved promise.
          promise: Promise.resolve().then(async () => {
            try {
              connectionStore.assertSchemaConnectionAcquisition(producerAcquisition);
              const schemas = await api.listSchemas(connectionId, database);
              connectionStore.assertSchemaConnectionAcquisition(producerAcquisition);
              if (schemaRequests.get(key) !== producer) throw new Error(CONNECTION_ATTEMPT_CANCELLED_MESSAGE);
              const nextOptions = schemaOptionsForConnection(schemas, connection, database);
              // Publish the stamp first so synchronous reactive readers see it.
              schemaOptionsRevisions.set(key, producerAcquisition.stateRevision);
              schemaOptions.value[key] = nextOptions;
            } catch (error) {
              // An obsolete failure is cancellation, not a newer session error.
              connectionStore.assertSchemaConnectionAcquisition(producerAcquisition);
              throw error;
            } finally {
              if (schemaRequests.get(key) === producer) schemaRequests.delete(key);
            }
          }),
        };
        schemaRequests.set(key, producer);
        entry = producer;
      }
      await entry.promise;
      // Sharing a producer does not share this caller's post-await validity.
      connectionStore.assertSchemaConnectionAcquisition(acquisition);
    } catch (error) {
      if (acquisition) connectionStore.assertSchemaConnectionAcquisition(acquisition);
      throw error;
    } finally {
      tickets.delete(ticket);
      if (tickets.size === 0 && loadingTickets.get(key) === tickets) {
        loadingTickets.delete(key);
        loadingSchemaOptions.value[key] = false;
      }
      // Releasing the last ticket can synchronously run reactive observers.
      // A close from such an observer must also cancel a cache-hit return.
      if (acquisition) connectionStore.assertSchemaConnectionAcquisition(acquisition);
    }
  }

  function getSchemaOptionsForDb(connectionId: string, database: string): string[] {
    return getCachedSchemaOptions(cacheKey(connectionId, database), connectionStore.connectionStateRevision(connectionId)) ?? [];
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
