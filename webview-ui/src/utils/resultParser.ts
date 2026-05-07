/**
 * Utilities for parsing OMP tool results and rendering file paths.
 */

import { getVSCodeAPI } from "../vscode";

/**
 * Extract displayable text from an OMP tool result.
 * OMP results are typically: { content: [{ type: "text", text: "..." }], details: {...} }
 */
export function extractResultText(result: unknown): string | null {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return null;

  const r = result as Record<string, unknown>;

  // Standard content block array
  if (Array.isArray(r.content)) {
    const texts = r.content
      .filter((b: any) => b?.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text as string);
    if (texts.length > 0) return texts.join("\n");
  }

  // Direct text field
  if (typeof r.text === "string") return r.text;

  return null;
}

/**
 * Extract details/metadata from a tool result.
 */
export function extractResultDetails(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  if (r.details && typeof r.details === "object") {
    return r.details as Record<string, unknown>;
  }
  return null;
}

/**
 * Strip XML task-summary envelope from result text to get the readable summary.
 */
export function stripTaskSummaryXml(text: string): string {
  // Extract content from <result>...</result> tags
  const resultMatch = text.match(/<result>([\s\S]*?)<\/result>/);
  if (resultMatch) {
    const inner = resultMatch[1]!.trim();
    // Try to parse as JSON for clean display
    try {
      const parsed = JSON.parse(inner);
      if (typeof parsed === "object" && parsed.summary) {
        return parsed.summary;
      }
      return JSON.stringify(parsed, null, 2);
    } catch {
      return inner;
    }
  }

  // Strip header/agent XML tags and return readable text
  let cleaned = text
    .replace(/<task-summary>[\s\S]*?<\/header>/g, "")
    .replace(/<\/task-summary>/g, "")
    .replace(/<agent[^>]*>/g, "")
    .replace(/<\/agent>/g, "")
    .replace(/<status>[^<]*<\/status>/g, "")
    .replace(/<meta[^/]*\/>/g, "")
    .replace(/<result>/g, "")
    .replace(/<\/result>/g, "")
    .trim();

  // If what's left looks like JSON, try to extract summary
  if (cleaned.startsWith("{")) {
    try {
      const parsed = JSON.parse(cleaned);
      if (parsed.summary) return parsed.summary;
    } catch {}
  }

  return cleaned || text;
}

/**
 * Detect file paths in text and make them clickable.
 * Returns JSX-safe array of text segments and clickable path elements.
 */
export function parseFilePaths(text: string): Array<{ type: "text"; value: string } | { type: "path"; value: string; display: string }> {
  // Match patterns like: /path/to/file.ext, path/to/file.ext:line, path/to/file.ext:line-line
  const pathRegex = /((?:\/[\w./-]+|[\w./-]+\/[\w./-]+)(?:\.\w+)(?::[\d]+-?[\d]*)?)(?=[\s,;)\]}"']|$)/g;
  const segments: Array<{ type: "text"; value: string } | { type: "path"; value: string; display: string }> = [];
  let lastIndex = 0;
  let match;

  while ((match = pathRegex.exec(text)) !== null) {
    // Add text before this match
    if (match.index > lastIndex) {
      segments.push({ type: "text", value: text.slice(lastIndex, match.index) });
    }

    const fullMatch = match[0]!;
    // Extract just the filename for display
    const parts = fullMatch.split("/");
    const display = parts[parts.length - 1]!;

    segments.push({ type: "path", value: fullMatch, display: fullMatch });
    lastIndex = match.index + fullMatch.length;
  }

  // Add remaining text
  if (lastIndex < text.length) {
    segments.push({ type: "text", value: text.slice(lastIndex) });
  }

  // If no paths found, return single text segment
  if (segments.length === 0) {
    segments.push({ type: "text", value: text });
  }

  return segments;
}

/**
 * Open a file in VS Code editor.
 */
export function openFileInEditor(path: string): void {
  const vscode = getVSCodeAPI();

  // Parse line number from path:line or path:line-line
  const lineMatch = path.match(/^(.+):(\d+)(?:-(\d+))?$/);
  if (lineMatch) {
    vscode.postMessage({
      type: "openFile",
      path: lineMatch[1],
      line: parseInt(lineMatch[2]!, 10),
      endLine: lineMatch[3] ? parseInt(lineMatch[3], 10) : undefined,
    });
  } else {
    vscode.postMessage({ type: "openFile", path });
  }
}
