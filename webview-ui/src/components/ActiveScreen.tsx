import { useEffect, useRef } from "react";
import { useAppState } from "../state/store";
import { getVSCodeAPI } from "../vscode";
import { Composer } from "./Composer";
import { TurnView } from "./TurnView";

export function ActiveScreen() {
  const { selection, turnTranscript } = useAppState();
  const transcriptRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new content
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [turnTranscript.turns]);

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
          {turnTranscript.turns.length === 0 ? (
            <div className="omp-state-msg omp-transcript-empty">
              Session active. Send a message to begin.
            </div>
          ) : (
            turnTranscript.turns.map((turn) => <TurnView key={turn.id} turn={turn} />)
          )}
        </div>
      </div>
      <Composer onSubmit={handleSend} />
    </>
  );
}
