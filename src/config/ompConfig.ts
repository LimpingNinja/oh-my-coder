import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { parse as parseYaml } from "yaml";

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
  /** Raw config object for future field access */
  raw: Record<string, unknown>;
}

// ─── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_CYCLE_ORDER = ["smol", "default", "slow"];

const DEFAULT_CONFIG: OmpConfig = {
  modelRoles: {},
  enabledModels: [],
  cycleOrder: DEFAULT_CYCLE_ORDER,
  defaultThinkingLevel: undefined,
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
