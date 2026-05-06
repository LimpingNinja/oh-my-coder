import { useEffect, useRef } from "react";
import { useAppState } from "../state/store";
import { getVSCodeAPI } from "../vscode";
import { Composer } from "./Composer";
import { MessageBubble } from "./MessageBubble";

export function ActiveScreen() {
  const { selection, transcript } = useAppState();
  const transcriptRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [transcript]);

  function handleSend(content: string) {
    const vscode = getVSCodeAPI();
    const sessionPath = selection.kind === "active" ? selection.sessionPath : "";
    vscode.postMessage({ type: "chat.send", sessionPath, content });
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

  return (
    <>
      <div className="omp-active">
        <div className="omp-transcript" ref={transcriptRef}>
          {transcript.length === 0 ? (
            <div className="omp-state-msg omp-transcript-empty">
              Session active. Send a message to begin.
            </div>
          ) : (
            transcript.map((msg) => <MessageBubble key={msg.id} message={msg} />)
          )}
        </div>
      </div>
      <Composer onSubmit={handleSend} />
    </>
  );
}
