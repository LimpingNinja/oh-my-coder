/**
 * Models.dev catalog fetcher and disk cache.
 *
 * Fetches the public models.dev/api.json catalog containing model pricing,
 * context windows, and capabilities for hundreds of models. Caches to disk
 * with a configurable TTL. Used by the webview to provide best-effort pricing
 * when the runtime returns fallback/unknown metadata.
 *
 * Architecture:
 *   - Extension fetches + caches on activation and session start.
 *   - Sends flattened catalog entries to the webview.
 *   - Webview uses them as primary lookup for best-effort pricing.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

// ─── Types ───────────────────────────────────────────────────────────────────

/** A single model entry from models.dev — the fields we care about. */
export interface CatalogModel {
  id: string;
  name?: string;
  family?: string;
  reasoning?: boolean;
  attachment?: boolean;
  tool_call?: boolean;
  cost?: {
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
  };
  limit?: {
    context: number;
    input?: number;
    output: number;
  };
  modalities?: {
    input?: string[];
    output?: string[];
  };
  release_date?: string;
  isFree?: boolean;
}

/** Provider wrapper from models.dev response. */
interface ModelsDevProvider {
  id: string;
  name: string;
  models: Record<string, unknown>;
}

/** Flattened catalog entry sent to the webview: provider-qualified model data. */
export interface CatalogEntry {
  /** Provider-qualified ID, e.g. "zai-org/glm-5.1" */
  qualifiedId: string;
  /** Provider ID from models.dev, e.g. "zai-org" */
  provider: string;
  /** Model ID within the provider, e.g. "glm-5.1" */
  modelId: string;
  name?: string;
  family?: string;
  reasoning?: boolean;
  cost?: {
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
  };
  limit?: {
    context: number;
    input?: number;
    output: number;
  };
  isFree?: boolean;
}

// ─── Configuration ───────────────────────────────────────────────────────────

const MODELS_DEV_URL = "https://models.dev/api.json";
const CACHE_DIR = path.join(os.homedir(), ".omc", "cache");
const CACHE_FILE = path.join(CACHE_DIR, "models-dev.json");
const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const FETCH_TIMEOUT_MS = 15_000;

// ─── State ───────────────────────────────────────────────────────────────────

let cachedEntries: CatalogEntry[] | undefined;
let lastFetchTime = 0;
let fetchInProgress: Promise<CatalogEntry[]> | undefined;

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Get the current catalog entries. Returns cached in-memory data if available,
 * otherwise attempts to load from disk cache.
 * Does NOT trigger a network fetch — use `refreshCatalog()` for that.
 */
export function getCatalogEntries(): CatalogEntry[] {
  return cachedEntries ?? [];
}

/**
 * Whether the catalog has been loaded (from disk or network).
 */
export function hasCatalog(): boolean {
  return cachedEntries !== undefined && cachedEntries.length > 0;
}

/**
 * Load the catalog: try disk cache first, fetch from network if stale/missing.
 * Safe to call multiple times — deduplicates concurrent fetches.
 * @param force If true, ignores TTL and fetches fresh from network.
 */
export async function refreshCatalog(
  force = false,
  log?: (msg: string) => void,
): Promise<CatalogEntry[]> {
  // Deduplicate concurrent calls
  if (fetchInProgress) return fetchInProgress;

  fetchInProgress = doRefresh(force, log).finally(() => {
    fetchInProgress = undefined;
  });
  return fetchInProgress;
}

/**
 * Initialize from disk cache only (no network). Fast, sync-ish startup path.
 */
export async function loadFromDisk(log?: (msg: string) => void): Promise<CatalogEntry[]> {
  try {
    const stat = await fs.stat(CACHE_FILE);
    const age = Date.now() - stat.mtimeMs;
    const raw = await fs.readFile(CACHE_FILE, "utf-8");
    const entries = JSON.parse(raw) as CatalogEntry[];
    if (Array.isArray(entries) && entries.length > 0) {
      cachedEntries = entries;
      lastFetchTime = stat.mtimeMs;
      log?.(`[models-catalog] loaded ${entries.length} entries from disk (age: ${Math.round(age / 1000)}s)`);
      return entries;
    }
  } catch {
    // No cache on disk — that's fine.
  }
  return [];
}

/**
 * Whether the disk cache is expired (or missing).
 */
export function isExpired(): boolean {
  if (lastFetchTime === 0) return true;
  return Date.now() - lastFetchTime > CACHE_TTL_MS;
}

// ─── Internal ────────────────────────────────────────────────────────────────

async function doRefresh(force: boolean, log?: (msg: string) => void): Promise<CatalogEntry[]> {
  // If not forced and we have fresh in-memory data, return it.
  if (!force && cachedEntries && !isExpired()) {
    return cachedEntries;
  }

  // Try disk cache if we don't have in-memory data yet.
  if (!cachedEntries || cachedEntries.length === 0) {
    await loadFromDisk(log);
    if (cachedEntries && !force && !isExpired()) {
      return cachedEntries;
    }
  }

  // Fetch from network.
  log?.(`[models-catalog] fetching ${MODELS_DEV_URL}`);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const response = await fetch(MODELS_DEV_URL, {
      signal: controller.signal,
      headers: { "User-Agent": "oh-my-coder/0.1" },
    });
    clearTimeout(timer);

    if (!response.ok) {
      log?.(`[models-catalog] fetch failed: ${response.status} ${response.statusText}`);
      return cachedEntries ?? [];
    }

    const data = await response.json() as Record<string, unknown>;
    const entries = flattenProviders(data);
    log?.(`[models-catalog] fetched ${entries.length} entries`);

    // Update in-memory cache.
    cachedEntries = entries;
    lastFetchTime = Date.now();

    // Write to disk (best-effort, don't block).
    void writeToDisk(entries, log);

    return entries;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.(`[models-catalog] fetch error: ${msg}`);
    // Return stale data if available.
    return cachedEntries ?? [];
  }
}

async function writeToDisk(entries: CatalogEntry[], log?: (msg: string) => void): Promise<void> {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(CACHE_FILE, JSON.stringify(entries), "utf-8");
    log?.(`[models-catalog] cached ${entries.length} entries to disk`);
  } catch (err) {
    log?.(`[models-catalog] disk write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function flattenProviders(data: Record<string, unknown>): CatalogEntry[] {
  const entries: CatalogEntry[] = [];

  for (const [providerKey, providerRaw] of Object.entries(data)) {
    if (!providerRaw || typeof providerRaw !== "object") continue;
    const provider = providerRaw as ModelsDevProvider;
    const models = provider.models;
    if (!models || typeof models !== "object") continue;

    for (const [modelKey, modelRaw] of Object.entries(models)) {
      if (!modelRaw || typeof modelRaw !== "object") continue;
      const model = modelRaw as Record<string, unknown>;

      const entry: CatalogEntry = {
        qualifiedId: `${providerKey}/${modelKey}`,
        provider: providerKey,
        modelId: modelKey,
        name: typeof model.name === "string" ? model.name : undefined,
        family: typeof model.family === "string" ? model.family : undefined,
        reasoning: model.reasoning === true ? true : undefined,
      };

      // Cost
      if (model.cost && typeof model.cost === "object") {
        const cost = model.cost as Record<string, unknown>;
        const input = typeof cost.input === "number" ? cost.input : undefined;
        const output = typeof cost.output === "number" ? cost.output : undefined;
        if (input !== undefined && output !== undefined) {
          entry.cost = {
            input,
            output,
            cache_read: typeof cost.cache_read === "number" ? cost.cache_read : undefined,
            cache_write: typeof cost.cache_write === "number" ? cost.cache_write : undefined,
          };
        }
      }

      // Limits
      if (model.limit && typeof model.limit === "object") {
        const limit = model.limit as Record<string, unknown>;
        const context = typeof limit.context === "number" ? limit.context : undefined;
        const output = typeof limit.output === "number" ? limit.output : undefined;
        if (context !== undefined && output !== undefined) {
          entry.limit = {
            context,
            input: typeof limit.input === "number" ? limit.input : undefined,
            output,
          };
        }
      }

      // Free flag
      if (model.isFree === true) {
        entry.isFree = true;
      }

      entries.push(entry);
    }
  }

  return entries;
}
