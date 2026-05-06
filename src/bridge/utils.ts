import { posix, win32 } from "node:path";
import * as vscode from "vscode";

export function getWorkspaceFolders() {
  return (vscode.workspace.workspaceFolders ?? []).map((folder, index) => ({
    index,
    name: folder.name,
    filePath: folder.uri.fsPath,
    uri: folder.uri.toString(),
  }));
}

export function getFileUri(filePath: string): vscode.Uri {
  return vscode.Uri.file(resolveFilePath(filePath));
}

export function resolveFilePath(filePath: string): string {
  if (isAbsolutePath(filePath)) return filePath;
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root)
    throw new Error(`Cannot resolve relative path without a workspace folder: ${filePath}`);
  const pathApi = root.includes("\\") ? win32 : posix;
  return pathApi.resolve(root, filePath);
}

export function isAbsolutePath(filePath: string): boolean {
  return posix.isAbsolute(filePath) || win32.isAbsolute(filePath);
}

export function readSelection(
  value: unknown,
): { start: vscode.Position; end: vscode.Position } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const start = readPosition((value as Record<string, unknown>).start);
  const end = readPosition((value as Record<string, unknown>).end);
  if (!start || !end) return undefined;
  return { start, end };
}

export function readPosition(value: unknown): vscode.Position | undefined {
  if (!value || typeof value !== "object") return undefined;
  const line = readOptionalNumber((value as Record<string, unknown>).line);
  const character = readOptionalNumber((value as Record<string, unknown>).character);
  if (line === undefined || character === undefined) return undefined;
  return new vscode.Position(line, character);
}

export function readRequiredPosition(value: unknown, name: string): vscode.Position {
  const position = readPosition(value);
  if (!position) throw new Error(`Missing required position: ${name}`);
  return position;
}

export function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function readRequiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`Missing required parameter: ${name}`);
  return value;
}

export function readOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function readWorkspaceEditEntries(value: unknown): Array<{
  filePath: string;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  newText: string;
}> {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error("Missing required parameter: edits");
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object")
      throw new Error(`Invalid workspace edit at index ${index}`);
    const record = entry as Record<string, unknown>;
    const filePath = readRequiredString(record.filePath, `edits[${index}].filePath`);
    const range = readSelection(record.range);
    const newText = typeof record.newText === "string" ? record.newText : "";
    if (!range) throw new Error(`Invalid workspace edit range at index ${index}`);
    return {
      filePath,
      range: {
        start: { line: range.start.line, character: range.start.character },
        end: { line: range.end.line, character: range.end.character },
      },
      newText,
    };
  });
}

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createRange(range: {
  start: { line: number; character: number };
  end: { line: number; character: number };
}) {
  return new vscode.Range(
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character,
  );
}
