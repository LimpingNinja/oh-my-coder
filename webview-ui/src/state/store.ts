/**
 * Global webview state store.
 *
 * Simple pub/sub state management. Components subscribe to slices
 * and re-render when those slices change. No external dependencies.
 */

import { useEffect, useState, useCallback } from "react";

// ============================================================================
// Types (mirroring the extension protocol, kept loose for now)
// ============================================================================

export interface SessionSummary {
  id: string;
  path: string;
  title: string;
  status: "resumable" | "active" | "missing" | "invalid";
  createdAt?: number;
  updatedAt: number;
  firstMessage?: string;
  lastMessagePreview?: string;
  messageCount?: number;
  model?: string;
}

export interface TranscriptMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  thinking?: string;
  streaming?: boolean;
  finalized?: boolean;
  timestamp?: number;
  toolCalls?: ToolCall[];
  isError?: boolean;
  // Response metadata (populated from runtime when available)
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

export interface ToolCall {
  toolCallId: string;
  toolName: string;
  args?: unknown;
  intent?: string;
  status: "running" | "completed" | "error" | "cancelled";
  result?: unknown;
  isError?: boolean;
}

export type Screen = "home" | "history" | "active";

export type SessionListState =
  | { kind: "loading"; workspaceFolder?: string }
  | { kind: "empty"; workspaceFolder: string }
  | { kind: "ready"; workspaceFolder: string; sessions: SessionSummary[] }
  | { kind: "error"; workspaceFolder?: string; message: string; retryable: boolean };

export type SelectionState =
  | { kind: "new"; draft: string }
  | { kind: "preview"; session: SessionSummary; draft: string }
  | { kind: "launching"; mode: "new" | "resume" }
  | { kind: "active"; sessionPath: string; acceptsInput: boolean }
  | { kind: "failed"; message: string; retry: unknown };

export type RuntimeState =
  | { kind: "disconnected" }
  | { kind: "starting" }
  | { kind: "ready"; sessionPath: string; model?: unknown; thinking?: string }
  | { kind: "streaming"; sessionPath: string; model?: unknown; thinking?: string }
  | { kind: "error"; message: string };

import type { TurnTranscriptState } from "./turns";
import { createEmptyTurnTranscript } from "./turns";

// ============================================================================
// Header/footer state types (mirroring host protocol)
// ============================================================================

export interface HeaderState {
  connection: "connected" | "connecting" | "disconnected";
  sessionName: string;
  sessionPath: string;
  costUsd?: number;
  contextPercent?: number;
  canCompact: boolean;
  tokens?: { input: number; output: number; cacheRead: number };
  details?: {
    /** Active model identifier */
    model?: { provider: string; modelId: string };
    /** Thinking/reasoning level */
    thinkingLevel?: string;
    /** Runtime modes */
    steeringMode?: string;
    followUpMode?: string;
    interruptMode?: string;
    /** Session counters */
    messageCount?: number;
    queuedMessageCount?: number;
    /** Tool count from dumpTools */
    toolCount?: number;
    /** System prompt presence/truncated */
    hasSystemPrompt?: boolean;
  };
}

export interface FooterEditorContext {
  filePath?: string;
  languageId?: string;
  isDirty: boolean;
  line?: number;
  endLine?: number;
}

export interface FooterRuntimeContext {
  state: "ready" | "streaming" | "tool" | "compacting" | "error";
  model?: string;
  thinking?: string;
  thinkingSupported: boolean;
  thinkingMinLevel?: string;
  thinkingMaxLevel?: string;
  steeringMode?: "all" | "one-at-a-time";
  followUpMode?: "all" | "one-at-a-time";
  interruptMode?: "immediate" | "wait";
}

export interface ComposerFileContext {
  id: string;
  path: string;
  languageId?: string;
  line?: number;
  endLine?: number;
}

export interface ComposerImageAttachment {
  id: string;
  data: string;
  mediaType: string;
}

export interface TodoTask {
  id: string;
  content: string;
  status: string;
}

export interface TodoPhase {
  id: string;
  name: string;
  tasks: TodoTask[];
}

// ============================================================================
// Store
// ============================================================================

interface AppState {
  screen: Screen;
  sessionList: SessionListState;
  selection: SelectionState;
  runtime: RuntimeState;
  transcript: TranscriptMessage[];
  turnTranscript: TurnTranscriptState;
  historySearch: string;
  header: HeaderState;
  footerEditor: FooterEditorContext;
  footerRuntime: FooterRuntimeContext;
  composerFileContexts: ComposerFileContext[];
  composerImageAttachments: ComposerImageAttachment[];
  todos: TodoPhase[];
}

const initialState: AppState = {
  screen: "home",
  sessionList: { kind: "loading" },
  selection: { kind: "new", draft: "" },
  runtime: { kind: "disconnected" },
  transcript: [],
  turnTranscript: createEmptyTurnTranscript(),
  historySearch: "",
   header: {
     connection: "disconnected",
     sessionName: "New Session",
     sessionPath: "",
     costUsd: undefined,
     contextPercent: undefined,
     canCompact: false,
     tokens: undefined,
     details: undefined,
   },
  footerEditor: {
    filePath: undefined,
    languageId: undefined,
    isDirty: false,
    line: undefined,
    endLine: undefined,
  },
  footerRuntime: {
    state: "ready",
    model: undefined,
    thinking: undefined,
    thinkingSupported: true,
  },
  composerFileContexts: [],
  composerImageAttachments: [],
  todos: [],
};

let state: AppState = { ...initialState };
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

export function getState(): AppState {
  return state;
}

export function setState(partial: Partial<AppState>) {
  state = { ...state, ...partial };
  notify();
}

export function setScreen(screen: Screen) {
  setState({ screen });
}

export function setSessionList(sessionList: SessionListState) {
  setState({ sessionList });
}

export function setSelection(selection: SelectionState) {
  // Auto-transition to active screen
  if (selection.kind === "active" && state.screen !== "active") {
    setState({ selection, screen: "active" });
  } else {
    setState({ selection });
  }
}

export function setRuntime(runtime: RuntimeState) {
  setState({ runtime });
}

export function setTranscript(messages: TranscriptMessage[]) {
  setState({ transcript: messages });
}

export function setTurnTranscript(turnTranscript: TurnTranscriptState) {
  setState({ turnTranscript });
}

export function addComposerFileContext(context: Omit<ComposerFileContext, "id">) {
  const existing = state.composerFileContexts.find(
    (entry) =>
      entry.path === context.path &&
      entry.line === context.line &&
      entry.endLine === context.endLine,
  );
  if (existing) return existing.id;

  const id = `ctx_${Date.now()}_${state.composerFileContexts.length + 1}`;
  setState({
    composerFileContexts: [...state.composerFileContexts, { id, ...context }],
  });
  return id;
}

export function removeComposerFileContext(id: string) {
  setState({
    composerFileContexts: state.composerFileContexts.filter((entry) => entry.id !== id),
  });
}

export function clearComposerFileContexts() {
  if (state.composerFileContexts.length === 0) return;
  setState({ composerFileContexts: [] });
}

export function addComposerImageAttachment(attachment: Omit<ComposerImageAttachment, "id">) {
  const id = `img_${Date.now()}_${state.composerImageAttachments.length + 1}`;
  setState({
    composerImageAttachments: [...state.composerImageAttachments, { id, ...attachment }],
  });
  return id;
}

export function removeComposerImageAttachment(id: string) {
  setState({
    composerImageAttachments: state.composerImageAttachments.filter((entry) => entry.id !== id),
  });
}

export function clearComposerImageAttachments() {
  if (state.composerImageAttachments.length === 0) return;
  setState({ composerImageAttachments: [] });
}

export function appendMessage(msg: TranscriptMessage) {
  // Dedupe user messages by content (prevents double-add from host + frame)
  if (msg.role === "user" && msg.content) {
    const recent = state.transcript.slice(-3);
    if (recent.some((m) => m.role === "user" && m.content === msg.content)) {
      return;
    }
  }
  setState({ transcript: [...state.transcript, msg] });
}

export function updateMessage(id: string, updater: (msg: TranscriptMessage) => TranscriptMessage) {
  setState({
    transcript: state.transcript.map((m) => (m.id === id ? updater(m) : m)),
  });
}

export function upsertMessage(msg: TranscriptMessage) {
  const idx = state.transcript.findIndex((m) => m.id === msg.id);
  if (idx !== -1) {
    const updated = [...state.transcript];
    updated[idx] = msg;
    setState({ transcript: updated });
  } else {
    appendMessage(msg);
  }
}

export function clearTranscript() {
  setState({ transcript: [] });
}

export function setHistorySearch(search: string) {
  setState({ historySearch: search });
}

export function setHeader(header: HeaderState) {
  setState({ header });
}

export function setFooterEditor(footerEditor: FooterEditorContext) {
  setState({ footerEditor });
}

export function setFooterRuntime(footerRuntime: FooterRuntimeContext) {
  setState({ footerRuntime });
}

export function setTodos(todos: TodoPhase[]) {
  setState({ todos });
}

// ============================================================================
// React hook
// ============================================================================

export function useAppState(): AppState {
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    const listener = () => forceUpdate((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  return state;
}

export function useAppStateSlice<T>(selector: (s: AppState) => T): T {
  const [value, setValue] = useState(() => selector(state));

  useEffect(() => {
    const listener = () => {
      const next = selector(state);
      setValue(next);
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [selector]);

  return value;
}
