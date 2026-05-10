import { useState, useEffect, useRef } from "react";
import { useAppState, type SessionSummary } from "../state/store";
import { getVSCodeAPI } from "../vscode";

interface SessionPanelProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Slide-out session panel. Animates in from the right side, full height.
 * Lists all workspace sessions with search. Clicking a session switches to it.
 */
export function SessionPanel({ open, onClose }: SessionPanelProps) {
  const { runtime, sessionList } = useAppState();
  const [search, setSearch] = useState("");
  const [pendingDelete, setPendingDelete] = useState<SessionSummary | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const sessions = sessionList.kind === "ready" ? sessionList.sessions : [];
  const filtered = filterSessions(sessions, search);

  // Focus search input when panel opens
  useEffect(() => {
    if (open) {
      setSearch("");
      setPendingDelete(null);
      setDeleteError(null);
      setTimeout(() => inputRef.current?.focus(), 150);
      // Request session refresh
      const vscode = getVSCodeAPI();
      vscode.postMessage({ type: "sessions.refresh" });
    }
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    function handleMessage(event: MessageEvent) {
      const msg = event.data;
      if (!msg || msg.type !== "session.deleteResult") return;
      if (msg.success) {
        setPendingDelete(null);
        setDeleteError(null);
      } else {
        setDeleteError(typeof msg.message === "string" ? msg.message : "Session could not be deleted.");
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [open]);

  function handleSelect(path: string) {
    const vscode = getVSCodeAPI();
    vscode.postMessage({ type: "session.resume", sessionPath: path });
    onClose();
  }

  function handleDeleteRequest(session: SessionSummary) {
    setDeleteError(null);
    setPendingDelete(session);
  }

  function handleDeleteConfirm() {
    if (!pendingDelete) return;
    const vscode = getVSCodeAPI();
    vscode.postMessage({ type: "session.delete", sessionPath: pendingDelete.path });
  }

  function isActiveSession(path: string): boolean {
    return (runtime.kind === "ready" || runtime.kind === "streaming") && runtime.sessionPath === path;
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className={`omp-panel-backdrop ${open ? "omp-panel-backdrop--open" : ""}`}
        onClick={onClose}
      />
      {/* Panel */}
      <div
        ref={panelRef}
        className={`omp-session-panel ${open ? "omp-session-panel--open" : ""}`}
        aria-hidden={!open}
      >
        <div className="omp-session-panel-header">
          <span className="omp-session-panel-title">Sessions</span>
          <button className="omp-icon-btn" onClick={onClose} title="Close" aria-label="Close">
            <i className="codicon codicon-close" />
          </button>
        </div>

        <div className="omp-session-panel-search">
          <i className="codicon codicon-search omp-session-panel-search-icon" />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search sessions..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="omp-session-panel-list">
          {sessionList.kind === "loading" && (
            <div className="omp-state-msg">
              <span className="omp-spinner" /> Loading...
            </div>
          )}
          {filtered.length === 0 && sessionList.kind !== "loading" && (
            <div className="omp-state-msg">No sessions found</div>
          )}
          {filtered.map((s) => (
            <div
              key={s.path}
              className="omp-session-panel-item"
              onClick={() => handleSelect(s.path)}
            >
              <div className="omp-session-panel-item-row">
                <span className="omp-session-panel-item-title">{s.title}</span>
                <span className="omp-session-panel-item-time">{formatRelative(s.updatedAt)}</span>
                <button
                  className="omp-session-panel-delete-btn"
                  disabled={isActiveSession(s.path)}
                  title={isActiveSession(s.path) ? "Cannot delete active session" : "Delete session"}
                  aria-label={`Delete session ${s.title}`}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!isActiveSession(s.path)) handleDeleteRequest(s);
                  }}
                >
                  <i className="codicon codicon-trash" />
                </button>
              </div>
              {s.firstMessage && (
                <div className="omp-session-panel-item-preview">
                  {s.firstMessage.length > 60 ? s.firstMessage.slice(0, 60) + "…" : s.firstMessage}
                </div>
              )}
            </div>
          ))}
        </div>

        {pendingDelete && (
          <div className="omp-session-delete-overlay" role="dialog" aria-modal="true" aria-label="Delete session confirmation">
            <div className="omp-session-delete-card">
              <div className="omp-session-delete-icon">
                <i className="codicon codicon-trash" />
              </div>
              <div className="omp-session-delete-title">Delete this session?</div>
              <div className="omp-session-delete-message">
                This will permanently remove <span>{pendingDelete.title}</span> from this workspace.
              </div>
              {deleteError && <div className="omp-session-delete-error">{deleteError}</div>}
              <div className="omp-session-delete-actions">
                <button className="omp-session-delete-cancel" onClick={() => setPendingDelete(null)}>Cancel</button>
                <button className="omp-session-delete-confirm" onClick={handleDeleteConfirm}>Yes, delete</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────

function filterSessions(sessions: SessionSummary[], query: string): SessionSummary[] {
  if (!query) return sessions;
  const q = query.toLowerCase();
  return sessions.filter(
    (s) =>
      s.title?.toLowerCase().includes(q) || s.firstMessage?.toLowerCase().includes(q),
  );
}

function formatRelative(epochMs: number): string {
  if (!epochMs) return "";
  const diff = Date.now() - epochMs;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
