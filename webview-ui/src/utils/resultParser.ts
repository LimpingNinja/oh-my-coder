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

export interface TaskResultSegment {
  path?: string;
  text: string;
}

export function parseTaskResultSegments(text: string): TaskResultSegment[] {
  const decoded = decodeOuterPayload(text).trim();
  const previewRegex = /<preview\b([^>]*)>([\s\S]*?)<\/preview>/g;
  const previews = Array.from(decoded.matchAll(previewRegex));
  if (previews.length > 0) {
    const segments: TaskResultSegment[] = previews.map(match => ({
      path: extractPreviewPath(match[1] ?? ""),
      text: normalizeDisplayText(decodeSegmentBody(match[2]!.trim())),
    })).filter(segment => segment.text.length > 0);

    const remainder = decoded.replace(previewRegex, "").trim();
    if (remainder) {
      const text = normalizeDisplayText(extractTaskResultText(remainder));
      if (text) segments.push({ text });
    }

    return segments;
  }

  return [{ text: normalizeDisplayText(extractTaskResultText(decoded)) }].filter(segment => segment.text.length > 0);
}

export function getTaskOutputPath(result: unknown, previewPath?: string): string | undefined {
  if (previewPath && !previewPath.startsWith("agent://")) return previewPath;
  if (!result || typeof result !== "object") return previewPath;

  const details = (result as Record<string, unknown>).details;
  if (!details || typeof details !== "object") return previewPath;

  const record = details as Record<string, unknown>;
  if (previewPath?.startsWith("agent://") && Array.isArray(record.results)) {
    const id = previewPath.slice("agent://".length);
    const matchingResult = (record.results as Array<Record<string, unknown>>).find(item => item.id === id);
    if (typeof matchingResult?.outputPath === "string") return matchingResult.outputPath;
    return undefined;
  }

  if (Array.isArray(record.outputPaths) && typeof record.outputPaths[0] === "string") return record.outputPaths[0];
  return previewPath;
}

function decodeOuterPayload(text: string): string {
  return decodeJsonStringOrEscapes(text);
}

function decodeSegmentBody(text: string): string {
  return decodeJsonStringOrEscapes(text);
}

function decodeJsonStringOrEscapes(text: string): string {
  const normalizedInput = unwrapQuotedPayload(text);
  try {
    const parsed = JSON.parse(normalizedInput);
    if (typeof parsed === "string") return parsed;
    if (parsed && typeof parsed === "object" && typeof parsed.summary === "string") return parsed.summary;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return decodeEscapedStringText(normalizedInput);
  }
}

function extractPreviewPath(attrs: string): string | undefined {
  const match = attrs.match(/\bfull-path\s*=\s*("([^"]*)"|'([^']*)')/);
  return match?.[2] ?? match?.[3];
}

function unwrapQuotedPayload(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('"') && !trimmed.endsWith('"')) return trimmed.slice(1);
  return trimmed;
}

function extractTaskResultText(text: string): string {
  const resultMatches = Array.from(text.matchAll(/<result>([\s\S]*?)<\/result>/g));
  if (resultMatches.length > 0) {
    return resultMatches.map(match => decodeSegmentBody(match[1]!.trim())).join("\n");
  }

  const cleaned = text
    .replace(/<header>[\s\S]*?<\/header>/g, "")
    .replace(/<task-summary>/g, "")
    .replace(/<\/task-summary>/g, "")
    .replace(/<agent[^>]*>/g, "")
    .replace(/<\/agent>/g, "")
    .replace(/<status>[^<]*<\/status>/g, "")
    .replace(/<meta[^/]*\/>/g, "")
    .trim();

  return cleaned || text;
}

function decodeEscapedStringText(text: string): string {
  const unquoted = text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text;
  return unquoted.replace(/\\(r|n|t|`|"|\\)/g, (match, ch: string) => {
    const replacements: Record<string, string> = {
      r: "\r",
      n: "\n",
      t: "\t",
      "`": "`",
      '"': '"',
      "\\": "\\",
    };
    return replacements[ch] ?? match;
  });
}

function normalizeDisplayText(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n");
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
