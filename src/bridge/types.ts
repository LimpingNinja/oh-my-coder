import type { Server } from "node:http";
import * as vscode from "vscode";

export interface BridgeSelection {
  text: string;
  isEmpty: boolean;
  filePath: string;
  fileUri: string;
  languageId: string;
  start: { line: number; character: number };
  end: { line: number; character: number };
}

export interface BridgeSelectionStatus {
  isEmpty: boolean;
  filePath: string;
  fileUri: string;
  languageId: string;
  start: { line: number; character: number };
  end: { line: number; character: number };
  selectedLineCount: number;
  selectedCharacterCount?: number;
}

export interface BridgeDiagnosticSummary {
  errors: number;
  warnings: number;
  infos: number;
  hints: number;
}

export interface BridgeEditorInfo {
  filePath: string;
  fileUri: string;
  languageId: string;
  isDirty: boolean;
  viewColumn?: vscode.ViewColumn;
  isActive: boolean;
}

export interface BridgeNotification {
  id: string;
  type:
    | "selection_changed"
    | "diagnostics_changed"
    | "active_editor_changed"
    | "visible_editors_changed"
    | "document_dirty_changed"
    | "document_saved";
  timestamp: number;
  data: unknown;
}

export interface CachedCodeAction {
  action: vscode.CodeAction | vscode.Command;
  filePath: string;
}

export interface BridgeContext {
  server: Server;
  url: string;
  token: string;
  reverseBridgePort?: number;
  dispose(): Promise<void>;
}

export interface RpcRequest {
  method?: string;
  params?: Record<string, unknown>;
}

export interface TurnMetadataSnapshot {
  model?: { provider: string; modelId: string };
  thinkingLevel?: string;
  contextPercent?: number;
  tokens?: { input: number; output: number; cacheRead: number };
  costUsd?: number;
  durationMs?: number;
}

export interface UserAttachmentsSnapshot {
  fileContexts?: Array<{ path: string; line?: number; endLine?: number; languageId?: string }>;
}

export interface BridgeState {
  latestSelection: BridgeSelection | undefined;
  notifications: BridgeNotification[];
  codeActions: Map<string, CachedCodeAction>;
  enqueue(type: BridgeNotification["type"], data: unknown): void;
  cacheCodeAction(action: vscode.CodeAction | vscode.Command, filePath: string): string;
  reportTerminalSession(terminalId: string, sessionFile: string): void;
  getTurnMetadata(): TurnMetadataSnapshot;
  getUserAttachments(): UserAttachmentsSnapshot | null;
  onCommandsDiscovered?: (commands: Array<{ name: string; description?: string; source: string; location?: string; path?: string }>) => void;
  reverseBridgePort?: number;
}
