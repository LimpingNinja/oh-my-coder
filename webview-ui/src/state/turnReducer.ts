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
  TurnMetadata,
  TextEvent,
  ThinkingEvent,
  ToolCallEvent,
} from "./turns";
import { createEmptyTurnTranscript, generateTurnId } from "./turns";
import { seedComposerHistory } from "../components/Composer";

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
      return hydrateFromMessages(state, msg.messages as unknown[], msg.turnMetadataEntries as TurnMetadata[] | undefined);

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

    case "runtime.turnMetadata":
      return attachTurnMetadata(state, msg.metadata as TurnMetadata);

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

function hydrateFromMessages(state: TurnTranscriptState, messages: unknown[], turnMetadataEntries?: TurnMetadata[]): TurnTranscriptState {
  if (!Array.isArray(messages)) return state;

  const turns: Turn[] = [];

  // Build a metadata lookup by assistant message id for correlation.
  // JSONL-first hydration preserves the true wrapper ids, which exactly match
  // turn_metadata.parentId.
  const metadataByMessageId = new Map<string, TurnMetadata>();
  if (turnMetadataEntries) {
    for (const entry of turnMetadataEntries as Array<TurnMetadata & { parentMessageId?: string }>) {
      if (entry.parentMessageId) {
        metadataByMessageId.set(entry.parentMessageId, entry);
      }
    }
  }

  // Build a map of tool results by toolCallId for matching
  const toolResults = new Map<string, { toolName: string; content: unknown; details: unknown; isError: boolean }>();
  for (const raw of messages) {
    const msg = raw as Record<string, unknown>;
    if (msg.role === "toolResult" && typeof msg.toolCallId === "string") {
      toolResults.set(msg.toolCallId, {
        toolName: (msg.toolName as string) || "",
        content: msg.content,
        details: msg.details,
        isError: (msg.isError as boolean) || false,
      });
    }
  }

  for (const raw of messages) {
    const msg = raw as Record<string, unknown>;
    const role = msg.role as string;

    if (role === "user") {
      const content = extractContent(msg.content);
      if (content) {
        const images = (msg.images as Array<{ mimeType: string; data: string | null }> | undefined) ?? extractImages(msg.content);
        const fileContexts = msg.fileContexts as Array<{ path: string; line?: number; endLine?: number; languageId?: string }> | undefined;
        turns.push({
          kind: "user",
          id: generateTurnId(),
          timestamp: (msg.timestamp as number) || Date.now(),
          text: content,
          images: images.length > 0 ? images : undefined,
          fileContexts: fileContexts?.length ? fileContexts : undefined,
        });
      }
    } else if (role === "assistant" || role === "system") {
      const events: TurnEvent[] = [];

      // Parse content blocks to find text, thinking, and tool calls
      if (Array.isArray(msg.content)) {
        for (const block of msg.content as Array<Record<string, unknown>>) {
          if (block.type === "thinking" && typeof block.thinking === "string") {
            events.push({ kind: "thinking", content: block.thinking, streaming: false });
          } else if (block.type === "text" && typeof block.text === "string") {
            events.push({ kind: "text", content: block.text, streaming: false });
          } else if (block.type === "toolCall" || block.type === "tool_use") {
            const toolCallId = (block.id || block.toolCallId) as string || "";
            const toolName = (block.name || block.toolName) as string || "";
            const args = block.arguments || block.args || block.input;

            // Look up the result
            const resultEntry = toolResults.get(toolCallId);

            events.push({
              kind: "tool_call",
              toolCallId,
              toolName,
              args,
              argsComplete: true,
              status: resultEntry ? (resultEntry.isError ? "error" : "completed") : "completed",
              result: resultEntry ? { content: resultEntry.content, details: resultEntry.details } : undefined,
              isError: resultEntry?.isError,
            });
          }
        }
      } else {
        // Simple string content
        const content = extractContent(msg.content);
        const thinking = extractThinking(msg.content);
        if (thinking) events.push({ kind: "thinking", content: thinking, streaming: false });
        if (content) events.push({ kind: "text", content, streaming: false });
      }

      const stop = getStopEvent(msg);
      if (stop) events.push(stop);

      if (events.length > 0) {
        const messageId = (msg.id as string) || (msg.messageId as string) || "";
        const metadata = messageId ? metadataByMessageId.get(messageId) : undefined;
        turns.push({
          kind: "agent",
          id: generateTurnId(),
          timestamp: (msg.timestamp as number) || Date.now(),
          events,
          active: false,
          metadata,
        });
      }
    }
    // Skip toolResult messages — they're consumed above via the toolResults map
  }

  // Seed composer history from hydrated user messages
  const userTexts = turns
    .filter((t): t is Turn & { kind: "user" } => t.kind === "user")
    .map((t) => (t as { text: string }).text);
  seedComposerHistory(userTexts);

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
    // Extract images from content blocks or top-level field
    const images = (msg.images as Array<{ mimeType: string; data: string | null }> | undefined) ?? extractImages(msg.content);
    const fileContexts = msg.fileContexts as Array<{ path: string; line?: number; endLine?: number; languageId?: string }> | undefined;
    return {
      ...state,
      turns: [
        ...state.turns,
        { kind: "user", id: generateTurnId(), timestamp: Date.now(), text: content, images: images.length > 0 ? images : undefined, fileContexts },
      ],
    };
  }

  if (role === "system" && content) {
    return {
      ...state,
      turns: [
        ...state.turns,
        {
          kind: "agent",
          id: generateTurnId(),
          timestamp: Date.now(),
          events: [{ kind: "text", content, streaming: false }],
          active: false,
        },
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

    const stop = getStopEvent(msg);
    if (stop) {
      return appendEventToCurrentTurn(state, stop);
    }
  }

  return state;
}

function getStopEvent(msg: Record<string, unknown>): TurnEvent | null {
  const stopReason = typeof msg.stopReason === "string" ? msg.stopReason : undefined;
  if (stopReason !== "error" && stopReason !== "length" && stopReason !== "aborted") return null;
  const fallback = getStopFallback(stopReason);
  const message = typeof msg.errorMessage === "string" && msg.errorMessage.trim()
    ? msg.errorMessage.trim()
    : fallback.message;
  return {
    kind: "error",
    title: fallback.title,
    message,
    stopReason,
    tone: fallback.tone,
    raw: msg.raw ?? msg,
  };
}

function getStopFallback(stopReason: string): { title: string; message: string; tone: "error" | "warning" | "cancelled" } {
  if (stopReason === "length") {
    return {
      title: "Assistant response reached limit",
      message: "The assistant stopped because the response reached a length or token limit.",
      tone: "warning",
    };
  }
  if (stopReason === "aborted") {
    return {
      title: "Assistant response aborted",
      message: "The assistant response was cancelled before completion.",
      tone: "cancelled",
    };
  }
  return {
    title: "Assistant response error",
    message: "Assistant response stopped with an error.",
    tone: "error",
  };
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
    case "agent_start": {
      // Clear queuedAs on all user turns — the agent is consuming queued messages
      let s = state;
      const hasQueued = s.turns.some((t) => t.kind === "user" && t.queuedAs);
      if (hasQueued) {
        const turns = s.turns.map((t) =>
          t.kind === "user" && t.queuedAs ? { ...t, queuedAs: undefined } : t,
        );
        s = { ...s, turns };
      }
      return { ...ensureActiveAgentTurn(s), agentActive: true };
    }

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
      const partialResult = frame.partialResult as Record<string, unknown> | undefined;

      // Extract progress array from task tool updates
      let progress: import("./turns").TaskProgress[] | undefined;
      if (partialResult?.details && typeof partialResult.details === "object") {
        const details = partialResult.details as Record<string, unknown>;
        if (Array.isArray(details.progress)) {
          progress = details.progress.map((p: any) => ({
            index: p.index ?? 0,
            id: p.id ?? "",
            agent: p.agent ?? "agent",
            status: p.status ?? "running",
            description: p.description,
            task: p.task,
            currentTool: p.currentTool,
            currentToolArgs: p.currentToolArgs,
            lastIntent: p.lastIntent,
            toolCount: p.toolCount,
            tokens: p.tokens,
            durationMs: p.durationMs,
            recentTools: Array.isArray(p.recentTools) ? p.recentTools : undefined,
            recentOutput: Array.isArray(p.recentOutput) ? p.recentOutput : undefined,
          }));
        }
      }

      return updateToolCall(state, toolCallId, { status: "running", ...(progress ? { progress } : {}) });
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

/**
 * Attach frozen metadata to the most recent agent turn.
 * Called when the extension emits `runtime.turnMetadata` after agent_end.
 */
function attachTurnMetadata(state: TurnTranscriptState, metadata: TurnMetadata): TurnTranscriptState {
  // Walk backwards to find the most recent agent turn (should be the last one)
  const turns = [...state.turns];
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]!;
    if (turn.kind === "agent") {
      turns[i] = { ...turn, metadata };
      return { ...state, turns };
    }
  }
  return state;
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

/**
 * Strip `<attached-file>...</attached-file>` blocks and the `User request:\n`
 * wrapper that buildRuntimePrompt adds when file contexts are included.
 */
function stripAttachedFileWrapper(text: string): string {
  // Check if text contains attached-file blocks followed by "User request:" or "User Request:"
  const userRequestMatch = text.match(/\n\nUser [Rr]equest:\n([\s\S]*)$/);
  if (userRequestMatch && text.includes("<attached-file")) {
    return userRequestMatch[1].trim();
  }
  return text;
}

function extractContent(content: unknown): string {
  if (typeof content === "string") return stripAttachedFileWrapper(content);
  if (Array.isArray(content)) {
    const raw = content
      .filter((b: any) => b?.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("");
    return stripAttachedFileWrapper(raw);
  }
  if (content && typeof content === "object") {
    const c = content as Record<string, unknown>;
    if (typeof c.text === "string") return stripAttachedFileWrapper(c.text);
  }
  return "";
}

function extractImages(content: unknown): Array<{ mimeType: string; data: string | null }> {
  if (!Array.isArray(content)) return [];
  const images: Array<{ mimeType: string; data: string | null }> = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as any).type === "image") {
      const b = block as Record<string, unknown>;
      const mimeType = (b.mimeType as string) ?? (b.media_type as string) ?? "image/png";
      const data = (b.data as string) ?? null;
      // Skip unresolved blob refs — they'll show as broken-image icon
      images.push({ mimeType, data: data?.startsWith("blob:") ? null : data });
    }
  }
  return images;
}

function extractThinking(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b?.type === "thinking" && typeof b.thinking === "string")
    .map((b: any) => b.thinking)
    .join("\n");
}
