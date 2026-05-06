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

          // Suppress system messages that duplicate tool results
          if (incoming.role === "system" && incoming.content && !incoming.isError) {
            if (isToolResultDuplicate(incoming.content)) break;
          }

          // Attach model info from runtime state to finalized assistant messages
          if (incoming.role === "assistant" && incoming.finalized && !incoming.model) {
            const { runtime } = getState();
            if (runtime.kind === "ready" || runtime.kind === "streaming") {
              const modelStr = runtime.model
                ? typeof runtime.model === "string"
                  ? runtime.model
                  : (runtime.model as any)?.id || (runtime.model as any)?.name || String(runtime.model)
                : undefined;
              if (modelStr) incoming.model = modelStr;
            }
          }

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

/**
 * Check if a system message is a duplicate of a recent tool result.
 * Returns true if the content matches or is contained in a tool call result
 * from the last assistant message.
 */
function isToolResultDuplicate(content: string): boolean {
  const { transcript } = getState();
  // Check last few messages for assistant messages with tool calls
  const recent = transcript.slice(-5);
  for (const msg of recent) {
    if (msg.role !== "assistant" || !msg.toolCalls) continue;
    for (const tc of msg.toolCalls) {
      if (tc.status !== "completed" && tc.status !== "error") continue;
      if (tc.result == null) continue;
      const resultStr = typeof tc.result === "string" ? tc.result : JSON.stringify(tc.result);
      // Check if system message is the same content or a subset
      if (resultStr === content) return true;
      if (content.length > 20 && resultStr.includes(content.slice(0, 50))) return true;
      if (content.length > 20 && content.includes(resultStr.slice(0, 50))) return true;
    }
  }
  return false;
}
