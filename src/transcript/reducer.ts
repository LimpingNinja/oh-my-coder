/**
 * Transcript state reducer.
 *
 * Pure function: takes the current TranscriptState and an OMP RPC frame,
 * returns the next state. No side effects — the manager is responsible
 * for emitting webview messages based on state transitions.
 *
 * Implements the `applyOmpFrame` pattern from the canonical plan (Phase 5).
 */

import type { OmpRpcFrame } from "../protocol/ompRpcTypes.ts";
import type { TranscriptState, TranscriptMessage, TranscriptToolCall } from "./types.ts";
import { generateMessageId } from "./types.ts";

// ============================================================================
// Frame application result
// ============================================================================

/**
 * Result of applying a frame to the transcript state.
 *
 * The `effect` field describes what changed so the manager can decide
 * what webview messages to emit without diffing the full state.
 */
export interface ReducerResult {
  state: TranscriptState;
  effect: TranscriptEffect;
}

/**
 * Describes what changed in the transcript as a result of applying a frame.
 */
export type TranscriptEffect =
  | { kind: "none" }
  | { kind: "message_started"; message: TranscriptMessage }
  | { kind: "text_delta"; messageId: string; delta: string }
  | { kind: "thinking_delta"; messageId: string; delta: string }
  | { kind: "tool_call_delta"; messageId: string; toolCallId: string }
  | { kind: "message_finalized"; message: TranscriptMessage }
  | { kind: "tool_started"; messageId: string; toolCall: TranscriptToolCall }
  | { kind: "tool_updated"; messageId: string; toolCall: TranscriptToolCall }
  | { kind: "tool_ended"; messageId: string; toolCall: TranscriptToolCall }
  | { kind: "agent_started" }
  | { kind: "agent_ended" }
  | { kind: "compaction_started"; reason: string }
  | { kind: "compaction_ended" }
  | { kind: "retry_started" }
  | { kind: "retry_ended" };

// ============================================================================
// Reducer
// ============================================================================

/**
 * Apply a single OMP RPC frame to the transcript state.
 *
 * Returns the new state and a description of the effect for the manager
 * to translate into webview messages.
 */
export function applyFrame(state: TranscriptState, frame: OmpRpcFrame): ReducerResult {
  const frameType = (frame as Record<string, unknown>).type as string;

  switch (frameType) {
    case "message_start":
      return handleMessageStart(state, frame as Record<string, unknown>);
    case "message_update":
      return handleMessageUpdate(state, frame as Record<string, unknown>);
    case "message_end":
      return handleMessageEnd(state, frame as Record<string, unknown>);
    case "agent_start":
      return handleAgentStart(state);
    case "agent_end":
      return handleAgentEnd(state);
    case "tool_execution_start":
      return handleToolStart(state, frame as Record<string, unknown>);
    case "tool_execution_update":
      return handleToolUpdate(state, frame as Record<string, unknown>);
    case "tool_execution_end":
      return handleToolEnd(state, frame as Record<string, unknown>);
    case "auto_compaction_start":
      return handleCompactionStart(state, frame as Record<string, unknown>);
    case "auto_compaction_end":
      return handleCompactionEnd(state);
    case "auto_retry_start":
      return handleRetryStart(state);
    case "auto_retry_end":
      return handleRetryEnd(state);
    default:
      return { state, effect: { kind: "none" } };
  }
}

// ============================================================================
// Handlers
// ============================================================================

function handleMessageStart(state: TranscriptState, frame: Record<string, unknown>): ReducerResult {
  const messagePayload = frame.message as Record<string, unknown> | undefined;

  // Determine role from the message payload.
  const role = (messagePayload?.role as "user" | "assistant" | "system") ?? "assistant";

  // Skip user messages from the frame stream — user messages are added
  // explicitly via TranscriptManager.addUserMessage() when prompts are accepted.
  // The runtime re-emits user messages as events, which would cause duplicates.
  if (role === "user") {
    return { state, effect: { kind: "none" } };
  }

  // Extract an id from the runtime message payload if available,
  // otherwise generate one locally.
  const id =
    (messagePayload?.id as string) ?? (messagePayload?.messageId as string) ?? generateMessageId();

  const newMessage: TranscriptMessage = {
    id,
    role,
    content: "",
    thinking: "",
    streaming: true,
    finalized: false,
    startedAt: Date.now(),
    toolCalls: [],
  };

  const newState: TranscriptState = {
    ...state,
    messages: [...state.messages, newMessage],
    activeMessageId: id,
  };

  return { state: newState, effect: { kind: "message_started", message: newMessage } };
}

function handleMessageUpdate(
  state: TranscriptState,
  frame: Record<string, unknown>,
): ReducerResult {
  if (!state.activeMessageId) {
    return { state, effect: { kind: "none" } };
  }

  // OMP may use "assistantMessageEvent" or "event" for the delta payload
  const event = (frame.assistantMessageEvent ?? frame.event) as Record<string, unknown> | undefined;
  if (!event) {
    return { state, effect: { kind: "none" } };
  }

  const eventType = event.type as string;
  const delta = event.delta as string | undefined;

  if (eventType === "text_delta" && typeof delta === "string") {
    const newState = updateActiveMessage(state, (msg) => ({
      ...msg,
      content: msg.content + delta,
    }));
    return {
      state: newState,
      effect: { kind: "text_delta", messageId: state.activeMessageId, delta },
    };
  }

  if (eventType === "thinking_delta" && typeof delta === "string") {
    const newState = updateActiveMessage(state, (msg) => ({
      ...msg,
      thinking: msg.thinking + delta,
    }));
    return {
      state: newState,
      effect: { kind: "thinking_delta", messageId: state.activeMessageId, delta },
    };
  }

  if (eventType === "tool_call_delta") {
    return {
      state,
      effect: { kind: "tool_call_delta", messageId: state.activeMessageId, toolCallId: "" },
    };
  }

  // Fallback: if the event has a "text" field directly (some OMP versions)
  if (typeof event.text === "string") {
    const text = event.text;
    const newState = updateActiveMessage(state, (msg) => ({
      ...msg,
      content: msg.content + text,
    }));
    return {
      state: newState,
      effect: { kind: "text_delta", messageId: state.activeMessageId, delta: text },
    };
  }

  return { state, effect: { kind: "none" } };
}

function handleMessageEnd(state: TranscriptState, frame: Record<string, unknown>): ReducerResult {
  if (!state.activeMessageId) {
    return { state, effect: { kind: "none" } };
  }

  // If the message still has no content, try to extract from the frame's message payload.
  // OMP's message_end often carries the final complete message object.
  const messagePayload = frame.message as Record<string, unknown> | undefined;
  let contentFallback: string | undefined;
  if (messagePayload) {
    const rawContent = messagePayload.content;
    if (typeof rawContent === "string" && rawContent) {
      contentFallback = rawContent;
    } else if (Array.isArray(rawContent)) {
      // Content block array
      const parts: string[] = [];
      for (const block of rawContent) {
        if (typeof block === "string") parts.push(block);
        else if (block && typeof block === "object") {
          const b = block as Record<string, unknown>;
          if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
        }
      }
      if (parts.length > 0) contentFallback = parts.join("");
    }
  }

  const newState = updateActiveMessage(state, (msg) => ({
    ...msg,
    // Use fallback content only if the reducer didn't accumulate anything during streaming
    content: msg.content || contentFallback || "",
    streaming: false,
    finalized: true,
    finalizedAt: Date.now(),
  }));

  const finalized = newState.messages.find((m) => m.id === state.activeMessageId);

  return {
    state: { ...newState, activeMessageId: null },
    effect: finalized ? { kind: "message_finalized", message: finalized } : { kind: "none" },
  };
}

function handleAgentStart(state: TranscriptState): ReducerResult {
  return {
    state: { ...state, agentActive: true },
    effect: { kind: "agent_started" },
  };
}

function handleAgentEnd(state: TranscriptState): ReducerResult {
  return {
    state: { ...state, agentActive: false, activeMessageId: null },
    effect: { kind: "agent_ended" },
  };
}

function handleToolStart(state: TranscriptState, frame: Record<string, unknown>): ReducerResult {
  const toolCallId = frame.toolCallId as string;
  const toolName = frame.toolName as string;
  const args = frame.args;
  const intent = frame.intent as string | undefined;

  const toolCall: TranscriptToolCall = {
    toolCallId,
    toolName,
    args,
    intent,
    status: "running",
  };

  // Attach tool call to the active message if one exists.
  if (state.activeMessageId) {
    const newState = updateActiveMessage(state, (msg) => ({
      ...msg,
      toolCalls: [...msg.toolCalls, toolCall],
    }));
    return {
      state: newState,
      effect: { kind: "tool_started", messageId: state.activeMessageId, toolCall },
    };
  }

  // No active message — tool started outside message lifecycle.
  // This shouldn't normally happen, but handle gracefully.
  return { state, effect: { kind: "tool_started", messageId: "", toolCall } };
}

function handleToolUpdate(state: TranscriptState, frame: Record<string, unknown>): ReducerResult {
  const toolCallId = frame.toolCallId as string;
  const partialResult = frame.partialResult;

  if (!state.activeMessageId) {
    return { state, effect: { kind: "none" } };
  }

  let updatedToolCall: TranscriptToolCall | undefined;

  const newState = updateActiveMessage(state, (msg) => ({
    ...msg,
    toolCalls: msg.toolCalls.map((tc) => {
      if (tc.toolCallId === toolCallId) {
        updatedToolCall = { ...tc, partialResult };
        return updatedToolCall;
      }
      return tc;
    }),
  }));

  return updatedToolCall
    ? {
        state: newState,
        effect: {
          kind: "tool_updated",
          messageId: state.activeMessageId,
          toolCall: updatedToolCall,
        },
      }
    : { state, effect: { kind: "none" } };
}

function handleToolEnd(state: TranscriptState, frame: Record<string, unknown>): ReducerResult {
  const toolCallId = frame.toolCallId as string;
  const result = frame.result;
  const isError = frame.isError as boolean | undefined;

  if (!state.activeMessageId) {
    return { state, effect: { kind: "none" } };
  }

  let endedToolCall: TranscriptToolCall | undefined;

  const newState = updateActiveMessage(state, (msg) => ({
    ...msg,
    toolCalls: msg.toolCalls.map((tc) => {
      if (tc.toolCallId === toolCallId) {
        endedToolCall = {
          ...tc,
          status: isError ? "error" : "completed",
          result,
          isError,
        };
        return endedToolCall;
      }
      return tc;
    }),
  }));

  return endedToolCall
    ? {
        state: newState,
        effect: { kind: "tool_ended", messageId: state.activeMessageId, toolCall: endedToolCall },
      }
    : { state, effect: { kind: "none" } };
}

function handleCompactionStart(
  state: TranscriptState,
  frame: Record<string, unknown>,
): ReducerResult {
  const reason = (frame.reason as string) ?? "unknown";
  return {
    state: { ...state, compacting: true, compactionReason: reason },
    effect: { kind: "compaction_started", reason },
  };
}

function handleCompactionEnd(state: TranscriptState): ReducerResult {
  return {
    state: { ...state, compacting: false, compactionReason: undefined },
    effect: { kind: "compaction_ended" },
  };
}

function handleRetryStart(state: TranscriptState): ReducerResult {
  return {
    state: { ...state, retrying: true },
    effect: { kind: "retry_started" },
  };
}

function handleRetryEnd(state: TranscriptState): ReducerResult {
  return {
    state: { ...state, retrying: false },
    effect: { kind: "retry_ended" },
  };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Immutably update the active message in the transcript.
 */
function updateActiveMessage(
  state: TranscriptState,
  updater: (msg: TranscriptMessage) => TranscriptMessage,
): TranscriptState {
  if (!state.activeMessageId) return state;

  return {
    ...state,
    messages: state.messages.map((msg) => (msg.id === state.activeMessageId ? updater(msg) : msg)),
  };
}
