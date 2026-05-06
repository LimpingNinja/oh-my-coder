/**
 * Canonical OMP RPC type definitions.
 *
 * Grounded in the OMP RPC protocol (`omp --mode rpc` stdio JSONL transport)
 * and the canonical rpc-types.ts source. This module encodes the runtime
 * truth the extension host must understand: command shapes, response
 * discriminated unions, event stream types, and the extension UI sub-protocol.
 *
 * These types represent what travels over the wire. Controller-level types
 * (pending requests, process state) belong in `src/rpc/types.ts`.
 */

// ============================================================================
// Shared value types
// ============================================================================

/** OMP thinking/reasoning effort levels. */
export type OmpThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** Streaming behavior required when sending prompt during active streaming. */
export type OmpStreamingBehavior = "steer" | "followUp";

/** Queue modes for steering and follow-up message delivery. */
export type OmpQueueMode = "all" | "one-at-a-time";

/** Interrupt mode: when to check for steering during tool execution. */
export type OmpInterruptMode = "immediate" | "wait";

/** Model reference returned by get_state and model responses. */
export interface OmpModelRef {
  provider: string;
  id: string;
}

/** Image content block for multimodal prompts. */
export interface OmpImageContent {
  type: "image";
  data: string;
  media_type: string;
}

/** Back-compat alias used by the controller contract in `src/rpc/types.ts`. */
export type ImageContent = OmpImageContent;

/** Todo phase structure from get_state / set_todos. */
export interface OmpTodoPhase {
  id: string;
  name: string;
  tasks: Array<{
    id: string;
    content: string;
    status: string;
  }>;
}

/** Tool schema definition for set_host_tools / get_state dumpTools. */
export interface OmpToolSchema {
  name: string;
  description: string;
  parameters: unknown;
}

/** Context usage metrics from get_state. */
export interface OmpContextUsage {
  tokens?: number;
  percent?: number;
}

// ============================================================================
// Session state payload (get_state response data)
// ============================================================================

/** Full session state returned by the `get_state` command. */
export interface OmpSessionState {
  model?: OmpModelRef;
  thinkingLevel?: OmpThinkingLevel;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: OmpQueueMode;
  followUpMode: OmpQueueMode;
  interruptMode: OmpInterruptMode;
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  autoCompactionEnabled: boolean;
  messageCount: number;
  queuedMessageCount: number;
  todoPhases: OmpTodoPhase[];
  systemPrompt?: string;
  dumpTools?: OmpToolSchema[];
  contextUsage?: OmpContextUsage;
}

/**
 * Phase 1 parser/types contract alias for controller `getState()` responses.
 *
 * This remains a direct alias to `OmpSessionState` until later phases prove
 * a narrower UI-facing projection.
 */
export type OmpStatePayload = OmpSessionState;

/**
 * Runtime state exposed by the controller surface.
 *
 * In this parser/types slice, this is intentionally a lightweight contract type
 * only; lifecycle behavior is implemented in later phases.
 */
export type OmpRuntimeState =
  | { kind: "disconnected" }
  | { kind: "starting"; runId: string }
  | {
      kind: "ready";
      sessionPath: string;
      sessionId?: string;
      model?: OmpModelRef;
      thinking?: OmpThinkingLevel;
      queuedMessageCount: number;
    }
  | {
      kind: "streaming";
      sessionPath: string;
      sessionId?: string;
      model?: OmpModelRef;
      thinking?: OmpThinkingLevel;
      queuedMessageCount: number;
    }
  | { kind: "waitingForTool"; sessionPath: string; toolName: string }
  | { kind: "compacting"; sessionPath: string; usedPercent?: number }
  | { kind: "error"; sessionPath?: string; message: string; recoverable: boolean };

/**
 * Chat message payload returned by `get_messages`.
 *
 * Kept structurally loose for Phase 1 because parser/types work does not yet
 * implement transcript mapping.
 */
export type ChatMessage = Record<string, unknown>;

/**
 * Session stats payload returned by `get_session_stats`.
 *
 * Kept intentionally partial until the footer/usage slice validates exact runtime
 * field coverage.
 */
export type SessionStatsPayload = Record<string, unknown>;

// ============================================================================
// RPC Commands (stdin → omp)
// ============================================================================

/**
 * Union of all OMP RPC commands sent over stdin.
 *
 * Every command accepts optional `id` for response correlation.
 * Unknown-command and parse-error responses may return `id: undefined`.
 */
export type OmpRpcCommand =
  // Prompting
  | {
      id?: string;
      type: "prompt";
      message: string;
      images?: OmpImageContent[];
      streamingBehavior?: OmpStreamingBehavior;
    }
  | { id?: string; type: "steer"; message: string; images?: OmpImageContent[] }
  | { id?: string; type: "follow_up"; message: string; images?: OmpImageContent[] }
  | { id?: string; type: "abort" }
  | { id?: string; type: "abort_and_prompt"; message: string; images?: OmpImageContent[] }
  | { id?: string; type: "new_session"; parentSession?: string }

  // State
  | { id?: string; type: "get_state" }
  | { id?: string; type: "set_todos"; phases: OmpTodoPhase[] }
  | { id?: string; type: "set_host_tools"; tools: OmpHostToolDefinition[] }

  // Model
  | { id?: string; type: "set_model"; provider: string; modelId: string }
  | { id?: string; type: "cycle_model" }
  | { id?: string; type: "get_available_models" }

  // Thinking
  | { id?: string; type: "set_thinking_level"; level: OmpThinkingLevel }
  | { id?: string; type: "cycle_thinking_level" }

  // Queue modes
  | { id?: string; type: "set_steering_mode"; mode: OmpQueueMode }
  | { id?: string; type: "set_follow_up_mode"; mode: OmpQueueMode }
  | { id?: string; type: "set_interrupt_mode"; mode: OmpInterruptMode }

  // Compaction
  | { id?: string; type: "compact"; customInstructions?: string }
  | { id?: string; type: "set_auto_compaction"; enabled: boolean }

  // Retry
  | { id?: string; type: "set_auto_retry"; enabled: boolean }
  | { id?: string; type: "abort_retry" }

  // Bash
  | { id?: string; type: "bash"; command: string }
  | { id?: string; type: "abort_bash" }

  // Session
  | { id?: string; type: "get_session_stats" }
  | { id?: string; type: "export_html"; outputPath?: string }
  | { id?: string; type: "switch_session"; sessionPath: string }
  | { id?: string; type: "branch"; entryId: string }
  | { id?: string; type: "get_branch_messages" }
  | { id?: string; type: "get_last_assistant_text" }
  | { id?: string; type: "set_session_name"; name: string }
  | { id?: string; type: "handoff"; customInstructions?: string }

  // Messages
  | { id?: string; type: "get_messages" };

/** String literal union of all command type discriminators. */
export type OmpRpcCommandType = OmpRpcCommand["type"];

// ============================================================================
// Host tool definitions (stdin → omp)
// ============================================================================

/** Tool definition for set_host_tools. */
export interface OmpHostToolDefinition {
  name: string;
  label?: string;
  description: string;
  parameters: Record<string, unknown>;
  hidden?: boolean;
}

// ============================================================================
// RPC Responses (omp → stdout)
// ============================================================================

/**
 * Union of all OMP RPC response frames.
 *
 * Responses carry the command name and `id` for correlation.
 * The `id` field may be `undefined` for parse errors and unknown-command
 * responses even when the original request had an `id`.
 *
 * Only the most commonly used success data shapes are typed here.
 * Command-specific data payloads that the extension does not yet consume
 * are typed as `unknown` to avoid lying about unobserved shapes.
 */
export type OmpRpcResponse =
  // Prompting — immediate ack, completion observed via events
  | { id?: string; type: "response"; command: "prompt"; success: true }
  | { id?: string; type: "response"; command: "steer"; success: true }
  | { id?: string; type: "response"; command: "follow_up"; success: true }
  | { id?: string; type: "response"; command: "abort"; success: true }
  | { id?: string; type: "response"; command: "abort_and_prompt"; success: true }
  | {
      id?: string;
      type: "response";
      command: "new_session";
      success: true;
      data: { cancelled: boolean };
    }

  // State
  | { id?: string; type: "response"; command: "get_state"; success: true; data: OmpSessionState }
  | {
      id?: string;
      type: "response";
      command: "set_todos";
      success: true;
      data: { todoPhases: OmpTodoPhase[] };
    }
  | {
      id?: string;
      type: "response";
      command: "set_host_tools";
      success: true;
      data: { toolNames: string[] };
    }

  // Model
  | { id?: string; type: "response"; command: "set_model"; success: true; data: OmpModelRef }
  | { id?: string; type: "response"; command: "cycle_model"; success: true; data: unknown }
  | {
      id?: string;
      type: "response";
      command: "get_available_models";
      success: true;
      data: { models: OmpModelRef[] };
    }

  // Thinking
  | { id?: string; type: "response"; command: "set_thinking_level"; success: true }
  | { id?: string; type: "response"; command: "cycle_thinking_level"; success: true; data: unknown }

  // Queue modes
  | { id?: string; type: "response"; command: "set_steering_mode"; success: true }
  | { id?: string; type: "response"; command: "set_follow_up_mode"; success: true }
  | { id?: string; type: "response"; command: "set_interrupt_mode"; success: true }

  // Compaction
  | { id?: string; type: "response"; command: "compact"; success: true; data: unknown }
  | { id?: string; type: "response"; command: "set_auto_compaction"; success: true }

  // Retry
  | { id?: string; type: "response"; command: "set_auto_retry"; success: true }
  | { id?: string; type: "response"; command: "abort_retry"; success: true }

  // Bash
  | { id?: string; type: "response"; command: "bash"; success: true; data: unknown }
  | { id?: string; type: "response"; command: "abort_bash"; success: true }

  // Session
  | { id?: string; type: "response"; command: "get_session_stats"; success: true; data: unknown }
  | { id?: string; type: "response"; command: "export_html"; success: true; data: { path: string } }
  | {
      id?: string;
      type: "response";
      command: "switch_session";
      success: true;
      data: { cancelled: boolean };
    }
  | { id?: string; type: "response"; command: "branch"; success: true; data: unknown }
  | { id?: string; type: "response"; command: "get_branch_messages"; success: true; data: unknown }
  | {
      id?: string;
      type: "response";
      command: "get_last_assistant_text";
      success: true;
      data: { text: string | null };
    }
  | { id?: string; type: "response"; command: "set_session_name"; success: true }
  | { id?: string; type: "response"; command: "handoff"; success: true; data: unknown }

  // Messages
  | {
      id?: string;
      type: "response";
      command: "get_messages";
      success: true;
      data: { messages: unknown[] };
    }

  // Error — any command can fail
  | { id?: string; type: "response"; command: string; success: false; error: string };

// ============================================================================
// Ready frame
// ============================================================================

/** Startup frame emitted once before command processing begins. */
export interface OmpReadyFrame {
  type: "ready";
}

// ============================================================================
// Agent session events (omp → stdout)
// ============================================================================

/**
 * Events forwarded from AgentSession.subscribe() over stdout.
 *
 * These are the real-time event stream that drives UI updates.
 * `message_update` includes streaming deltas in `assistantMessageEvent`.
 */
export type OmpAgentEvent =
  // Agent lifecycle
  | { type: "agent_start" }
  | { type: "agent_end"; messages: unknown[] }

  // Turn lifecycle
  | { type: "turn_start" }
  | { type: "turn_end"; message: unknown; toolResults: unknown[] }

  // Message lifecycle
  | { type: "message_start"; message: unknown }
  | { type: "message_update"; message: unknown; assistantMessageEvent: OmpAssistantMessageEvent }
  | { type: "message_end"; message: unknown }

  // Tool execution lifecycle
  | {
      type: "tool_execution_start";
      toolCallId: string;
      toolName: string;
      args: unknown;
      intent?: string;
    }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args: unknown;
      partialResult: unknown;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError?: boolean;
    }

  // Auto compaction
  | {
      type: "auto_compaction_start";
      reason: "threshold" | "overflow" | "idle";
      action: "context-full" | "handoff";
    }
  | { type: "auto_compaction_end" }

  // Auto retry
  | { type: "auto_retry_start" }
  | { type: "auto_retry_end" }

  // Miscellaneous
  | { type: "ttsr_triggered" }
  | { type: "todo_reminder" }
  | { type: "todo_auto_clear" };

/** Streaming delta within a `message_update` event. */
export type OmpAssistantMessageEvent =
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_call_delta" };

// ============================================================================
// Extension UI sub-protocol (omp ↔ extension)
// ============================================================================

/** Extension UI request emitted by the runtime for user interaction. */
export type OmpExtensionUiRequest =
  | {
      type: "extension_ui_request";
      id: string;
      method: "select";
      title: string;
      options: string[];
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "confirm";
      title: string;
      message: string;
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "input";
      title: string;
      placeholder?: string;
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "editor";
      title: string;
      prefill?: string;
      promptStyle?: boolean;
    }
  | { type: "extension_ui_request"; id: string; method: "cancel"; targetId: string }
  | {
      type: "extension_ui_request";
      id: string;
      method: "notify";
      message: string;
      notifyType?: "info" | "warning" | "error";
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setStatus";
      statusKey: string;
      statusText: string | undefined;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setWidget";
      widgetKey: string;
      widgetLines: string[] | undefined;
      widgetPlacement?: "aboveEditor" | "belowEditor";
    }
  | { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
  | { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

/** Extension UI response sent back over stdin. */
export type OmpExtensionUiResponse =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true; timedOut?: boolean };

// ============================================================================
// Host tool sub-protocol (omp ↔ extension)
// ============================================================================

/** Runtime requests the host to execute a registered tool. */
export interface OmpHostToolCallRequest {
  type: "host_tool_call";
  id: string;
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

/** Runtime requests cancellation of a pending host tool call. */
export interface OmpHostToolCancelRequest {
  type: "host_tool_cancel";
  id: string;
  targetId: string;
}

/** Host streams partial tool result back to the runtime. */
export interface OmpHostToolUpdate {
  type: "host_tool_update";
  id: string;
  partialResult: unknown;
}

/** Host completes a pending tool call. */
export interface OmpHostToolResult {
  type: "host_tool_result";
  id: string;
  result: unknown;
  isError?: boolean;
}

// ============================================================================
// Extension error frame
// ============================================================================

/** Extension runner error emitted on stdout. */
export interface OmpExtensionErrorFrame {
  type: "extension_error";
  extensionPath: string;
  event: string;
  error: string;
}

// ============================================================================
// Top-level outbound frame union
// ============================================================================

/**
 * Any frame that can appear on the OMP RPC stdout stream.
 *
 * The parser produces these. Consumers discriminate by `type`.
 */
export type OmpRpcOutboundFrame =
  | OmpReadyFrame
  | OmpRpcResponse
  | OmpAgentEvent
  | OmpExtensionUiRequest
  | OmpHostToolCallRequest
  | OmpHostToolCancelRequest
  | OmpExtensionErrorFrame;

/** Canonical controller-facing alias for any outbound stdout frame. */
export type OmpRpcFrame = OmpRpcOutboundFrame;

// ============================================================================
// Top-level inbound frame union
// ============================================================================

/**
 * Any frame that can be sent over stdin to the OMP RPC process.
 */
export type OmpRpcInboundFrame =
  | OmpRpcCommand
  | OmpExtensionUiResponse
  | OmpHostToolUpdate
  | OmpHostToolResult;
