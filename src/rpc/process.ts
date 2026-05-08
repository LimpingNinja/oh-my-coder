/**
 * OMP RPC child process management.
 *
 * Spawns `omp --mode rpc`, parses stdout JSONL through the existing parser,
 * detects the `ready` frame, captures stderr for diagnostics, and writes
 * commands to stdin.
 *
 * This layer owns process lifecycle only. Request correlation, state tracking,
 * and the controller contract live in `controller.ts`.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createJsonlParser } from "./parser.ts";
import {
  OmpMalformedFrameError,
  OmpSpawnError,
  OmpStartupError,
  OmpStartupTimeoutError,
} from "./errors.ts";
import type { OmpLaunchRequest } from "./types.ts";
import type { OmpRpcOutboundFrame } from "../protocol/ompRpcTypes.ts";

// ============================================================================
// Args builder
// ============================================================================

/**
 * Build the `omp` command-line arguments for an RPC launch request.
 *
 * - New session: `--mode rpc [--model X] [--thinking Y]`
 * - Resume:      `--mode rpc --resume <sessionPath>`
 *
 * Bare `--resume` (no path) is rejected because it invokes the TUI picker
 * and blocks JSONL protocol flow.
 */
export function buildOmpRpcArgs(request: OmpLaunchRequest): string[] {
  const args = ["--mode", "rpc"];

  if (request.kind === "resume") {
    if (!request.sessionPath) {
      throw new Error("resume launch requires an explicit session path");
    }
    args.push("--resume", request.sessionPath);
  }

  if (request.kind === "new" && request.model) {
    args.push("--model", request.model);
  }
  if (request.kind === "new" && request.thinking) {
    args.push("--thinking", request.thinking);
  }

  return args;
}

// ============================================================================
// Spawn injection
// ============================================================================

/** Subset of Node.js spawn options needed by OmpProcess. */
export interface OmpSpawnOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdio?: "pipe" | "ignore" | "inherit" | [string, string, string];
}

/** Injectable spawn function for testing. Matches Node.js child_process.spawn. */
export type OmpSpawnFn = (
  command: string,
  args: string[],
  options: OmpSpawnOptions,
) => ChildProcess;

// ============================================================================
// Process config
// ============================================================================

/** Configuration for creating an OmpProcess. */
export interface OmpProcessConfig {
  /** Path to the omp binary. Defaults to "omp". */
  binaryPath?: string;
  /** Additional environment variables merged on top of process.env. */
  env?: Record<string, string>;
  /** Working directory for the child process. */
  cwd?: string;
  /** Extension file paths to pass via --extension. */
  extensions?: string[];
  /** Startup timeout in milliseconds. Defaults to 30 000. */
  startupTimeoutMs?: number;
  /** Injectable spawn function for testing. */
  spawn?: OmpSpawnFn;
}

// ============================================================================
// Callback types
// ============================================================================

/** Called when a parsed frame is received on stdout. */
export type FrameCallback = (frame: OmpRpcOutboundFrame) => void;

/** Called when raw stderr data is received. */
export type StderrCallback = (data: string) => void;

/** Called when a malformed JSONL frame is parsed from stdout. */
export type MalformedFrameCallback = (error: OmpMalformedFrameError) => void;

/** Called when the child process exits. */
export type ExitCallback = (exitCode: number | null, signal: NodeJS.Signals | null) => void;

// ============================================================================
// Process lifecycle
// ============================================================================

/** Internal lifecycle states for the process. */
export type ProcessLifecycle = "idle" | "starting" | "running" | "exited";

// ============================================================================
// OmpProcess
// ============================================================================

/**
 * Persistent OMP RPC child process.
 *
 * Manages spawning, stdout parsing via the JSONL parser, `ready` detection,
 * stderr accumulation, stdin writes, and graceful shutdown.
 *
 * Usage:
 * ```ts
 * const proc = new OmpProcess({ cwd: "/workspace" });
 * proc.onFrame((frame) => { ... });
 * await proc.start({ kind: "new", workspaceFolder: "/workspace" }, "run_1");
 * proc.writeCommand({ type: "get_state", id: "req_1" });
 * await proc.stop("deactivate");
 * ```
 */
export class OmpProcess {
  private child: ChildProcess | null = null;
  private parser = createJsonlParser();
  private stderrBuffer = "";
  private _lifecycle: ProcessLifecycle = "idle";
  private runId = "";
  private frameCallbacks = new Set<FrameCallback>();
  private malformedFrameCallbacks = new Set<MalformedFrameCallback>();
  private stderrCallbacks = new Set<StderrCallback>();
  private exitCallbacks = new Set<ExitCallback>();
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private startupTimeoutMs: number;
  private binaryPath: string;
  private env: Record<string, string>;
  private cwd: string | undefined;
  private spawnFn: OmpSpawnFn;
  private extensions: string[];
  private stdinBuffer: string[] = [];
  private resolveStart: (() => void) | null = null;
  private rejectStart: ((error: Error) => void) | null = null;

  constructor(config?: OmpProcessConfig) {
    this.binaryPath = config?.binaryPath ?? "omp";
    this.env = config?.env ?? {};
    this.cwd = config?.cwd;
    this.extensions = config?.extensions ?? [];
    this.startupTimeoutMs = config?.startupTimeoutMs ?? 30_000;
    this.spawnFn = config?.spawn ?? (spawn as OmpSpawnFn);
  }

  /** Current lifecycle state. */
  get lifecycle(): ProcessLifecycle {
    return this._lifecycle;
  }

  /** Accumulated stderr output (for diagnostics). */
  get stderrOutput(): string {
    return this.stderrBuffer;
  }

  /** Whether the process is running and has reached the ready state. */
  get isReady(): boolean {
    return this._lifecycle === "running";
  }

  /** Subscribe to parsed outbound frames. Returns unsubscribe function. */
  onFrame(callback: FrameCallback): () => void {
    this.frameCallbacks.add(callback);
    return () => {
      this.frameCallbacks.delete(callback);
    };
  }

  /** Subscribe to raw stderr data. Returns unsubscribe function. */
  onStderr(callback: StderrCallback): () => void {
    this.stderrCallbacks.add(callback);
    return () => {
      this.stderrCallbacks.delete(callback);
    };
  }

  /** Subscribe to process exit. Returns unsubscribe function. */
  onExit(callback: ExitCallback): () => void {
    this.exitCallbacks.add(callback);
    return () => {
      this.exitCallbacks.delete(callback);
    };
  }

  /** Subscribe to malformed-frame diagnostics. Returns unsubscribe function. */
  onMalformedFrame(callback: MalformedFrameCallback): () => void {
    this.malformedFrameCallbacks.add(callback);
    return () => {
      this.malformedFrameCallbacks.delete(callback);
    };
  }

  /**
   * Start the OMP RPC process and wait for the `ready` frame.
   *
   * Resolves when `{ type: "ready" }` is received on stdout.
   * Rejects with OmpSpawnError if the binary cannot be spawned.
   * Rejects with OmpStartupError if the process exits before ready.
   * Rejects with OmpStartupTimeoutError if ready is not received in time.
   *
   * @throws {Error} If called while a process is already active.
   */
  async start(request: OmpLaunchRequest, runId: string): Promise<void> {
    if (this._lifecycle !== "idle" && this._lifecycle !== "exited") {
      throw new Error(`Cannot start: process lifecycle is '${this._lifecycle}'`);
    }

    const args = buildOmpRpcArgs(request);
    // Append --extension flags for bridge and other extension files
    for (const ext of this.extensions) {
      args.push("--extension", ext);
    }
    this._lifecycle = "starting";
    this.runId = runId;
    this.stderrBuffer = "";
    this.parser.reset();
    this.stdinBuffer = [];

    return new Promise<void>((resolve, reject) => {
      this.resolveStart = resolve;
      this.rejectStart = reject;

      let settled = false;

      const env: Record<string, string | undefined> = { ...process.env };
      for (const [key, value] of Object.entries(this.env)) {
        env[key] = value;
      }

      try {
        const child = this.spawnFn(this.binaryPath, args, {
          cwd: this.cwd,
          env,
          stdio: ["pipe", "pipe", "pipe"],
        } satisfies OmpSpawnOptions);

        this.child = child;

        // Handle spawn error (binary not found, permission denied, etc.)
        child.on("error", (err: Error) => {
          if (settled) return;
          settled = true;
          this.clearStartupTimer();
          this.cleanup();
          const spawnCode = (err as Error & { code?: string }).code;
          reject(new OmpSpawnError(this.binaryPath, spawnCode));
        });

        // Parse stdout JSONL
        child.stdout?.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf-8");
          for (const result of this.parser.feed(text)) {
            if (result.kind === "frame") {
              this.emitFrame(result.frame);

              // Detect ready frame
              if (result.frame.type === "ready" && this._lifecycle === "starting") {
                if (!settled) {
                  settled = true;
                  this._lifecycle = "running";
                  this.clearStartupTimer();
                  this.flushStdinBuffer();
                  resolve();
                }
              }
            } else if (result.kind === "error") {
              this.emitMalformedFrame(result.error);
            }
          }
        });

        // Accumulate stderr
        child.stderr?.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf-8");
          this.stderrBuffer += text;
          for (const cb of this.stderrCallbacks) {
            cb(text);
          }
        });

        // Handle process exit
        child.on("exit", (code, signal) => {
          if (this._lifecycle === "starting" && !settled) {
            settled = true;
            this.clearStartupTimer();
            this.cleanup();
            reject(new OmpStartupError(code, this.stderrBuffer));
            return;
          }

          this._lifecycle = "exited";
          this.clearStartupTimer();

          if (!settled) {
            // Process exited after startup — not an error for the start promise
            settled = true;
          }

          // Flush any buffered stdin that will never be sent
          this.stdinBuffer = [];

          for (const cb of this.exitCallbacks) {
            cb(code, signal as NodeJS.Signals | null);
          }

          // If still referencing the same child, clear it
          if (this.child === child) {
            this.child = null;
          }
        });

        // Set startup timeout
        this.startupTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          this.kill();
          this.cleanup();
          reject(new OmpStartupTimeoutError(this.startupTimeoutMs));
        }, this.startupTimeoutMs);
      } catch (err) {
        if (!settled) {
          settled = true;
          this.clearStartupTimer();
          this.cleanup();
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });
  }

  /**
   * Write a JSON command to the process stdin.
   *
   * If the process is not yet ready, the command is buffered and flushed
   * once the `ready` frame is received.
   *
   * Respects stdin backpressure: if the writable stream signals that its
   * internal buffer is full (write returns false), this method waits for
   * the `drain` event before returning, ensuring no data is lost.
   *
   * @throws {Error} If the process has exited or was never started.
   */
  async writeCommand(command: object): Promise<void> {
    const serialized = JSON.stringify(command) + "\n";

    if (this._lifecycle === "running" && this.child?.stdin) {
      await this.writeToStdin(serialized);
    } else if (this._lifecycle === "starting") {
      // Buffer commands until ready; they will be flushed in startup resolution
      this.stdinBuffer.push(serialized);
    } else {
      throw new Error(`Cannot write command: process lifecycle is '${this._lifecycle}'`);
    }
  }

  /**
   * Stop the process gracefully.
   *
   * Sends SIGTERM, waits for exit, then sends SIGKILL after a timeout.
   * Resolves when the process has exited (or was already dead).
   */
  async stop(reason: string = "deactivate", killTimeoutMs = 5_000): Promise<void> {
    if (!this.child || this._lifecycle === "idle" || this._lifecycle === "exited") {
      this._lifecycle = "exited";
      return;
    }

    const child = this.child;

    if (child.exitCode !== null) {
      this._lifecycle = "exited";
      this.child = null;
      return;
    }

    // Send SIGTERM
    child.kill("SIGTERM");

    return new Promise<void>((resolve) => {
      let resolved = false;

      const onExit = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(killTimer);
        this._lifecycle = "exited";
        if (this.child === child) {
          this.child = null;
        }
        resolve();
      };

      const killTimer = setTimeout(() => {
        // Escalate to SIGKILL if the process has not actually exited.
        // child.killed is unreliable: Node sets it true as soon as kill()
        // is called, even before the process exits. exitCode is only set
        // when the process actually terminates.
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
      }, killTimeoutMs);

      // If already exited before we registered the listener, resolve now.
      if (child.exitCode !== null) {
        onExit();
        return;
      }

      child.on("exit", onExit);
    });
  }

  /**
   * Kill the process immediately (SIGKILL).
   *
   * For graceful shutdown, use `stop()` instead.
   */
  kill(): void {
    if (this.child && !this.child.killed) {
      this.child.kill("SIGKILL");
    }
  }

  // ========================================================================
  // Private helpers
  // ========================================================================

  private emitFrame(frame: OmpRpcOutboundFrame): void {
    for (const cb of this.frameCallbacks) {
      try {
        cb(frame);
      } catch {
        // Listener errors must not crash the process layer.
      }
    }
  }

  private clearStartupTimer(): void {
    if (this.startupTimer !== null) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
  }

  private flushStdinBuffer(): void {
    if (!this.child?.stdin) return;
    // Flush buffered commands sequentially, respecting backpressure.
    // We start the chain but do not await it — the start() promise
    // resolves immediately after flushStdinBuffer() is called, and
    // buffered writes will drain in the background.
    const buffer = this.stdinBuffer;
    this.stdinBuffer = [];
    this.flushStdinChain(buffer, 0);
  }

  private flushStdinChain(buffer: string[], index: number): void {
    if (index >= buffer.length || !this.child?.stdin) return;
    const canContinue = this.child.stdin.write(buffer[index]);
    if (canContinue) {
      this.flushStdinChain(buffer, index + 1);
    } else {
      const stdin = this.child.stdin;
      const onDrain = () => {
        stdin.removeListener("drain", onDrain);
        this.flushStdinChain(buffer, index + 1);
      };
      stdin.on("drain", onDrain);
    }
  }

  private async writeToStdin(data: string): Promise<void> {
    if (!this.child?.stdin) return;
    const canContinue = this.child.stdin.write(data);
    if (canContinue) return;
    // Backpressure: wait for drain event
    await new Promise<void>((resolve) => {
      const stdin = this.child!.stdin!;
      const onDrain = () => {
        stdin.removeListener("drain", onDrain);
        resolve();
      };
      stdin.on("drain", onDrain);
    });
  }

  private cleanup(): void {
    this.clearStartupTimer();
    this.resolveStart = null;
    this.rejectStart = null;
  }

  private emitMalformedFrame(error: OmpMalformedFrameError): void {
    for (const cb of this.malformedFrameCallbacks) {
      try {
        cb(error);
      } catch {
        // Listener errors must not crash the process layer.
      }
    }
  }
}
