/**
 * Footer/status and header item types for the OMP chat webview.
 *
 * The header surfaces session identity, cost, and context at a glance.
 * The footer has two data authorities for the file-context and controls zones:
 * - VS Code bridge (active editor, selection)
 * - OMP runtime (model, thinking, context, usage)
 *
 * Grounded in the canonical plan's "Header/footer information architecture".
 */

import type { ThinkingLevel } from "./webviewMessages.ts";

// ============================================================================
// Header state
// ============================================================================

/**
 * Header state pushed to the webview. Always visible; the expandable
 * details row is toggled client-side.
 */
export interface ChatHeaderState {
  /** RPC connection health: green/yellow/red */
  connection: "connected" | "connecting" | "disconnected";
  /** Session display name (editable by user) */
  sessionName: string;
  /** Session file path (for rename RPC) */
  sessionPath: string;
  /** Cumulative session cost in USD, undefined = unavailable */
  costUsd?: number;
  /** Context window usage as 0–100 percentage, undefined = unavailable */
  contextPercent?: number;
  /** Whether compaction is available/applicable */
  canCompact: boolean;
  /** Token counts for the expandable detail row */
  tokens?: {
    input: number;
    output: number;
    cacheRead: number;
  };
}

// ============================================================================
// Footer items
// ============================================================================

/**
 * Discriminated union of footer items, each tagged with its source.
 *
 * Zone 1 (file context): editor + selection from VS Code bridge.
 * Zone 3 (controls): runtime state + model + thinking from OMP runtime.
 *
 * Missing data must be labelled "unavailable" — never shown as zero
 * or an empty string that could be mistaken for a real value.
 */
export type ChatFooterItem =
  // ── VS Code bridge items (Zone 1: file context bar) ──────────────────
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
      endLine?: number;
      character?: number;
      selectedTextPreview?: string;
    }
  // ── OMP runtime items (Zone 3: controls bar) ─────────────────────────
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
  // ── Usage stats (header: cost + token detail) ────────────────────────
  | {
      source: "usageStats";
      kind: "usage";
      requests?: number;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      totalCostUsd?: number;
      tokensPerSecond?: number;
      ttftMs?: number;
    };

// ============================================================================
// Initial states
// ============================================================================

/**
 * Initial header state sent before any runtime data is available.
 */
export const EMPTY_HEADER_STATE: ChatHeaderState = {
  connection: "disconnected",
  sessionName: "New Session",
  sessionPath: "",
  costUsd: undefined,
  contextPercent: undefined,
  canCompact: false,
  tokens: undefined,
};

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
