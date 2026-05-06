/**
 * OMP RPC controller implementation.
 *
 * Manages the persistent `omp --mode rpc` process lifecycle, request/response
 * correlation, and exposes the `OmpRpcController` contract defined in `types.ts`.
 *
 * The controller owns exactly one active process. Multi-active sessions are
 * deferred to a later phase.
 *
 * Extension wiring (`src/extension.ts`) is intentionally not in this slice.
 * This module provides the controller surface; extension activation consumes it.
 */

import type {
  OmpLaunchRequest,
  OmpProcessState,
  OmpRpcController,
  OmpStopReason,
  PendingRpcRequest,
  Disposable,
} from "./types.ts";
import type {
  ChatMessage,
  ImageContent,
  OmpRpcCommand,
  OmpRpcFrame,
  OmpRpcResponse,
  OmpStatePayload,
  OmpRuntimeState,
  SessionStatsPayload,
} from "../protocol/ompRpcTypes.ts";
import {
  OmpCommandError,
  OmpMalformedFrameError,
  OmpNotReadyError,
  OmpOrphanResponseError,
  OmpResumePathError,
} from "./errors.ts";
import { OmpProcess, type OmpProcessConfig } from "./process.ts";
import { promises as fs } from "node:fs";

// ============================================================================
// Controller config
// ============================================================================

/** Result of validating a resume session path before spawn. */
export type ResumePathValidationResult = "ok" | "missing" | "notReadable";

/** Configuration for creating an OmpRpcControllerImpl. */
export interface OmpRpcControllerConfig {
  /** Process configuration passed through to OmpProcess. */
  process?: OmpProcessConfig;
  /** Maximum wait time (ms) for individual command responses. Defaults to 60 000. */
  commandTimeoutMs?: number;
  /**
   * Injectable path validator for resume launch requests.
   *
   * Returns "ok" if the path exists and is readable, "missing" if the path
   * does not exist, "notReadable" if the path exists but cannot be read.
   *
   * Defaults to fs.access-based validation. Inject a mock for testing.
   */
  pathValidator?: (path: string) => Promise<ResumePathValidationResult>;
}

// ============================================================================
// Request ID generation
// ============================================================================

let globalRequestId = 0;

function generateRequestId(): string {
  return `omp_req_${Date.now()}_${++globalRequestId}`;
}

function generateRunId(): string {
  return `omp_run_${Date.now()}`;
}

// ============================================================================
// Default path validator
// ============================================================================

/**
 * Default resume-path validator using fs.access.
 *
 * Distinguishes missing paths from unreadable paths so the controller
 * can surface an honest error instead of letting OMP silently create
 * a new session at the stale path.
 */
export async function defaultPathValidator(filePath: string): Promise<ResumePathValidationResult> {
  try {
    await fs.access(filePath, fs.constants.R_OK);
    return "ok";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "missing";
    if (code === "EACCES" || code === "EPERM") return "notReadable";
    // Other errors (ENOTDIR, etc.) mean the path is not a readable file
    return "missing";
  }
}

// ============================================================================
// Controller implementation
// ============================================================================

/**
 * Persistent OMP RPC controller.
 *
 * Implements the `OmpRpcController` contract: starts and stops the OMP RPC
 * process, correlates request IDs to response frames, and exposes typed
 * convenience methods for common commands.
 */
export class OmpRpcControllerImpl implements OmpRpcController {
  private process: OmpProcess | null = null;
  private processState: OmpProcessState = { kind: "idle" };
  private pendingRequests = new Map<string, PendingRpcRequest>();
  private frameListeners = new Set<(frame: OmpRpcFrame) => void>();
  private malformedFrameListeners = new Set<(error: OmpMalformedFrameError) => void>();
  private config: OmpRpcControllerConfig;
  private commandTimeoutMs: number;
  private unsubProcessFrame: (() => void) | null = null;
  private unsubProcessExit: (() => void) | null = null;
  private unsubProcessStderr: (() => void) | null = null;
  private unsubProcessMalformedFrame: (() => void) | null = null;
  private disposed = false;

  constructor(config?: OmpRpcControllerConfig) {
    this.config = config ?? {};
    this.commandTimeoutMs = config?.commandTimeoutMs ?? 60_000;
  }

  // ========================================================================
  // OmpRpcController — lifecycle
  // ========================================================================

  /**
   * Start a new or resumed OMP RPC process.
   *
   * Spawns the process, waits for the `ready` frame, then queries initial
   * runtime state via `get_state`. Resolves with an `OmpRuntimeState`
   * reflecting the current session.
   *
   * If `request.prompt` is provided, it is **not** sent automatically.
   * The caller should use `prompt()` after `start()` resolves.
   *
   * For resume requests, the session path is validated before spawn.
   * OMP treats missing session files as empty sessions and initializes
   * at that path. The controller rejects resume with a missing or
   * unreadable path to prevent a stale session row from silently creating
   * a new session under an old filename.
   *
   * @throws {OmpResumePathError} If the resume path is missing or not readable.
   * @throws {OmpSpawnError} If the binary cannot be spawned.
   * @throws {OmpStartupError} If the process exits before ready.
   * @throws {OmpStartupTimeoutError} If ready is not received in time.
   * @throws {Error} If a process is already active.
   */
  async start(request: OmpLaunchRequest): Promise<OmpRuntimeState> {
    this.assertNotDisposed();

    if (this.processState.kind !== "idle" && this.processState.kind !== "stopped") {
      throw new Error(`Cannot start: process state is '${this.processState.kind}'`);
    }

    // Validate resume path before any state mutation or process creation.
    // OMP treats missing session files as empty sessions and initializes
    // at that path. The extension must not let a stale session row silently
    // create a new session under an old filename.
    if (request.kind === "resume") {
      const validator = this.config.pathValidator ?? defaultPathValidator;
      const result = await validator(request.sessionPath);
      if (result !== "ok") {
        throw new OmpResumePathError(request.sessionPath, result);
      }
    }

    const runId = generateRunId();
    this.processState = { kind: "starting", runId, request };

    const cwd = request.kind === "new" ? request.workspaceFolder : request.workspaceFolder;
    const procConfig: OmpProcessConfig = {
      ...this.config.process,
      cwd: cwd ?? this.config.process?.cwd,
    };

    const proc = new OmpProcess(procConfig);
    this.process = proc;

    // Wire up frame listener before starting to avoid missing early frames
    this.unsubProcessFrame = proc.onFrame((frame) => this.handleFrame(frame));
    this.unsubProcessStderr = proc.onStderr(() => {
      // Stderr is accumulated in the process for diagnostics; no action needed here.
    });
    this.unsubProcessExit = proc.onExit((code, signal) => {
      this.handleProcessExit(code, signal);
    });

    // Wire up malformed-frame listener before starting to avoid missing early diagnostics
    this.unsubProcessMalformedFrame = proc.onMalformedFrame((error) =>
      this.handleMalformedFrame(error),
    );

    try {
      // Spawn and wait for ready
      await proc.start(request, runId);

      // Process is ready — query initial state
      this.processState = { kind: "ready", runId, sessionId: "" };

      let state: OmpStatePayload;
      try {
        state = await this.getState();
        // Update sessionId from get_state response
        this.processState = {
          kind: "ready",
          runId,
          sessionId: state.sessionId,
        };
      } catch (getStateError) {
        // get_state failed — process is ready but runtime state unconfirmed.
        // Return an honest error state rather than fabricating a plausible one.
        // The caller can retry getState() once the process stabilizes.
        return {
          kind: "error" as const,
          sessionPath: request.workspaceFolder,
          message:
            getStateError instanceof Error
              ? `get_state failed during startup: ${getStateError.message}`
              : "get_state failed during startup",
          recoverable: true,
        };
      }

      return this.runtimeStateFromPayload(state, request);
    } catch (err) {
      // Startup failed — clean up and propagate error
      this.cleanup();
      throw err;
    }
  }

  /**
   * Stop the current process for the given reason.
   *
   * Rejects all pending requests, stops the child process, and transitions
   * to the `stopped` state.
   */
  async stop(reason: OmpStopReason): Promise<void> {
    this.assertNotDisposed();

    if (this.processState.kind === "idle") {
      return;
    }

    const runId =
      this.processState.kind === "starting" || this.processState.kind === "ready"
        ? this.processState.runId
        : this.processState.kind === "stopped"
          ? this.processState.runId
          : "unknown";

    // Reject all pending requests
    this.rejectAllPendingRequests(new Error(`Process stopped: ${reason}`));

    // Stop the child process
    if (this.process) {
      await this.process.stop(reason);
    }

    if (this.processState.kind !== "stopped") {
      this.processState = {
        kind: "stopped",
        runId,
        reason,
        exitCode: undefined,
        stderr: this.process?.stderrOutput || undefined,
      };
    }
    this.unsubscribeProcessListeners();
  }

  /** Whether a process is currently running and has reached the ready state. */
  isRunning(): boolean {
    return this.processState.kind === "ready";
  }

  /** Current process lifecycle state. */
  getProcessState(): OmpProcessState {
    return this.processState;
  }

  // ========================================================================
  // OmpRpcController — commands
  // ========================================================================

  /**
   * Send a command and return typed response data.
   *
   * Correlates the request ID with the response frame. If the runtime
   * responds with `success: false`, throws `OmpCommandError`. If the
   * process is not in a ready state, throws `OmpNotReadyError`.
   */
  async send<TResponse = unknown>(command: OmpRpcCommand): Promise<TResponse> {
    this.assertNotDisposed();

    if (!this.isRunning()) {
      throw new OmpNotReadyError(this.processState.kind);
    }

    const id = generateRequestId();
    const commandWithId = { ...command, id };

    return new Promise<TResponse>((resolve, reject) => {
      const pendingEntry: PendingRpcRequest = {
        id,
        commandType: command.type,
        sentAt: Date.now(),
        resolve: (frame: OmpRpcFrame) => {
          // We know frame is a response because only responses are correlated
          if (frame.type === "response") {
            if (frame.success) {
              const data = "data" in frame ? (frame as { data: unknown }).data : undefined;
              resolve(data as TResponse);
            } else {
              reject(
                new OmpCommandError(frame.command, (frame as { error: string }).error, frame.id),
              );
            }
          } else {
            // Non-response frame correlated to a request — protocol violation
            reject(new Error(`Expected response frame for ${command.type}, got ${frame.type}`));
          }
        },
        reject,
      };

      this.pendingRequests.set(id, pendingEntry);

      // Set a command-level timeout
      const timer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Command '${command.type}' timed out after ${this.commandTimeoutMs}ms`));
        }
      }, this.commandTimeoutMs);

      // Clear the timeout when the request resolves or rejects
      const originalResolve = pendingEntry.resolve;
      const originalReject = pendingEntry.reject;
      pendingEntry.resolve = (frame: OmpRpcFrame) => {
        clearTimeout(timer);
        originalResolve(frame);
      };
      pendingEntry.reject = (error: Error) => {
        clearTimeout(timer);
        originalReject(error);
      };

      this.process?.writeCommand(commandWithId);
    });
  }

  /**
   * Send a prompt with correct streaming behavior.
   *
   * Treats the prompt response as acknowledgment only — completion is
   * observed through event flow (agent_start/agent_end), not the prompt
   * response itself.
   *
   * When the runtime is streaming, `streamingBehavior` is required.
   * The controller does not auto-detect streaming state; the caller
   * should check `getState().isStreaming` and provide the appropriate
   * behavior.
   */
  async prompt(input: {
    message: string;
    images?: ImageContent[];
    streamingBehavior?: "steer" | "followUp";
  }): Promise<void> {
    const command: OmpRpcCommand = {
      type: "prompt",
      message: input.message,
      images: input.images,
      streamingBehavior: input.streamingBehavior,
    };

    await this.send(command);
    // Prompt is acknowledged — completion comes from events, not this promise.
  }

  /** Query current session state from the runtime. */
  async getState(): Promise<OmpStatePayload> {
    return this.send<OmpStatePayload>({ type: "get_state" });
  }

  /** Retrieve current transcript messages from the runtime session. */
  async getMessages(): Promise<ChatMessage[]> {
    const result = await this.send<{ messages: ChatMessage[] }>({ type: "get_messages" });
    return result?.messages ?? [];
  }

  /** Retrieve session-level usage/stats when available from the runtime. */
  async getSessionStats(): Promise<SessionStatsPayload | undefined> {
    try {
      const result = await this.send<SessionStatsPayload>({ type: "get_session_stats" });
      return result ?? undefined;
    } catch {
      // Stats are optional; return undefined on failure
      return undefined;
    }
  }

  // ========================================================================
  // OmpRpcController — events
  // ========================================================================

  /** Register a listener for all outbound frames. Returns a disposable subscription. */
  onFrame(listener: (frame: OmpRpcFrame) => void): Disposable {
    this.assertNotDisposed();
    this.frameListeners.add(listener);
    return {
      dispose: () => {
        this.frameListeners.delete(listener);
      },
    };
  }

  /** Register a listener for malformed-frame diagnostics. Returns a disposable subscription. */
  onMalformedFrame(listener: (error: OmpMalformedFrameError) => void): Disposable {
    this.assertNotDisposed();
    this.malformedFrameListeners.add(listener);
    return {
      dispose: () => {
        this.malformedFrameListeners.delete(listener);
      },
    };
  }

  // ========================================================================
  // Internal — frame handling
  // ========================================================================

  private handleMalformedFrame(error: OmpMalformedFrameError): void {
    for (const listener of this.malformedFrameListeners) {
      try {
        listener(error);
      } catch {
        // Listener errors must not affect process operation.
      }
    }
  }

  private handleFrame(frame: OmpRpcFrame): void {
    // Always emit to frame listeners first
    for (const listener of this.frameListeners) {
      try {
        listener(frame);
      } catch {
        // Listener errors must not affect frame processing.
      }
    }

    // Correlate response frames with pending requests
    if (frame.type === "response") {
      this.handleResponseFrame(frame);
    }
    // Agent events, UI requests, host-tool calls, and other frames
    // are emitted via onFrame but not correlated with requests.
  }

  private handleResponseFrame(frame: OmpRpcResponse): void {
    const id = frame.id;

    if (id !== undefined) {
      const pending = this.pendingRequests.get(id);
      if (pending) {
        this.pendingRequests.delete(id);
        pending.resolve(frame);
      } else {
        // Orphan response — no pending request matches this id
        this.handleOrphanResponse(frame);
      }
    } else {
      // Response with undefined id — cannot correlate
      this.handleOrphanResponse(frame);
    }
  }

  private handleOrphanResponse(frame: OmpRpcResponse): void {
    // Log but do not crash. Orphan responses can occur when:
    // - The runtime emits a parse-error response with id: undefined
    // - The runtime emits a delayed error response after a prompt ack
    // - An id is reused or stale
    const error = new OmpOrphanResponseError(frame.command, frame.id);
    // In a full implementation, this would be logged to an output channel.
    // For Phase 1, we silently track it; onFrame listeners already received it.
    void error; // Prevent unused-variable lint
  }

  // ========================================================================
  // Internal — process lifecycle
  // ========================================================================

  private handleProcessExit(code: number | null, signal: NodeJS.Signals | null): void {
    // If still in starting or ready state, the process died unexpectedly
    if (this.processState.kind === "starting" || this.processState.kind === "ready") {
      const runId =
        this.processState.kind === "starting" || this.processState.kind === "ready"
          ? this.processState.runId
          : "unknown";

      const reason: OmpStopReason = code !== null && code !== 0 ? "error" : "deactivate";

      this.processState = {
        kind: "stopped",
        runId,
        reason,
        exitCode: code ?? undefined,
        stderr: this.process?.stderrOutput || undefined,
      };

      // Reject all pending requests
      this.rejectAllPendingRequests(
        new Error(`OMP process exited with code ${code}, signal ${signal}`),
      );
    }

    this.unsubscribeProcessListeners();
  }

  private rejectAllPendingRequests(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private unsubscribeProcessListeners(): void {
    if (this.unsubProcessMalformedFrame) {
      this.unsubProcessMalformedFrame();
      this.unsubProcessMalformedFrame = null;
    }
    if (this.unsubProcessFrame) {
      this.unsubProcessFrame();
      this.unsubProcessFrame = null;
    }
    if (this.unsubProcessStderr) {
      this.unsubProcessStderr();
      this.unsubProcessStderr = null;
    }
    if (this.unsubProcessExit) {
      this.unsubProcessExit();
      this.unsubProcessExit = null;
    }
  }

  /** Clean up process listeners and reject all pending requests on failure. */
  private cleanup(): void {
    this.unsubscribeProcessListeners();
    this.rejectAllPendingRequests(new Error("Process start failed"));
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.processState = { kind: "idle" };
  }

  // ========================================================================
  // Internal — state mapping
  // ========================================================================

  private runtimeStateFromPayload(
    state: OmpStatePayload,
    request: OmpLaunchRequest,
  ): OmpRuntimeState {
    const sessionPath = state.sessionFile ?? request.workspaceFolder;

    if (state.isStreaming) {
      return {
        kind: "streaming",
        sessionPath,
        sessionId: state.sessionId || undefined,
        model: state.model,
        thinking: state.thinkingLevel,
        queuedMessageCount: state.queuedMessageCount,
      };
    }

    return {
      kind: "ready",
      sessionPath,
      sessionId: state.sessionId || undefined,
      model: state.model,
      thinking: state.thinkingLevel,
      queuedMessageCount: state.queuedMessageCount,
    };
  }

  // ========================================================================
  // Internal — assertions
  // ========================================================================

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error("Controller has been disposed");
    }
  }

  // ========================================================================
  // Disposal
  // ========================================================================

  /**
   * Dispose the controller: stop the process and release all resources.
   *
   * After disposal, all methods throw.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;

    // Stop the child process before marking disposed so callers cannot
    // observe a disposed controller while the process is still running.
    await this.stop("deactivate").catch(() => {
      // Best-effort stop on disposal
    });

    this.disposed = true;

    this.rejectAllPendingRequests(new Error("Controller disposed"));
    this.frameListeners.clear();
    this.malformedFrameListeners.clear();
    this.process = null;
  }
}
