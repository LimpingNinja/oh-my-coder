/**
 * Session discovery types for OMP workspace-scoped session enumeration.
 *
 * These types represent session metadata derived from JSONL session files.
 * They are the domain model consumed by the webview and controller; they are
 * not the raw JSONL wire format.
 *
 * File reads, summary parsing, status classification, and watchers belong
 * to later slices. This module defines the shape those slices produce and
 * consume.
 */

// ============================================================================
// Session summary
// ============================================================================

/** Status of a session file as classified by discovery. */
export type OmpSessionStatus = "resumable" | "active" | "missing" | "invalid";

/** Lightweight summary of a session file for the sidebar list. */
export interface OmpSessionSummary {
  /** OMP session id from the header line, if available. */
  id: string;
  /** Absolute path to the JSONL file. This is the durable resume identity. */
  path: string;
  /** Workspace folder this session belongs to. */
  workspaceFolder: string;
  /** Display title: header title → first user prompt → header id → filename. */
  title: string;
  /** Whether this session can be resumed. */
  status: OmpSessionStatus;
  /** Epoch ms when the session was created, if available. */
  createdAt?: number;
  /** Epoch ms when the session file was last modified. Always present for listed sessions. */
  updatedAt: number;
  /** First user-message preview text, truncated for list display. */
  firstMessage?: string;
  /** Last assistant-message preview text, truncated for list display. */
  lastMessagePreview?: string;
  /** Number of messages in the session, if known. */
  messageCount?: number;
  /** Model used in the session, if known. */
  model?: string;
  /** Thinking level used in the session, if known. */
  thinking?: string;
  /** Usage statistics, if available from the session header or summary. */
  usage?: {
    totalRequests?: number;
    totalCostUsd?: number;
    inputTokens?: number;
    outputTokens?: number;
  };
}

// ============================================================================
// Session list state (discriminated union for webview)
// ============================================================================

/** State of the session list in the sidebar. */
export type OmpSessionListState =
  | { kind: "loading"; workspaceFolder?: string }
  | { kind: "empty"; workspaceFolder: string }
  | {
      kind: "ready";
      workspaceFolder: string;
      sessions: OmpSessionSummary[];
      selectedSessionPath?: string;
    }
  | { kind: "error"; workspaceFolder?: string; message: string; retryable: boolean };

// ============================================================================
// Resume path validation
// ============================================================================

/** Result of validating a session path for resume. */
export type OmpResumeValidation = "ok" | "missing" | "invalid";

// ============================================================================
// Discovery service interface
// ============================================================================

/**
 * Service contract for enumerating workspace sessions.
 *
 * Implemented in later slices. Defined here so consumers can depend on
 * the interface without pulling in file-reading machinery.
 */
export interface SessionDiscoveryService {
  /** List sessions for the given workspace folder, sorted by mtime descending. */
  listWorkspaceSessions(workspaceFolder: string): Promise<OmpSessionSummary[]>;

  /** Validate whether a session path is safe to pass to `--resume`. */
  validateResumePath(sessionPath: string): Promise<OmpResumeValidation>;
}
