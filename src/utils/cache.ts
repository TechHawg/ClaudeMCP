/**
 * In-memory cache for odds data with configurable TTL.
 * Prevents burning API quota by caching results for 60 seconds.
 */

interface CacheEntry<T> {
  data: T;
  cachedAt: string; // ISO 8601
  expiresAt: number; // epoch ms
}

export class OddsCache<T = unknown> {
  private store = new Map<string, CacheEntry<T>>();
  private defaultTtlMs: number;

  constructor(defaultTtlSeconds: number = 60) {
    this.defaultTtlMs = defaultTtlSeconds * 1000;
  }

  /** Build a cache key from an object of params */
  static buildKey(params: Record<string, unknown>): string {
    const sorted = Object.keys(params)
      .sort()
      .map((k) => `${k}=${String(params[k])}`)
      .join("&");
    return sorted;
  }

  get(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.data;
  }

  set(key: string, data: T, ttlSeconds?: number): void {
    const ttl = ttlSeconds ? ttlSeconds * 1000 : this.defaultTtlMs;
    this.store.set(key, {
      data,
      cachedAt: new Date().toISOString(),
      expiresAt: Date.now() + ttl,
    });
  }

  clear(): void {
    this.store.clear();
  }

  /** Remove all expired entries */
  prune(): number {
    let removed = 0;
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.store.size;
  }
}

/** Global odds cache instance — 60 second TTL */
export const oddsCache = new OddsCache(60);

/** Global search cache instance — 5 minute TTL */
export const searchCache = new OddsCache(300);
