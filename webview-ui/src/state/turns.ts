/**
 * Turn-based transcript types.
 *
 * The transcript is a sequence of Turns. Each turn is either a user turn
 * (one text input) or an agent turn (a bracket of events between agent_start
 * and agent_end, rendered sequentially by content type).
 *
 * This replaces the role-based TranscriptMessage model which created
 * orphaned "SYSTEM" messages and failed to attach tool executions to
 * their parent turn.
 *
 * Grounded in:
 * - OMP RPC protocol (agent_start/agent_end brackets, event stream)
 * - vscode-pi's event forwarder (decomposed deltas, turn-based lifecycle)
 * - KiloCode's flat message array (content-type rendering, no role labels)
 */

// ============================================================================
// Per-turn metadata (frozen at agent_end)
// ============================================================================

/**
 * Metadata captured at the end of an agent turn.
 *
 * This is a frozen snapshot of the state at turn completion — it never
 * updates after being attached. Used by the Response Details panel to
 * show per-response stats rather than live session-level data.
 *
 * Populated via two paths:
 * 1. Live: extension host emits `runtime.turnMetadata` at agent_end
 * 2. Hydration: parsed from `custom`/`turn_metadata` JSONL entries
 */
export interface TurnMetadata {
  /** Model used for this turn */
  model?: { provider: string; modelId: string };
  /** Thinking/reasoning level active during this turn */
  thinkingLevel?: string;
  /** Context window usage percentage at turn completion */
  contextPercent?: number;
  /** Tokens consumed by this turn (not cumulative) */
  tokens?: { input: number; output: number; cacheRead: number };
  /** Cost in USD for this turn (not cumulative) */
  costUsd?: number;
  /** Wall-clock duration of this turn in milliseconds */
  durationMs?: number;
}

// ============================================================================
// Turn model
// ============================================================================

export type TurnId = string;

/**
 * A single turn in the conversation.
 * User turns contain one text event.
 * Agent turns contain a flat sequence of events between agent_start/agent_end.
 * UI request turns are interactive dialogs from the runtime awaiting user response.
 */
export type Turn =
  | { kind: "user"; id: TurnId; timestamp: number; text: string; queuedAs?: "steer" | "followUp" }
  | { kind: "agent"; id: TurnId; timestamp: number; events: TurnEvent[]; active: boolean; metadata?: TurnMetadata }
  | { kind: "ui-request"; id: TurnId; timestamp: number; request: UiRequestData; response?: UiResponseData };

/**
 * An event within an agent turn. Rendered sequentially, each by its own component.
 */
export type TurnEvent =
  | ThinkingEvent
  | TextEvent
  | ToolCallEvent
  | ToolResultEvent
  | CompactionEvent
  | RetryEvent
  | ErrorEvent;

export interface ThinkingEvent {
  kind: "thinking";
  content: string;
  streaming: boolean;
}

export interface TextEvent {
  kind: "text";
  content: string;
  streaming: boolean;
}

export interface ToolCallEvent {
  kind: "tool_call";
  toolCallId: string;
  toolName: string;
  args: unknown;
  argsComplete: boolean;
  status: "streaming" | "running" | "completed" | "error" | "cancelled";
  intent?: string;
  result?: unknown;
  isError?: boolean;
  /** Live progress for task/agent tool calls */
  progress?: TaskProgress[];
}

/** Progress entry for a sub-agent within a task tool call */
export interface TaskProgress {
  index: number;
  id: string;
  agent: string;
  status: "pending" | "running" | "completed" | "failed" | "aborted";
  description?: string;
  task?: string;
  currentTool?: string;
  currentToolArgs?: string;
  lastIntent?: string;
  toolCount?: number;
  tokens?: number;
  durationMs?: number;
  recentTools?: { tool: string; args?: string; endMs?: number }[];
  recentOutput?: string[];
}

export interface ToolResultEvent {
  kind: "tool_result";
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError: boolean;
}

export interface CompactionEvent {
  kind: "compaction";
  reason: string;
  active: boolean;
}

export interface RetryEvent {
  kind: "retry";
  active: boolean;
}

export interface ErrorEvent {
  kind: "error";
  message: string;
}

// ============================================================================
// Extension UI request/response types (inline turns)
// ============================================================================

export type UiRequestData =
  | { method: "select"; requestId: string; title: string; options: string[]; timeout?: number }
  | { method: "confirm"; requestId: string; title: string; message: string; timeout?: number }
  | { method: "input"; requestId: string; title: string; placeholder?: string; timeout?: number }
  | { method: "editor"; requestId: string; title: string; prefill?: string };

export type UiResponseData =
  | { kind: "value"; value: string }
  | { kind: "confirmed"; confirmed: boolean }
  | { kind: "cancelled" };

// ============================================================================
// Transcript state (turn-based)
// ============================================================================

export interface TurnTranscriptState {
  turns: Turn[];
  /** Whether we're inside an agent_start/agent_end bracket. */
  agentActive: boolean;
  /** Whether thinking is currently streaming (for boundary synthesis). */
  thinkingActive: boolean;
}

export function createEmptyTurnTranscript(): TurnTranscriptState {
  return {
    turns: [],
    agentActive: false,
    thinkingActive: false,
  };
}

// ============================================================================
// ID generation
// ============================================================================

let turnIdCounter = 0;

export function generateTurnId(): TurnId {
  return `turn_${Date.now()}_${++turnIdCounter}`;
}
