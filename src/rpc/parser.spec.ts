import { describe, expect, it } from "vitest";
import { createJsonlParser } from "./parser.ts";
import type { ParsedFrame } from "./parser.ts";
import { OmpMalformedFrameError } from "./errors.ts";

/** Collect all parse results from feeding a chunk to the parser. */
function feedAll(parser: ReturnType<typeof createJsonlParser>, chunk: string): ParsedFrame[] {
  const results: ParsedFrame[] = [];
  for (const result of parser.feed(chunk)) {
    results.push(result);
  }
  return results;
}

describe("createJsonlParser", () => {
  it("parses a single complete JSONL line", () => {
    const parser = createJsonlParser();
    const results = feedAll(parser, '{"type":"ready"}\n');

    expect(results).toHaveLength(1);
    expect(results[0]!.kind).toBe("frame");
    if (results[0]!.kind === "frame") {
      expect(results[0]!.frame).toEqual({ type: "ready" });
    }
  });

  it("parses multiple JSONL lines in a single chunk", () => {
    const parser = createJsonlParser();
    const results = feedAll(parser, '{"type":"ready"}\n{"type":"agent_start"}\n');

    expect(results).toHaveLength(2);
    expect(results[0]!.kind).toBe("frame");
    expect(results[1]!.kind).toBe("frame");
    if (results[0]!.kind === "frame" && results[1]!.kind === "frame") {
      expect(results[0]!.frame).toEqual({ type: "ready" });
      expect(results[1]!.frame).toEqual({ type: "agent_start" });
    }
  });

  it("preserves incomplete trailing line between chunks", () => {
    const parser = createJsonlParser();

    // First chunk has an incomplete line (no newline)
    const first = feedAll(parser, '{"type":"re');
    expect(first).toHaveLength(0);
    expect(parser.pendingLine).toBe('{"type":"re');

    // Second chunk completes it
    const second = feedAll(parser, 'ady"}\n');
    expect(second).toHaveLength(1);
    expect(second[0]!.kind).toBe("frame");
    if (second[0]!.kind === "frame") {
      expect(second[0]!.frame).toEqual({ type: "ready" });
    }
    expect(parser.pendingLine).toBe("");
  });

  it("handles CRLF line endings by trimming trailing CR", () => {
    const parser = createJsonlParser();
    const results = feedAll(parser, '{"type":"ready"}\r\n');

    expect(results).toHaveLength(1);
    expect(results[0]!.kind).toBe("frame");
    if (results[0]!.kind === "frame") {
      expect(results[0]!.frame).toEqual({ type: "ready" });
    }
  });

  it("ignores blank lines", () => {
    const parser = createJsonlParser();
    const results = feedAll(parser, '{"type":"ready"}\n\n\n{"type":"agent_start"}\n');

    expect(results).toHaveLength(2);
    expect(results[0]!.kind).toBe("frame");
    expect(results[1]!.kind).toBe("frame");
  });

  it("ignores blank CRLF lines", () => {
    const parser = createJsonlParser();
    const results = feedAll(parser, '{"type":"ready"}\r\n\r\n{"type":"agent_start"}\r\n');

    expect(results).toHaveLength(2);
    expect(results[0]!.kind).toBe("frame");
    expect(results[1]!.kind).toBe("frame");
  });

  it("surfaces malformed JSON as parser errors, not frames", () => {
    const parser = createJsonlParser();
    const results = feedAll(parser, "not json at all\n");

    expect(results).toHaveLength(1);
    expect(results[0]!.kind).toBe("error");
    if (results[0]!.kind === "error") {
      expect(results[0]!.error).toBeInstanceOf(OmpMalformedFrameError);
      expect(results[0]!.error.rawLine).toBe("not json at all");
      expect(results[0]!.error.recoverable).toBe(true);
    }
  });

  it("surfaces valid JSON without type field as parser error", () => {
    const parser = createJsonlParser();
    const results = feedAll(parser, '{"command":"something"}\n');

    expect(results).toHaveLength(1);
    expect(results[0]!.kind).toBe("error");
    if (results[0]!.kind === "error") {
      expect(results[0]!.error).toBeInstanceOf(OmpMalformedFrameError);
      expect(results[0]!.error.rawLine).toBe('{"command":"something"}');
      expect(results[0]!.error.parseError).toContain("type");
    }
  });

  it("continues parsing after a malformed line", () => {
    const parser = createJsonlParser();
    const results = feedAll(parser, 'broken line\n{"type":"ready"}\n');

    expect(results).toHaveLength(2);
    expect(results[0]!.kind).toBe("error");
    expect(results[1]!.kind).toBe("frame");
    if (results[1]!.kind === "frame") {
      expect(results[1]!.frame).toEqual({ type: "ready" });
    }
  });

  it("parses a command response frame with id correlation", () => {
    const parser = createJsonlParser();
    const results = feedAll(
      parser,
      '{"id":"req_1","type":"response","command":"prompt","success":true}\n',
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.kind).toBe("frame");
    if (results[0]!.kind === "frame") {
      const frame = results[0]!.frame;
      expect(frame).toEqual({
        id: "req_1",
        type: "response",
        command: "prompt",
        success: true,
      });
    }
  });

  it("parses an error response frame", () => {
    const parser = createJsonlParser();
    const results = feedAll(
      parser,
      '{"id":"req_2","type":"response","command":"set_model","success":false,"error":"Model not found"}\n',
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.kind).toBe("frame");
    if (results[0]!.kind === "frame") {
      const frame = results[0]!.frame;
      expect(frame).toEqual({
        id: "req_2",
        type: "response",
        command: "set_model",
        success: false,
        error: "Model not found",
      });
    }
  });

  it("parses an extension_ui_request frame", () => {
    const parser = createJsonlParser();
    const results = feedAll(
      parser,
      '{"type":"extension_ui_request","id":"ui_7","method":"input","title":"Branch name","placeholder":"feature/..."}\n',
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.kind).toBe("frame");
    if (results[0]!.kind === "frame") {
      expect(results[0]!.frame.type).toBe("extension_ui_request");
    }
  });

  it("parses a message_update event with text_delta", () => {
    const parser = createJsonlParser();
    const results = feedAll(
      parser,
      '{"type":"message_update","message":{"role":"assistant","content":[]},"assistantMessageEvent":{"type":"text_delta","delta":"Hello"}}\n',
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.kind).toBe("frame");
    if (results[0]!.kind === "frame") {
      expect(results[0]!.frame.type).toBe("message_update");
    }
  });

  it("parses a host_tool_call frame", () => {
    const parser = createJsonlParser();
    const results = feedAll(
      parser,
      '{"type":"host_tool_call","id":"host_1","toolCallId":"toolu_123","toolName":"echo_host","arguments":{"message":"hello"}}\n',
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.kind).toBe("frame");
    if (results[0]!.kind === "frame") {
      expect(results[0]!.frame.type).toBe("host_tool_call");
    }
  });

  it("parses an extension_error frame", () => {
    const parser = createJsonlParser();
    const results = feedAll(
      parser,
      '{"type":"extension_error","extensionPath":"/ext","event":"run","error":"crashed"}\n',
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.kind).toBe("frame");
    if (results[0]!.kind === "frame") {
      expect(results[0]!.frame.type).toBe("extension_error");
    }
  });

  it("handles a chunk that is only a partial JSONL line split across three feeds", () => {
    const parser = createJsonlParser();

    const r1 = feedAll(parser, '{"ty');
    expect(r1).toHaveLength(0);

    const r2 = feedAll(parser, 'pe":"re');
    expect(r2).toHaveLength(0);

    const r3 = feedAll(parser, 'ady"}\n');
    expect(r3).toHaveLength(1);
    expect(r3[0]!.kind).toBe("frame");
    if (r3[0]!.kind === "frame") {
      expect(r3[0]!.frame).toEqual({ type: "ready" });
    }
  });

  it("handles empty chunk without error", () => {
    const parser = createJsonlParser();
    const results = feedAll(parser, "");
    expect(results).toHaveLength(0);
  });

  it("resets buffer on reset()", () => {
    const parser = createJsonlParser();
    feedAll(parser, '{"type":"incomplete');
    expect(parser.pendingLine).toBe('{"type":"incomplete');

    parser.reset();
    expect(parser.pendingLine).toBe("");

    // After reset, the old partial line is gone; a fresh line parses normally
    const results = feedAll(parser, '{"type":"ready"}\n');
    expect(results).toHaveLength(1);
    expect(results[0]!.kind).toBe("frame");
  });

  it("handles a chunk that ends mid-line then continues with multiple lines", () => {
    const parser = createJsonlParser();

    const r1 = feedAll(parser, '{"type":"rea');
    expect(r1).toHaveLength(0);

    const r2 = feedAll(
      parser,
      'dy"}\n{"type":"agent_start"}\n{"type":"agent_end","messages":[]}\n',
    );
    expect(r2).toHaveLength(3);
    expect(r2[0]!.kind).toBe("frame");
    expect(r2[1]!.kind).toBe("frame");
    expect(r2[2]!.kind).toBe("frame");
  });

  it("rejects JSON primitives (not objects) as malformed frames", () => {
    const parser = createJsonlParser();
    const results = feedAll(parser, '42\n"hello"\n');

    expect(results).toHaveLength(2);
    expect(results[0]!.kind).toBe("error");
    expect(results[1]!.kind).toBe("error");
  });

  it("rejects JSON null as a malformed frame", () => {
    const parser = createJsonlParser();
    const results = feedAll(parser, "null\n");

    expect(results).toHaveLength(1);
    expect(results[0]!.kind).toBe("error");
  });
});
