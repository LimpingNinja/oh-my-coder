/**
 * Footer/status item types for the OMP chat webview.
 *
 * The footer has three authorities that must label missing data honestly:
 * - VS Code bridge (editor, selection, diagnostics)
 * - OMP runtime (model, thinking, compaction, streaming state)
 * - Usage stats (requests, tokens, cost)
 *
 * Grounded in the canonical plan's "Status/footer information architecture".
 */

import type { ThinkingLevel } from "./webviewMessages.ts";

// ============================================================================
// Chat footer items
// ============================================================================

/**
 * Discriminated union of footer items, each tagged with its source.
 *
 * The webview renders these in three zones:
 * - Left: editor/selection/diagnostics (vscodeBridge)
 * - Center: runtime state/model/thinking/compaction (ompRuntime)
 * - Right: usage stats (usageStats)
 *
 * Missing data must be labelled "unavailable" — never shown as zero
 * or an empty string that could be mistaken for a real value.
 */
export type ChatFooterItem =
  // ── VS Code bridge items ─────────────────────────────────────────────
  | {
      source: "vscodeBridge";
      kind: "editor";
      filePath?: string;
      languageId?: string;
      isDirty: boolean;
    }
  | {
      source: "vscodeBridge";
      kind: "selection";
      line?: number;
      character?: number;
      selectedTextPreview?: string;
    }
  | {
      source: "vscodeBridge";
      kind: "diagnostics";
      errors: number;
      warnings: number;
      infos: number;
      hints: number;
    }
  // ── OMP runtime items ────────────────────────────────────────────────
  | {
      source: "ompRuntime";
      kind: "runtime";
      state: "ready" | "streaming" | "tool" | "compacting" | "error";
      model?: string;
      thinking?: ThinkingLevel;
    }
  | {
      source: "ompRuntime";
      kind: "context";
      usedPercent?: number;
      compacting: boolean;
    }
  // ── Usage stats items ────────────────────────────────────────────────
  | {
      source: "usageStats";
      kind: "usage";
      requests?: number;
      inputTokens?: number;
      outputTokens?: number;
      totalCostUsd?: number;
      tokensPerSecond?: number;
      ttftMs?: number;
    };

// ============================================================================
// Footer initial state
// ============================================================================

/**
 * Initial footer state sent to the webview before any bridge or runtime
 * data is available. Every field signals "unavailable" — never a
 * plausible zero or empty string.
 */
export const EMPTY_FOOTER_ITEMS: ChatFooterItem[] = [
  {
    source: "vscodeBridge",
    kind: "editor",
    filePath: undefined,
    languageId: undefined,
    isDirty: false,
  },
  {
    source: "ompRuntime",
    kind: "runtime",
    state: "ready",
    model: undefined,
    thinking: undefined,
  },
  {
    source: "usageStats",
    kind: "usage",
  },
];
