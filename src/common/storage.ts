/**
 * A tiny key/value abstraction over `chrome.storage`.
 *
 * Two reasons this exists rather than calling `chrome.storage` directly:
 *
 *   1. The whole storage layer becomes testable in Node with `MemoryArea`.
 *   2. It forces the local/session distinction to be explicit at every call
 *      site. `local` survives a browser restart and is readable on disk;
 *      `session` is memory-only and dies with the browser. Putting an unlocked
 *      key in the wrong one is the difference between a locked vault and a
 *      plaintext one.
 */

export interface KeyValueArea {
  get<T>(key: string): Promise<T | undefined>;
  getMany(keys: string[]): Promise<Record<string, unknown>>;
  set(key: string, value: unknown): Promise<void>;
  setMany(values: Record<string, unknown>): Promise<void>;
  remove(key: string | string[]): Promise<void>;
  clear(): Promise<void>;
  keys(): Promise<string[]>;
}

/** In-memory area: the test double, and the fallback outside a browser. */
export class MemoryArea implements KeyValueArea {
  private readonly map = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }

  async getMany(keys: string[]): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      if (this.map.has(key)) out[key] = this.map.get(key);
    }
    return out;
  }

  async set(key: string, value: unknown): Promise<void> {
    this.map.set(key, structuredClone(value));
  }

  async setMany(values: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(values)) await this.set(key, value);
  }

  async remove(key: string | string[]): Promise<void> {
    for (const k of Array.isArray(key) ? key : [key]) this.map.delete(k);
  }

  async clear(): Promise<void> {
    this.map.clear();
  }

  async keys(): Promise<string[]> {
    return [...this.map.keys()];
  }

  /** Test helper: raw contents, so a test can assert what hit "disk". */
  snapshot(): Record<string, unknown> {
    return Object.fromEntries(this.map.entries());
  }
}

/** Adapter over a real `chrome.storage.StorageArea`. */
export class ChromeArea implements KeyValueArea {
  constructor(private readonly area: chrome.storage.StorageArea) {}

  async get<T>(key: string): Promise<T | undefined> {
    const result = await this.area.get(key);
    return result[key] as T | undefined;
  }

  async getMany(keys: string[]): Promise<Record<string, unknown>> {
    return this.area.get(keys);
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.area.set({ [key]: value });
  }

  async setMany(values: Record<string, unknown>): Promise<void> {
    await this.area.set(values);
  }

  async remove(key: string | string[]): Promise<void> {
    await this.area.remove(key);
  }

  async clear(): Promise<void> {
    await this.area.clear();
  }

  async keys(): Promise<string[]> {
    return Object.keys(await this.area.get(null));
  }
}

export interface StorageAreas {
  /** Encrypted-at-rest, survives restarts. */
  local: KeyValueArea;
  /** Memory-only, cleared when the browser exits. Holds unlocked key material. */
  session: KeyValueArea;
}

/**
 * Wire up the real Chrome areas. `TRUSTED_CONTEXTS` keeps content scripts from
 * reading session storage even if one is compromised by a hostile page.
 */
export function chromeStorageAreas(): StorageAreas {
  const session = chrome.storage.session;
  void session.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {
    /* older Chrome: default is already TRUSTED_CONTEXTS */
  });
  return { local: new ChromeArea(chrome.storage.local), session: new ChromeArea(session) };
}

/** Areas backed entirely by memory — used by the test suite. */
export function memoryStorageAreas(): StorageAreas & { local: MemoryArea; session: MemoryArea } {
  return { local: new MemoryArea(), session: new MemoryArea() };
}
