/**
 * Transcript state types.
 *
 * The extension host owns transcript state — the webview renders it.
 * This module defines the host-side model for accumulated messages,
 * streaming deltas, and tool execution blocks within a session.
 *
 * Grounded in Phase 5 of the canonical plan: the host converts OMP
 * runtime frames into structured transcript items and pushes them
 * to the webview via the typed message protocol.
 */

// ============================================================================
// Message model
// ============================================================================

/** Unique message identifier — either runtime-assigned or locally generated. */
export type TranscriptMessageId = string;

/**
 * A single transcript message owned by the host.
 *
 * Messages accumulate content via deltas during streaming. Once
 * `message_end` arrives, the message is finalized and content is
 * the complete text.
 */
export interface TranscriptMessage {
  /** Unique id for this message. */
  id: TranscriptMessageId;
  /** Message role. */
  role: "user" | "assistant" | "system";
  /** Accumulated text content. Empty string during streaming before first delta. */
  content: string;
  /** Accumulated thinking/reasoning content (assistant only). */
  thinking: string;
  /** Whether this message is still receiving deltas. */
  streaming: boolean;
  /** Whether this message has been finalized by message_end. */
  finalized: boolean;
  /** Timestamp when the message was started (ms since epoch). */
  startedAt: number;
  /** Timestamp when the message was finalized (ms since epoch). */
  finalizedAt?: number;
  /** Tool calls within this assistant message. */
  toolCalls: TranscriptToolCall[];
  /** Provider stop reason for finalized assistant messages. */
  stopReason?: string;
  /** Provider/runtime error message when stopReason is error. */
  errorMessage?: string;
  /** Raw finalized runtime message for diagnostics/details. */
  raw?: unknown;
}

/**
 * A tool execution block within an assistant message.
 */
export interface TranscriptToolCall {
  /** Tool call id from the runtime. */
  toolCallId: string;
  /** Tool name. */
  toolName: string;
  /** Tool arguments (opaque to the host). */
  args: unknown;
  /** Execution intent description from runtime, if provided. */
  intent?: string;
  /** Current execution status. */
  status: "running" | "completed" | "error";
  /** True when tool_execution_end arrived with async.state === "running" — tool is still running in the background. */
  background?: boolean;
  /** Partial result during execution. */
  partialResult?: unknown;
  /** Final result after completion. */
  result?: unknown;
  /** Whether the tool execution ended in error. */
  isError?: boolean;
}

// ============================================================================
// Transcript state
// ============================================================================

/**
 * Full transcript state for the active session.
 *
 * The host accumulates this incrementally from runtime frames.
 * On resume, it's populated from `get_messages` then updated via
 * live frames. The state is the single source of truth for what
 * the webview should render.
 */
export interface TranscriptState {
  /** Session path this transcript belongs to. */
  sessionPath: string;
  /** Ordered messages in the transcript. */
  messages: TranscriptMessage[];
  /** Id of the currently streaming message, if any. */
  activeMessageId: TranscriptMessageId | null;
  /** Whether the agent is currently active (between agent_start/agent_end). */
  agentActive: boolean;
  /** Whether we're in a compaction phase. */
  compacting: boolean;
  /** Compaction reason if active. */
  compactionReason?: string;
  /** Whether we're in an auto-retry phase. */
  retrying: boolean;
}

/**
 * Create an empty transcript state for a new session.
 */
export function createEmptyTranscript(sessionPath: string): TranscriptState {
  return {
    sessionPath,
    messages: [],
    activeMessageId: null,
    agentActive: false,
    compacting: false,
    retrying: false,
  };
}

// ============================================================================
// ID generation
// ============================================================================

let messageIdCounter = 0;

/**
 * Generate a unique local message id.
 *
 * Used when the runtime doesn't provide one (e.g., user messages
 * created locally before the runtime acknowledges them).
 */
export function generateMessageId(): TranscriptMessageId {
  return `msg_${Date.now()}_${++messageIdCounter}`;
}
