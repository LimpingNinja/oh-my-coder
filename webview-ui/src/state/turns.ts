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
// Turn model
// ============================================================================

export type TurnId = string;

/**
 * A single turn in the conversation.
 * User turns contain one text event.
 * Agent turns contain a flat sequence of events between agent_start/agent_end.
 */
export type Turn =
  | { kind: "user"; id: TurnId; timestamp: number; text: string; queuedAs?: "steer" | "followUp" }
  | { kind: "agent"; id: TurnId; timestamp: number; events: TurnEvent[]; active: boolean };

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
