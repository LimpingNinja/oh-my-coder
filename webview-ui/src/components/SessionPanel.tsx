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
  const { sessionList } = useAppState();
  const [search, setSearch] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const sessions = sessionList.kind === "ready" ? sessionList.sessions : [];
  const filtered = filterSessions(sessions, search);

  // Focus search input when panel opens
  useEffect(() => {
    if (open) {
      setSearch("");
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

  function handleSelect(path: string) {
    const vscode = getVSCodeAPI();
    vscode.postMessage({ type: "session.resume", sessionPath: path });
    onClose();
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
              </div>
              {s.firstMessage && (
                <div className="omp-session-panel-item-preview">
                  {s.firstMessage.length > 60 ? s.firstMessage.slice(0, 60) + "…" : s.firstMessage}
                </div>
              )}
            </div>
          ))}
        </div>
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
