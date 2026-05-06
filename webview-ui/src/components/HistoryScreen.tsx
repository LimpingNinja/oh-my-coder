import { useAppState, setScreen, setHistorySearch } from "../state/store";
import { getVSCodeAPI } from "../vscode";

export function HistoryScreen() {
  const { sessionList, historySearch } = useAppState();
  const sessions = sessionList.kind === "ready" ? sessionList.sessions : [];
  const filtered = filterSessions(sessions, historySearch);
  const grouped = groupByDate(filtered);

  function handleResume(path: string) {
    const vscode = getVSCodeAPI();
    vscode.postMessage({ type: "session.resume", sessionPath: path });
  }

  function handleExport(path: string) {
    const vscode = getVSCodeAPI();
    vscode.postMessage({ type: "session.openTranscript", sessionPath: path });
  }

  return (
    <div className="omp-history">
      {/* Header */}
      <div className="omp-history-header">
        <button
          className="omp-link-btn"
          onClick={() => {
            setHistorySearch("");
            setScreen("home");
          }}
        >
          ← Back
        </button>
        <div className="omp-history-actions">
          <button className="omp-link-btn omp-small" disabled>
            Import session
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="omp-search-bar">
        <input
          type="text"
          placeholder="Search sessions..."
          value={historySearch}
          onChange={(e) => setHistorySearch(e.target.value)}
          autoFocus
        />
      </div>

      {/* List */}
      <div className="omp-history-list">
        {sessionList.kind === "loading" && (
          <div className="omp-state-msg">
            <span className="omp-spinner" /> Loading...
          </div>
        )}

        {filtered.length === 0 && sessionList.kind !== "loading" && (
          <div className="omp-state-msg">No sessions found</div>
        )}

        {grouped.map((group) => (
          <div key={group.label}>
            <div className="omp-date-group">{group.label}</div>
            {group.sessions.map((s) => (
              <div key={s.path} className="omp-history-item" onClick={() => handleResume(s.path)}>
                <div className="omp-history-item-row">
                  <span className="omp-history-title">{s.title}</span>
                  <span className="omp-history-time">{formatRelativeTime(s.updatedAt)}</span>
                </div>
                {s.firstMessage && (
                  <div className="omp-history-preview">{truncate(s.firstMessage, 80)}</div>
                )}
                <div className="omp-history-meta">
                  {s.messageCount && <span>{s.messageCount} msgs</span>}
                  {s.model && <span> · {s.model}</span>}
                  <button
                    className="omp-export-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleExport(s.path);
                    }}
                    title="Export / Open transcript"
                  >
                    ↓ Export
                  </button>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────

interface SessionSummary {
  path: string;
  title: string;
  updatedAt: number;
  firstMessage?: string;
  messageCount?: number;
  model?: string;
}

function filterSessions(sessions: SessionSummary[], query: string): SessionSummary[] {
  if (!query) return sessions;
  const q = query.toLowerCase();
  return sessions.filter(
    (s) =>
      s.title?.toLowerCase().includes(q) || s.firstMessage?.toLowerCase().includes(q),
  );
}

function groupByDate(sessions: SessionSummary[]) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = today - 86400000;
  const weekAgo = today - 7 * 86400000;

  const groups: { label: string; sessions: SessionSummary[] }[] = [];
  const todayG: SessionSummary[] = [];
  const yesterdayG: SessionSummary[] = [];
  const weekG: SessionSummary[] = [];
  const olderG: SessionSummary[] = [];

  for (const s of sessions) {
    if (s.updatedAt >= today) todayG.push(s);
    else if (s.updatedAt >= yesterday) yesterdayG.push(s);
    else if (s.updatedAt >= weekAgo) weekG.push(s);
    else olderG.push(s);
  }

  if (todayG.length) groups.push({ label: "Today", sessions: todayG });
  if (yesterdayG.length) groups.push({ label: "Yesterday", sessions: yesterdayG });
  if (weekG.length) groups.push({ label: "This Week", sessions: weekG });
  if (olderG.length) groups.push({ label: "Older", sessions: olderG });

  return groups;
}

function formatRelativeTime(epochMs: number): string {
  if (!epochMs) return "";
  const diff = Date.now() - epochMs;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(epochMs).toLocaleDateString();
}

function truncate(str: string, len: number): string {
  return str.length > len ? str.slice(0, len) + "…" : str;
}
