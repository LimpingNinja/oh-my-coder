/**
 * Transcript manager.
 *
 * Owns the host-side TranscriptState for the active session. Consumes
 * OMP RPC frames via the reducer and emits typed ExtensionToWebviewMessage
 * payloads through a provided post function.
 *
 * The manager is the integration seam between the RPC controller's frame
 * stream and the webview message protocol. It handles:
 *
 * - Frame-to-state reduction (via reducer.ts)
 * - Effect-to-webview-message translation
 * - Resume hydration (get_messages → chat.messagesLoaded)
 * - User message injection (when a prompt is accepted)
 * - Session reset on new/switch
 */

import type { OmpRpcFrame, ChatMessage } from "../protocol/ompRpcTypes.ts";
import type {
  ExtensionToWebviewMessage,
  ChatMessageForWebview,
  ChatDelta,
  OmpRpcFrameForWebview,
} from "../protocol/webviewMessages.ts";
import type { TranscriptState, TranscriptMessage } from "./types.ts";
import { createEmptyTranscript, generateMessageId } from "./types.ts";
import { applyFrame, type TranscriptEffect } from "./reducer.ts";

// ============================================================================
// Manager configuration
// ============================================================================

export interface TranscriptManagerConfig {
  /** Function to post typed messages to the webview. */
  postToWebview: (message: ExtensionToWebviewMessage) => void;
  /** Optional logger for diagnostics. */
  log?: (message: string) => void;
}

// ============================================================================
// Manager implementation
// ============================================================================

export class TranscriptManager {
  private state: TranscriptState;
  private config: TranscriptManagerConfig;

  constructor(sessionPath: string, config: TranscriptManagerConfig) {
    this.state = createEmptyTranscript(sessionPath);
    this.config = config;
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /** Get the current transcript state (read-only snapshot). */
  getState(): Readonly<TranscriptState> {
    return this.state;
  }

  /** Get the session path this transcript belongs to. */
  get sessionPath(): string {
    return this.state.sessionPath;
  }

  /**
   * Apply an OMP RPC frame to the transcript.
   *
   * Runs the reducer, emits appropriate webview messages based on
   * the effect, and forwards relevant frames as runtime.frame.
   */
  handleFrame(frame: OmpRpcFrame): void {
    const frameType = (frame as Record<string, unknown>).type as string | undefined;
    this.log(`frame: ${frameType ?? "unknown"}`);

    const { state, effect } = applyFrame(this.state, frame);
    this.state = state;

    if (effect.kind !== "none") {
      this.log(`effect: ${effect.kind}`);
    }

    // Emit webview messages based on the effect
    this.emitEffect(effect);

    // Forward the frame to the webview for debug/visibility
    const webviewFrame = toWebviewFrame(frame);
    if (webviewFrame) {
      this.config.postToWebview({
        type: "runtime.frame",
        sessionPath: this.state.sessionPath,
        frame: webviewFrame,
      });
    }
  }

  /**
   * Hydrate the transcript from a get_messages response (resume path).
   *
   * Converts the raw ChatMessage[] from the runtime into TranscriptMessages,
   * replaces the current state, and pushes chat.messagesLoaded to the webview.
   */
  hydrateFromMessages(messages: ChatMessage[]): void {
    const transcriptMessages: TranscriptMessage[] = messages.map((raw) => {
      const record = raw as Record<string, unknown>;
      return {
        id: (record.id as string) ?? (record.messageId as string) ?? generateMessageId(),
        role: (record.role as "user" | "assistant" | "system") ?? "assistant",
        content: extractTextContent(record.content),
        thinking: extractThinkingContent(record.content),
        streaming: false,
        finalized: true,
        startedAt: (record.timestamp as number) ?? (record.createdAt as number) ?? Date.now(),
        finalizedAt: (record.timestamp as number) ?? (record.createdAt as number) ?? Date.now(),
        toolCalls: [], // Historical tool calls are not reconstructed from get_messages
      };
    });

    this.state = {
      ...this.state,
      messages: transcriptMessages,
      activeMessageId: null,
      agentActive: false,
    };

    // Push the full history to the webview
    const webviewMessages: ChatMessageForWebview[] = transcriptMessages.map(toWebviewMessage);

    this.config.postToWebview({
      type: "chat.messagesLoaded",
      sessionPath: this.state.sessionPath,
      messages: webviewMessages,
    });

    this.log(`hydrated ${transcriptMessages.length} messages from get_messages`);
  }

  /**
   * Add a user message to the transcript.
   *
   * Called when a prompt is accepted by the runtime (after the prompt
   * command response). Pushes chat.message to the webview immediately.
   */
  addUserMessage(content: string): TranscriptMessage {
    const msg: TranscriptMessage = {
      id: generateMessageId(),
      role: "user",
      content,
      thinking: "",
      streaming: false,
      finalized: true,
      startedAt: Date.now(),
      finalizedAt: Date.now(),
      toolCalls: [],
    };

    this.state = {
      ...this.state,
      messages: [...this.state.messages, msg],
    };

    this.config.postToWebview({
      type: "chat.message",
      sessionPath: this.state.sessionPath,
      message: toWebviewMessage(msg),
    });

    return msg;
  }

  /**
   * Reset the transcript for a new session or session switch.
   */
  reset(sessionPath: string): void {
    this.state = createEmptyTranscript(sessionPath);
    this.log(`transcript reset for ${sessionPath}`);
  }

  // ==========================================================================
  // Effect → webview message translation
  // ==========================================================================

  private emitEffect(effect: TranscriptEffect): void {
    switch (effect.kind) {
      case "none":
        break;

      case "message_started":
        this.config.postToWebview({
          type: "chat.message",
          sessionPath: this.state.sessionPath,
          message: toWebviewMessage(effect.message),
        });
        break;

      case "text_delta":
        this.config.postToWebview({
          type: "chat.delta",
          sessionPath: this.state.sessionPath,
          messageId: effect.messageId,
          delta: { kind: "text", text: effect.delta } satisfies ChatDelta,
        });
        break;

      case "thinking_delta":
        this.config.postToWebview({
          type: "chat.delta",
          sessionPath: this.state.sessionPath,
          messageId: effect.messageId,
          delta: { kind: "thinking", text: effect.delta } satisfies ChatDelta,
        });
        break;

      case "tool_call_delta":
        this.config.postToWebview({
          type: "chat.delta",
          sessionPath: this.state.sessionPath,
          messageId: effect.messageId,
          delta: {
            kind: "toolCall",
            toolCallId: effect.toolCallId,
            toolName: "",
          } satisfies ChatDelta,
        });
        break;

      case "message_finalized":
        // Push the final complete message so the webview can replace
        // any streaming placeholder with the finalized version.
        this.config.postToWebview({
          type: "chat.message",
          sessionPath: this.state.sessionPath,
          message: toWebviewMessage(effect.message),
        });
        break;

      case "tool_started":
      case "tool_updated":
      case "tool_ended":
        // Tool state is conveyed via the runtime.frame forwarding.
        // The webview will render tool blocks from those frames.
        break;

      case "agent_started":
      case "agent_ended":
      case "compaction_started":
      case "compaction_ended":
      case "retry_started":
      case "retry_ended":
        // These are lifecycle signals — conveyed via runtime.frame forwarding.
        break;
    }
  }

  // ==========================================================================
  // Internal helpers
  // ==========================================================================

  private log(message: string): void {
    this.config.log?.(`[transcript] ${message}`);
  }
}

// ============================================================================
// Conversion helpers
// ============================================================================

/**
 * Convert a host TranscriptMessage to the webview-facing shape.
 */
function toWebviewMessage(msg: TranscriptMessage): ChatMessageForWebview {
  return {
    id: msg.id,
    role: msg.role,
    content: msg.content,
    timestamp: msg.startedAt,
    thinking: msg.thinking || undefined,
    streaming: msg.streaming,
    finalized: msg.finalized,
    toolCalls: msg.toolCalls.length > 0 ? msg.toolCalls : undefined,
  };
}

/**
 * Convert an OMP RPC frame to the webview-safe subset, or null if
 * the frame type is not forwarded to the webview.
 */
function toWebviewFrame(frame: OmpRpcFrame): OmpRpcFrameForWebview | null {
  const frameType = (frame as Record<string, unknown>).type as string;

  switch (frameType) {
    case "agent_start":
      return { type: "agent_start" };
    case "agent_end":
      return { type: "agent_end" };
    case "turn_start":
      return { type: "turn_start" };
    case "turn_end":
      return { type: "turn_end" };
    case "message_start":
      return { type: "message_start", message: (frame as Record<string, unknown>).message };
    case "message_update":
      return {
        type: "message_update",
        message: (frame as Record<string, unknown>).message,
        assistantMessageEvent: (frame as Record<string, unknown>).assistantMessageEvent,
      };
    case "message_end":
      return { type: "message_end", message: (frame as Record<string, unknown>).message };
    case "tool_execution_start": {
      const f = frame as Record<string, unknown>;
      return {
        type: "tool_execution_start",
        toolCallId: f.toolCallId as string,
        toolName: f.toolName as string,
        args: f.args,
      };
    }
    case "tool_execution_update": {
      const f = frame as Record<string, unknown>;
      return {
        type: "tool_execution_update",
        toolCallId: f.toolCallId as string,
        toolName: f.toolName as string,
        partialResult: f.partialResult,
      };
    }
    case "tool_execution_end": {
      const f = frame as Record<string, unknown>;
      return {
        type: "tool_execution_end",
        toolCallId: f.toolCallId as string,
        toolName: f.toolName as string,
        result: f.result,
        isError: f.isError as boolean | undefined,
      };
    }
    case "auto_compaction_start": {
      const f = frame as Record<string, unknown>;
      return {
        type: "auto_compaction_start",
        reason: (f.reason as string) ?? "unknown",
        action: (f.action as string) ?? "context-full",
      };
    }
    case "auto_compaction_end":
      return { type: "auto_compaction_end" };
    case "auto_retry_start":
      return { type: "auto_retry_start" };
    case "auto_retry_end":
      return { type: "auto_retry_end" };
    default:
      // Response frames, extension_ui_request, host_tool_call, etc.
      // are not forwarded to the webview transcript layer.
      return null;
  }
}

/**
 * Extract text content from an OMP message's content field.
 *
 * OMP messages can have content as:
 * - A plain string (simple case)
 * - An array of content blocks: [{ type: "text", text: "..." }, { type: "tool_use", ... }, ...]
 * - An object with a text field
 * - undefined/null
 */
function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";

  // Array of content blocks (Anthropic message format)
  if (Array.isArray(content)) {
    const textParts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") {
        textParts.push(block);
      } else if (block && typeof block === "object") {
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          textParts.push(b.text);
        }
      }
    }
    return textParts.join("");
  }

  // Object with text field
  if (typeof content === "object") {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
  }

  return String(content);
}

/**
 * Extract thinking/reasoning content from an OMP message's content field.
 *
 * Thinking blocks appear as content blocks with type "thinking".
 */
function extractThinkingContent(content: unknown): string {
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if (b.type === "thinking" && typeof b.thinking === "string") {
        parts.push(b.thinking);
      }
    }
  }
  return parts.join("\n");
}
