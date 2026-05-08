import { useAppState, setScreen } from "../state/store";
import { getVSCodeAPI } from "../vscode";
import { getAssetUri } from "../utils/assets";
import { Composer } from "./Composer";

const MAX_RECENT = 3;

export function HomeScreen() {
  const { sessionList } = useAppState();
  const sessions = sessionList.kind === "ready" ? sessionList.sessions : [];
  const recentSessions = sessions.slice(0, MAX_RECENT);

  function handleStartSession(content: string) {
    const vscode = getVSCodeAPI();
    vscode.postMessage({ type: "session.start", prompt: content });
  }

  function handleResumeSession(path: string) {
    const vscode = getVSCodeAPI();
    vscode.postMessage({ type: "session.resume", sessionPath: path });
  }

  return (
    <>
      <div className="omp-home">
        {/* Hero */}
        <div className="omp-hero">
          <div className="omp-logo">
            <img
              src={getAssetUri("logoFull")}
              alt="Oh My Coder"
              className="omp-hero-lockup"
            />
          </div>
          <p className="omp-welcome">
            Oh My Coder is an OMP-powered AI assistant. Start a session to build features, fix bugs,
            or explore your codebase.
          </p>
        </div>

        {/* Recent sessions */}
        {sessionList.kind === "loading" && (
          <div className="omp-section">
            <div className="omp-state-msg">
              <span className="omp-spinner" /> Loading sessions...
            </div>
          </div>
        )}

        {recentSessions.length > 0 && (
          <div className="omp-section">
            <div className="omp-section-header">RECENT</div>
            {recentSessions.map((s) => (
              <div
                key={s.path}
                className="omp-recent-item"
                onClick={() => handleResumeSession(s.path)}
              >
                <span className="omp-recent-title">{s.title}</span>
                <span className="omp-recent-time">{formatRelativeTime(s.updatedAt)}</span>
              </div>
            ))}
          </div>
        )}

        {sessionList.kind === "empty" && (
          <div className="omp-section">
            <div className="omp-state-msg">No sessions yet. Type below to get started.</div>
          </div>
        )}

        {/* Show History link */}
        {sessions.length > 0 && (
          <div className="omp-show-history">
            <button className="omp-link-btn" onClick={() => setScreen("history")}>
              ↻ Show History
            </button>
          </div>
        )}
      </div>

      <Composer onSubmit={handleStartSession} placeholder="Type a message... (Enter to send)" />
    </>
  );
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
