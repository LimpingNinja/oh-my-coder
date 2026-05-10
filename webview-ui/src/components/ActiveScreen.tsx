import { useEffect, useRef, useState, useCallback, type DragEvent } from "react";
import { clearComposerFileContexts, clearComposerImageAttachments, useAppState } from "../state/store";
import { getVSCodeAPI } from "../vscode";
import { ChatHeader } from "./ChatHeader";
import { ChatFooter } from "./ChatFooter";
import { AssistantActivity } from "./AssistantActivity";
import { attachImageFiles, collectImageFiles, hasFileDrag } from "./Composer";
import { TurnView } from "./TurnView";

/** Threshold in px: if user is within this distance of bottom, auto-scroll is active. */
const SCROLL_NEAR_BOTTOM = 80;
const DRAG_ACTIVE_TTL_MS = 220;

export function ActiveScreen() {
  const { selection, turnTranscript, footerRuntime, composerFileContexts, composerImageAttachments } = useAppState();
  const transcriptRef = useRef<HTMLDivElement>(null);
  const transcriptContentRef = useRef<HTMLDivElement>(null);
  const dragActiveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pinnedToBottom = useRef(true);
  const [userScrolledUp, setUserScrolledUp] = useState(false);
  const [dragActive, setDragActive] = useState(false);

  useEffect(() => {
    return () => {
      if (dragActiveTimer.current) clearTimeout(dragActiveTimer.current);
    };
  }, []);

  const clearDragActive = useCallback(() => {
    if (dragActiveTimer.current) {
      clearTimeout(dragActiveTimer.current);
      dragActiveTimer.current = null;
    }
    setDragActive(false);
  }, []);

  const keepDragActive = useCallback(() => {
    if (dragActiveTimer.current) clearTimeout(dragActiveTimer.current);
    setDragActive(true);
    dragActiveTimer.current = setTimeout(() => {
      setDragActive(false);
      dragActiveTimer.current = null;
    }, DRAG_ACTIVE_TTL_MS);
  }, []);

  const acceptFileDrag = useCallback((e: DragEvent<HTMLDivElement>): boolean => {
    if (!hasFileDrag(e.dataTransfer)) return false;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
    keepDragActive();
    return true;
  }, [keepDragActive]);

  const handleDragEnter = useCallback((e: DragEvent<HTMLDivElement>) => {
    acceptFileDrag(e);
  }, [acceptFileDrag]);

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    acceptFileDrag(e);
  }, [acceptFileDrag]);

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!hasFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(async (e: DragEvent<HTMLDivElement>) => {
    if (!hasFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    clearDragActive();

    const files = collectImageFiles(e.dataTransfer);
    if (files.length === 0) return;
    await attachImageFiles(files);
  }, [clearDragActive]);

  // Track user scroll position to determine if they've scrolled up
  const handleScroll = useCallback(() => {
    const el = transcriptRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const scrolledUp = distanceFromBottom > SCROLL_NEAR_BOTTOM;
    pinnedToBottom.current = !scrolledUp;
    setUserScrolledUp(scrolledUp);
  }, []);

  useEffect(() => {
    const el = transcriptRef.current;
    const contentEl = transcriptContentRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => {
      if (!pinnedToBottom.current) return;
      el.scrollTop = el.scrollHeight;
    });

    observer.observe(contentEl ?? el);
    return () => observer.disconnect();
  }, []);

  // Auto-scroll when content changes — only if user hasn't scrolled up
  useEffect(() => {
    if (userScrolledUp) return;
    const el = transcriptRef.current;
    if (!el) return;
    pinnedToBottom.current = true;
    el.scrollTop = el.scrollHeight;
  });

  // Jump to bottom handler
  const scrollToBottom = useCallback(() => {
    const el = transcriptRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    pinnedToBottom.current = true;
    setUserScrolledUp(false);
  }, []);

  function handleSend(content: string, behavior?: "steer" | "followUp" | "forceSend") {
    const vscode = getVSCodeAPI();
    const sessionPath = selection.kind === "active" ? selection.sessionPath : "";
    vscode.postMessage({
      type: "chat.send",
      sessionPath,
      content,
      behavior,
      attachments: composerImageAttachments.map((attachment) => ({
        type: "image" as const,
        data: attachment.data,
        mediaType: attachment.mediaType,
      })),
      fileContexts: composerFileContexts.map((context) => ({
        path: context.path,
        languageId: context.languageId,
        line: context.line,
        endLine: context.endLine,
      })),
    });
    clearComposerFileContexts();
    clearComposerImageAttachments();
    // After sending, always scroll to bottom
    pinnedToBottom.current = true;
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
    <div
      className={`omp-active-layout${dragActive ? " omp-active-layout--drag-active" : ""}`}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dragActive && (
        <div className="omp-active-drop-indicator" aria-hidden="true">
          <i className="codicon codicon-cloud-upload" />
          <span>Drop image to attach</span>
        </div>
      )}
      <ChatHeader />
      <div className="omp-transcript" ref={transcriptRef} onScroll={handleScroll}>
        {turnTranscript.turns.length === 0 ? (
          <div className="omp-state-msg omp-transcript-empty">
            Session active. Send a message to begin.
          </div>
        ) : (
          <div className="omp-transcript-content" ref={transcriptContentRef}>
            {turnTranscript.turns.map((turn) => <TurnView key={turn.id} turn={turn} />)}
            <AssistantActivity turns={turnTranscript.turns} runtime={footerRuntime} />
          </div>
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
      <ChatFooter onSubmit={handleSend} isStreaming={isStreaming} dragActive={dragActive} />
    </div>
  );
}
