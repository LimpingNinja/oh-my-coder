import { useState, useCallback } from "react";
import { setHeaderDetailsOpen, setTodosExpanded, useAppState } from "../state/store";
import { getVSCodeAPI } from "../vscode";
import { getAssetUri } from "../utils/assets";
import { SessionPanel } from "./SessionPanel";
import { TaskWaveform } from "./TaskWaveform";

/** OMP logo — renders the square icon asset at the given size. */
function OmpLogo({ size = 20 }: { size?: number }) {
  return (
    <img
      src={getAssetUri("logoIcon")}
      width={size}
      height={size}
      className="omp-header-logo"
      aria-hidden="true"
      alt=""
    />
  );
}

/**
 * Sticky header for the active session view.
 *
 * Row 1: connection dot + session name (editable) | icon buttons (compact, sessions, details)
 * Row 2 (expandable): cost + context + token counts
 */
export function ChatHeader() {
  const { header, todos, webviewPrefs } = useAppState();
  const detailsOpen = webviewPrefs.chat.headerDetailsOpen;
  const todosExpanded = webviewPrefs.chat.todosExpanded;
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [sessionPanelOpen, setSessionPanelOpen] = useState(false);

  const connectionClass =
    header.connection === "connected"
      ? "omp-header-dot--connected"
      : header.connection === "connecting"
        ? "omp-header-dot--connecting"
        : "omp-header-dot--disconnected";

  const handleRename = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== header.sessionName) {
      const vscode = getVSCodeAPI();
      vscode.postMessage({
        type: "session.rename",
        sessionPath: header.sessionPath,
        title: trimmed,
      });
    }
    setEditing(false);
  }, [editValue, header.sessionName, header.sessionPath]);

  const handleCompact = useCallback(() => {
    const vscode = getVSCodeAPI();
    vscode.postMessage({ type: "runtime.compact" });
  }, []);

  const startEdit = useCallback(() => {
    setEditValue(header.sessionName);
    setEditing(true);
  }, [header.sessionName]);

  const handleOpenTranscript = useCallback(() => {
    if (header.sessionPath) {
      const vscode = getVSCodeAPI();
      vscode.postMessage({ type: "session.openTranscript", sessionPath: header.sessionPath });
    }
  }, [header.sessionPath]);

  const handleScrollToTurn = useCallback((turnId: string) => {
    // Find the turn's DOM element in the transcript and scroll to it
    const el = document.querySelector(`[data-turn-id="${turnId}"]`) as HTMLElement | null;
    if (!el) return;
    // Find the scrollable transcript container
    const container = el.closest(".omp-transcript") as HTMLElement | null;
    if (container) {
      // Calculate scroll position to center the element
      const elTop = el.offsetTop - container.offsetTop;
      const centerOffset = elTop - container.clientHeight / 2 + el.clientHeight / 2;
      container.scrollTo({ top: centerOffset, behavior: "smooth" });
    } else {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    // Brief highlight flash
    el.classList.add("omp-turn--highlight");
    setTimeout(() => el.classList.remove("omp-turn--highlight"), 1500);
  }, []);

  // Flatten all todo tasks across phases
  const allTasks = todos.flatMap((phase) => phase.tasks);
  const completedCount = allTasks.filter((t) => t.status === "completed" || t.status === "done").length;

  return (
    <>
      <header className="omp-header" aria-label="Session header">
        {/* Row 1 */}
        <div className="omp-header-row">
        <div className="omp-header-left">
          <div className="omp-header-logo-wrap">
            <OmpLogo size={28} />
            <span className={`omp-header-dot ${connectionClass}`} aria-label={header.connection} />
          </div>
          {editing ? (
              <input
                className="omp-header-name-input"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={handleRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleRename();
                  if (e.key === "Escape") setEditing(false);
                }}
                autoFocus
              />
            ) : (
              <span className="omp-header-name" onClick={startEdit} title="Click to rename">
                {header.sessionName}
                <i className="codicon codicon-edit omp-header-edit-icon" />
              </span>
            )}
          </div>
          <div className="omp-header-right">
            <span className="omp-header-cost" data-tip={header.costUsd != null ? `Total: $${header.costUsd.toFixed(4)}` : undefined}>
              {header.costUsd != null ? `$${header.costUsd.toFixed(2)}` : "—"}
            </span>
            <span className="omp-header-context" data-tip={header.contextPercent != null ? `Context: ${header.contextPercent}% used` : undefined}>
              {header.contextPercent != null ? `${header.contextPercent}%` : "—"}
            </span>
            {header.canCompact && (
              <button
                className="omp-icon-btn-circle"
                onClick={handleCompact}
                data-tip="Compact"
                aria-label="Compact context"
              >
                <i className="codicon codicon-fold" />
              </button>
            )}
            <button
              className="omp-icon-btn-circle"
              onClick={handleOpenTranscript}
              data-tip="Open in editor"
              aria-label="Open transcript in editor"
            >
              <i className="codicon codicon-go-to-file" />
            </button>
            <button
              className="omp-icon-btn-circle"
              onClick={() => setSessionPanelOpen(true)}
              data-tip="Sessions"
              aria-label="Switch session"
            >
              <i className="codicon codicon-history" />
            </button>
            <button
              className="omp-icon-btn-circle"
              onClick={() => setHeaderDetailsOpen(!detailsOpen)}
              data-tip={detailsOpen ? "Hide details" : "Details"}
              aria-label="Toggle token details"
              aria-expanded={detailsOpen}
            >
              <i className={`codicon codicon-chevron-${detailsOpen ? "up" : "down"}`} />
            </button>
          </div>
        </div>

         {/* Row 2: expandable token details with waveform + context progress bar */}
         {detailsOpen && (
           <div className="omp-header-details">
             <TaskWaveform onScrollToTurn={handleScrollToTurn} />
             {header.tokens ? (
               <>
                 <div className="omp-context-progress">
                   <span className="omp-context-count">{formatTokenCount(header.tokens.input + header.tokens.output)}</span>
                   <div
                     className="omp-context-bar"
                     title={`Used: ${formatTokenCount(header.tokens.input + header.tokens.output)} | Cache: ${formatTokenCount(header.tokens.cacheRead)} | Context: ${header.contextPercent ?? "?"}%`}
                   >
                     <div
                       className={`omp-context-used ${(header.contextPercent ?? 0) >= 50 ? "omp-context-used--hot" : ""}`}
                       style={{ width: `${Math.min(header.contextPercent ?? 0, 100)}%` }}
                     />
                   </div>
                   <span className="omp-context-count omp-context-count--muted">{header.contextPercent ?? 0}%</span>
                 </div>
                 <div className="omp-header-tokens">
                   <span className="omp-token-up" title="Input tokens">↑ {formatTokenCount(header.tokens.input)}</span>
                   <span className="omp-token-down" title="Output tokens">↓ {formatTokenCount(header.tokens.output)}</span>
                   <span className="omp-token-cache" title="Cache read tokens">⟳ {formatTokenCount(header.tokens.cacheRead)}</span>
                 </div>
               </>
             ) : (
               <span className="omp-header-tokens omp-header-tokens--unavailable">
                 Token data unavailable
               </span>
             )}
            </div>
          )}

         {/* Row 3: conditional todo summary */}
        {allTasks.length > 0 && (
          <div className="omp-header-todos">
            <button
              className="omp-header-todos-toggle"
              onClick={() => setTodosExpanded(!todosExpanded)}
              aria-expanded={todosExpanded}
            >
              <i className="codicon codicon-checklist" />
              <span>
                {completedCount}/{allTasks.length} done
              </span>
              <i className={`codicon codicon-chevron-${todosExpanded ? "up" : "down"} omp-header-todos-chevron`} />
            </button>
            {todosExpanded && (
              <ul className="omp-header-todos-list">
                {allTasks.map((task) => (
                  <li key={task.id} className={`omp-header-todo-item omp-header-todo-item--${task.status}`}>
                    <i className={`codicon ${todoStatusIcon(task.status)}`} />
                    <span>{task.content}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </header>

      {/* Session switch panel */}
      <SessionPanel open={sessionPanelOpen} onClose={() => setSessionPanelOpen(false)} />
    </>
  );
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function todoStatusIcon(status: string): string {
  switch (status) {
    case "completed":
    case "done":
      return "codicon-pass-filled";
    case "in_progress":
    case "running":
      return "codicon-record";
    case "cancelled":
      return "codicon-close";
    default:
      return "codicon-circle-large-outline";
  }
}
