import { useState, useRef, useCallback, useEffect } from "react";
import { getVSCodeAPI } from "../vscode";
import { getState } from "../state/store";

interface SendButtonProps {
  isStreaming: boolean;
  interruptMode?: "immediate" | "wait";
  onSend: (behavior?: "steer" | "followUp" | "forceSend") => void;
}

/**
 * Context-aware send button.
 *
 * When idle: simple send icon.
 * When streaming: shows default behavior icon. Long-press (400ms) reveals
 * a 3-option popup: Follow-up, Steer, Force Send.
 */
export function SendButton({ isStreaming, interruptMode, onSend }: SendButtonProps) {
  const [popupOpen, setPopupOpen] = useState(false);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didLongPress = useRef(false);

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (pressTimer.current) clearTimeout(pressTimer.current);
    };
  }, []);

  const handleMouseDown = useCallback(() => {
    if (!isStreaming) return; // No long-press when idle
    didLongPress.current = false;
    pressTimer.current = setTimeout(() => {
      didLongPress.current = true;
      setPopupOpen(true);
    }, 400);
  }, [isStreaming]);

  const handleMouseUp = useCallback(() => {
    if (pressTimer.current) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
    // Normal click (not long-press) during streaming: send with default
    if (isStreaming && !didLongPress.current && !popupOpen) {
      onSend(interruptMode === "immediate" ? "steer" : "followUp");
    }
  }, [isStreaming, interruptMode, onSend, popupOpen]);

  const handleClick = useCallback(() => {
    if (!isStreaming) {
      onSend(undefined); // Normal send
    }
    // Streaming click handled in mouseUp
  }, [isStreaming, onSend]);

  const handleOption = useCallback((behavior: "steer" | "followUp" | "forceSend") => {
    setPopupOpen(false);
    onSend(behavior);
  }, [onSend]);

  const handleAbort = useCallback(() => {
    const vscode = getVSCodeAPI();
    const { selection } = getState();
    if (selection.kind === "active") {
      vscode.postMessage({ type: "chat.abort", sessionPath: selection.sessionPath });
    }
  }, []);

  // Default icon during streaming based on interruptMode
  const streamingIcon = interruptMode === "immediate" ? "codicon-milestone" : "codicon-git-compare";
  const streamingTitle = interruptMode === "immediate" ? "Send as steering (hold for options)" : "Send as follow-up (hold for options)";

  if (isStreaming) {
    return (
      <div className="omp-send-wrap">
        {/* Popup */}
        {popupOpen && (
          <div className="omp-send-popup">
            <button className="omp-send-option" onClick={() => handleOption("followUp")}>
              <i className="codicon codicon-git-compare" />
              <span>Follow-up</span>
            </button>
            <button className="omp-send-option" onClick={() => handleOption("steer")}>
              <i className="codicon codicon-milestone" />
              <span>Steer</span>
            </button>
            <button className="omp-send-option omp-send-option--force" onClick={() => handleOption("forceSend")}>
              <i className="codicon codicon-stop-circle" />
              <span>Force Send</span>
            </button>
          </div>
        )}
        {popupOpen && (
          <div className="omp-send-popup-backdrop" onClick={() => setPopupOpen(false)} />
        )}
        {/* Main buttons */}
        <button
          className="omp-icon-btn-circle omp-icon-btn-circle--stop"
          onClick={handleAbort}
          title="Stop"
        >
          <i className="codicon codicon-debug-stop" />
        </button>
        <button
          className="omp-icon-btn-circle omp-icon-btn-circle--send"
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
          onClick={handleClick}
          title={streamingTitle}
        >
          <i className={`codicon ${streamingIcon}`} />
        </button>
      </div>
    );
  }

  return (
    <div className="omp-send-wrap">
      <button
        className="omp-icon-btn-circle omp-icon-btn-circle--send"
        onClick={handleClick}
        title="Send"
      >
        <i className="codicon codicon-send" />
      </button>
    </div>
  );
}
