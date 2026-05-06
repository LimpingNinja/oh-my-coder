import { describe, expect, it } from "vitest";
import { applyFrame } from "./reducer.ts";
import { createEmptyTranscript } from "./types.ts";
import type { TranscriptState } from "./types.ts";
import type { OmpRpcFrame } from "../protocol/ompRpcTypes.ts";

function emptyState(): TranscriptState {
  return createEmptyTranscript("/test/session.jsonl");
}

describe("transcript reducer", () => {
  describe("message_start", () => {
    it("creates a new streaming assistant message", () => {
      const state = emptyState();
      const frame = {
        type: "message_start",
        message: { id: "msg_1", role: "assistant" },
      } as unknown as OmpRpcFrame;

      const result = applyFrame(state, frame);

      expect(result.state.messages).toHaveLength(1);
      expect(result.state.messages[0]!.id).toBe("msg_1");
      expect(result.state.messages[0]!.role).toBe("assistant");
      expect(result.state.messages[0]!.streaming).toBe(true);
      expect(result.state.messages[0]!.finalized).toBe(false);
      expect(result.state.messages[0]!.content).toBe("");
      expect(result.state.activeMessageId).toBe("msg_1");
      expect(result.effect.kind).toBe("message_started");
    });

    it("generates an id when the runtime does not provide one", () => {
      const state = emptyState();
      const frame = {
        type: "message_start",
        message: { role: "assistant" },
      } as unknown as OmpRpcFrame;

      const result = applyFrame(state, frame);

      expect(result.state.messages[0]!.id).toMatch(/^msg_/);
      expect(result.state.activeMessageId).toBe(result.state.messages[0]!.id);
    });

    it("defaults role to assistant when not provided", () => {
      const state = emptyState();
      const frame = {
        type: "message_start",
        message: {},
      } as unknown as OmpRpcFrame;

      const result = applyFrame(state, frame);

      expect(result.state.messages[0]!.role).toBe("assistant");
    });
  });

  describe("message_update (text_delta)", () => {
    it("accumulates text content on the active message", () => {
      let state = emptyState();
      // Start a message first
      const startResult = applyFrame(state, {
        type: "message_start",
        message: { id: "msg_1", role: "assistant" },
      } as unknown as OmpRpcFrame);
      state = startResult.state;

      // Apply text deltas
      const r1 = applyFrame(state, {
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_delta", delta: "Hello" },
      } as unknown as OmpRpcFrame);

      expect(r1.state.messages[0]!.content).toBe("Hello");
      expect(r1.effect.kind).toBe("text_delta");
      if (r1.effect.kind === "text_delta") {
        expect(r1.effect.delta).toBe("Hello");
        expect(r1.effect.messageId).toBe("msg_1");
      }

      const r2 = applyFrame(r1.state, {
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_delta", delta: " world" },
      } as unknown as OmpRpcFrame);

      expect(r2.state.messages[0]!.content).toBe("Hello world");
    });

    it("returns none effect when no active message", () => {
      const state = emptyState();
      const result = applyFrame(state, {
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_delta", delta: "orphan" },
      } as unknown as OmpRpcFrame);

      expect(result.effect.kind).toBe("none");
    });
  });

  describe("message_update (thinking_delta)", () => {
    it("accumulates thinking content on the active message", () => {
      let state = emptyState();
      state = applyFrame(state, {
        type: "message_start",
        message: { id: "msg_1", role: "assistant" },
      } as unknown as OmpRpcFrame).state;

      const result = applyFrame(state, {
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "thinking_delta", delta: "Let me think..." },
      } as unknown as OmpRpcFrame);

      expect(result.state.messages[0]!.thinking).toBe("Let me think...");
      expect(result.effect.kind).toBe("thinking_delta");
    });
  });

  describe("message_end", () => {
    it("finalizes the active message and clears activeMessageId", () => {
      let state = emptyState();
      state = applyFrame(state, {
        type: "message_start",
        message: { id: "msg_1", role: "assistant" },
      } as unknown as OmpRpcFrame).state;

      state = applyFrame(state, {
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_delta", delta: "Done." },
      } as unknown as OmpRpcFrame).state;

      const result = applyFrame(state, {
        type: "message_end",
        message: { id: "msg_1" },
      } as unknown as OmpRpcFrame);

      expect(result.state.messages[0]!.streaming).toBe(false);
      expect(result.state.messages[0]!.finalized).toBe(true);
      expect(result.state.messages[0]!.content).toBe("Done.");
      expect(result.state.messages[0]!.finalizedAt).toBeGreaterThan(0);
      expect(result.state.activeMessageId).toBeNull();
      expect(result.effect.kind).toBe("message_finalized");
    });

    it("returns none when no active message", () => {
      const state = emptyState();
      const result = applyFrame(state, {
        type: "message_end",
        message: {},
      } as unknown as OmpRpcFrame);

      expect(result.effect.kind).toBe("none");
    });
  });

  describe("agent_start / agent_end", () => {
    it("marks agent as active on agent_start", () => {
      const state = emptyState();
      const result = applyFrame(state, { type: "agent_start" } as unknown as OmpRpcFrame);

      expect(result.state.agentActive).toBe(true);
      expect(result.effect.kind).toBe("agent_started");
    });

    it("marks agent as inactive on agent_end and clears activeMessageId", () => {
      let state = emptyState();
      state = applyFrame(state, { type: "agent_start" } as unknown as OmpRpcFrame).state;
      state = applyFrame(state, {
        type: "message_start",
        message: { id: "msg_1" },
      } as unknown as OmpRpcFrame).state;

      const result = applyFrame(state, {
        type: "agent_end",
        messages: [],
      } as unknown as OmpRpcFrame);

      expect(result.state.agentActive).toBe(false);
      expect(result.state.activeMessageId).toBeNull();
      expect(result.effect.kind).toBe("agent_ended");
    });
  });

  describe("tool_execution_start / update / end", () => {
    it("adds a tool call to the active message on tool_execution_start", () => {
      let state = emptyState();
      state = applyFrame(state, {
        type: "message_start",
        message: { id: "msg_1", role: "assistant" },
      } as unknown as OmpRpcFrame).state;

      const result = applyFrame(state, {
        type: "tool_execution_start",
        toolCallId: "tc_1",
        toolName: "read_file",
        args: { path: "/foo" },
        intent: "Reading file",
      } as unknown as OmpRpcFrame);

      expect(result.state.messages[0]!.toolCalls).toHaveLength(1);
      expect(result.state.messages[0]!.toolCalls[0]!.toolCallId).toBe("tc_1");
      expect(result.state.messages[0]!.toolCalls[0]!.toolName).toBe("read_file");
      expect(result.state.messages[0]!.toolCalls[0]!.status).toBe("running");
      expect(result.state.messages[0]!.toolCalls[0]!.intent).toBe("Reading file");
      expect(result.effect.kind).toBe("tool_started");
    });

    it("updates partial result on tool_execution_update", () => {
      let state = emptyState();
      state = applyFrame(state, {
        type: "message_start",
        message: { id: "msg_1", role: "assistant" },
      } as unknown as OmpRpcFrame).state;
      state = applyFrame(state, {
        type: "tool_execution_start",
        toolCallId: "tc_1",
        toolName: "read_file",
        args: {},
      } as unknown as OmpRpcFrame).state;

      const result = applyFrame(state, {
        type: "tool_execution_update",
        toolCallId: "tc_1",
        toolName: "read_file",
        args: {},
        partialResult: "partial output...",
      } as unknown as OmpRpcFrame);

      expect(result.state.messages[0]!.toolCalls[0]!.partialResult).toBe("partial output...");
      expect(result.effect.kind).toBe("tool_updated");
    });

    it("marks tool completed on tool_execution_end", () => {
      let state = emptyState();
      state = applyFrame(state, {
        type: "message_start",
        message: { id: "msg_1", role: "assistant" },
      } as unknown as OmpRpcFrame).state;
      state = applyFrame(state, {
        type: "tool_execution_start",
        toolCallId: "tc_1",
        toolName: "read_file",
        args: {},
      } as unknown as OmpRpcFrame).state;

      const result = applyFrame(state, {
        type: "tool_execution_end",
        toolCallId: "tc_1",
        toolName: "read_file",
        result: "file contents",
        isError: false,
      } as unknown as OmpRpcFrame);

      expect(result.state.messages[0]!.toolCalls[0]!.status).toBe("completed");
      expect(result.state.messages[0]!.toolCalls[0]!.result).toBe("file contents");
      expect(result.state.messages[0]!.toolCalls[0]!.isError).toBe(false);
      expect(result.effect.kind).toBe("tool_ended");
    });

    it("marks tool as error when isError is true", () => {
      let state = emptyState();
      state = applyFrame(state, {
        type: "message_start",
        message: { id: "msg_1", role: "assistant" },
      } as unknown as OmpRpcFrame).state;
      state = applyFrame(state, {
        type: "tool_execution_start",
        toolCallId: "tc_1",
        toolName: "bash",
        args: {},
      } as unknown as OmpRpcFrame).state;

      const result = applyFrame(state, {
        type: "tool_execution_end",
        toolCallId: "tc_1",
        toolName: "bash",
        result: "command failed",
        isError: true,
      } as unknown as OmpRpcFrame);

      expect(result.state.messages[0]!.toolCalls[0]!.status).toBe("error");
      expect(result.state.messages[0]!.toolCalls[0]!.isError).toBe(true);
    });
  });

  describe("compaction events", () => {
    it("marks compacting on auto_compaction_start", () => {
      const state = emptyState();
      const result = applyFrame(state, {
        type: "auto_compaction_start",
        reason: "threshold",
        action: "context-full",
      } as unknown as OmpRpcFrame);

      expect(result.state.compacting).toBe(true);
      expect(result.state.compactionReason).toBe("threshold");
      expect(result.effect.kind).toBe("compaction_started");
    });

    it("clears compacting on auto_compaction_end", () => {
      let state = emptyState();
      state = applyFrame(state, {
        type: "auto_compaction_start",
        reason: "overflow",
        action: "handoff",
      } as unknown as OmpRpcFrame).state;

      const result = applyFrame(state, {
        type: "auto_compaction_end",
      } as unknown as OmpRpcFrame);

      expect(result.state.compacting).toBe(false);
      expect(result.state.compactionReason).toBeUndefined();
      expect(result.effect.kind).toBe("compaction_ended");
    });
  });

  describe("retry events", () => {
    it("marks retrying on auto_retry_start", () => {
      const state = emptyState();
      const result = applyFrame(state, {
        type: "auto_retry_start",
      } as unknown as OmpRpcFrame);

      expect(result.state.retrying).toBe(true);
      expect(result.effect.kind).toBe("retry_started");
    });

    it("clears retrying on auto_retry_end", () => {
      let state = emptyState();
      state = applyFrame(state, {
        type: "auto_retry_start",
      } as unknown as OmpRpcFrame).state;

      const result = applyFrame(state, {
        type: "auto_retry_end",
      } as unknown as OmpRpcFrame);

      expect(result.state.retrying).toBe(false);
      expect(result.effect.kind).toBe("retry_ended");
    });
  });

  describe("unhandled frames", () => {
    it("returns none effect for response frames", () => {
      const state = emptyState();
      const result = applyFrame(state, {
        type: "response",
        command: "get_state",
        success: true,
        data: {},
      } as unknown as OmpRpcFrame);

      expect(result.effect.kind).toBe("none");
      expect(result.state).toEqual(state);
    });

    it("returns none effect for extension_ui_request frames", () => {
      const state = emptyState();
      const result = applyFrame(state, {
        type: "extension_ui_request",
        id: "req_1",
        method: "confirm",
        title: "Are you sure?",
        message: "Really?",
      } as unknown as OmpRpcFrame);

      expect(result.effect.kind).toBe("none");
    });
  });

  describe("full message lifecycle", () => {
    it("handles a complete assistant turn with text and tools", () => {
      let state = emptyState();

      // Agent starts
      state = applyFrame(state, { type: "agent_start" } as unknown as OmpRpcFrame).state;
      expect(state.agentActive).toBe(true);

      // Message starts
      state = applyFrame(state, {
        type: "message_start",
        message: { id: "msg_1", role: "assistant" },
      } as unknown as OmpRpcFrame).state;

      // Text streaming
      state = applyFrame(state, {
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_delta", delta: "I'll read " },
      } as unknown as OmpRpcFrame).state;
      state = applyFrame(state, {
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_delta", delta: "the file." },
      } as unknown as OmpRpcFrame).state;

      expect(state.messages[0]!.content).toBe("I'll read the file.");

      // Tool execution
      state = applyFrame(state, {
        type: "tool_execution_start",
        toolCallId: "tc_1",
        toolName: "read_file",
        args: { path: "/src/main.ts" },
      } as unknown as OmpRpcFrame).state;
      state = applyFrame(state, {
        type: "tool_execution_end",
        toolCallId: "tc_1",
        toolName: "read_file",
        result: "file contents here",
      } as unknown as OmpRpcFrame).state;

      // More text after tool
      state = applyFrame(state, {
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_delta", delta: "\n\nHere's what I found." },
      } as unknown as OmpRpcFrame).state;

      // Message ends
      const endResult = applyFrame(state, {
        type: "message_end",
        message: { id: "msg_1" },
      } as unknown as OmpRpcFrame);
      state = endResult.state;

      expect(state.messages[0]!.content).toBe("I'll read the file.\n\nHere's what I found.");
      expect(state.messages[0]!.finalized).toBe(true);
      expect(state.messages[0]!.streaming).toBe(false);
      expect(state.messages[0]!.toolCalls).toHaveLength(1);
      expect(state.messages[0]!.toolCalls[0]!.status).toBe("completed");
      expect(state.activeMessageId).toBeNull();

      // Agent ends
      state = applyFrame(state, {
        type: "agent_end",
        messages: [],
      } as unknown as OmpRpcFrame).state;
      expect(state.agentActive).toBe(false);
    });
  });
});
