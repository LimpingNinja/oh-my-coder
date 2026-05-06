/**
 * Proof tests for the OMP RPC process and controller.
 *
 * These tests verify the process layer (args construction, spawn lifecycle,
 * ready detection, error handling) and the controller layer (start/stop
 * lifecycle, request correlation, prompt semantics, state transitions)
 * using injected mock spawn functions and fake child processes.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { buildOmpRpcArgs, OmpProcess, type OmpSpawnFn } from "./process.ts";
import {
  OmpRpcControllerImpl,
  defaultPathValidator,
  type ResumePathValidationResult,
} from "./controller.ts";
import {
  OmpCommandError,
  OmpMalformedFrameError,
  OmpResumePathError,
  OmpNotReadyError,
  OmpSpawnError,
  OmpStartupError,
  OmpStartupTimeoutError,
} from "./errors.ts";
import type { OmpLaunchRequest } from "./types.ts";
import type { OmpRuntimeState, OmpRpcFrame } from "../protocol/ompRpcTypes.ts";
// Mock child process
// ============================================================================

/**
 * Fake child process that simulates the OMP RPC process over stdio.
 *
 * Allows tests to:
 * - Emit data on stdout/stderr
 * - Consume writes to stdin
 * - Emit exit/error events
 * - Control the killed/exitCode state
 */
class MockChildProcess extends EventEmitter {
  stdin = new MockWritable();
  stdout = new MockReadable();
  stderr = new MockReadable();
  killed = false;
  exitCode: number | null = null;
  pid = 12345;
  private _signalLog: (string | number | undefined)[] = [];

  /** All signals passed to kill(), in order. */
  get signalLog(): (string | number | undefined)[] {
    return this._signalLog;
  }

  /** Simulate sending data on stdout (as the OMP process would). */
  emitStdout(data: string): void {
    this.stdout.emit("data", Buffer.from(data, "utf-8"));
  }

  /** Simulate sending data on stderr. */
  emitStderr(data: string): void {
    this.stderr.emit("data", Buffer.from(data, "utf-8"));
  }

  /** Simulate process exit. */
  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.emit("exit", code, signal);
  }

  /** Simulate a spawn error (e.g., binary not found). */
  emitError(error: Error & { code?: string }): void {
    this.emit("error", error);
  }

  kill(signal?: string | number): boolean {
    this._signalLog.push(signal);
    // Matches real Node.js behavior: killed is set true as soon as kill()
    // is called, even before the process has actually exited.
    this.killed = true;
    // A cooperative mock: SIGTERM and SIGKILL both cause exit.
    // Use setImmediate so the exit fires after kill() returns,
    // matching real process exit timing.
    setImmediate(() => {
      if (signal === "SIGKILL" || signal === 9) {
        this.emitExit(null, "SIGKILL");
      } else {
        this.emitExit(0, null);
      }
    });
    return true;
  }
}

/**
 * Mock child process that ignores SIGTERM.
 *
 * Only SIGKILL causes it to exit. Used to test SIGTERM→SIGKILL escalation.
 * Does not use internal setTimeout — the test drives exit by calling
 * emitExit() after observing SIGKILL was sent.
 */
class StubbornMockChildProcess extends EventEmitter {
  stdin = new MockWritable();
  stdout = new MockReadable();
  stderr = new MockReadable();
  killed = false;
  exitCode: number | null = null;
  pid = 12346;
  private _signalLog: (string | number | undefined)[] = [];
  private _onSigkill: (() => void) | null = null;

  get signalLog(): (string | number | undefined)[] {
    return this._signalLog;
  }

  /** Register a callback to fire when SIGKILL is received. */
  onSigkill(cb: () => void): void {
    this._onSigkill = cb;
  }

  emitStdout(data: string): void {
    this.stdout.emit("data", Buffer.from(data, "utf-8"));
  }

  emitStderr(data: string): void {
    this.stderr.emit("data", Buffer.from(data, "utf-8"));
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.emit("exit", code, signal);
  }

  emitError(error: Error & { code?: string }): void {
    this.emit("error", error);
  }

  kill(signal?: string | number): boolean {
    this._signalLog.push(signal);
    this.killed = true;
    // Only SIGKILL triggers exit; SIGTERM is silently ignored.
    if ((signal === "SIGKILL" || signal === 9) && this._onSigkill) {
      this._onSigkill();
    }
    return true;
  }
}
/** Mock writable stream for stdin that auto-responds to get_state commands.
 *
 * Supports simulating backpressure: set `backpressureEnabled = true` and
 * call `drain()` to emit the 'drain' event, allowing writes to proceed.
 */
class MockWritable extends EventEmitter {
  written: string[] = [];
  private autoResponder?: (command: Record<string, unknown>) => void;
  /** When true, write() returns false to simulate backpressure. */
  backpressureEnabled = false;
  private _pendingDrain = false;

  /** Set or clear the auto-responder. Pass undefined to clear. */
  setAutoResponder(responder: ((command: Record<string, unknown>) => void) | undefined): void {
    this.autoResponder = responder;
  }

  /** Whether there is a pending drain wait (backpressure active). */
  get pendingDrain(): boolean {
    return this._pendingDrain;
  }

  /** Emit the 'drain' event to release backpressure. */
  drain(): void {
    this._pendingDrain = false;
    this.emit("drain");
  }

  write(data: string | Buffer): boolean {
    const text = typeof data === "string" ? data : data.toString("utf-8");
    this.written.push(text);

    // Auto-respond to commands if a responder is set
    if (this.autoResponder) {
      try {
        const trimmed = text.trim();
        if (trimmed.length > 0) {
          const command = JSON.parse(trimmed);
          this.autoResponder(command);
        }
      } catch {
        // Not valid JSON, ignore
      }
    }

    if (this.backpressureEnabled) {
      this._pendingDrain = true;
      return false;
    }
    return true;
  }

  end(): void {
    // No-op
  }
}

/** Mock readable stream for stdout/stderr. */
class MockReadable extends EventEmitter {
  // Node.js Readable methods used by the process layer
}

// ============================================================================
// Helper to create a mock spawn function
// ============================================================================

/** Common type for mock child processes used in tests. */
type AnyMockChildProcess = MockChildProcess | StubbornMockChildProcess;

function createMockSpawn(mockProcess?: AnyMockChildProcess): {
  spawn: OmpSpawnFn;
  process: AnyMockChildProcess;
} {
  const proc = mockProcess ?? new MockChildProcess();
  const spawn: OmpSpawnFn = vi.fn(() => {
    // Return immediately; the test will simulate events
    return proc as unknown as ChildProcess;
  });
  return { spawn, process: proc };
}

// ============================================================================
// buildOmpRpcArgs tests
// ============================================================================

describe("buildOmpRpcArgs", () => {
  it("builds new-session args with no options", () => {
    const request: OmpLaunchRequest = {
      kind: "new",
      workspaceFolder: "/workspace",
    };
    expect(buildOmpRpcArgs(request)).toEqual(["--mode", "rpc"]);
  });

  it("builds new-session args with model and thinking", () => {
    const request: OmpLaunchRequest = {
      kind: "new",
      workspaceFolder: "/workspace",
      model: "openai/gpt-5",
      thinking: "high",
    };
    expect(buildOmpRpcArgs(request)).toEqual([
      "--mode",
      "rpc",
      "--model",
      "openai/gpt-5",
      "--thinking",
      "high",
    ]);
  });

  it("builds resume args with explicit session path", () => {
    const request: OmpLaunchRequest = {
      kind: "resume",
      workspaceFolder: "/workspace",
      sessionPath: "/home/user/.omp/agent/sessions/--workspace--/session.jsonl",
    };
    expect(buildOmpRpcArgs(request)).toEqual([
      "--mode",
      "rpc",
      "--resume",
      "/home/user/.omp/agent/sessions/--workspace--/session.jsonl",
    ]);
  });

  it("rejects resume without session path", () => {
    expect(() =>
      buildOmpRpcArgs({
        kind: "resume",
        workspaceFolder: "/workspace",
        sessionPath: "",
      }),
    ).toThrow("resume launch requires an explicit session path");
  });

  it("handles paths with spaces in session path", () => {
    const request: OmpLaunchRequest = {
      kind: "resume",
      workspaceFolder: "/my workspace",
      sessionPath: "/path with spaces/session.jsonl",
    };
    const args = buildOmpRpcArgs(request);
    expect(args).toContain("/path with spaces/session.jsonl");
  });

  it("does not add model/thinking flags for resume requests", () => {
    const request: OmpLaunchRequest = {
      kind: "resume",
      workspaceFolder: "/workspace",
      sessionPath: "/path/session.jsonl",
      // model and thinking are not used for resume
    };
    const args = buildOmpRpcArgs(request);
    expect(args).toEqual(["--mode", "rpc", "--resume", "/path/session.jsonl"]);
    expect(args).not.toContain("--model");
    expect(args).not.toContain("--thinking");
  });
});

// ============================================================================
// OmpProcess tests
// ============================================================================

describe("OmpProcess", () => {
  let mockProcess: AnyMockChildProcess;
  let mockSpawn: OmpSpawnFn;

  beforeEach(() => {
    const mock = createMockSpawn();
    mockSpawn = mock.spawn;
    mockProcess = mock.process;
  });

  it("spawns the process with correct args and resolves on ready", async () => {
    const proc = new OmpProcess({ spawn: mockSpawn, cwd: "/workspace" });
    const startPromise = proc.start({ kind: "new", workspaceFolder: "/workspace" }, "run_test");

    // Simulate the process sending the ready frame
    mockProcess.emitStdout('{"type":"ready"}\n');

    await startPromise;
    expect(proc.lifecycle).toBe("running");
  });

  it("rejects with OmpSpawnError if spawn fails", async () => {
    const failingSpawn: OmpSpawnFn = vi.fn(() => {
      const proc = new MockChildProcess();
      // Defer error to next tick so the caller can attach handlers
      setTimeout(() => {
        proc.emitError(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
      }, 0);
      return proc as unknown as ChildProcess;
    });

    const proc = new OmpProcess({ spawn: failingSpawn, binaryPath: "/nonexistent/omp" });

    await expect(
      proc.start({ kind: "new", workspaceFolder: "/workspace" }, "run_fail"),
    ).rejects.toThrow(OmpSpawnError);
    expect(proc.lifecycle).toBe("starting");
  });

  it("rejects with OmpStartupError if process exits before ready", async () => {
    const proc = new OmpProcess({ spawn: mockSpawn });
    const startPromise = proc.start({ kind: "new", workspaceFolder: "/workspace" }, "run_exit");

    // Simulate process exit before ready
    mockProcess.emitStderr("fatal error\n");
    mockProcess.emitExit(1, null);

    await expect(startPromise).rejects.toThrow(OmpStartupError);
  });

  it("rejects with OmpStartupTimeoutError if ready is not received in time", async () => {
    vi.useFakeTimers();

    const proc = new OmpProcess({ spawn: mockSpawn, startupTimeoutMs: 100 });
    const startPromise = proc.start({ kind: "new", workspaceFolder: "/workspace" }, "run_timeout");

    // Advance past the timeout without sending ready
    vi.advanceTimersByTime(150);

    await expect(startPromise).rejects.toThrow(OmpStartupTimeoutError);

    vi.useRealTimers();
  });

  it("accumulates stderr output", async () => {
    const proc = new OmpProcess({ spawn: mockSpawn });
    const startPromise = proc.start({ kind: "new", workspaceFolder: "/workspace" }, "run_stderr");

    mockProcess.emitStderr("debug info\n");
    mockProcess.emitStderr("more info\n");
    mockProcess.emitStdout('{"type":"ready"}\n');

    await startPromise;
    expect(proc.stderrOutput).toContain("debug info");
    expect(proc.stderrOutput).toContain("more info");
  });

  it("emits frames through onFrame callback", async () => {
    const proc = new OmpProcess({ spawn: mockSpawn });
    const receivedFrames: unknown[] = [];
    proc.onFrame((frame) => receivedFrames.push(frame));

    const startPromise = proc.start({ kind: "new", workspaceFolder: "/workspace" }, "run_frames");

    mockProcess.emitStdout('{"type":"ready"}\n');
    await startPromise;

    mockProcess.emitStdout('{"type":"agent_start"}\n');
    mockProcess.emitStdout('{"type":"agent_end","messages":[]}\n');

    expect(receivedFrames).toHaveLength(3);
    expect(receivedFrames[0]).toEqual({ type: "ready" });
    expect(receivedFrames[1]).toEqual({ type: "agent_start" });
    expect(receivedFrames[2]).toEqual({ type: "agent_end", messages: [] });
  });

  it("writes commands to stdin", async () => {
    const proc = new OmpProcess({ spawn: mockSpawn });
    const startPromise = proc.start({ kind: "new", workspaceFolder: "/workspace" }, "run_write");

    mockProcess.emitStdout('{"type":"ready"}\n');
    await startPromise;

    await proc.writeCommand({ type: "get_state", id: "req_1" });

    expect(mockProcess.stdin.written.length).toBeGreaterThan(0);
    const written = mockProcess.stdin.written.join("");
    expect(written).toContain('"type":"get_state"');
    expect(written).toContain('"id":"req_1"');
  });

  it("rejects when writing to a process that is not running", async () => {
    const proc = new OmpProcess({ spawn: mockSpawn });
    await expect(proc.writeCommand({ type: "get_state" })).rejects.toThrow("Cannot write command");
  });

  it("buffers commands written during startup and flushes on ready", async () => {
    const proc = new OmpProcess({ spawn: mockSpawn });
    const startPromise = proc.start({ kind: "new", workspaceFolder: "/workspace" }, "run_buffer");

    // Write a command before ready — should be buffered
    proc.writeCommand({ type: "get_state", id: "buffered_req" });

    // Now send ready
    mockProcess.emitStdout('{"type":"ready"}\n');
    await startPromise;

    // The buffered command should have been flushed
    const written = mockProcess.stdin.written.join("");
    expect(written).toContain('"buffered_req"');
  });

  it("transitions through lifecycle states", async () => {
    const proc = new OmpProcess({ spawn: mockSpawn });

    expect(proc.lifecycle).toBe("idle");

    const startPromise = proc.start(
      { kind: "new", workspaceFolder: "/workspace" },
      "run_lifecycle",
    );
    expect(proc.lifecycle).toBe("starting");

    mockProcess.emitStdout('{"type":"ready"}\n');
    await startPromise;
    expect(proc.lifecycle).toBe("running");

    const stopPromise = proc.stop("deactivate");
    // Simulate process exit
    mockProcess.emitExit(0, null);
    await stopPromise;
    expect(proc.lifecycle).toBe("exited");
  });

  it("handles unsubscribe from frame callbacks", async () => {
    const proc = new OmpProcess({ spawn: mockSpawn });
    const receivedFrames: unknown[] = [];
    const unsub = proc.onFrame((frame) => receivedFrames.push(frame));

    const startPromise = proc.start({ kind: "new", workspaceFolder: "/workspace" }, "run_unsub");

    mockProcess.emitStdout('{"type":"ready"}\n');
    await startPromise;

    // Unsubscribe
    unsub();

    mockProcess.emitStdout('{"type":"agent_start"}\n');
    // Should only have received the ready frame
    expect(receivedFrames).toHaveLength(1);
  });

  it("rejects start when process is already active", async () => {
    const proc = new OmpProcess({ spawn: mockSpawn });
    const startPromise = proc.start({ kind: "new", workspaceFolder: "/workspace" }, "run_active");

    mockProcess.emitStdout('{"type":"ready"}\n');
    await startPromise;

    await expect(
      proc.start({ kind: "new", workspaceFolder: "/workspace" }, "run_active2"),
    ).rejects.toThrow("Cannot start");
  });

  it("stops gracefully even when lifecycle is idle", async () => {
    const proc = new OmpProcess({ spawn: mockSpawn });
    await proc.stop("deactivate");
    // Should not throw
  });

  it("escalates to SIGKILL when process ignores SIGTERM", async () => {
    vi.useFakeTimers();

    const stubbornProc = new StubbornMockChildProcess();
    const { spawn: stubbornSpawn } = createMockSpawn(stubbornProc);

    const proc = new OmpProcess({ spawn: stubbornSpawn, startupTimeoutMs: 5000 });
    const startPromise = proc.start(
      { kind: "new", workspaceFolder: "/workspace" },
      "run_sigterm_ignore",
    );

    stubbornProc.emitStdout('{"type":"ready"}\n');
    await startPromise;
    expect(proc.lifecycle).toBe("running");

    // When SIGKILL is sent, trigger exit on next tick
    stubbornProc.onSigkill(() => {
      // Must use setImmediate to get out of the kill() call stack
      // so the exit event fires after kill() returns.
      setImmediate(() => stubbornProc.emitExit(null, "SIGKILL"));
    });

    const stopPromise = proc.stop("deactivate", 1000);

    // Advance past the SIGTERM send but not yet past the kill timeout.
    await vi.advanceTimersByTimeAsync(500);

    // SIGTERM was sent, process hasn't exited yet (it ignores SIGTERM).
    expect(stubbornProc.signalLog).toContain("SIGTERM");
    expect(proc.lifecycle).not.toBe("exited");

    // Advance past the kill timeout — SIGKILL should fire.
    await vi.advanceTimersByTimeAsync(600);

    // The setImmediate from onSigkill also needs to flush.
    await vi.advanceTimersByTimeAsync(1);

    await stopPromise;

    expect(stubbornProc.signalLog).toContain("SIGKILL");
    expect(proc.lifecycle).toBe("exited");

    vi.useRealTimers();
  });

  it("stops normally without SIGKILL when process cooperates", async () => {
    const proc = new OmpProcess({ spawn: mockSpawn });
    const startPromise = proc.start(
      { kind: "new", workspaceFolder: "/workspace" },
      "run_normal_stop",
    );
    mockProcess.emitStdout('{"type":"ready"}\n');
    await startPromise;

    // Cooperative process: SIGTERM causes exit
    const stopPromise = proc.stop("deactivate", 5000);
    mockProcess.emitExit(0, null);
    await stopPromise;

    // SIGKILL should NOT have been sent
    expect(mockProcess.signalLog).not.toContain("SIGKILL");
    expect(mockProcess.signalLog).toContain("SIGTERM");
    expect(proc.lifecycle).toBe("exited");
  });
});

// ============================================================================
// OmpProcess — stdin backpressure
// ============================================================================

describe("OmpProcess — stdin backpressure", () => {
  let mockProcess: MockChildProcess;
  let mockSpawn: OmpSpawnFn;
  let mockStdin: MockWritable;

  beforeEach(() => {
    mockProcess = new MockChildProcess();
    mockStdin = mockProcess.stdin as MockWritable;
    const spawn: OmpSpawnFn = vi.fn(() => mockProcess as unknown as ChildProcess);
    mockSpawn = spawn;
  });

  it("writeCommand waits for drain when stdin signals backpressure", async () => {
    const proc = new OmpProcess({ spawn: mockSpawn });
    const startPromise = proc.start({ kind: "new", workspaceFolder: "/workspace" }, "run_bp_1");
    mockProcess.emitStdout('{"type":"ready"}\n');
    await startPromise;

    // Enable backpressure — all writes return false
    mockStdin.backpressureEnabled = true;

    const writePromise = proc.writeCommand({ type: "get_state", id: "bp_1" });

    // writeCommand should not resolve until drain
    // Give it a microtick to settle
    await new Promise((r) => setTimeout(r, 0));
    // writeCommand is still waiting for drain
    expect(mockStdin.pendingDrain).toBe(true);

    // Release backpressure
    mockStdin.drain();
    await writePromise;

    // The command was written
    const written = mockStdin.written.join("");
    expect(written).toContain('"bp_1"');
  });

  it("writeCommand resolves immediately when no backpressure", async () => {
    const proc = new OmpProcess({ spawn: mockSpawn });
    const startPromise = proc.start({ kind: "new", workspaceFolder: "/workspace" }, "run_bp_2");
    mockProcess.emitStdout('{"type":"ready"}\n');
    await startPromise;

    // Backpressure is off (default) — write returns true
    await proc.writeCommand({ type: "get_state", id: "bp_2" });

    const written = mockStdin.written.join("");
    expect(written).toContain('"bp_2"');
  });

  it("flushStdinBuffer respects backpressure for buffered commands", async () => {
    const proc = new OmpProcess({ spawn: mockSpawn });
    const startPromise = proc.start({ kind: "new", workspaceFolder: "/workspace" }, "run_bp_flush");

    // Buffer two commands before ready
    proc.writeCommand({ type: "get_state", id: "buf_1" });
    proc.writeCommand({ type: "get_state", id: "buf_2" });

    // Enable backpressure before ready
    mockStdin.backpressureEnabled = true;

    // Send ready — triggers flushStdinBuffer
    mockProcess.emitStdout('{"type":"ready"}\n');
    await startPromise;

    // First buffered command was written (write() was called), but returned false
    expect(mockStdin.written.length).toBeGreaterThanOrEqual(1);
    const written = mockStdin.written.join("");
    expect(written).toContain('"buf_1"');

    // Drain to flush remaining buffered commands
    mockStdin.drain();
    // Give drain chain a tick to process
    await new Promise((r) => setTimeout(r, 0));

    // Second command should now be flushed
    const writtenAfterDrain = mockStdin.written.join("");
    expect(writtenAfterDrain).toContain('"buf_2"');
  });

  it("multiple sequential writeCommands each wait for their own drain", async () => {
    const proc = new OmpProcess({ spawn: mockSpawn });
    const startPromise = proc.start({ kind: "new", workspaceFolder: "/workspace" }, "run_bp_multi");
    mockProcess.emitStdout('{"type":"ready"}\n');
    await startPromise;

    mockStdin.backpressureEnabled = true;

    // First write — backpressure kicks in
    const write1 = proc.writeCommand({ type: "get_state", id: "seq_1" });
    await new Promise((r) => setTimeout(r, 0));
    expect(mockStdin.pendingDrain).toBe(true);

    // Drain first
    mockStdin.drain();
    await write1;

    // Second write — backpressure still on, so another drain needed
    const write2 = proc.writeCommand({ type: "get_state", id: "seq_2" });
    await new Promise((r) => setTimeout(r, 0));
    expect(mockStdin.pendingDrain).toBe(true);

    mockStdin.drain();
    await write2;

    const written = mockStdin.written.join("");
    expect(written).toContain('"seq_1"');
    expect(written).toContain('"seq_2"');
  });
});

// ============================================================================
// OmpProcess — malformed frame diagnostics
// ============================================================================

describe("OmpProcess — malformed frame diagnostics", () => {
  let mockProcess: AnyMockChildProcess;
  let mockSpawn: OmpSpawnFn;

  beforeEach(() => {
    const mock = createMockSpawn();
    mockSpawn = mock.spawn;
    mockProcess = mock.process;
  });

  it("emits malformed-frame errors through onMalformedFrame callback", async () => {
    const proc = new OmpProcess({ spawn: mockSpawn });
    const malformedErrors: OmpMalformedFrameError[] = [];
    proc.onMalformedFrame((error) => malformedErrors.push(error));

    const startPromise = proc.start(
      { kind: "new", workspaceFolder: "/workspace" },
      "run_malformed_1",
    );

    // Send a valid ready frame first
    mockProcess.emitStdout('{"type":"ready"}\n');
    await startPromise;

    // Now send a malformed line
    mockProcess.emitStdout("this is not json\n");

    expect(malformedErrors).toHaveLength(1);
    expect(malformedErrors[0]).toBeInstanceOf(OmpMalformedFrameError);
    expect(malformedErrors[0]!.rawLine).toBe("this is not json");
  });

  it("does not crash when malformed frames are received during startup", async () => {
    const proc = new OmpProcess({ spawn: mockSpawn });
    const receivedFrames: unknown[] = [];
    const malformedErrors: OmpMalformedFrameError[] = [];
    proc.onFrame((frame) => receivedFrames.push(frame));
    proc.onMalformedFrame((error) => malformedErrors.push(error));

    const startPromise = proc.start(
      { kind: "new", workspaceFolder: "/workspace" },
      "run_malformed_startup",
    );

    // Send a malformed frame before ready
    mockProcess.emitStdout("not-json-before-ready\n");
    // Then send the ready frame
    mockProcess.emitStdout('{"type":"ready"}\n');

    await startPromise;
    expect(proc.lifecycle).toBe("running");
    expect(malformedErrors).toHaveLength(1);
    expect(malformedErrors[0]!.rawLine).toBe("not-json-before-ready");
    // The ready frame should still have been processed
    expect(receivedFrames.some((f) => (f as { type: string }).type === "ready")).toBe(true);
  });

  it("continues processing valid frames after malformed frames", async () => {
    const proc = new OmpProcess({ spawn: mockSpawn });
    const receivedFrames: unknown[] = [];
    const malformedErrors: OmpMalformedFrameError[] = [];
    proc.onFrame((frame) => receivedFrames.push(frame));
    proc.onMalformedFrame((error) => malformedErrors.push(error));

    const startPromise = proc.start(
      { kind: "new", workspaceFolder: "/workspace" },
      "run_malformed_mixed",
    );

    mockProcess.emitStdout('{"type":"ready"}\n');
    await startPromise;

    // Send a mix of valid and malformed frames
    mockProcess.emitStdout('{"type":"agent_start"}\n');
    mockProcess.emitStdout("broken line\n");
    mockProcess.emitStdout('{"type":"agent_end","messages":[]}\n');
    mockProcess.emitStdout('{"missing_type": true}\n');

    expect(receivedFrames).toHaveLength(3); // ready + agent_start + agent_end
    expect(malformedErrors).toHaveLength(2); // broken line + missing type
    expect(malformedErrors[0]!.rawLine).toBe("broken line");
    expect(malformedErrors[1]!.rawLine).toBe('{"missing_type": true}');
  });

  it("supports unsubscribe from malformed-frame callbacks", async () => {
    const proc = new OmpProcess({ spawn: mockSpawn });
    const malformedErrors: OmpMalformedFrameError[] = [];
    const unsub = proc.onMalformedFrame((error) => malformedErrors.push(error));

    const startPromise = proc.start(
      { kind: "new", workspaceFolder: "/workspace" },
      "run_malformed_unsub",
    );

    mockProcess.emitStdout('{"type":"ready"}\n');
    await startPromise;

    // Unsubscribe
    unsub();

    // Send malformed data — should NOT be captured
    mockProcess.emitStdout("after-unsub-bad\n");

    expect(malformedErrors).toHaveLength(0);
  });

  it("malformed frame listener errors do not crash the process", async () => {
    const proc = new OmpProcess({ spawn: mockSpawn });
    const goodErrors: OmpMalformedFrameError[] = [];

    // Bad listener that throws
    proc.onMalformedFrame(() => {
      throw new Error("listener error");
    });
    // Good listener that should still be called
    proc.onMalformedFrame((error) => goodErrors.push(error));

    const startPromise = proc.start(
      { kind: "new", workspaceFolder: "/workspace" },
      "run_malformed_listener_error",
    );

    mockProcess.emitStdout('{"type":"ready"}\n');
    await startPromise;

    // Send malformed data
    mockProcess.emitStdout("bad-frame\n");

    // Good listener should still have received the error
    expect(goodErrors).toHaveLength(1);
    // Process should still be running
    expect(proc.lifecycle).toBe("running");
  });
});

// ============================================================================
// OmpRpcControllerImpl tests
// ============================================================================

describe("OmpRpcControllerImpl", () => {
  let mockProcess: AnyMockChildProcess;
  let mockSpawn: OmpSpawnFn;
  let controller: OmpRpcControllerImpl;

  beforeEach(() => {
    const mock = createMockSpawn();
    mockSpawn = mock.spawn;
    mockProcess = mock.process;

    // Auto-respond to get_state commands so controller.start() can complete
    mockProcess.stdin.setAutoResponder((command) => {
      if (command.type === "get_state") {
        mockProcess.emitStdout(
          JSON.stringify({
            id: command.id,
            type: "response",
            command: "get_state",
            success: true,
            data: {
              sessionId: "sess_123",
              isStreaming: false,
              isCompacting: false,
              steeringMode: "one-at-a-time",
              followUpMode: "one-at-a-time",
              interruptMode: "immediate",
              messageCount: 0,
              queuedMessageCount: 0,
              autoCompactionEnabled: false,
              todoPhases: [],
            },
          }) + "\n",
        );
      }
    });

    controller = new OmpRpcControllerImpl({
      process: { spawn: mockSpawn },
      commandTimeoutMs: 5000,
    });
  });

  afterEach(async () => {
    await controller.dispose();
  });

  /**
   * Helper: start the controller by emitting the ready frame.
   * The get_state response is handled by the auto-responder.
   * After startup, the auto-responder is cleared so tests control responses manually.
   */
  async function startController(
    request: OmpLaunchRequest = {
      kind: "new",
      workspaceFolder: "/workspace",
    },
  ): Promise<OmpRuntimeState> {
    const startPromise = controller.start(request);

    // Simulate ready frame — the auto-responder handles get_state
    mockProcess.emitStdout('{"type":"ready"}\n');

    const state = await startPromise;
    // Clear auto-responder so tests can control responses manually
    mockProcess.stdin.setAutoResponder(undefined);
    return state;
  }

  it("starts and transitions to ready state", async () => {
    const state = await startController();
    expect(state.kind).toBe("ready");
    expect(controller.isRunning()).toBe(true);
    expect(controller.getProcessState().kind).toBe("ready");
  });

  it("returns runtime state from get_state", async () => {
    const state = await startController();
    expect(state.kind).toBe("ready");
    if (state.kind === "ready") {
      expect(state.sessionId).toBe("sess_123");
    }
  });

  it("returns error state when get_state fails during startup", async () => {
    // Override auto-responder to fail get_state
    mockProcess.stdin.setAutoResponder((command) => {
      if (command.type === "get_state") {
        mockProcess.emitStdout(
          JSON.stringify({
            id: command.id,
            type: "response",
            command: "get_state",
            success: false,
            error: "session not initialized",
          }) + "\n",
        );
      }
    });

    const startPromise = controller.start({
      kind: "new",
      workspaceFolder: "/workspace",
    });

    mockProcess.emitStdout('{"type":"ready"}\n');
    const state = await startPromise;

    // start() must NOT fabricate a ready state when get_state fails
    expect(state.kind).toBe("error");
    if (state.kind === "error") {
      expect(state.recoverable).toBe(true);
      expect(state.message).toContain("get_state failed");
    }

    // But the process IS ready — it sent the ready frame
    expect(controller.getProcessState().kind).toBe("ready");
    expect(controller.isRunning()).toBe(true);
  });

  it("allows commands after startup get_state failure", async () => {
    // Override auto-responder to fail get_state during startup
    mockProcess.stdin.setAutoResponder((command) => {
      if (command.type === "get_state") {
        mockProcess.emitStdout(
          JSON.stringify({
            id: command.id,
            type: "response",
            command: "get_state",
            success: false,
            error: "session not initialized",
          }) + "\n",
        );
      }
    });

    const startPromise = controller.start({
      kind: "new",
      workspaceFolder: "/workspace",
    });
    mockProcess.emitStdout('{"type":"ready"}\n');
    const state = await startPromise;
    expect(state.kind).toBe("error");

    // Now respond successfully to a subsequent getState()
    mockProcess.stdin.setAutoResponder((command) => {
      if (command.type === "get_state") {
        mockProcess.emitStdout(
          JSON.stringify({
            id: command.id,
            type: "response",
            command: "get_state",
            success: true,
            data: {
              sessionId: "sess_recovered",
              isStreaming: false,
              isCompacting: false,
              steeringMode: "one-at-a-time",
              followUpMode: "one-at-a-time",
              interruptMode: "immediate",
              messageCount: 0,
              queuedMessageCount: 0,
              autoCompactionEnabled: false,
              todoPhases: [],
            },
          }) + "\n",
        );
      }
    });

    // Controller is still running; caller can retry getState()
    const recovered = await controller.getState();
    expect(recovered.sessionId).toBe("sess_recovered");
  });

  it("stops the process and transitions to stopped state", async () => {
    await startController();

    const stopPromise = controller.stop("user");
    mockProcess.emitExit(0, null);
    await stopPromise;

    expect(controller.isRunning()).toBe(false);
    expect(controller.getProcessState().kind).toBe("stopped");
  });

  it("detaches process frame listener during stop cleanup", async () => {
    await startController();

    const observedFrames: OmpRpcFrame[] = [];
    controller.onFrame((frame) => observedFrames.push(frame));

    const stopPromise = controller.stop("user");
    mockProcess.emitExit(0, null);
    await stopPromise;

    // Simulate a late frame from the old process after stop.
    // Controller-level listener should not see it once process subscriptions are cleaned up.
    mockProcess.emitStdout('{"type":"agent_start"}\n');

    expect(observedFrames).toEqual([]);
  });

  it("preserves exit-derived stopped state when stop races with exit handling", async () => {
    await startController();

    const stopPromise = controller.stop("user");
    mockProcess.emitExit(42, null);
    await stopPromise;

    const processState = controller.getProcessState();
    expect(processState.kind).toBe("stopped");
    if (processState.kind === "stopped") {
      expect(processState.reason).toBe("error");
      expect(processState.exitCode).toBe(42);
    }
  });
  it("throws OmpNotReadyError when sending commands while not ready", async () => {
    await expect(controller.send({ type: "get_state" })).rejects.toThrow(OmpNotReadyError);
  });

  it("correlates request IDs to response frames", async () => {
    await startController();

    // Clear previous writes (from get_state during start)
    mockProcess.stdin.written = [];

    const sendPromise = controller.send<{ models: unknown[] }>({
      type: "get_available_models",
    });

    // Find the written command and extract its id
    const written = mockProcess.stdin.written.join("");
    const match = written.match(/"id"\s*:\s*"([^"]+)"/);
    expect(match).not.toBeNull();
    const requestId = match![1];

    // Simulate response
    mockProcess.emitStdout(
      JSON.stringify({
        id: requestId,
        type: "response",
        command: "get_available_models",
        success: true,
        data: { models: [{ provider: "openai", id: "gpt-5" }] },
      }) + "\n",
    );

    const result = await sendPromise;
    expect(result).toEqual({ models: [{ provider: "openai", id: "gpt-5" }] });
  });

  it("rejects with OmpCommandError on failure response", async () => {
    await startController();
    mockProcess.stdin.written = [];

    const sendPromise = controller.send({ type: "set_model", provider: "x", modelId: "y" });

    const written = mockProcess.stdin.written.join("");
    const match = written.match(/"id"\s*:\s*"([^"]+)"/);
    const requestId = match![1];

    mockProcess.emitStdout(
      JSON.stringify({
        id: requestId,
        type: "response",
        command: "set_model",
        success: false,
        error: "Model not found",
      }) + "\n",
    );

    await expect(sendPromise).rejects.toThrow(OmpCommandError);
  });

  it("sends prompt and resolves on acknowledgment", async () => {
    await startController();
    mockProcess.stdin.written = [];

    const promptPromise = controller.prompt({
      message: "Hello, world!",
    });

    const written = mockProcess.stdin.written.join("");
    const match = written.match(/"id"\s*:\s*"([^"]+)"/);
    const requestId = match![1];

    mockProcess.emitStdout(
      JSON.stringify({
        id: requestId,
        type: "response",
        command: "prompt",
        success: true,
      }) + "\n",
    );

    // Should resolve without waiting for agent_end
    await expect(promptPromise).resolves.toBeUndefined();
  });

  it("sends prompt with streaming behavior", async () => {
    await startController();
    mockProcess.stdin.written = [];

    const promptPromise = controller.prompt({
      message: "steer this",
      streamingBehavior: "steer",
    });

    const written = mockProcess.stdin.written.join("");
    expect(written).toContain('"streamingBehavior":"steer"');
    expect(written).toContain('"message":"steer this"');

    const match = written.match(/"id"\s*:\s*"([^"]+)"/);
    const requestId = match![1];

    mockProcess.emitStdout(
      JSON.stringify({
        id: requestId,
        type: "response",
        command: "prompt",
        success: true,
      }) + "\n",
    );

    await promptPromise;
  });

  it("emits frames through onFrame listener", async () => {
    await startController();

    const frames: OmpRpcFrame[] = [];
    const disposable = controller.onFrame((frame) => frames.push(frame));

    // Simulate an event frame
    mockProcess.emitStdout('{"type":"agent_start"}\n');

    expect(frames).toHaveLength(1);
    expect(frames[0]!.type).toBe("agent_start");

    disposable.dispose();
  });

  it("rejects pending requests when process exits unexpectedly", async () => {
    await startController();
    mockProcess.stdin.written = [];

    const sendPromise = controller.send({ type: "get_state" });

    // Simulate unexpected process exit
    mockProcess.emitExit(1, null);

    await expect(sendPromise).rejects.toThrow("OMP process exited");
  });

  it("getState sends get_state command and returns payload", async () => {
    await startController();
    mockProcess.stdin.written = [];

    const statePromise = controller.getState();

    const written = mockProcess.stdin.written.join("");
    const match = written.match(/"id"\s*:\s*"([^"]+)"/);
    const requestId = match![1];

    mockProcess.emitStdout(
      JSON.stringify({
        id: requestId,
        type: "response",
        command: "get_state",
        success: true,
        data: {
          sessionId: "sess_abc",
          isStreaming: false,
          isCompacting: false,
          steeringMode: "one-at-a-time",
          followUpMode: "one-at-a-time",
          interruptMode: "immediate",
          messageCount: 5,
          queuedMessageCount: 0,
          autoCompactionEnabled: true,
          todoPhases: [],
        },
      }) + "\n",
    );

    const state = await statePromise;
    expect(state.sessionId).toBe("sess_abc");
    expect(state.isStreaming).toBe(false);
    expect(state.messageCount).toBe(5);
  });

  it("getMessages returns messages array", async () => {
    await startController();
    mockProcess.stdin.written = [];

    const messagesPromise = controller.getMessages();

    const written = mockProcess.stdin.written.join("");
    const match = written.match(/"id"\s*:\s*"([^"]+)"/);
    const requestId = match![1];

    mockProcess.emitStdout(
      JSON.stringify({
        id: requestId,
        type: "response",
        command: "get_messages",
        success: true,
        data: {
          messages: [
            { role: "user", content: "hello" },
            { role: "assistant", content: "hi" },
          ],
        },
      }) + "\n",
    );

    const messages = await messagesPromise;
    expect(messages).toHaveLength(2);
  });

  it("getSessionStats returns stats or undefined on failure", async () => {
    await startController();
    mockProcess.stdin.written = [];

    const statsPromise = controller.getSessionStats();

    const written = mockProcess.stdin.written.join("");
    const match = written.match(/"id"\s*:\s*"([^"]+)"/);
    const requestId = match![1];

    mockProcess.emitStdout(
      JSON.stringify({
        id: requestId,
        type: "response",
        command: "get_session_stats",
        success: true,
        data: { totalRequests: 10 },
      }) + "\n",
    );

    const stats = await statsPromise;
    expect(stats).toEqual({ totalRequests: 10 });
  });

  it("getSessionStats returns undefined when command fails", async () => {
    await startController();
    mockProcess.stdin.written = [];

    const statsPromise = controller.getSessionStats();

    const written = mockProcess.stdin.written.join("");
    const match = written.match(/"id"\s*:\s*"([^"]+)"/);
    const requestId = match![1];

    mockProcess.emitStdout(
      JSON.stringify({
        id: requestId,
        type: "response",
        command: "get_session_stats",
        success: false,
        error: "not available",
      }) + "\n",
    );

    const stats = await statsPromise;
    expect(stats).toBeUndefined();
  });

  it("disposes controller and rejects all methods", async () => {
    await startController();

    await controller.dispose();

    await expect(controller.start({ kind: "new", workspaceFolder: "/workspace" })).rejects.toThrow(
      "disposed",
    );
  });

  it("dispose actually stops the child process before marking disposed", async () => {
    await startController();
    expect(controller.isRunning()).toBe(true);

    // After dispose, the process must be stopped
    await controller.dispose();

    expect(controller.getProcessState().kind).toBe("stopped");
    expect(controller.isRunning()).toBe(false);
    // The child process lifecycle should be exited after stop
    expect(mockProcess.killed).toBe(true);
  });

  it("does not crash when listener throws during frame emission", async () => {
    await startController();

    const badListener = vi.fn(() => {
      throw new Error("listener error");
    });
    const goodListener = vi.fn();

    controller.onFrame(badListener);
    controller.onFrame(goodListener);

    // This should not throw even though badListener throws
    mockProcess.emitStdout('{"type":"agent_start"}\n');

    expect(badListener).toHaveBeenCalled();
    expect(goodListener).toHaveBeenCalled();
  });
});

// ============================================================================
// OmpRpcControllerImpl — malformed frame diagnostics
// ============================================================================

describe("OmpRpcControllerImpl — malformed frame diagnostics", () => {
  let mockProcess: AnyMockChildProcess;
  let mockSpawn: OmpSpawnFn;
  let controller: OmpRpcControllerImpl;

  beforeEach(() => {
    const mock = createMockSpawn();
    mockSpawn = mock.spawn;
    mockProcess = mock.process;

    // Auto-respond to get_state commands so controller.start() can complete
    mockProcess.stdin.setAutoResponder((command) => {
      if (command.type === "get_state") {
        mockProcess.emitStdout(
          JSON.stringify({
            id: command.id,
            type: "response",
            command: "get_state",
            success: true,
            data: {
              sessionId: "sess_malformed",
              isStreaming: false,
              isCompacting: false,
              steeringMode: "one-at-a-time",
              followUpMode: "one-at-a-time",
              interruptMode: "immediate",
              messageCount: 0,
              queuedMessageCount: 0,
              autoCompactionEnabled: false,
              todoPhases: [],
            },
          }) + "\n",
        );
      }
    });

    controller = new OmpRpcControllerImpl({
      process: { spawn: mockSpawn },
      commandTimeoutMs: 5000,
    });
  });

  afterEach(async () => {
    await controller.dispose();
  });

  async function startController(
    request: OmpLaunchRequest = {
      kind: "new",
      workspaceFolder: "/workspace",
    },
  ): Promise<OmpRuntimeState> {
    const startPromise = controller.start(request);
    mockProcess.emitStdout('{"type":"ready"}\n');
    const state = await startPromise;
    mockProcess.stdin.setAutoResponder(undefined);
    return state;
  }

  it("surfaces malformed-frame errors through onMalformedFrame", async () => {
    const malformedErrors: OmpMalformedFrameError[] = [];
    controller.onMalformedFrame((error) => malformedErrors.push(error));

    await startController();

    // Send a malformed frame
    mockProcess.emitStdout("not-valid-json\n");

    expect(malformedErrors).toHaveLength(1);
    expect(malformedErrors[0]).toBeInstanceOf(OmpMalformedFrameError);
    expect(malformedErrors[0]!.rawLine).toBe("not-valid-json");
  });

  it("does not crash controller when malformed frames are received", async () => {
    const malformedErrors: OmpMalformedFrameError[] = [];
    controller.onMalformedFrame((error) => malformedErrors.push(error));

    await startController();

    // Send malformed data
    mockProcess.emitStdout("garbage\n");
    // Then a valid frame
    mockProcess.emitStdout('{"type":"agent_start"}\n');

    expect(malformedErrors).toHaveLength(1);
    // Controller is still running and functional
    expect(controller.isRunning()).toBe(true);
  });

  it("supports unsubscribe from onMalformedFrame", async () => {
    const malformedErrors: OmpMalformedFrameError[] = [];
    const disposable = controller.onMalformedFrame((error) => malformedErrors.push(error));

    await startController();

    // Unsubscribe
    disposable.dispose();

    // Send malformed data
    mockProcess.emitStdout("after-dispose-bad\n");

    // Should not have captured anything after disposal
    expect(malformedErrors).toHaveLength(0);
  });

  it("onMalformedFrame listener error does not affect other listeners or controller", async () => {
    const goodErrors: OmpMalformedFrameError[] = [];

    controller.onMalformedFrame(() => {
      throw new Error("bad listener");
    });
    controller.onMalformedFrame((error) => goodErrors.push(error));

    await startController();

    mockProcess.emitStdout("bad-line\n");

    expect(goodErrors).toHaveLength(1);
    expect(controller.isRunning()).toBe(true);
  });
});

// ============================================================================
// Resume path validation tests
// ============================================================================

describe("OmpRpcControllerImpl — resume path validation", () => {
  let mockProcess: AnyMockChildProcess;
  let mockSpawn: OmpSpawnFn;
  let controller: OmpRpcControllerImpl;
  let spawnCallCount: number;

  beforeEach(() => {
    const mock = createMockSpawn();
    mockSpawn = mock.spawn;
    mockProcess = mock.process;
    spawnCallCount = 0;

    // Track spawn calls
    const originalSpawn = mockSpawn;
    mockSpawn = vi.fn(((...args: unknown[]) => {
      spawnCallCount++;
      return (originalSpawn as unknown as (...a: unknown[]) => unknown)(...args);
    }) as unknown as OmpSpawnFn);

    // Auto-respond to get_state commands so controller.start() can complete
    mockProcess.stdin.setAutoResponder((command) => {
      if (command.type === "get_state") {
        mockProcess.emitStdout(
          JSON.stringify({
            id: command.id,
            type: "response",
            command: "get_state",
            success: true,
            data: {
              sessionId: "sess_resumed",
              isStreaming: false,
              isCompacting: false,
              steeringMode: "one-at-a-time",
              followUpMode: "one-at-a-time",
              interruptMode: "immediate",
              messageCount: 5,
              queuedMessageCount: 0,
              autoCompactionEnabled: false,
              todoPhases: [],
            },
          }) + "\n",
        );
      }
    });
  });

  afterEach(async () => {
    await controller.dispose();
  });

  it("rejects resume with missing session path before spawn", async () => {
    const missingValidator = vi.fn(
      async (_path: string): Promise<ResumePathValidationResult> => "missing",
    );

    controller = new OmpRpcControllerImpl({
      process: { spawn: mockSpawn },
      commandTimeoutMs: 5000,
      pathValidator: missingValidator,
    });

    await expect(
      controller.start({
        kind: "resume",
        workspaceFolder: "/workspace",
        sessionPath: "/nonexistent/session.jsonl",
      }),
    ).rejects.toThrow(OmpResumePathError);

    // Verify the error carries the correct reason
    try {
      await controller.start({
        kind: "resume",
        workspaceFolder: "/workspace",
        sessionPath: "/nonexistent/session.jsonl",
      });
    } catch (err) {
      expect(err).toBeInstanceOf(OmpResumePathError);
      const resumeErr = err as OmpResumePathError;
      expect(resumeErr.reason).toBe("missing");
      expect(resumeErr.sessionPath).toBe("/nonexistent/session.jsonl");
    }

    // Validate was called but spawn was never invoked
    expect(missingValidator).toHaveBeenCalledWith("/nonexistent/session.jsonl");
    expect(spawnCallCount).toBe(0);
  });

  it("rejects resume with not-readable session path before spawn", async () => {
    const notReadableValidator = vi.fn(
      async (_path: string): Promise<ResumePathValidationResult> => "notReadable",
    );

    controller = new OmpRpcControllerImpl({
      process: { spawn: mockSpawn },
      commandTimeoutMs: 5000,
      pathValidator: notReadableValidator,
    });

    await expect(
      controller.start({
        kind: "resume",
        workspaceFolder: "/workspace",
        sessionPath: "/etc/shadow/session.jsonl",
      }),
    ).rejects.toThrow(OmpResumePathError);

    // Verify the error carries the correct reason
    try {
      await controller.start({
        kind: "resume",
        workspaceFolder: "/workspace",
        sessionPath: "/etc/shadow/session.jsonl",
      });
    } catch (err) {
      expect(err).toBeInstanceOf(OmpResumePathError);
      const resumeErr = err as OmpResumePathError;
      expect(resumeErr.reason).toBe("notReadable");
      expect(resumeErr.sessionPath).toBe("/etc/shadow/session.jsonl");
    }

    expect(notReadableValidator).toHaveBeenCalledWith("/etc/shadow/session.jsonl");
    expect(spawnCallCount).toBe(0);
  });

  it("allows resume when path validator returns ok", async () => {
    const okValidator = vi.fn(async (_path: string): Promise<ResumePathValidationResult> => "ok");

    controller = new OmpRpcControllerImpl({
      process: { spawn: mockSpawn },
      commandTimeoutMs: 5000,
      pathValidator: okValidator,
    });

    const startPromise = controller.start({
      kind: "resume",
      workspaceFolder: "/workspace",
      sessionPath: "/valid/session.jsonl",
    });

    // The first await in controller.start() is the path validator.
    // We must defer the ready frame until after the validator resolves
    // and the process is created with listeners wired up.
    // Two microtick yields: one for the validator await, one for proc.start await.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    mockProcess.emitStdout('{"type":"ready"}\n');

    const state = await startPromise;
    expect(state.kind).toBe("ready");
    expect(okValidator).toHaveBeenCalledWith("/valid/session.jsonl");
    // Spawn WAS called because validation passed
    expect(spawnCallCount).toBeGreaterThan(0);
  });

  it("does not call pathValidator for new-session requests", async () => {
    const validator = vi.fn(
      async (_path: string): Promise<ResumePathValidationResult> => "missing",
    );

    controller = new OmpRpcControllerImpl({
      process: { spawn: mockSpawn },
      commandTimeoutMs: 5000,
      pathValidator: validator,
    });

    const startPromise = controller.start({
      kind: "new",
      workspaceFolder: "/workspace",
    });

    mockProcess.emitStdout('{"type":"ready"}\n');
    await startPromise;

    // pathValidator should never be called for new-session requests
    expect(validator).not.toHaveBeenCalled();
  });

  it("leaves controller in correct state after resume validation failure", async () => {
    const missingValidator = vi.fn(
      async (_path: string): Promise<ResumePathValidationResult> => "missing",
    );

    controller = new OmpRpcControllerImpl({
      process: { spawn: mockSpawn },
      commandTimeoutMs: 5000,
      pathValidator: missingValidator,
    });

    try {
      await controller.start({
        kind: "resume",
        workspaceFolder: "/workspace",
        sessionPath: "/gone/session.jsonl",
      });
    } catch {
      // Expected
    }

    // Controller should be in idle state — validation failed before any
    // state mutation, so the previous state should be preserved.
    expect(controller.getProcessState().kind).toBe("idle");

    // A subsequent start with a different controller and valid path should succeed
    const okValidator = vi.fn(async (_path: string): Promise<ResumePathValidationResult> => "ok");
    const controller2 = new OmpRpcControllerImpl({
      process: { spawn: mockSpawn },
      commandTimeoutMs: 5000,
      pathValidator: okValidator,
    });

    const startPromise = controller2.start({
      kind: "resume",
      workspaceFolder: "/workspace",
      sessionPath: "/valid/session.jsonl",
    });

    // Defer ready frame for the same reason as the "ok" test above
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    mockProcess.emitStdout('{"type":"ready"}\n');
    const state = await startPromise;
    expect(state.kind).toBe("ready");

    await controller2.dispose();
  });
});

// ============================================================================
// defaultPathValidator tests
// ============================================================================

describe("defaultPathValidator", () => {
  it("returns ok for an existing readable file", async () => {
    const thisFile = new URL(import.meta.url).pathname;
    const result = await defaultPathValidator(thisFile);
    expect(result).toBe("ok");
  });

  it("returns missing for a nonexistent path", async () => {
    const result = await defaultPathValidator("/no/such/path/session.jsonl");
    expect(result).toBe("missing");
  });

  it("returns missing for a path in a nonexistent directory", async () => {
    const result = await defaultPathValidator("/nonexistent_dir/nonexistent_file.jsonl");
    expect(result).toBe("missing");
  });
});
