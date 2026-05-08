/**
 * UiRequestTurn — renders an extension UI request as an interactive inline card.
 *
 * Once the user responds, the card becomes read-only showing what was asked
 * and what was answered. If cancelled (by runtime or user), shows cancelled state.
 */

import { useState, useRef, useCallback } from "react";
import { getVSCodeAPI } from "../vscode";
import { getState, setTurnTranscript } from "../state/store";
import type { UiRequestData, UiResponseData } from "../state/turns";

interface UiRequestTurnProps {
  turnId: string;
  request: UiRequestData;
  response?: UiResponseData;
}

export function UiRequestTurn({ turnId, request, response }: UiRequestTurnProps) {
  if (response) {
    return <AnsweredCard request={request} response={response} />;
  }

  switch (request.method) {
    case "confirm":
      return <ConfirmDialog turnId={turnId} request={request} />;
    case "select":
      return <SelectDialog turnId={turnId} request={request} />;
    case "input":
      return <InputDialog turnId={turnId} request={request} />;
    case "editor":
      return <EditorDialog turnId={turnId} request={request} />;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function sendResponse(turnId: string, requestId: string, responsePayload: Record<string, unknown>) {
  const vscode = getVSCodeAPI();
  vscode.postMessage({ type: "extensionUi.respond", requestId, response: responsePayload });

  // Mark the turn as answered in state
  const { turnTranscript } = getState();
  const turns = turnTranscript.turns.map((t) => {
    if (t.id === turnId && t.kind === "ui-request") {
      let uiResponse: UiResponseData;
      if ("value" in responsePayload) {
        uiResponse = { kind: "value", value: responsePayload.value as string };
      } else if ("confirmed" in responsePayload) {
        uiResponse = { kind: "confirmed", confirmed: responsePayload.confirmed as boolean };
      } else {
        uiResponse = { kind: "cancelled" };
      }
      return { ...t, response: uiResponse };
    }
    return t;
  });
  setTurnTranscript({ ...turnTranscript, turns });
}

function cancelRequest(turnId: string, requestId: string) {
  sendResponse(turnId, requestId, { cancelled: true });
}

// ── Answered (read-only) ──────────────────────────────────────────────────

function AnsweredCard({ request, response }: { request: UiRequestData; response: UiResponseData }) {
  const title = request.title;
  let answerText: string;

  if (response.kind === "cancelled") {
    answerText = "Cancelled";
  } else if (response.kind === "confirmed") {
    answerText = response.confirmed ? "Yes" : "No";
  } else {
    answerText = response.value;
  }

  return (
    <div className="omp-turn omp-turn-ui-request omp-turn-ui-request--answered">
      <div className="omp-ui-card">
        <div className="omp-ui-card-header">
          <i className="codicon codicon-question" />
          <span className="omp-ui-card-title">{title}</span>
        </div>
        <div className="omp-ui-card-answer">
          <span className={`omp-ui-answer-badge ${response.kind === "cancelled" ? "omp-ui-answer-badge--cancelled" : ""}`}>
            {answerText}
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Confirm ──────────────────────────────────────────────────────────────

function ConfirmDialog({ turnId, request }: { turnId: string; request: Extract<UiRequestData, { method: "confirm" }> }) {
  return (
    <div className="omp-turn omp-turn-ui-request">
      <div className="omp-ui-card">
        <div className="omp-ui-card-header">
          <i className="codicon codicon-question" />
          <span className="omp-ui-card-title">{request.title}</span>
        </div>
        <div className="omp-ui-card-body">
          <p className="omp-ui-card-message">{request.message}</p>
        </div>
        <div className="omp-ui-card-actions">
          <button
            className="omp-ui-btn omp-ui-btn--primary"
            onClick={() => sendResponse(turnId, request.requestId, { confirmed: true })}
          >
            Yes
          </button>
          <button
            className="omp-ui-btn"
            onClick={() => sendResponse(turnId, request.requestId, { confirmed: false })}
          >
            No
          </button>
          <button
            className="omp-ui-btn omp-ui-btn--ghost"
            onClick={() => cancelRequest(turnId, request.requestId)}
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Select ──────────────────────────────────────────────────────────────

function SelectDialog({ turnId, request }: { turnId: string; request: Extract<UiRequestData, { method: "select" }> }) {
  return (
    <div className="omp-turn omp-turn-ui-request">
      <div className="omp-ui-card">
        <div className="omp-ui-card-header">
          <i className="codicon codicon-list-selection" />
          <span className="omp-ui-card-title">{request.title}</span>
        </div>
        <div className="omp-ui-card-body">
          <div className="omp-ui-select-options">
            {request.options.map((option, i) => (
              <button
                key={i}
                className="omp-ui-select-option"
                onClick={() => sendResponse(turnId, request.requestId, { value: option })}
              >
                {option}
              </button>
            ))}
          </div>
        </div>
        <div className="omp-ui-card-actions">
          <button
            className="omp-ui-btn omp-ui-btn--ghost"
            onClick={() => cancelRequest(turnId, request.requestId)}
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Input ──────────────────────────────────────────────────────────────

function InputDialog({ turnId, request }: { turnId: string; request: Extract<UiRequestData, { method: "input" }> }) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = useCallback(() => {
    if (value.trim()) {
      sendResponse(turnId, request.requestId, { value: value.trim() });
    }
  }, [value, turnId, request.requestId]);

  return (
    <div className="omp-turn omp-turn-ui-request">
      <div className="omp-ui-card">
        <div className="omp-ui-card-header">
          <i className="codicon codicon-edit" />
          <span className="omp-ui-card-title">{request.title}</span>
        </div>
        <div className="omp-ui-card-body">
          <input
            ref={inputRef}
            type="text"
            className="omp-ui-input"
            placeholder={request.placeholder ?? ""}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); }}
            autoFocus
          />
        </div>
        <div className="omp-ui-card-actions">
          <button
            className="omp-ui-btn omp-ui-btn--primary"
            onClick={handleSubmit}
            disabled={!value.trim()}
          >
            Submit
          </button>
          <button
            className="omp-ui-btn omp-ui-btn--ghost"
            onClick={() => cancelRequest(turnId, request.requestId)}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Editor ──────────────────────────────────────────────────────────────

function EditorDialog({ turnId, request }: { turnId: string; request: Extract<UiRequestData, { method: "editor" }> }) {
  const [value, setValue] = useState(request.prefill ?? "");

  const handleSubmit = useCallback(() => {
    sendResponse(turnId, request.requestId, { value });
  }, [value, turnId, request.requestId]);

  return (
    <div className="omp-turn omp-turn-ui-request">
      <div className="omp-ui-card">
        <div className="omp-ui-card-header">
          <i className="codicon codicon-notebook" />
          <span className="omp-ui-card-title">{request.title}</span>
        </div>
        <div className="omp-ui-card-body">
          <textarea
            className="omp-ui-editor"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            rows={6}
            autoFocus
          />
        </div>
        <div className="omp-ui-card-actions">
          <button
            className="omp-ui-btn omp-ui-btn--primary"
            onClick={handleSubmit}
          >
            Submit
          </button>
          <button
            className="omp-ui-btn omp-ui-btn--ghost"
            onClick={() => cancelRequest(turnId, request.requestId)}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
