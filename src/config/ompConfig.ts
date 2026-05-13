import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

// ─── Path Resolution ───────────────────────────────────────────────────────────

export function resolveAgentDir(): string {
  if (process.env.PI_CODING_AGENT_DIR) {
    return path.resolve(process.env.PI_CODING_AGENT_DIR);
  }
  const configDirName = process.env.PI_CONFIG_DIR || ".omp";
  return path.join(os.homedir(), configDirName, "agent");
}

export function resolveConfigPath(): string {
  return path.join(resolveAgentDir(), "config.yml");
}

// ─── Config Type ───────────────────────────────────────────────────────────────

export interface OmpConfig {
  /** Model role assignments (e.g., { default: "anthropic/claude-sonnet-4-20250514", smol: "..." }) */
  modelRoles: Record<string, string>;
  /** Enabled models for scoped cycling */
  enabledModels: string[];
  /** Role cycling order (default: ["smol", "default", "slow"]) */
  cycleOrder: string[];
  /** Default thinking level */
  defaultThinkingLevel?: string;
  /** Steering mode */
  steeringMode?: string;
  /** Follow-up mode */
  followUpMode?: string;
  /** Interrupt mode */
  interruptMode?: string;
  /** Sampling temperature */
  temperature?: number;
  /** Top-P sampling */
  topP?: number;
  /** Top-K sampling */
  topK?: number;
  /** Whether compaction is enabled */
  compactionEnabled?: boolean;
  /** Compaction strategy */
  compactionStrategy?: string;
  /** Compaction threshold percentage */
  compactionThresholdPercent?: number;
  /** Memory backend */
  memoryBackend?: string;
  /** Full raw config for settings panel consumption */
  raw: Record<string, unknown>;
}

// ─── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_CYCLE_ORDER = ["smol", "default", "slow"];

const DEFAULT_CONFIG: OmpConfig = {
  modelRoles: {},
  enabledModels: [],
  cycleOrder: DEFAULT_CYCLE_ORDER,
  defaultThinkingLevel: undefined,
  steeringMode: undefined,
  followUpMode: undefined,
  interruptMode: undefined,
  temperature: undefined,
  topP: undefined,
  topK: undefined,
  compactionEnabled: undefined,
  compactionStrategy: undefined,
  compactionThresholdPercent: undefined,
  memoryBackend: undefined,
  raw: {},
};

// ─── Type Guards ───────────────────────────────────────────────────────────────

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(
    (v) => typeof v === "string",
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

// ─── Reader ────────────────────────────────────────────────────────────────────

/**
 * Read and parse the omp config.yml file.
 * Returns defaults if file doesn't exist or can't be parsed.
 */
export async function loadOmpConfig(): Promise<OmpConfig> {
  const configPath = resolveConfigPath();
  try {
    const content = await fs.readFile(configPath, "utf-8");
    const raw = parseYaml(content);
    if (!raw || typeof raw !== "object") return { ...DEFAULT_CONFIG };
    const obj = raw as Record<string, unknown>;
    const compaction = (typeof obj.compaction === "object" && obj.compaction !== null)
      ? obj.compaction as Record<string, unknown>
      : undefined;
    const memory = (typeof obj.memory === "object" && obj.memory !== null)
      ? obj.memory as Record<string, unknown>
      : undefined;
    return {
      modelRoles: isStringRecord(obj.modelRoles) ? obj.modelRoles : {},
      enabledModels: isStringArray(obj.enabledModels)
        ? obj.enabledModels
        : [],
      cycleOrder: isStringArray(obj.cycleOrder)
        ? obj.cycleOrder
        : DEFAULT_CYCLE_ORDER,
      defaultThinkingLevel:
        typeof obj.defaultThinkingLevel === "string"
          ? obj.defaultThinkingLevel
          : undefined,
      steeringMode: typeof obj.steeringMode === "string" ? obj.steeringMode : undefined,
      followUpMode: typeof obj.followUpMode === "string" ? obj.followUpMode : undefined,
      interruptMode: typeof obj.interruptMode === "string" ? obj.interruptMode : undefined,
      temperature: typeof obj.temperature === "number" ? obj.temperature : undefined,
      topP: typeof obj.topP === "number" ? obj.topP : undefined,
      topK: typeof obj.topK === "number" ? obj.topK : undefined,
      compactionEnabled: compaction && typeof compaction.enabled === "boolean"
        ? compaction.enabled : undefined,
      compactionStrategy: compaction && typeof compaction.strategy === "string"
        ? compaction.strategy : undefined,
      compactionThresholdPercent: compaction && typeof compaction.thresholdPercent === "number"
        ? compaction.thresholdPercent : undefined,
      memoryBackend: memory && typeof memory.backend === "string"
        ? memory.backend : undefined,
      raw: obj,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

// ─── Cached Singleton ──────────────────────────────────────────────────────────

let cachedConfig: OmpConfig | undefined;
let cachedConfigPath: string | undefined;

/**
 * Get the current cached config, or load from disk.
 * Call refreshOmpConfig() to force a reload.
 */
export async function getOmpConfig(): Promise<OmpConfig> {
  if (cachedConfig) return cachedConfig;
  return refreshOmpConfig();
}

/**
 * Force reload config from disk.
 */
export async function refreshOmpConfig(): Promise<OmpConfig> {
  cachedConfig = await loadOmpConfig();
  cachedConfigPath = resolveConfigPath();
  return cachedConfig;
}

/**
 * Get the resolved config file path (for diagnostics/display).
 */
export function getOmpConfigPath(): string {
  return cachedConfigPath ?? resolveConfigPath();
}

/**
 * Reset cached config (for testing or session restart).
 */
export function resetOmpConfigCache(): void {
  cachedConfig = undefined;
  cachedConfigPath = undefined;
}

// ─── Writer ─────────────────────────────────────────────────────────────────────

/**
 * Expand flat dot-path keys into nested objects.
 * e.g. { 'compaction.enabled': true } → { compaction: { enabled: true } }
 */
export function expandDotPaths(flat: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(flat)) {
    const parts = key.split(".");
    if (parts.length === 1) {
      result[key] = flat[key];
      continue;
    }
    let current = result;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]!;
      if (!(part in current) || typeof current[part] !== "object" || current[part] === null) {
        current[part] = {};
      }
      current = current[part] as Record<string, unknown>;
    }
    current[parts[parts.length - 1]!] = flat[key];
  }
  return result;
}

/**
 * Deep-merge source into target (mutates target). Arrays are replaced, not merged.
 */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(source)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    const srcVal = source[key];
    const tgtVal = target[key];
    if (
      srcVal !== null && typeof srcVal === "object" && !Array.isArray(srcVal) &&
      tgtVal !== null && typeof tgtVal === "object" && !Array.isArray(tgtVal)
    ) {
      deepMerge(tgtVal as Record<string, unknown>, srcVal as Record<string, unknown>);
    } else {
      target[key] = srcVal;
    }
  }
  return target;
}

/**
 * Write a config patch to config.yml atomically.
 * Reads existing config, deep-merges the patch (expanding dot-paths),
 * writes to a temp file, then renames.
 */
export async function writeOmpConfig(patch: Record<string, unknown>): Promise<OmpConfig> {
  const configPath = resolveConfigPath();
  let existing: Record<string, unknown> = {};
  try {
    const content = await fs.readFile(configPath, "utf-8");
    const parsed = parseYaml(content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    // File missing or unparseable — start fresh
  }

  const expanded = expandDotPaths(patch);
  deepMerge(existing, expanded);

  const yaml = stringifyYaml(existing);
  const tmpPath = configPath + ".tmp";

  // Ensure directory exists
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(tmpPath, yaml, "utf-8");
  await fs.rename(tmpPath, configPath);

  return refreshOmpConfig();
}

// ─── File Watcher ────────────────────────────────────────────────────────────────

/**
 * Watch config.yml for external changes.
 * Watches the directory (more reliable cross-platform) and filters for config.yml.
 * Returns a dispose function to stop watching.
 */
export function watchConfigFile(onChange: () => void): { dispose: () => void } {
  const configPath = resolveConfigPath();
  const dir = path.dirname(configPath);
  const filename = path.basename(configPath);

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let watcher: import("node:fs").FSWatcher | undefined;

  try {
    // Use the synchronous fs.watch (from node:fs, not node:fs/promises)
    const nodeFs = require("node:fs") as typeof import("node:fs");
    watcher = nodeFs.watch(dir, (eventType, changedFile) => {
      if (changedFile !== filename) return;
      if (debounceTimer !== undefined) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        onChange();
      }, 300);
    });
  } catch {
    // Directory doesn't exist — return no-op dispose
    return { dispose: () => {} };
  }

  return {
    dispose: () => {
      if (debounceTimer !== undefined) clearTimeout(debounceTimer);
      watcher?.close();
    },
  };
}
