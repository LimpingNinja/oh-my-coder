/**
 * Message handler — wires VS Code extension messages to the store.
 */

import { useEffect } from "react";
import { getVSCodeAPI } from "../vscode";
import {
  addComposerFileContext,
  setSessionList,
  setSelection,
  setRuntime,
  setTranscript,
  setTurnTranscript,
  setHeader,
  setFooterEditor,
  setFooterRuntime,
  setTodos,
  setModelCatalog,
  upsertMessage,
  updateMessage,
  appendMessage,
  clearTranscript,
  setState,
  getState,
  type TranscriptMessage,
  type HeaderState,
  type FooterEditorContext,
  type FooterRuntimeContext,
  type TodoPhase,
} from "../state/store";
import { processTurnMessage } from "../state/turnReducer";
import { createEmptyTurnTranscript } from "../state/turns";
import type { UiRequestData, UiResponseData } from "../state/turns";
import { generateTurnId } from "../state/turns";

export function useMessageHandler() {
  useEffect(() => {
    const vscode = getVSCodeAPI();

    // Post ready on mount
    vscode.postMessage({ type: "webview.ready" });

    function handleMessage(event: MessageEvent) {
      const msg = event.data;
      if (!msg || typeof msg.type !== "string") return;

      // Process through turn-based reducer for all transcript-relevant messages
      const turnTypes = new Set([
        "chat.messagesLoaded", "chat.message", "chat.delta", "runtime.frame", "runtime.turnMetadata", "error",
      ]);
      if (turnTypes.has(msg.type)) {
        const { turnTranscript } = getState();
        const newTurnTranscript = processTurnMessage(turnTranscript, msg);
        if (newTurnTranscript !== turnTranscript) {
          setTurnTranscript(newTurnTranscript);
        }
      }

      switch (msg.type) {
        case "sessions.state":
          setSessionList(msg.state);
          break;

        case "selection.state":
          setSelection(msg.state);
          break;

        case "runtime.state": {
          setRuntime(msg.state);
          // Sync header connection indicator from runtime state
          const { header } = getState();
          const rs = msg.state as { kind: string; model?: unknown; thinking?: string };
          const connection =
            rs.kind === "ready" || rs.kind === "streaming"
              ? "connected"
              : rs.kind === "starting"
                ? "connecting"
                : "disconnected";
          const model = rs.model
            ? typeof rs.model === "string"
              ? rs.model
              : (rs.model as any)?.id || (rs.model as any)?.name || undefined
            : undefined;
          setHeader({
            ...header,
            connection: connection as HeaderState["connection"],
            ...(model ? { canCompact: true } : {}),
          });
          // Also keep footer runtime in sync
          if (rs.kind === "ready" || rs.kind === "streaming") {
            const { footerRuntime } = getState();
            setFooterRuntime({
              ...footerRuntime,
              state: rs.kind as FooterRuntimeContext["state"],
              model: model ?? footerRuntime.model,
              thinking: rs.thinking ?? footerRuntime.thinking,
              // If runtime reports a thinkingLevel (even "off"), the model supports it
              // If undefined, it doesn't
              thinkingSupported: rs.thinking !== undefined,
            });
          }
          break;
        }

        case "session.launchState":
          if (msg.state.kind === "launching") {
            clearTranscript();
            setTurnTranscript(createEmptyTurnTranscript());
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

        case "runtime.modelCatalog": {
          if (Array.isArray(msg.entries)) {
            setModelCatalog(msg.entries);
          }
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

        case "header.state":
          setHeader(msg.state as HeaderState);
          break;

        case "header.todos":
          setTodos((msg.todos as TodoPhase[]) || []);
          break;

        case "chat.queued": {
          // Mark the last user turn as queued with the behavior
          const behavior = msg.behavior as "steer" | "followUp";
          const { turnTranscript } = getState();
          const turns = [...turnTranscript.turns];
          // Find the last user turn and mark it
          for (let i = turns.length - 1; i >= 0; i--) {
            if (turns[i]!.kind === "user") {
              turns[i] = { ...turns[i]!, queuedAs: behavior } as typeof turns[number];
              break;
            }
          }
          setTurnTranscript({ ...turnTranscript, turns });
          break;
        }

        case "footer.state": {
          // Footer items come as a discriminated array; split into editor + runtime slices
          const items = msg.items as Array<{ source: string; kind: string; [k: string]: unknown }>;
          if (Array.isArray(items)) {
            for (const item of items) {
              if (item.source === "vscodeBridge" && item.kind === "editor") {
                setFooterEditor({
                  filePath: item.filePath as string | undefined,
                  languageId: item.languageId as string | undefined,
                  isDirty: (item.isDirty as boolean) || false,
                  line: item.line as number | undefined,
                  endLine: item.endLine as number | undefined,
                });
              } else if (item.source === "vscodeBridge" && item.kind === "selection") {
                // Merge selection into existing editor context
                const { footerEditor } = getState();
                setFooterEditor({
                  ...footerEditor,
                  line: item.line as number | undefined,
                  endLine: item.endLine as number | undefined,
                });
              } else if (item.source === "ompRuntime" && item.kind === "runtime") {
                const { footerRuntime } = getState();
                const newModel = item.model as string | undefined;
                const modelChanged = newModel !== undefined && newModel !== footerRuntime.model;
                setFooterRuntime({
                  ...footerRuntime,
                  state: (item.state as FooterRuntimeContext["state"]) || "ready",
                  model: newModel,
                  thinking: item.thinking as string | undefined,
                  // Reset thinking support when model changes — will be re-confirmed by footer.thinkingSupport
                  ...(modelChanged ? { thinkingSupported: false, thinkingMinLevel: undefined, thinkingMaxLevel: undefined } : {}),
                });
              }
            }
          }
          break;
        }

        case "footer.modes": {
          const { footerRuntime } = getState();
          setFooterRuntime({
            ...footerRuntime,
            steeringMode: msg.steeringMode as "all" | "one-at-a-time" | undefined,
            followUpMode: msg.followUpMode as "all" | "one-at-a-time" | undefined,
            interruptMode: msg.interruptMode as "immediate" | "wait" | undefined,
          });
          break;
        }

        case "footer.thinkingSupport": {
          const { footerRuntime } = getState();
          setFooterRuntime({
            ...footerRuntime,
            thinkingSupported: msg.supported as boolean,
            thinkingMinLevel: msg.minLevel as string | undefined,
            thinkingMaxLevel: msg.maxLevel as string | undefined,
          });
          break;
        }

        case "composer.addFileContext": {
          const context = msg.context as {
            path?: string;
            languageId?: string;
            line?: number;
            endLine?: number;
          };
          if (context?.path) {
            addComposerFileContext({
              path: context.path,
              languageId: context.languageId,
              line: context.line,
              endLine: context.endLine,
            });
          }
          break;
        }

        case "extensionUi.request": {
          // Add as a ui-request turn in the transcript
          const request = msg.request as UiRequestData;
          const { turnTranscript } = getState();
          setTurnTranscript({
            ...turnTranscript,
            turns: [
              ...turnTranscript.turns,
              {
                kind: "ui-request",
                id: generateTurnId(),
                timestamp: Date.now(),
                request,
                response: undefined,
              },
            ],
          });
          break;
        }

        case "extensionUi.cancel": {
          // Remove the pending ui-request turn (or mark it cancelled)
          const targetId = msg.targetId as string;
          const { turnTranscript } = getState();
          const turns = turnTranscript.turns.map((t) => {
            if (t.kind === "ui-request" && t.request.requestId === targetId && !t.response) {
              return { ...t, response: { kind: "cancelled" as const } };
            }
            return t;
          });
          setTurnTranscript({ ...turnTranscript, turns });
          break;
        }

        case "extensionUi.setEditorText": {
          // Dispatch a custom event that the Composer can listen for
          const text = msg.text as string;
          window.dispatchEvent(new CustomEvent("omp:setEditorText", { detail: { text } }));
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
