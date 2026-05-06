import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { listWorkspaceSessions, validateResumePath } from "./discovery.ts";
import { getOmpSessionDir } from "./workspaceScope.ts";

// ============================================================================
// Helpers
// ============================================================================

/** Create a temp directory for test sessions. Returns cleanup function. */
function createTempSessionDir(cwd: string): { dir: string; cleanup: () => void } {
  const sessionDir = getOmpSessionDir(cwd);
  fs.mkdirSync(sessionDir, { recursive: true });
  return {
    dir: sessionDir,
    cleanup: () => {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    },
  };
}

/** Write a session JSONL file. Lines is an array of objects; each gets JSON.stringify'd. */
function writeSessionFile(dir: string, name: string, lines: unknown[]): string {
  const filePath = path.join(dir, name);
  const content = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

/** Standard valid header. */
function makeHeader(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "session",
    version: 3,
    id: "abc12345",
    timestamp: "2026-02-16T10:20:30.000Z",
    cwd: "/work/project",
    ...overrides,
  };
}

/** Standard user message entry. */
function makeUserMessage(text: string): Record<string, unknown> {
  return {
    type: "message",
    id: "msg00001",
    parentId: null,
    timestamp: "2026-02-16T10:21:00.000Z",
    message: {
      role: "user",
      content: text,
    },
  };
}

/** Standard assistant message entry. */
function makeAssistantMessage(text: string): Record<string, unknown> {
  return {
    type: "message",
    id: "msg00002",
    parentId: "msg00001",
    timestamp: "2026-02-16T10:21:30.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      usage: { input: 100, output: 20, cost: { total: 0.01 } },
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("listWorkspaceSessions", () => {
  const testCwd = `/tmp/omp-test-discovery-${process.pid}`;
  let sessionDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    const result = createTempSessionDir(testCwd);
    sessionDir = result.dir;
    cleanup = result.cleanup;
  });

  afterEach(() => {
    cleanup();
  });

  it("returns empty array when session directory does not exist", async () => {
    const bogusCwd = `/tmp/omp-test-noexist-${process.pid}`;
    const result = await listWorkspaceSessions(bogusCwd);
    expect(result).toEqual([]);
  });

  it("returns empty array when session directory is empty", async () => {
    const result = await listWorkspaceSessions(testCwd);
    expect(result).toEqual([]);
  });

  it("lists a valid session with header and messages", async () => {
    writeSessionFile(sessionDir, "2026-02-16_abc12345.jsonl", [
      makeHeader({ title: "My session" }),
      makeUserMessage("Hello world"),
      makeAssistantMessage("Hi there"),
    ]);

    const result = await listWorkspaceSessions(testCwd);

    expect(result).toHaveLength(1);
    const session = result[0]!;
    expect(session.id).toBe("abc12345");
    expect(session.title).toBe("My session");
    expect(session.status).toBe("resumable");
    expect(session.messageCount).toBe(2);
    expect(session.firstMessage).toBe("Hello world");
    expect(session.path).toContain("2026-02-16_abc12345.jsonl");
    expect(session.workspaceFolder).toBe(testCwd);
    expect(session.createdAt).toBe(new Date("2026-02-16T10:20:30.000Z").getTime());
    expect(session.updatedAt).toBeGreaterThan(0);
  });

  it("uses first user prompt as title when header has no title", async () => {
    writeSessionFile(sessionDir, "2026-02-16_def45678.jsonl", [
      makeHeader({ title: undefined }),
      makeUserMessage("What is the meaning of life?"),
      makeAssistantMessage("42"),
    ]);

    const result = await listWorkspaceSessions(testCwd);

    expect(result).toHaveLength(1);
    expect(result[0]!.title).toBe("What is the meaning of life?");
  });

  it("falls back to header id when no title or user prompt", async () => {
    writeSessionFile(sessionDir, "2026-02-16_ghi90123.jsonl", [makeHeader({ id: "ghi90123" })]);

    const result = await listWorkspaceSessions(testCwd);

    expect(result).toHaveLength(1);
    expect(result[0]!.title).toBe("ghi90123");
    expect(result[0]!.status).toBe("invalid"); // zero messages
  });

  it("marks zero-message sessions as invalid (not resumable)", async () => {
    writeSessionFile(sessionDir, "2026-02-16_zero_msgs.jsonl", [
      makeHeader({ id: "zero0001", title: "Empty session" }),
    ]);

    const result = await listWorkspaceSessions(testCwd);

    expect(result).toHaveLength(1);
    expect(result[0]!.status).toBe("invalid");
    expect(result[0]!.title).toBe("Empty session");
  });

  it("marks files with invalid headers as invalid", async () => {
    // No type: "session" header
    writeSessionFile(sessionDir, "2026-02-16_broken.jsonl", [
      { something: "else" },
      makeUserMessage("Hello"),
    ]);

    const result = await listWorkspaceSessions(testCwd);

    expect(result).toHaveLength(1);
    expect(result[0]!.status).toBe("invalid");
  });

  it("marks files with missing header id as invalid", async () => {
    // type: "session" but no id
    writeSessionFile(sessionDir, "2026-02-16_noid.jsonl", [
      { type: "session", timestamp: "2026-02-16T10:20:30.000Z" },
      makeUserMessage("Hello"),
    ]);

    const result = await listWorkspaceSessions(testCwd);

    expect(result).toHaveLength(1);
    expect(result[0]!.status).toBe("invalid");
  });

  it("handles partial/short prefix reads (truncated JSONL)", async () => {
    const header = makeHeader({ id: "partial01", title: "Partial read" });
    const lines = [JSON.stringify(header), JSON.stringify(makeUserMessage("First prompt"))].join(
      "\n",
    );

    // Create a file and then truncate it so the prefix read gets partial data
    const filePath = path.join(sessionDir, "2026-02-16_partial01.jsonl");
    fs.writeFileSync(filePath, lines + "\n", "utf-8");

    const result = await listWorkspaceSessions(testCwd);

    expect(result).toHaveLength(1);
    // Should still parse what's available from the prefix
    expect(result[0]!.id).toBe("partial01");
    expect(result[0]!.title).toBe("Partial read");
  });

  it("sorts sessions by mtime descending", async () => {
    const file1 = path.join(sessionDir, "2026-02-15_old.jsonl");
    const file2 = path.join(sessionDir, "2026-02-16_new.jsonl");

    fs.writeFileSync(
      file1,
      JSON.stringify(makeHeader({ id: "old1" })) +
        "\n" +
        JSON.stringify(makeUserMessage("old")) +
        "\n",
      "utf-8",
    );
    fs.writeFileSync(
      file2,
      JSON.stringify(makeHeader({ id: "new1" })) +
        "\n" +
        JSON.stringify(makeUserMessage("new")) +
        "\n",
      "utf-8",
    );

    // Make file1 older
    const oldTime = Date.now() - 60_000;
    fs.utimesSync(file1, new Date(oldTime), new Date(oldTime));

    const result = await listWorkspaceSessions(testCwd);

    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe("new1");
    expect(result[1]!.id).toBe("old1");
  });

  it("handles paths with spaces in workspace folder", async () => {
    const spacedCwd = "/tmp/omp-test with spaces";
    const spacedDir = createTempSessionDir(spacedCwd);

    try {
      writeSessionFile(spacedDir.dir, "2026-02-16_spaced.jsonl", [
        makeHeader({ id: "spaced01", cwd: spacedCwd }),
        makeUserMessage("Hello from spaced path"),
      ]);

      const result = await listWorkspaceSessions(spacedCwd);

      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe("spaced01");
      expect(result[0]!.path).toContain("2026-02-16_spaced.jsonl");
    } finally {
      spacedDir.cleanup();
    }
  });

  it("extracts first user message from content array blocks", async () => {
    writeSessionFile(sessionDir, "2026-02-16_blocks.jsonl", [
      makeHeader({ title: "Content blocks" }),
      {
        type: "message",
        id: "msg001",
        parentId: null,
        timestamp: "2026-02-16T10:21:00.000Z",
        message: {
          role: "user",
          content: [
            { type: "text", text: "Check this file" },
            { type: "image", url: "data:..." },
          ],
        },
      },
    ]);

    const result = await listWorkspaceSessions(testCwd);

    expect(result).toHaveLength(1);
    expect(result[0]!.firstMessage).toBe("Check this file");
  });

  it("truncates long first messages for preview", async () => {
    const longText = "a".repeat(300);
    writeSessionFile(sessionDir, "2026-02-16_long.jsonl", [
      makeHeader({ title: "Long message" }),
      makeUserMessage(longText),
    ]);

    const result = await listWorkspaceSessions(testCwd);

    expect(result).toHaveLength(1);
    expect(result[0]!.firstMessage!.length).toBeLessThan(longText.length);
    expect(result[0]!.firstMessage).toContain("…");
  });

  it("skips non-JSONL files in session directory", async () => {
    writeSessionFile(sessionDir, "2026-02-16_valid.jsonl", [
      makeHeader({ id: "valid1" }),
      makeUserMessage("Hello"),
    ]);
    // Write a non-JSONL file that should be ignored
    fs.writeFileSync(path.join(sessionDir, "readme.txt"), "not a session", "utf-8");
    fs.writeFileSync(path.join(sessionDir, "notes.json"), "{}", "utf-8");

    const result = await listWorkspaceSessions(testCwd);

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("valid1");
  });

  it("handles malformed JSON lines gracefully", async () => {
    const header = makeHeader({ id: "malformed1", title: "Malformed" });
    const lines =
      [
        JSON.stringify(header),
        "this is not valid json",
        JSON.stringify(makeUserMessage("Still works")),
      ].join("\n") + "\n";

    const filePath = path.join(sessionDir, "2026-02-16_malformed.jsonl");
    fs.writeFileSync(filePath, lines, "utf-8");

    const result = await listWorkspaceSessions(testCwd);

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("malformed1");
    expect(result[0]!.firstMessage).toBe("Still works");
  });
  it("sanitizes titles by taking first line and stripping control characters", async () => {
    // Title has newline so only first line is used, then control chars stripped
    writeSessionFile(sessionDir, "2026-02-16_dirty.jsonl", [
      makeHeader({ id: "dirty01", title: "First Line\nSecond Line\r\nWith\x01Control" }),
      makeUserMessage("test"),
    ]);

    const result = await listWorkspaceSessions(testCwd);

    expect(result).toHaveLength(1);
    // Newlines truncate to first line; control chars are stripped from that line
    expect(result[0]!.title).toBe("First Line");
  });
  it("prefers header title over first user prompt", async () => {
    writeSessionFile(sessionDir, "2026-02-16_pref_title.jsonl", [
      makeHeader({ id: "preftitle", title: "From Header" }),
      makeUserMessage("From user prompt"),
    ]);

    const result = await listWorkspaceSessions(testCwd);

    expect(result).toHaveLength(1);
    expect(result[0]!.title).toBe("From Header");
  });
});

describe("validateResumePath", () => {
  const testCwd = `/tmp/omp-test-resume-${process.pid}`;
  let sessionDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    const result = createTempSessionDir(testCwd);
    sessionDir = result.dir;
    cleanup = result.cleanup;
  });

  afterEach(() => {
    cleanup();
  });

  it("returns 'ok' for a valid session with messages", async () => {
    const filePath = writeSessionFile(sessionDir, "2026-02-16_valid.jsonl", [
      makeHeader({ id: "valid1" }),
      makeUserMessage("Hello"),
    ]);

    const result = await validateResumePath(filePath);

    expect(result).toBe("ok");
  });

  it("returns 'missing' for a non-existent file", async () => {
    const result = await validateResumePath("/tmp/omp-nonexistent-path-12345.jsonl");

    expect(result).toBe("missing");
  });

  it("returns 'invalid' for a file with no valid header", async () => {
    const filePath = writeSessionFile(sessionDir, "2026-02-16_noheader.jsonl", [
      { something: "else" },
      makeUserMessage("Hello"),
    ]);

    const result = await validateResumePath(filePath);

    expect(result).toBe("invalid");
  });

  it("returns 'invalid' for a zero-message session", async () => {
    const filePath = writeSessionFile(sessionDir, "2026-02-16_empty.jsonl", [
      makeHeader({ id: "empty1" }),
    ]);

    const result = await validateResumePath(filePath);

    expect(result).toBe("invalid");
  });

  it("returns 'invalid' for header without id", async () => {
    const filePath = writeSessionFile(sessionDir, "2026-02-16_noid.jsonl", [
      { type: "session", timestamp: "2026-02-16T10:20:30.000Z" },
      makeUserMessage("Hello"),
    ]);

    const result = await validateResumePath(filePath);

    expect(result).toBe("invalid");
  });

  it("returns 'ok' for a session with only user messages (no assistant)", async () => {
    const filePath = writeSessionFile(sessionDir, "2026-02-16_onlyuser.jsonl", [
      makeHeader({ id: "onlyuser" }),
      makeUserMessage("Just a user message"),
    ]);

    const result = await validateResumePath(filePath);

    expect(result).toBe("ok");
  });
});
