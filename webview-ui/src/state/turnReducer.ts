/**
 * Turn-based message processing for the webview.
 *
 * Processes incoming extension messages and maintains the turn transcript.
 * Replaces the role-based message handling that created orphaned SYSTEM messages.
 */

import type {
  Turn,
  TurnEvent,
  TurnTranscriptState,
  TextEvent,
  ThinkingEvent,
  ToolCallEvent,
} from "./turns";
import { createEmptyTurnTranscript, generateTurnId } from "./turns";

/**
 * Process a raw extension→webview message and update the transcript state.
 * Returns the new state.
 */
export function processTurnMessage(
  state: TurnTranscriptState,
  msg: { type: string; [key: string]: unknown },
): TurnTranscriptState {
  switch (msg.type) {
    // ── Session lifecycle ──────────────────────────────────────────
    case "chat.messagesLoaded":
      return hydrateFromMessages(state, msg.messages as unknown[]);

    case "chat.message":
      return handleChatMessage(state, msg.message as Record<string, unknown>);

    case "chat.delta":
      return handleChatDelta(
        state,
        msg.messageId as string,
        msg.delta as { kind: string; text?: string },
      );

    case "runtime.frame":
      return handleRuntimeFrame(state, msg.frame as Record<string, unknown>);

    case "error": {
      const scope = msg.scope as string;
      const message = msg.message as string;
      if (scope === "runtime" || scope === "launch") {
        return appendEventToCurrentTurn(state, { kind: "error", message });
      }
      return state;
    }

    default:
      return state;
  }
}

// ── Hydration ─────────────────────────────────────────────────────────

function hydrateFromMessages(state: TurnTranscriptState, messages: unknown[]): TurnTranscriptState {
  if (!Array.isArray(messages)) return state;

  const turns: Turn[] = [];

  for (const raw of messages) {
    const msg = raw as Record<string, unknown>;
    const role = msg.role as string;
    const content = extractContent(msg.content);

    if (role === "user") {
      turns.push({
        kind: "user",
        id: generateTurnId(),
        timestamp: (msg.timestamp as number) || Date.now(),
        text: content,
      });
    } else if (role === "assistant" && content) {
      // Create an agent turn with a text event
      const events: TurnEvent[] = [];
      const thinking = extractThinking(msg.content);
      if (thinking) events.push({ kind: "thinking", content: thinking, streaming: false });
      events.push({ kind: "text", content, streaming: false });
      turns.push({
        kind: "agent",
        id: generateTurnId(),
        timestamp: (msg.timestamp as number) || Date.now(),
        events,
        active: false,
      });
    }
    // Skip system/tool-result messages during hydration — they're duplicates
  }

  return { ...state, turns };
}

// ── Chat message (from addUserMessage or message_started/finalized) ────

function handleChatMessage(
  state: TurnTranscriptState,
  msg: Record<string, unknown> | null,
): TurnTranscriptState {
  if (!msg) return state;

  const role = msg.role as string;
  const content = extractContent(msg.content);

  if (role === "user" && content) {
    // Dedupe: check if last turn is a user turn with same content
    const lastTurn = state.turns[state.turns.length - 1];
    if (lastTurn?.kind === "user" && lastTurn.text === content) {
      return state;
    }
    return {
      ...state,
      turns: [
        ...state.turns,
        { kind: "user", id: generateTurnId(), timestamp: Date.now(), text: content },
      ],
    };
  }

  if (role === "assistant") {
    // If no active agent turn, create one
    if (!state.agentActive) {
      return ensureActiveAgentTurn(state);
    }
    // If content is provided (finalized message), update text event
    if (content && !msg.streaming) {
      return updateLastTextEvent(state, content);
    }
  }

  return state;
}

// ── Chat delta (streaming text/thinking) ──────────────────────────────

function handleChatDelta(
  state: TurnTranscriptState,
  _messageId: string,
  delta: { kind: string; text?: string } | null,
): TurnTranscriptState {
  if (!delta || !delta.text) return state;

  state = ensureActiveAgentTurn(state);

  if (delta.kind === "thinking") {
    return appendThinkingDelta(state, delta.text);
  }

  if (delta.kind === "text") {
    return appendTextDelta(state, delta.text);
  }

  return state;
}

// ── Runtime frame (tool calls, agent lifecycle) ───────────────────────

function handleRuntimeFrame(
  state: TurnTranscriptState,
  frame: Record<string, unknown> | null,
): TurnTranscriptState {
  if (!frame) return state;

  const type = frame.type as string;

  switch (type) {
    case "agent_start":
      return { ...ensureActiveAgentTurn(state), agentActive: true };

    case "agent_end":
      return finalizeAgentTurn({ ...state, agentActive: false, thinkingActive: false });

    case "turn_start":
    case "turn_end":
      // Sub-turn boundaries — no action needed for rendering
      return state;

    case "message_start": {
      // Skip user messages (handled by addUserMessage)
      const msgPayload = frame.message as Record<string, unknown> | undefined;
      if (msgPayload?.role === "user") return state;
      return ensureActiveAgentTurn(state);
    }

    case "message_end":
      // Finalize streaming state on current text/thinking events
      return finalizeStreamingEvents(state);

    case "tool_execution_start":
      return appendEventToCurrentTurn(state, {
        kind: "tool_call",
        toolCallId: frame.toolCallId as string,
        toolName: frame.toolName as string,
        args: frame.args,
        argsComplete: true,
        status: "running",
        intent: frame.intent as string | undefined,
      });

    case "tool_execution_update": {
      const toolCallId = frame.toolCallId as string;
      return updateToolCall(state, toolCallId, { status: "running" });
    }

    case "tool_execution_end": {
      const toolCallId = frame.toolCallId as string;
      return updateToolCall(state, toolCallId, {
        status: (frame.isError as boolean) ? "error" : "completed",
        result: frame.result,
        isError: frame.isError as boolean,
      });
    }

    case "auto_compaction_start":
      return appendEventToCurrentTurn(state, {
        kind: "compaction",
        reason: (frame.reason as string) || "context",
        active: true,
      });

    case "auto_compaction_end":
      return updateLastCompaction(state, false);

    case "auto_retry_start":
      return appendEventToCurrentTurn(state, { kind: "retry", active: true });

    case "auto_retry_end":
      return updateLastRetry(state, false);

    default:
      return state;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

function ensureActiveAgentTurn(state: TurnTranscriptState): TurnTranscriptState {
  const lastTurn = state.turns[state.turns.length - 1];
  if (lastTurn?.kind === "agent" && lastTurn.active) {
    return state;
  }
  return {
    ...state,
    agentActive: true,
    turns: [
      ...state.turns,
      { kind: "agent", id: generateTurnId(), timestamp: Date.now(), events: [], active: true },
    ],
  };
}

function finalizeAgentTurn(state: TurnTranscriptState): TurnTranscriptState {
  const turns = [...state.turns];
  const lastIdx = turns.length - 1;
  if (lastIdx >= 0 && turns[lastIdx]!.kind === "agent") {
    turns[lastIdx] = { ...turns[lastIdx]!, active: false } as Turn;
  }
  return { ...state, turns };
}

function finalizeStreamingEvents(state: TurnTranscriptState): TurnTranscriptState {
  const turns = [...state.turns];
  const lastIdx = turns.length - 1;
  const lastTurn = turns[lastIdx];
  if (!lastTurn || lastTurn.kind !== "agent") return state;

  const events = lastTurn.events.map((e) => {
    if ((e.kind === "text" || e.kind === "thinking") && e.streaming) {
      return { ...e, streaming: false };
    }
    return e;
  });
  turns[lastIdx] = { ...lastTurn, events };
  return { ...state, turns, thinkingActive: false };
}

function appendThinkingDelta(state: TurnTranscriptState, delta: string): TurnTranscriptState {
  const turns = [...state.turns];
  const lastIdx = turns.length - 1;
  const lastTurn = turns[lastIdx];
  if (!lastTurn || lastTurn.kind !== "agent") return state;

  const events = [...lastTurn.events];
  const lastEvent = events[events.length - 1];

  if (lastEvent?.kind === "thinking" && lastEvent.streaming) {
    events[events.length - 1] = { ...lastEvent, content: lastEvent.content + delta };
  } else {
    events.push({ kind: "thinking", content: delta, streaming: true });
  }

  turns[lastIdx] = { ...lastTurn, events };
  return { ...state, turns, thinkingActive: true };
}

function appendTextDelta(state: TurnTranscriptState, delta: string): TurnTranscriptState {
  const turns = [...state.turns];
  const lastIdx = turns.length - 1;
  const lastTurn = turns[lastIdx];
  if (!lastTurn || lastTurn.kind !== "agent") return state;

  // If thinking was active, finalize it
  let events = [...lastTurn.events];
  if (state.thinkingActive) {
    events = events.map((e) =>
      e.kind === "thinking" && e.streaming ? { ...e, streaming: false } : e,
    );
  }

  const lastEvent = events[events.length - 1];
  if (lastEvent?.kind === "text" && lastEvent.streaming) {
    events[events.length - 1] = { ...lastEvent, content: lastEvent.content + delta };
  } else {
    events.push({ kind: "text", content: delta, streaming: true });
  }

  turns[lastIdx] = { ...lastTurn, events };
  return { ...state, turns, thinkingActive: false };
}

function updateLastTextEvent(state: TurnTranscriptState, content: string): TurnTranscriptState {
  const turns = [...state.turns];
  const lastIdx = turns.length - 1;
  const lastTurn = turns[lastIdx];
  if (!lastTurn || lastTurn.kind !== "agent") return state;

  const events = [...lastTurn.events];
  const textIdx = events.findIndex((e) => e.kind === "text");
  if (textIdx >= 0) {
    events[textIdx] = { kind: "text", content, streaming: false };
  } else {
    events.push({ kind: "text", content, streaming: false });
  }

  turns[lastIdx] = { ...lastTurn, events };
  return { ...state, turns };
}

function appendEventToCurrentTurn(
  state: TurnTranscriptState,
  event: TurnEvent,
): TurnTranscriptState {
  const s = ensureActiveAgentTurn(state);
  const turns = [...s.turns];
  const lastIdx = turns.length - 1;
  const lastTurn = turns[lastIdx]!;
  if (lastTurn.kind !== "agent") return s;
  turns[lastIdx] = { ...lastTurn, events: [...lastTurn.events, event] };
  return { ...s, turns };
}

function updateToolCall(
  state: TurnTranscriptState,
  toolCallId: string,
  update: Partial<ToolCallEvent>,
): TurnTranscriptState {
  const turns = [...state.turns];
  const lastIdx = turns.length - 1;
  const lastTurn = turns[lastIdx];
  if (!lastTurn || lastTurn.kind !== "agent") return state;

  const events = lastTurn.events.map((e) => {
    if (e.kind === "tool_call" && e.toolCallId === toolCallId) {
      return { ...e, ...update };
    }
    return e;
  });

  turns[lastIdx] = { ...lastTurn, events };
  return { ...state, turns };
}

function updateLastCompaction(state: TurnTranscriptState, active: boolean): TurnTranscriptState {
  const turns = [...state.turns];
  const lastIdx = turns.length - 1;
  const lastTurn = turns[lastIdx];
  if (!lastTurn || lastTurn.kind !== "agent") return state;

  const events = [...lastTurn.events];
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.kind === "compaction") {
      events[i] = { ...events[i]!, active } as TurnEvent;
      break;
    }
  }

  turns[lastIdx] = { ...lastTurn, events };
  return { ...state, turns };
}

function updateLastRetry(state: TurnTranscriptState, active: boolean): TurnTranscriptState {
  const turns = [...state.turns];
  const lastIdx = turns.length - 1;
  const lastTurn = turns[lastIdx];
  if (!lastTurn || lastTurn.kind !== "agent") return state;

  const events = [...lastTurn.events];
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.kind === "retry") {
      events[i] = { ...events[i]!, active } as TurnEvent;
      break;
    }
  }

  turns[lastIdx] = { ...lastTurn, events };
  return { ...state, turns };
}

// ── Content extraction ────────────────────────────────────────────────

function extractContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b?.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("");
  }
  if (content && typeof content === "object") {
    const c = content as Record<string, unknown>;
    if (typeof c.text === "string") return c.text;
  }
  return "";
}

function extractThinking(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b?.type === "thinking" && typeof b.thinking === "string")
    .map((b: any) => b.thinking)
    .join("\n");
}
