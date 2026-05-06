/**
 * JSONL frame parser for the OMP stdio transport.
 *
 * OMP RPC communicates over newline-delimited JSON on stdout.
 * This parser handles the realities of streaming chunked output:
 *
 * - A single chunk may contain multiple complete JSONL lines.
 * - A JSONL line may be split across two chunks.
 * - Blank lines are ignored.
 * - Trailing CR in CRLF pairs is trimmed.
 * - Malformed JSON is surfaced as a parser error, not swallowed or
 *   treated as assistant text.
 */

import type { OmpRpcOutboundFrame } from "../protocol/ompRpcTypes.ts";
import { OmpMalformedFrameError } from "./errors.ts";

// ============================================================================
// Parse result
// ============================================================================

/** Outcome of parsing a single JSONL line. */
export type ParsedFrame =
  | { kind: "frame"; frame: OmpRpcOutboundFrame }
  | { kind: "error"; error: OmpMalformedFrameError };

// ============================================================================
// Parser state
// ============================================================================

/**
 * Stateful JSONL parser that handles partial chunks across reads.
 *
 * Usage:
 * ```ts
 * const parser = createJsonlParser();
 * for (const result of parser.feed(chunk)) {
 *   if (result.kind === "frame") handleFrame(result.frame);
 *   if (result.kind === "error") handleError(result.error);
 * }
 * ```
 */
export interface JsonlParser {
  /**
   * Feed a chunk of raw bytes/text from the OMP stdout stream.
   *
   * Yields one `ParsedFrame` per complete line found in the chunk.
   * Incomplete trailing lines are buffered for the next feed call.
   *
   * Blank lines produce no output. Malformed JSON produces an error
   * result rather than being silently dropped.
   */
  feed(chunk: string): IterableIterator<ParsedFrame>;

  /**
   * Reset internal buffer. Call this when reconnecting to a new process
   * to avoid treating a partial line from a dead process as the start
   * of a frame from a new one.
   */
  reset(): void;

  /** Current incomplete line buffer (for diagnostics). */
  readonly pendingLine: string;
}

// ============================================================================
// Parser implementation
// ============================================================================

/**
 * Create a stateful JSONL parser.
 */
export function createJsonlParser(): JsonlParser {
  let buffer = "";

  const parser: JsonlParser = {
    get pendingLine() {
      return buffer;
    },

    *feed(chunk: string): IterableIterator<ParsedFrame> {
      buffer += chunk;

      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        // Extract the line up to and including the newline
        const line = buffer.slice(0, newlineIndex);
        // Remove processed content from buffer
        buffer = buffer.slice(newlineIndex + 1);

        // Trim trailing CR for CRLF sequences
        const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;

        // Skip blank lines
        if (trimmed.length === 0) continue;

        // Parse JSON
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          yield { kind: "error", error: new OmpMalformedFrameError(trimmed, message) };
          continue;
        }

        // Validate it looks like an OMP frame (must have a `type` field)
        if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) {
          yield {
            kind: "error",
            error: new OmpMalformedFrameError(trimmed, "frame missing 'type' field"),
          };
          continue;
        }

        yield { kind: "frame", frame: parsed as OmpRpcOutboundFrame };
      }
    },

    reset() {
      buffer = "";
    },
  };

  return parser;
}
