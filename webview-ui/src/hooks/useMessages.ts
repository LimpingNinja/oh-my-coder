/**
 * Message handler — wires VS Code extension messages to the store.
 */

import { useEffect } from "react";
import { getVSCodeAPI } from "../vscode";
import {
  setSessionList,
  setSelection,
  setRuntime,
  setTranscript,
  upsertMessage,
  updateMessage,
  appendMessage,
  clearTranscript,
  setState,
  getState,
  type TranscriptMessage,
} from "../state/store";

export function useMessageHandler() {
  useEffect(() => {
    const vscode = getVSCodeAPI();

    // Post ready on mount
    vscode.postMessage({ type: "webview.ready" });

    function handleMessage(event: MessageEvent) {
      const msg = event.data;
      if (!msg || typeof msg.type !== "string") return;

      switch (msg.type) {
        case "sessions.state":
          setSessionList(msg.state);
          break;

        case "selection.state":
          setSelection(msg.state);
          break;

        case "runtime.state":
          setRuntime(msg.state);
          break;

        case "session.launchState":
          if (msg.state.kind === "launching") {
            clearTranscript();
            setSelection({ kind: "launching", mode: msg.state.mode });
            setState({ screen: "active" });
          } else if (msg.state.kind === "failed") {
            setSelection({ kind: "failed", message: msg.state.message, retry: null });
          }
          break;

        case "chat.messagesLoaded":
          setTranscript(msg.messages || []);
          break;

        case "chat.message": {
          const incoming = msg.message as TranscriptMessage | undefined;
          if (!incoming) break;
          upsertMessage(incoming);
          break;
        }

        case "chat.delta": {
          const { messageId, delta } = msg as {
            messageId: string;
            delta: { kind: string; text?: string; toolCallId?: string; toolName?: string };
          };
          if (!messageId || !delta) break;

          const existing = getState().transcript.find((m) => m.id === messageId);
          if (existing) {
            if (delta.kind === "text" && delta.text) {
              updateMessage(messageId, (m) => ({
                ...m,
                content: (m.content || "") + delta.text,
              }));
            } else if (delta.kind === "thinking" && delta.text) {
              updateMessage(messageId, (m) => ({
                ...m,
                thinking: (m.thinking || "") + delta.text,
              }));
            }
          } else {
            // Create placeholder for unknown message
            appendMessage({
              id: messageId,
              role: "assistant",
              content: delta.kind === "text" ? delta.text || "" : "",
              thinking: delta.kind === "thinking" ? delta.text || "" : "",
              streaming: true,
              finalized: false,
              timestamp: Date.now(),
              toolCalls: [],
            });
          }
          break;
        }

        case "runtime.frame": {
          const frame = msg.frame as { type: string; [key: string]: unknown } | undefined;
          if (!frame) break;
          handleRuntimeFrame(frame);
          break;
        }

        case "error": {
          const { scope, message: errorMsg } = msg as { scope: string; message: string };
          if (scope === "runtime" || scope === "launch") {
            appendMessage({
              id: `err_${Date.now()}`,
              role: "system",
              content: errorMsg,
              streaming: false,
              finalized: true,
              timestamp: Date.now(),
              isError: true,
            });
          }
          break;
        }
      }
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);
}

function handleRuntimeFrame(frame: { type: string; [key: string]: unknown }) {
  switch (frame.type) {
    case "tool_execution_start": {
      const { transcript } = getState();
      const lastAssistant = [...transcript].reverse().find((m) => m.role === "assistant");
      if (lastAssistant) {
        updateMessage(lastAssistant.id, (m) => ({
          ...m,
          toolCalls: [
            ...(m.toolCalls || []),
            {
              toolCallId: frame.toolCallId as string,
              toolName: frame.toolName as string,
              args: frame.args,
              status: "running" as const,
            },
          ],
        }));
      }
      break;
    }
    case "tool_execution_end": {
      const { transcript } = getState();
      const lastAssistant = [...transcript].reverse().find((m) => m.role === "assistant");
      if (lastAssistant) {
        updateMessage(lastAssistant.id, (m) => ({
          ...m,
          toolCalls: (m.toolCalls || []).map((tc) =>
            tc.toolCallId === (frame.toolCallId as string)
              ? {
                  ...tc,
                  status: (frame.isError ? "error" : "completed") as "error" | "completed",
                  result: frame.result,
                  isError: frame.isError as boolean | undefined,
                }
              : tc,
          ),
        }));
      }
      break;
    }
  }
}
