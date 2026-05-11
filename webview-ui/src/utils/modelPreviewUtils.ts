import type { ModelEntry } from "../types/modelInfo";
import { getState, type CatalogEntry } from "../state/store";

export type CostTier = "free" | "economy" | "standard" | "premium" | "flagship";

export interface ResolvedPricing {
  input?: number;
  output?: number;
  cacheRead?: number;
  context?: number;
  source: "runtime" | "inferred" | "free";
  note?: string;
}

interface StaticCatalogEntry {
  ids: string[];
  input: number;
  output: number;
  cacheRead?: number;
  context?: number;
}

const UNKNOWN_CONTEXT_WINDOWS = new Set([222_222]);

/**
 * Static fallback catalog — used ONLY when models.dev data is unavailable.
 * Once the API catalog is loaded, this is not consulted.
 */
const STATIC_FALLBACK: StaticCatalogEntry[] = [
  { ids: ["anthropic/claude-opus-4-6", "anthropic/claude-opus-4.6", "claude-opus-4-6", "claude-opus-4.6"], input: 15, output: 75, cacheRead: 1.5, context: 200_000 },
  { ids: ["anthropic/claude-opus-4-5", "anthropic/claude-opus-4.5", "claude-opus-4-5", "claude-opus-4.5"], input: 15, output: 75, cacheRead: 1.5, context: 200_000 },
  { ids: ["anthropic/claude-sonnet-4-6", "anthropic/claude-sonnet-4.6", "claude-sonnet-4-6", "claude-sonnet-4.6"], input: 3, output: 15, cacheRead: 0.3, context: 200_000 },
  { ids: ["anthropic/claude-sonnet-4-5", "anthropic/claude-sonnet-4.5", "claude-sonnet-4-5", "claude-sonnet-4.5"], input: 3, output: 15, cacheRead: 0.3, context: 200_000 },
  { ids: ["anthropic/claude-haiku-4-5", "anthropic/claude-haiku-4.5", "claude-haiku-4-5", "claude-haiku-4.5"], input: 1, output: 5, cacheRead: 0.1, context: 200_000 },
  { ids: ["openai/gpt-5", "gpt-5"], input: 1.25, output: 10, context: 400_000 },
  { ids: ["openai/gpt-5-mini", "gpt-5-mini"], input: 0.25, output: 2, context: 400_000 },
  { ids: ["openai/gpt-5-nano", "gpt-5-nano"], input: 0.05, output: 0.4, context: 400_000 },
  { ids: ["google/gemini-2.5-pro", "gemini-2.5-pro"], input: 1.25, output: 10, context: 1_000_000 },
  { ids: ["google/gemini-2.5-flash", "gemini-2.5-flash"], input: 0.3, output: 2.5, context: 1_000_000 },
];

export function formatModelName(id: string): string {
  return id.replace(/-\d{8}$/, "");
}

export function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) {
    const value = tokens / 1_000_000;
    return `${value.toFixed(Number.isInteger(value) ? 0 : 1)}M context`;
  }
  if (tokens >= 1_000) {
    const value = tokens / 1_000;
    return `${value.toFixed(Number.isInteger(value) ? 0 : 1)}K context`;
  }
  return `${tokens} context`;
}

export function formatCompactContext(tokens: number): string {
  return formatContext(tokens).replace(" context", " ctx");
}

export function formatPrice(value?: number): string | undefined {
  if (typeof value !== "number" || Number.isNaN(value)) return undefined;
  if (value === 0) return "Free";
  if (value < 0.01) return `$${value.toFixed(4)}/1M`;
  return `$${value.toFixed(2)}/1M`;
}

function price(value: unknown): number | undefined {
  return typeof value === "number" && !Number.isNaN(value) ? value : undefined;
}

function runtimeInputCost(model: ModelEntry): number | undefined {
  return price(model.cost?.input) ?? price(model.inputPrice);
}

function runtimeOutputCost(model: ModelEntry): number | undefined {
  return price(model.cost?.output) ?? price(model.outputPrice);
}

function runtimeCacheReadCost(model: ModelEntry): number | undefined {
  return price(model.cost?.cache_read) ?? price(model.cost?.cacheRead) ?? price(model.cost?.cache?.read) ?? price(model.cacheReadsPrice);
}

export function resolvePricing(model: ModelEntry): ResolvedPricing | undefined {
  const input = runtimeInputCost(model);
  const output = runtimeOutputCost(model);
  const cacheRead = runtimeCacheReadCost(model);
  const context = getModelContext(model);
  const real = (input != null && input > 0) || (output != null && output > 0) || (cacheRead != null && cacheRead > 0);
  if (real) return { input: positive(input), output: positive(output), cacheRead: positive(cacheRead), context, source: "runtime" };
  if (isExplicitlyFree(model)) return { input: 0, output: 0, cacheRead: 0, context, source: "free" };

  const inferred = inferPricing(model);
  if (!inferred) return undefined;
  return {
    input: inferred.input,
    output: inferred.output,
    cacheRead: inferred.cacheRead,
    context: inferred.context ?? (context && !UNKNOWN_CONTEXT_WINDOWS.has(context) ? context : undefined),
    source: "inferred",
    note: `Best effort pricing, see ${formatProviderName(model.provider)}`,
  };
}

export function inputCost(model: ModelEntry): number | undefined {
  return resolvePricing(model)?.input;
}

export function outputCost(model: ModelEntry): number | undefined {
  return resolvePricing(model)?.output;
}

export function cacheReadCost(model: ModelEntry): number | undefined {
  return resolvePricing(model)?.cacheRead;
}

/**
 * Blended cost per 1M tokens using the industry-standard 75/25 ratio.
 * Formula: (input * 0.75) + (output * 0.25)
 *
 * Reflects the 3:1 prompt-to-completion ratio observed across millions of
 * API calls. Gives a single comparable price tag for model ranking.
 */
export function blendedCost(model: ModelEntry): number | undefined {
  const input = inputCost(model);
  const output = outputCost(model);
  if (input == null || output == null) return undefined;
  return (input * 0.75) + (output * 0.25);
}

export function isModelFree(model: ModelEntry): boolean {
  return resolvePricing(model)?.source === "free";
}

export function hasPricing(model: ModelEntry): boolean {
  const pricing = resolvePricing(model);
  return !!pricing && (pricing.source === "free" || pricing.input != null || pricing.output != null || pricing.cacheRead != null);
}

export function outputCostShare(model: ModelEntry): number | undefined {
  const input = inputCost(model);
  const output = outputCost(model);

  if (input == null || output == null) return undefined;
  const total = input + output;
  if (total <= 0) return 0;
  return Math.round((output / total) * 100);
}

/**
 * Compute the blended cost ceiling from the catalog using percentile normalization.
 * Uses P95 of all models' blended costs so the bar reflects the real distribution.
 * 95% of models spread across 0-100%; only true outliers (top 5%) clamp at 100%.
 *
 * Memoized per catalog identity (recalculates only when catalog changes).
 */
let cachedCeiling: { catalogLength: number; value: number } | undefined;

function blendedCeiling(): number {
  const catalog = getState().modelCatalog;
  if (!catalog || catalog.length === 0) return 12.5; // sensible fallback

  // Memoize by catalog length (cheap proxy for identity).
  if (cachedCeiling && cachedCeiling.catalogLength === catalog.length) {
    return cachedCeiling.value;
  }

  const costs: number[] = [];
  for (const entry of catalog) {
    if (!entry.cost) continue;
    const blended = (entry.cost.input * 0.75) + (entry.cost.output * 0.25);
    if (blended > 0) costs.push(blended);
  }

  if (costs.length === 0) {
    cachedCeiling = { catalogLength: catalog.length, value: 12.5 };
    return 12.5;
  }

  costs.sort((a, b) => a - b);
  const p95Index = Math.floor(costs.length * 0.95);
  const ceiling = costs[Math.min(p95Index, costs.length - 1)];

  cachedCeiling = { catalogLength: catalog.length, value: ceiling };
  return ceiling;
}

/**
 * Blended cost as a percentage of the P95 ceiling from the catalog.
 * Uses percentile normalization: 95% of all known models spread across
 * 0-100% of the bar. The top 5% outliers clamp at 100%.
 *
 * This is data-driven — no arbitrary cap. The scale adapts to the
 * actual distribution of model prices in the market.
 */
export function outputPressurePercent(model: ModelEntry): number | undefined {
  const blended = blendedCost(model);
  if (blended == null) return undefined;
  if (blended <= 0) return 0;
  const ceiling = blendedCeiling();
  return Math.min(100, Math.round((blended / ceiling) * 100));
}

/**
 * Classify model cost tier based on blended 75/25 cost.
 *
 * Thresholds calibrated so models known to rip through quotas
 * show as flagship, not buried in "premium":
 *
 *   Free:     $0
 *   Economy:  < $1/1M blended   (DeepSeek, GLM-5.1, GPT-5 Nano)
 *   Standard: < $3/1M blended   (GPT-5, Gemini 2.5 Pro)
 *   Premium:  < $7/1M blended   (Sonnet 4.6, GPT-5 Pro)
 *   Flagship: >= $7/1M blended  (Opus 4.6+, o1-pro, quota burners)
 */
export function classifyCost(model: ModelEntry): CostTier | undefined {
  if (isModelFree(model)) return "free";
  const blended = blendedCost(model);
  if (blended == null) return undefined;
  if (blended < 1) return "economy";
  if (blended < 3) return "standard";
  if (blended < 7) return "premium";
  return "flagship";
}

export function costTierLabel(tier?: CostTier): string | undefined {
  switch (tier) {
    case "free": return "Free";
    case "economy": return "$ Economy";
    case "standard": return "$$ Standard";
    case "premium": return "$$$ Premium";
    case "flagship": return "$$$$ Flagship";
    default: return undefined;
  }
}

export function getModelContext(model: ModelEntry): number | undefined {
  const context = model.limit?.context ?? model.contextWindow ?? model.contextLength;
  return context != null && !UNKNOWN_CONTEXT_WINDOWS.has(context) ? context : undefined;
}

export function getModelDescription(model: ModelEntry): string | undefined {
  return model.description ?? model.options?.description;
}

function isExplicitlyFree(model: ModelEntry): boolean {
  if (model.isFree === true) return true;
  return /(^|[\s:_-])free($|[\s:_-]|\))/i.test(`${model.name ?? ""} ${model.id}`);
}

/** Result shape from catalog/static lookup. */
interface InferredPricing {
  input: number;
  output: number;
  cacheRead?: number;
  context?: number;
}

function inferPricing(model: ModelEntry): InferredPricing | undefined {
  // Try models.dev catalog first (fetched from API, hundreds of models).
  const catalogResult = inferFromCatalog(model);
  if (catalogResult) return catalogResult;

  // Fall back to static hardcoded entries (offline fallback).
  return inferFromStatic(model);
}

function inferFromCatalog(model: ModelEntry): InferredPricing | undefined {
  const catalog = getState().modelCatalog;
  if (!catalog || catalog.length === 0) return undefined;

  const keys = modelKeys(model);

  for (const entry of catalog) {
    // Check if any of the model's normalized keys match the catalog entry's normalized qualifiedId or modelId.
    const entryKeys = new Set<string>();
    entryKeys.add(normalizeModelKey(entry.qualifiedId));
    entryKeys.add(normalizeModelKey(entry.modelId));
    // Also add provider/modelId combo
    entryKeys.add(normalizeModelKey(`${entry.provider}/${entry.modelId}`));

    for (const key of keys) {
      if (entryKeys.has(key)) {
        if (entry.cost) {
          return {
            input: entry.cost.input,
            output: entry.cost.output,
            cacheRead: entry.cost.cache_read,
            context: entry.limit?.context,
          };
        }
        // Entry exists but has no cost — treat as explicitly known (avoid static fallback).
        return undefined;
      }
    }
  }
  return undefined;
}

function inferFromStatic(model: ModelEntry): InferredPricing | undefined {
  const keys = modelKeys(model);
  return STATIC_FALLBACK.find(entry => entry.ids.some(id => keys.has(normalizeModelKey(id))));
}

function modelKeys(model: ModelEntry): Set<string> {
  const values = [model.id, model.name, `${model.provider}/${model.id}`, `${model.provider}/${model.name ?? model.id}`];
  const keys = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    const key = normalizeModelKey(value);
    keys.add(key);
    const parts = key.split("/");
    for (let index = 0; index < parts.length; index += 1) {
      keys.add(parts.slice(index).join("/"));
    }
  }
  return keys;
}

function normalizeModelKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[._]/g, "-")
    .replace(/-\d{8}(?=$|\/)/g, "")
    .replace(/-+/g, "-")
    .replace(/^\/+|\/+$/g, "");
}

function positive(value: number | undefined): number | undefined {
  return value != null && value > 0 ? value : undefined;
}

function formatProviderName(provider: string): string {
  if (provider.toLowerCase() === "kilo") return "Kilo";
  if (provider.toLowerCase().includes("ollama")) return "Ollama";
  return provider.split(/[-_\s]+/).filter(Boolean).map(part => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(" ") || provider;
}
