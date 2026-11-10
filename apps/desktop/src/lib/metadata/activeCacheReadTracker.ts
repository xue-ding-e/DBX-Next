export interface ActiveCacheReadToken {
  readonly cacheKey: string;
  invalidated: boolean;
  cancelled: boolean;
}

/** Tracks only currently running operations, so state is bounded by concurrency. */
export class ActiveCacheReadTracker {
  private readonly readsByKey = new Map<string, Set<ActiveCacheReadToken>>();
  private count = 0;

  begin(cacheKey: string): ActiveCacheReadToken {
    const token: ActiveCacheReadToken = { cacheKey, invalidated: false, cancelled: false };
    const existing = this.readsByKey.get(cacheKey);
    if (existing) existing.add(token);
    else this.readsByKey.set(cacheKey, new Set([token]));
    this.count += 1;
    return token;
  }

  finish(token: ActiveCacheReadToken): void {
    const reads = this.readsByKey.get(token.cacheKey);
    if (!reads?.delete(token)) return;
    this.count -= 1;
    if (reads.size === 0) this.readsByKey.delete(token.cacheKey);
  }

  invalidatePrefix(prefix: string): void {
    for (const [cacheKey, reads] of this.readsByKey) {
      if (!cacheKey.startsWith(prefix)) continue;
      for (const token of reads) token.invalidated = true;
    }
  }

  cancelPrefix(prefix: string): void {
    for (const [cacheKey, reads] of this.readsByKey) {
      if (!cacheKey.startsWith(prefix)) continue;
      for (const token of reads) token.cancelled = true;
    }
  }

  get activeCount(): number {
    return this.count;
  }
}

/** Local lifecycle cancellation, not a physical backend abort. */
export class ObjectCacheLoadCancelledError extends Error {
  readonly code = "OBJECT_CACHE_LOAD_CANCELLED";

  readonly cacheKey: string;

  constructor(cacheKey: string) {
    super("Metadata loading cancelled locally.");
    this.name = "AbortError";
    this.cacheKey = cacheKey;
  }
}

export function throwIfCacheLoadCancelled(token: ActiveCacheReadToken): void {
  if (token.cancelled) throw new ObjectCacheLoadCancelledError(token.cacheKey);
}
