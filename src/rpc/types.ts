/**
 * Internal transport and controller types for the OMP RPC process.
 *
 * These types are not the wire protocol (that is `src/protocol/ompRpcTypes.ts`).
 * They represent the controller-level abstractions the extension host uses to
 * manage process lifecycle, correlate requests, and track runtime state.
 */

import type {
  ChatMessage,
  ImageContent,
  OmpRpcCommand,
  OmpRpcFrame,
  OmpRuntimeState,
  OmpStatePayload,
  SessionStatsPayload,
} from "../protocol/ompRpcTypes.ts";
// ============================================================================
// Launch request
// ============================================================================

/** Typed launch request that makes illegal states unrepresentable. */
export type OmpLaunchRequest =
  | { kind: "new"; workspaceFolder: string; prompt?: string; model?: string; thinking?: string }
  | { kind: "resume"; workspaceFolder: string; sessionPath: string; prompt?: string };

// ============================================================================
// Process lifecycle
// ============================================================================

/** Discriminated union for the process lifecycle state. */
export type OmpProcessState =
  | { kind: "idle" }
  | { kind: "starting"; runId: string; request: OmpLaunchRequest }
  | { kind: "ready"; runId: string; sessionId: string }
  | { kind: "stopped"; runId: string; reason: OmpStopReason; exitCode?: number; stderr?: string };

/** Reasons a process may stop. */
export type OmpStopReason =
  | "deactivate" // Extension deactivation
  | "switch" // Switching to a different session
  | "user" // User-initiated stop
  | "error"; // Process error / unexpected exit

// ============================================================================
// Request correlation
// ============================================================================

/** A pending command awaiting its response. */
export interface PendingRpcRequest {
  /** The command id sent to OMP. */
  id: string;
  /** The command type for diagnostics. */
  commandType: string;
  /** Timestamp the request was sent (ms since epoch). */
  sentAt: number;
  /** Resolve callback for the response promise. */
  resolve: (frame: OmpRpcFrame) => void;
  /** Reject callback for timeout or process failure. */
  reject: (error: Error) => void;
}

// ============================================================================
// RPC controller interface
// ============================================================================

/**
 * Controller contract for the persistent OMP RPC process.
 *
 * Implemented by `src/rpc/controller.ts` in a later slice.
 * Defined here so consumers can depend on the interface without
 * pulling in process-spawn machinery.
 */
export interface OmpRpcController {
  /** Start a new or resumed OMP RPC process. Resolves when `ready` is received. */
  start(request: OmpLaunchRequest): Promise<OmpRuntimeState>;
  /** Stop the current process for the given reason. */
  stop(reason: OmpStopReason): Promise<void>;

  /** Whether a process is currently running and has reached ready state. */
  isRunning(): boolean;

  /** Current process lifecycle state. */
  getProcessState(): OmpProcessState;

  /** Send a command and return typed response data. */
  send<TResponse = unknown>(command: OmpRpcCommand): Promise<TResponse>;
  /**
   * Send a prompt with correct streaming behavior.
   *
   * When the runtime is streaming, `streamingBehavior` is required.
   * The controller should derive the correct behavior from current state
   * if the caller does not specify it explicitly.
   */
  prompt(input: {
    message: string;
    images?: ImageContent[];
    streamingBehavior?: "steer" | "followUp";
  }): Promise<void>;

  /** Query current session state from the runtime. */
  getState(): Promise<OmpStatePayload>;
  /** Retrieve current transcript messages from the runtime session. */
  getMessages(): Promise<ChatMessage[]>;

  /** Retrieve session-level usage/stats when available from the runtime. */
  getSessionStats(): Promise<SessionStatsPayload | undefined>;

  /** Register a listener for all outbound frames. Returns a disposable subscription. */
  onFrame(listener: (frame: OmpRpcFrame) => void): Disposable;
}

/** Minimal disposable contract for frame subscriptions. */
export interface Disposable {
  dispose(): void;
}

// ============================================================================
// Frame listener type
// ============================================================================

/** Callback signature for outbound frame listeners. */
export type OmpFrameListener = (frame: OmpRpcFrame) => void;
