/**
 * Typed extension↔webview message protocol.
 *
 * This is the single source of truth for all messages that cross the
 * VS Code postMessage boundary between the extension host and the webview.
 * Both host and webview code import from this module; no string literals
 * for message types should appear outside it.
 *
 * Grounded in the canonical plan's "Message contracts" section.
 * Discriminated unions make illegal states unrepresentable.
 */

import type { OmpTodoPhase } from "./ompRpcTypes.ts";
import type { OmpSessionListState, OmpSessionSummary } from "../session/types.ts";
import type { OmpAvailableModel, OmpRuntimeState } from "./ompRpcTypes.ts";
import type { ChatFooterItem, ChatHeaderState } from "./footerTypes.ts";

// ============================================================================
// Shared value types
// ============================================================================

/** Thinking/reasoning effort levels matching the runtime's taxonomy. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** Model identifier for the webview layer. */
export interface ModelRef {
  provider: string;
  modelId: string;
}

/** Attachment alongside a chat message (future: images, files, etc.). */
export interface ChatAttachment {
  type: "image";
  data: string;
  mediaType: string;
}

/** Explicit file context attached to a chat send from the composer. */
export interface ChatFileContext {
  path: string;
  line?: number;
  endLine?: number;
  languageId?: string;
}

/** Structured composer context pushed from the extension host. */
export interface ComposerFileContextPayload extends ChatFileContext {
  id?: string;
}

/**
 * Per-turn metadata payload sent from extension host to webview at agent_end.
 * Mirrors the webview's TurnMetadata shape for zero-transformation attachment.
 */
export interface TurnMetadataPayload {
  /** ID of the assistant message this metadata belongs to (for hydration correlation) */
  parentMessageId?: string;
  model?: { provider: string; modelId: string };
  thinkingLevel?: string;
  contextPercent?: number;
  tokens?: { input: number; output: number; cacheRead: number };
  costUsd?: number;
  durationMs?: number;
}

/** Lightweight slash command contract sent to the webview catalog UI. */
export interface SlashCommandForWebview {
  name: string;
  description: string;
  tier: 1 | 2 | 3 | 4 | 5 | 6;
  source: "omc" | "runtime";
  aliases?: string[];
  acceptsArgs?: boolean;
  argsHint?: string;
  inlineHint?: string;
  subcommands?: Array<{ name: string; description: string; usage?: string }>;
  runtimeMeta?: { source?: string; location?: string; path?: string };
  route: { kind: string; reason?: string };
}

// ============================================================================
// Webview → Extension messages
// ============================================================================

/**
 * Messages the webview sends to the extension host.
 *
 * Every user intent that requires host-side action goes through one
 * of these messages. The host translates them into RPC commands,
 * discovery calls, or VS Code API calls.
 */
export type WebviewToExtensionMessage =
  // ── Lifecycle ──────────────────────────────────────────────────────
  /** Sent by the webview once its HTML/scripts have loaded and it is ready
   *  to receive state. The host responds by pushing initial state. */
  | { type: "webview.ready" }

  // ── Session list ───────────────────────────────────────────────────
  /** Request a refresh of the session list. */
  | { type: "sessions.refresh" }
  /** User selected a session row in the sidebar. Does NOT launch it. */
  | { type: "session.select"; sessionPath: string }
  /** User wants to rename a session. */
  | { type: "session.rename"; sessionPath: string; title: string }
  /** User wants to open the transcript file in a VS Code editor. */
  | { type: "session.openTranscript"; sessionPath: string }
  /** User confirmed deletion of a session file. */
  | { type: "session.delete"; sessionPath: string }

  // ── Session lifecycle ───────────────────────────────────────────────
  /** Start a brand-new session. */
  | {
      type: "session.start";
      prompt: string;
      model?: string;
      thinking?: ThinkingLevel;
      attachments?: ChatAttachment[];
    }
  /** Resume an existing session with an optional follow-up prompt. */
  | {
      type: "session.resume";
      sessionPath: string;
      prompt?: string;
      attachments?: ChatAttachment[];
    }
  /** Switch to a different active session (in-process or via process restart). */
  | { type: "session.switch"; sessionPath: string }

  // ── Chat ────────────────────────────────────────────────────────────
  /** Send a user message in an active session. */
  | {
      type: "chat.send";
      sessionPath: string;
      content: string;
      behavior?: "steer" | "followUp" | "forceSend";
      attachments?: ChatAttachment[];
      fileContexts?: ChatFileContext[];
    }
  /** Abort the current turn in an active session. */
  | { type: "chat.abort"; sessionPath: string }

  // ── Runtime controls ────────────────────────────────────────────────
  /** Set a specific model. */
  | { type: "runtime.setModel"; provider: string; modelId: string }
  /** Cycle to the next model. */
  | { type: "runtime.cycleModel" }
  /** Set a specific thinking level. */
  | { type: "runtime.setThinkingLevel"; level: ThinkingLevel }
  /** Cycle to the next thinking level. */
  | { type: "runtime.cycleThinkingLevel" }
  /** Compact context. */
  | { type: "runtime.compact"; customInstructions?: string }
  /** Explicitly request a full runtime state snapshot. */
  | { type: "runtime.getState" }
  /** Request available models list. */
  | { type: "runtime.getAvailableModels" }
  /** Request a fresh available-model metadata/pricing snapshot. */
  | { type: "runtime.refreshModelPricing" }
  /** Set queue delivery modes. */
  | { type: "runtime.setSteeringMode"; mode: "all" | "one-at-a-time" }
  | { type: "runtime.setFollowUpMode"; mode: "all" | "one-at-a-time" }
  | { type: "runtime.setInterruptMode"; mode: "immediate" | "wait" }
  | { type: "runtime.setRole"; role: string }

  // ── Extension UI response ───────────────────────────────────────────
  /** Respond to an extension UI request from the runtime.
   *  The response payload is a bare object ({ value, confirmed, or cancelled })
   *  without the transport `type`/`id` fields — the host stamps those before sending to stdin. */
  | { type: "extensionUi.respond"; requestId: string; response: { value: string } | { confirmed: boolean } | { cancelled: true } }

  // ── Focus ────────────────────────────────────────────────────────────
  /** Focus was requested (e.g. via command palette). */
  | { type: "input.focusRequested" }

  // ── File operations ─────────────────────────────────────────────────
  /** Open a file in the VS Code editor. */
  | { type: "openFile"; path: string; line?: number; endLine?: number }
  /** Open an image blob persisted by the runtime. */
  | { type: "image.open"; blobRef: string }

  // ── Slash commands ──────────────────────────────────────────────────
  /** Execute a parsed slash command. */
  | { type: "slash.execute"; raw: string; command: string; args: string }
  /** Request the current slash command catalog. */
  | { type: "slash.catalog.request" };

// ============================================================================
// Extension → Webview messages
// ============================================================================

/**
 * Selected pane state in the detail view.
 *
 * Makes preview distinct from active runtime state — selecting a session
 * row does not launch it.
 */
export type SelectedPaneState =
  | { kind: "new"; draft: string }
  | { kind: "preview"; session: OmpSessionSummary; draft: string }
  | {
      kind: "launching";
      mode: "new" | "resume";
      sessionPath?: string;
      draft: string;
      runId: string;
    }
  | { kind: "active"; sessionPath: string; acceptsInput: boolean }
  | {
      kind: "failed";
      attempted: "new" | "resume";
      sessionPath?: string;
      message: string;
      retry: WebviewToExtensionMessage;
      draft: string;
    };

/**
 * Messages the extension host sends to the webview.
 *
 * The host pushes state; the webview never polls. Every message
 * carries enough data for the webview to render without additional
 * requests, except `runtime.getState` which is an explicit round-trip.
 */
export type ExtensionToWebviewMessage =
  // ── Session list ───────────────────────────────────────────────────
  | { type: "sessions.state"; state: OmpSessionListState }

  // ── Selection ────────────────────────────────────────────────────────
  | { type: "selection.state"; state: SelectedPaneState }

  // ── Session lifecycle ────────────────────────────────────────────────
  | {
      type: "session.launchState";
      state: OmpLaunchState;
    }
  | { type: "session.deleteResult"; sessionPath: string; success: true }
  | { type: "session.deleteResult"; sessionPath: string; success: false; message: string }

  // ── Runtime ─────────────────────────────────────────────────────────
  | { type: "runtime.state"; sessionPath?: string; state: OmpRuntimeState }
  | { type: "runtime.availableModels"; models: OmpAvailableModel[]; source?: "runtime" | "cache" | "refresh"; updatedAt?: number }
  | { type: "runtime.modelCatalog"; entries: import("../models/catalog.ts").CatalogEntry[] }
  /** Forward a raw OMP RPC frame to the webview for transcript rendering. */
  | { type: "runtime.frame"; sessionPath?: string; frame: OmpRpcFrameForWebview }
  /** Per-turn metadata snapshot, emitted at agent_end. Attached to the most recent agent turn. */
  | { type: "runtime.turnMetadata"; metadata: TurnMetadataPayload }
  | { type: "composer.addFileContext"; context: ComposerFileContextPayload }

  // ── Chat ─────────────────────────────────────────────────────────────
  | { type: "chat.message"; sessionPath: string; message: ChatMessageForWebview }
  | { type: "chat.delta"; sessionPath: string; messageId: string; delta: ChatDelta }
  | { type: "chat.messagesLoaded"; sessionPath: string; messages: ChatMessageForWebview[]; turnMetadataEntries?: TurnMetadataPayload[] }
  | { type: "chat.queued"; behavior: "steer" | "followUp"; content: string }

  // ── Header/footer/status ─────────────────────────────────────────────
  | { type: "header.state"; state: ChatHeaderState }
  | { type: "header.todos"; todos: OmpTodoPhase[] }
  | { type: "footer.state"; items: ChatFooterItem[] }
  | { type: "footer.modes"; steeringMode: string; followUpMode: string; interruptMode: string; activeRole?: string; availableRoles?: string[] }
  | { type: "footer.thinkingSupport"; supported: boolean; minLevel?: string; maxLevel?: string }

  // ── Extension UI request ─────────────────────────────────────────────
  | { type: "extensionUi.request"; request: ExtensionUiRequestForWebview }
  | { type: "extensionUi.cancel"; targetId: string }
  | { type: "extensionUi.setEditorText"; text: string }

  // ── Slash commands ──────────────────────────────────────────────────
  /** Push the merged slash command catalog to the webview. */
  | { type: "slash.catalog"; version: string; commands: SlashCommandForWebview[] }
  /** Result feedback for a slash command execution. */
  | { type: "slash.result"; command: string; ok: boolean; message?: string }
  /** Trigger a webview UI action. */
  | { type: "ui.trigger"; action: string }
  /** Clear composer textarea in webview. */
  | { type: "composer.clear" }
  // ── Error ────────────────────────────────────────────────────────────
  | {
      type: "error";
      scope: "launch" | "runtime" | "sessionList" | "bridge" | "extensionUi";
      message: string;
      retry?: WebviewToExtensionMessage;
    };

// ============================================================================
// Launch state
// ============================================================================

/** Discriminated union for session launch/transition state. */
export type OmpLaunchState =
  | { kind: "idle" }
  | { kind: "launching"; mode: "new" | "resume"; sessionPath?: string; runId: string }
  | { kind: "launched"; sessionPath: string }
  | { kind: "failed"; mode: "new" | "resume"; sessionPath?: string; message: string };

// ============================================================================
// Webview-specific payload types
// ============================================================================

/**
 * Subset of OMP RPC frame types forwarded to the webview.
 *
 * The webview does not see raw RPC responses — those are consumed by
 * the controller. It sees agent events and host-tool calls that drive
 * transcript rendering.
 */
export type OmpRpcFrameForWebview =
  | { type: "agent_start" }
  | { type: "agent_end" }
  | { type: "turn_start" }
  | { type: "turn_end" }
  | { type: "message_start"; message: unknown }
  | { type: "message_update"; message: unknown; assistantMessageEvent: unknown }
  | { type: "message_end"; message: unknown }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; partialResult: unknown }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError?: boolean;
    }
  | { type: "auto_compaction_start"; reason: string; action: string }
  | { type: "auto_compaction_end" }
  | { type: "auto_retry_start" }
  | { type: "auto_retry_end" };

/**
 * Chat message shape for the webview.
 *
 * For hydration (chat.messagesLoaded), `content` may be the raw content block
 * array from the JSONL (preserving toolCall/thinking blocks).  For streaming
 * messages it remains a simple string.
 *
 * `role` includes "toolResult" for hydration — the webview reducer uses these
 * to correlate tool results with their originating tool calls.
 */
export interface ChatMessageForWebview {
  id: string;
  role: "user" | "assistant" | "system" | "toolResult";
  content: string | unknown[];
  timestamp?: number;
  /** Resolved image attachments for user turns (base64 data or null for missing). */
  images?: Array<{ mimeType: string; data: string | null; blobRef?: string }>;
  /** File context badges for user turns. */
  fileContexts?: Array<{ path: string; line?: number; endLine?: number; languageId?: string }>;
  [key: string]: unknown;
}

/** Streaming delta within an active message. */
export type ChatDelta =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "toolCall"; toolCallId: string; toolName: string; args?: unknown };

/**
 * Extension UI request shape forwarded to the webview.
 *
 * Simplified from the RPC type: the webview sees only what it needs
 * to render a dialog, not the raw RPC envelope.
 */
export type ExtensionUiRequestForWebview =
  | { method: "select"; requestId: string; title: string; options: string[]; timeout?: number }
  | { method: "confirm"; requestId: string; title: string; message: string; timeout?: number }
  | { method: "input"; requestId: string; title: string; placeholder?: string; timeout?: number }
  | { method: "editor"; requestId: string; title: string; prefill?: string }
  | { method: "cancel"; requestId: string; targetId: string }
  | {
      method: "notify";
      requestId: string;
      message: string;
      notifyType?: "info" | "warning" | "error";
    };

// ============================================================================
// Type discriminators (for exhaustive switch checking)
// ============================================================================

/** String literal union of all webview-to-extension message types. */
export type WebviewToExtensionMessageType = WebviewToExtensionMessage["type"];

/** String literal union of all extension-to-webview message types. */
export type ExtensionToWebviewMessageType = ExtensionToWebviewMessage["type"];

// ============================================================================
// Type guards
// ============================================================================

/** Type guard: is this a webview-to-extension message? */
export function isWebviewToExtensionMessage(msg: unknown): msg is WebviewToExtensionMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const type = (msg as Record<string, unknown>)["type"];
  return typeof type === "string" && webviewToExtensionTypes.has(type);
}

/** Type guard: is this an extension-to-webview message? */
export function isExtensionToWebviewMessage(msg: unknown): msg is ExtensionToWebviewMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const type = (msg as Record<string, unknown>)["type"];
  return typeof type === "string" && extensionToWebviewTypes.has(type);
}

// ── Internal sets for type guards ──────────────────────────────────────

const webviewToExtensionTypes = new Set<string>([
  "webview.ready",
  "sessions.refresh",
  "session.select",
  "session.rename",
  "session.openTranscript",
  "session.delete",
  "session.start",
  "session.resume",
  "session.switch",
  "chat.send",
  "chat.abort",
  "runtime.setModel",
  "runtime.cycleModel",
  "runtime.setThinkingLevel",
  "runtime.cycleThinkingLevel",
  "runtime.compact",
  "runtime.getState",
  "runtime.getAvailableModels",
  "runtime.refreshModelPricing",
  "runtime.setSteeringMode",
  "runtime.setFollowUpMode",
  "runtime.setInterruptMode",
  "extensionUi.respond",
  "input.focusRequested",
  "openFile",
  "image.open",
  "slash.execute",
  "runtime.setRole",
  "slash.catalog.request",
]);

const extensionToWebviewTypes = new Set<string>([
  "sessions.state",
  "selection.state",
  "session.launchState",
  "session.deleteResult",
  "runtime.state",
  "runtime.availableModels",
  "runtime.modelCatalog",
  "runtime.frame",
  "runtime.turnMetadata",
  "chat.message",
  "chat.delta",
  "chat.messagesLoaded",
  "chat.queued",
  "header.state",
  "header.todos",
  "footer.state",
  "footer.modes",
  "footer.thinkingSupport",
  "extensionUi.request",
  "extensionUi.cancel",
  "extensionUi.setEditorText",
  "slash.catalog",
  "slash.result",
  "ui.trigger",
  "composer.clear",
  "error",
]);
