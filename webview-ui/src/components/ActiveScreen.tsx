import { useEffect, useRef, useState, useCallback } from "react";
import { useAppState } from "../state/store";
import { getVSCodeAPI } from "../vscode";
import { ChatHeader } from "./ChatHeader";
import { ChatFooter } from "./ChatFooter";
import { TurnView } from "./TurnView";

/** Threshold in px: if user is within this distance of bottom, auto-scroll is active. */
const SCROLL_NEAR_BOTTOM = 80;

export function ActiveScreen() {
  const { selection, turnTranscript, footerRuntime } = useAppState();
  const transcriptRef = useRef<HTMLDivElement>(null);
  const [userScrolledUp, setUserScrolledUp] = useState(false);

  // Track user scroll position to determine if they've scrolled up
  const handleScroll = useCallback(() => {
    const el = transcriptRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setUserScrolledUp(distanceFromBottom > SCROLL_NEAR_BOTTOM);
  }, []);

  // Auto-scroll when content changes — only if user hasn't scrolled up
  useEffect(() => {
    if (userScrolledUp) return;
    const el = transcriptRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  });

  // Jump to bottom handler
  const scrollToBottom = useCallback(() => {
    const el = transcriptRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setUserScrolledUp(false);
  }, []);

  function handleSend(content: string, behavior?: "steer" | "followUp" | "forceSend") {
    const vscode = getVSCodeAPI();
    const sessionPath = selection.kind === "active" ? selection.sessionPath : "";
    vscode.postMessage({ type: "chat.send", sessionPath, content, behavior });
    // After sending, always scroll to bottom
    setUserScrolledUp(false);
    requestAnimationFrame(() => {
      const el = transcriptRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  if (selection.kind === "launching") {
    return (
      <div className="omp-active">
        <div className="omp-state-msg">
          <span className="omp-spinner" /> Launching session...
        </div>
      </div>
    );
  }

  if (selection.kind === "failed") {
    return (
      <div className="omp-active">
        <div className="omp-error-msg">{selection.message}</div>
      </div>
    );
  }

  const isStreaming = footerRuntime.state === "streaming" || footerRuntime.state === "tool";

  return (
    <div className="omp-active-layout">
      <ChatHeader />
      <div className="omp-transcript" ref={transcriptRef} onScroll={handleScroll}>
        {turnTranscript.turns.length === 0 ? (
          <div className="omp-state-msg omp-transcript-empty">
            Session active. Send a message to begin.
          </div>
        ) : (
          turnTranscript.turns.map((turn) => <TurnView key={turn.id} turn={turn} />)
        )}
      </div>
      {/* Floating scroll-to-bottom button */}
      {userScrolledUp && (
        <button
          className="omp-scroll-to-bottom"
          onClick={scrollToBottom}
          title="Scroll to bottom"
          aria-label="Scroll to bottom"
        >
          <i className="codicon codicon-arrow-down" />
        </button>
      )}
      <ChatFooter onSubmit={handleSend} isStreaming={isStreaming} />
    </div>
  );
}
