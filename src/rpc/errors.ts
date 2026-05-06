/**
 * Explicit RPC/transport error types for the OMP process controller.
 *
 * These errors distinguish between:
 * - Malformed JSONL frames (parser-level)
 * - Startup failures (process-level)
 * - Resume path validation failures (pre-spawn)
 * - Protocol violations (application-level)
 *
 * Every error class preserves the information a consumer needs to decide
 * whether the failure is recoverable and what to display.
 */

// ============================================================================
// Base class
// ============================================================================

/**
 * Base class for all OMP RPC errors.
 *
 * Carries a `recoverable` flag so callers can decide whether to retry
 * without inspecting error message strings.
 */
export class OmpRpcError extends Error {
  /** Whether the operation can be retried without restarting the process. */
  public readonly recoverable: boolean;

  constructor(message: string, recoverable: boolean, options?: ErrorOptions) {
    super(message, options);
    this.name = "OmpRpcError";
    this.recoverable = recoverable;
  }
}

// ============================================================================
// Parser / framing errors
// ============================================================================

/**
 * A JSONL line could not be parsed as valid JSON.
 *
 * This is recoverable at the protocol level: the runtime continues
 * reading subsequent lines. The malformed line is captured for
 * diagnostics but must NOT be treated as assistant text.
 */
export class OmpMalformedFrameError extends OmpRpcError {
  /** The raw line that failed to parse. */
  public readonly rawLine: string;
  /** The parse error detail. */
  public readonly parseError: string;

  constructor(rawLine: string, parseError: string) {
    super(
      `Malformed JSONL frame: ${parseError}`,
      true, // Recoverable: skip line and continue
    );
    this.name = "OmpMalformedFrameError";
    this.rawLine = rawLine;
    this.parseError = parseError;
  }
}

// ============================================================================
// Startup errors
// ============================================================================

/**
 * The OMP process exited before emitting the `ready` frame.
 *
 * Not recoverable without a new process spawn.
 * Includes stderr and exit code for diagnostics.
 */
export class OmpStartupError extends OmpRpcError {
  /** Process exit code, if available. */
  public readonly exitCode: number | null;
  /** Captured stderr output. */
  public readonly stderr: string;

  constructor(exitCode: number | null, stderr: string) {
    const exitMsg = exitCode != null ? `exit code ${exitCode}` : "unknown exit";
    const stderrSnippet = stderr.length > 200 ? `${stderr.slice(0, 200)}…` : stderr;
    super(
      `OMP process exited before ready: ${exitMsg}${stderrSnippet ? ` — ${stderrSnippet}` : ""}`,
      false, // Not recoverable: process is dead
    );
    this.name = "OmpStartupError";
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/**
 * The OMP process failed to spawn (binary not found, permission denied, etc.).
 */
export class OmpSpawnError extends OmpRpcError {
  /** The binary path that was attempted. */
  public readonly binaryPath: string;
  /** Original spawn error code. */
  public readonly spawnCode: string | undefined;

  constructor(binaryPath: string, spawnCode?: string) {
    super(`Failed to spawn OMP process: ${binaryPath}${spawnCode ? ` (${spawnCode})` : ""}`, false);
    this.name = "OmpSpawnError";
    this.binaryPath = binaryPath;
    this.spawnCode = spawnCode;
  }
}

/**
 * The `ready` frame was not received within the startup timeout.
 */
export class OmpStartupTimeoutError extends OmpRpcError {
  /** Startup timeout in milliseconds. */
  public readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`OMP process did not emit ready frame within ${timeoutMs}ms`, false);
    this.name = "OmpStartupTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

// ============================================================================
// Protocol violations
// ============================================================================

/**
 * A response was received that could not be correlated with a pending request.
 *
 * This may occur when:
 * - The runtime emits a parse-error response with `id: undefined`
 * - The runtime emits a delayed error response after a prompt ack
 * - An `id` is reused or stale
 */
export class OmpOrphanResponseError extends OmpRpcError {
  /** The command from the response, if parseable. */
  public readonly command: string | undefined;
  /** The response `id`, if present. */
  public readonly responseId: string | undefined;

  constructor(command: string | undefined, responseId: string | undefined) {
    super(
      `Orphan RPC response with no pending request: command=${command ?? "unknown"}, id=${responseId ?? "undefined"}`,
      true, // Recoverable: log and continue
    );
    this.name = "OmpOrphanResponseError";
    this.command = command;
    this.responseId = responseId;
  }
}

/**
 * The runtime rejected a command with `success: false`.
 *
 * Most command failures are recoverable; the process remains alive.
 * The error message is from the runtime, not invented by the extension.
 */
export class OmpCommandError extends OmpRpcError {
  /** The command that failed. */
  public readonly command: string;
  /** The runtime error message. */
  public readonly runtimeError: string;
  /** The response `id`, if present. */
  public readonly responseId: string | undefined;

  constructor(command: string, runtimeError: string, responseId?: string) {
    super(
      `OMP command '${command}' failed: ${runtimeError}`,
      true, // Most command failures are recoverable
    );
    this.name = "OmpCommandError";
    this.command = command;
    this.runtimeError = runtimeError;
    this.responseId = responseId;
  }
}

/**
 * A command was sent while the process is not in a ready state.
 *
 * Indicates a controller logic error, not a runtime failure.
 */
export class OmpNotReadyError extends OmpRpcError {
  /** Current process state kind. */
  public readonly stateKind: string;

  constructor(stateKind: string) {
    super(
      `Cannot send RPC command: process state is '${stateKind}', expected 'ready'`,
      false, // Not recoverable without process restart or state change
    );
    this.name = "OmpNotReadyError";
    this.stateKind = stateKind;
  }
}

// ============================================================================
// Resume path validation errors
// ============================================================================

/**
 * The resume session path failed validation before spawn.
 *
 * OMP treats missing session files as empty sessions and initializes at
 * that path. The extension must not allow a stale session row to silently
 * create a new session under an old filename.
 *
 * Distinguishes "missing" (path does not exist) from "notReadable"
 * (path exists but cannot be read) so the UI can show appropriate guidance.
 */
export class OmpResumePathError extends OmpRpcError {
  /** The session path that failed validation. */
  public readonly sessionPath: string;
  /** Why the path failed validation. */
  public readonly reason: "missing" | "notReadable";

  constructor(sessionPath: string, reason: "missing" | "notReadable") {
    super(
      reason === "missing"
        ? `Resume session path does not exist: ${sessionPath}`
        : `Resume session path is not readable: ${sessionPath}`,
      false, // Not recoverable: the path itself is wrong
    );
    this.name = "OmpResumePathError";
    this.sessionPath = sessionPath;
    this.reason = reason;
  }
}
