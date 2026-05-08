/**
 * Tool-specific result renderers.
 *
 * Each tool type gets a dedicated renderer that understands the OMP result shape
 * and displays it meaningfully instead of dumping raw JSON.
 */

import { useState, useEffect } from "react";
import type { ReactNode } from "react";
import { Icon } from "../Icon";
import { ClickableText } from "../ClickableText";
import { openFileInEditor } from "../../utils/resultParser";
import { highlightCode, guessLanguageFromPath } from "../CodeBlock";

// ============================================================================
// Hashline parsing
// ============================================================================

/**
 * Strip OMP hashline prefixes from content lines.
 * Format: `{lineNum}{2-char-hash}|{content}` or `*{lineNum}{hash}|{content}` for matches.
 * Returns clean content with optional line numbers.
 */
function stripHashlines(text: string): { lines: string[]; hasLineNumbers: boolean } {
  const rawLines = text.split("\n");
  const hashlineRegex = /^(\*| )?(\d+)\w{0,4}\|(.*)$/;
  let hasHashlines = false;
  let matchCount = 0;

  // Check if this looks like hashline format
  for (const line of rawLines.slice(0, 5)) {
    if (hashlineRegex.test(line)) matchCount++;
  }
  hasHashlines = matchCount >= 2;

  if (!hasHashlines) {
    return { lines: rawLines, hasLineNumbers: false };
  }

  const lines = rawLines.map((line) => {
    const match = line.match(hashlineRegex);
    if (match) return match[3] || "";
    return line;
  });

  return { lines, hasLineNumbers: true };
}

/**
 * Extract clean code content from hashline-formatted text.
 */
export function cleanHashlineContent(text: string): string {
  const { lines } = stripHashlines(text);
  return lines.join("\n");
}

// ============================================================================
// Read Tool Renderer
// ============================================================================

interface ReadResultProps {
  result: unknown;
  filename: string | null;
}

export function ReadResult({ result, filename }: ReadResultProps) {
  const r = result as Record<string, unknown> | null;
  if (!r) return null;

  const details = r.details as Record<string, unknown> | undefined;
  const meta = details?.meta as Record<string, unknown> | undefined;
  const truncation = meta?.truncation as Record<string, unknown> | undefined;
  const shownRange = truncation?.shownRange as { start: number; end: number } | undefined;

  // Prefer displayContent.text (pre-cleaned by runtime, no hashlines)
  const displayContent = details?.displayContent as { text?: string; startLine?: number } | undefined;
  let content: string | null;
  let startLineHint: number | undefined;

  if (displayContent?.text) {
    content = displayContent.text;
    startLineHint = displayContent.startLine ?? shownRange?.start;
  } else {
    content = extractText(r);
    startLineHint = shownRange?.start;
  }

  if (!content) return null;

  const { lines, startLine } = parseReadContent(content, startLineHint);
  const language = guessLanguageFromPath(filename);

  return (
    <ReadCodeView
      lines={lines}
      startLine={startLine}
      language={language}
      shownRange={shownRange}
    />
  );
}

/** Syntax-highlighted code view with line numbers for read results */
function ReadCodeView({ lines, startLine, language, shownRange }: {
  lines: string[];
  startLine: number;
  language: string;
  shownRange?: { start: number; end: number };
}) {
  const [highlighted, setHighlighted] = useState<ReactNode | null>(null);
  const code = lines.join("\n");

  useEffect(() => {
    let cancelled = false;
    highlightCode(code, language).then((result) => {
      if (!cancelled) setHighlighted(result);
    });
    return () => { cancelled = true; };
  }, [code, language]);

  return (
    <div className="omp-tool-result-read">
      {shownRange && (
        <div className="omp-tool-range-info">
          Lines {shownRange.start}–{shownRange.end}
        </div>
      )}
      <div className="omp-read-code-view">
        <div className="omp-read-gutter">
          {lines.map((_, i) => (
            <div key={i} className="omp-read-line-num">{startLine + i}</div>
          ))}
        </div>
        <div className="omp-read-code">
          {highlighted || <pre className="omp-read-fallback"><code>{code}</code></pre>}
        </div>
      </div>
    </div>
  );
}

/** Parse read content, stripping hashline prefixes and extracting start line */
function parseReadContent(text: string, rangeStart?: number): { lines: string[]; startLine: number } {
  const rawLines = text.split("\n");
  // OMP hashline format: optional marker (*/ ), digits, 2-4 lowercase alpha hash, pipe, content
  // Examples: "1hu|code", " 35ab|code", "*12xy|highlighted"
  const hashlineRegex = /^([* ])?(\d+)([a-z]{2,4})\|(.*)$/;

  let startLine = rangeStart || 1;
  const lines: string[] = [];
  let firstLineNum: number | null = null;
  let hashlineCount = 0;

  // First pass: check if this is actually hashline-formatted content
  // (avoid false positives on files that happen to have number|text patterns)
  const sampleSize = Math.min(rawLines.length, 10);
  let sampleMatches = 0;
  for (let i = 0; i < sampleSize; i++) {
    if (rawLines[i] && hashlineRegex.test(rawLines[i]!)) sampleMatches++;
  }
  const isHashlineFormat = sampleMatches >= Math.ceil(sampleSize * 0.6);

  for (const line of rawLines) {
    // Skip meta notices
    if (line.startsWith("[Showing lines") || line.startsWith("[Read artifact")) continue;
    if (line.startsWith("[") && line.endsWith("]") && line.includes("lines")) continue;

    if (isHashlineFormat) {
      const match = line.match(hashlineRegex);
      if (match) {
        if (firstLineNum === null) firstLineNum = parseInt(match[2]!, 10);
        lines.push(match[4] ?? "");
        hashlineCount++;
        continue;
      }
    }
    lines.push(line);
  }

  if (firstLineNum !== null && hashlineCount > 0) startLine = firstLineNum;

  // Remove trailing empty lines
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  return { lines, startLine };
}

// ============================================================================
// Search Tool Renderer
// ============================================================================

interface SearchResultProps {
  result: unknown;
}

export function SearchResult({ result }: SearchResultProps) {
  const [showMatches, setShowMatches] = useState(false);
  const r = result as Record<string, unknown> | null;
  if (!r) return null;

  const content = extractText(r);
  const details = r.details as Record<string, unknown> | undefined;
  const matchCount = details?.matchCount as number | undefined;
  const fileCount = details?.fileCount as number | undefined;
  const fileMatches = details?.fileMatches as Array<{ path: string; count: number }> | undefined;
  const truncated = details?.truncated as boolean | undefined;

  return (
    <div className="omp-tool-result-search">
      {/* Summary line */}
      <div className="omp-search-summary">
        {matchCount != null && <span className="omp-search-stat">{matchCount} matches</span>}
        {fileCount != null && <span className="omp-search-stat"> · {fileCount} files</span>}
        {truncated && <span className="omp-search-truncated"> (truncated)</span>}
      </div>

      {/* File list with match counts */}
      {fileMatches && fileMatches.length > 0 && (
        <div className="omp-search-files">
          {fileMatches.map((fm) => (
            <div key={fm.path} className="omp-search-file-item">
              <a
                href="#"
                className="omp-file-link"
                onClick={(e) => { e.preventDefault(); openFileInEditor(fm.path); }}
              >
                {fm.path}
              </a>
              <span className="omp-search-file-count">({fm.count})</span>
            </div>
          ))}
        </div>
      )}

      {/* Toggle for raw match content */}
      {content && (
        <div className="omp-search-matches-toggle">
          <button className="omp-tool-raw-btn" onClick={() => setShowMatches(!showMatches)}>
            {showMatches ? "Hide matches" : "Show matches"}
          </button>
          {showMatches && (
            <pre className="omp-search-matches-content">{cleanHashlineContent(content)}</pre>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Edit Tool Renderer
// ============================================================================

interface EditResultProps {
  result: unknown;
  filename: string | null;
}

export function EditResult({ result, filename }: EditResultProps) {
  const r = result as Record<string, unknown> | null;
  if (!r) return null;

  const content = extractText(r);
  const details = r.details as Record<string, unknown> | undefined;
  const diff = details?.diff as string | undefined;
  const op = details?.op as string | undefined;

  return (
    <div className="omp-tool-result-edit">
      {content && <div className="omp-edit-status">{content}</div>}
      {diff && <DiffView diff={diff} />}
      {!diff && !content && op && (
        <div className="omp-edit-status">Operation: {op}</div>
      )}
    </div>
  );
}

/** Renders a colored diff view with line numbers */
function DiffView({ diff }: { diff: string }) {
  const lines = parseDiffLines(diff);

  return (
    <div className="omp-diff-view">
      {lines.map((line, i) => (
        <div key={i} className={`omp-diff-line omp-diff-${line.type}`}>
          <span className="omp-diff-gutter">{line.lineNum || ""}</span>
          <span className="omp-diff-marker">{line.marker}</span>
          <span className="omp-diff-content">{line.content}</span>
        </div>
      ))}
    </div>
  );
}

interface DiffLine {
  type: "add" | "remove" | "context" | "ellipsis";
  marker: string;
  lineNum: string;
  content: string;
}

function parseDiffLines(diff: string): DiffLine[] {
  const rawLines = diff.split("\n");
  const result: DiffLine[] = [];
  // OMP diff format: " 35|    code" or "-39|    old" or "+39|    new" or " 1|..."
  const diffLineRegex = /^([+ -])(\d+)\|(.*)$/;

  for (const raw of rawLines) {
    if (!raw) continue;
    const match = raw.match(diffLineRegex);
    if (match) {
      const marker = match[1]!;
      const lineNum = match[2]!;
      const content = match[3]!;

      if (content === "...") {
        result.push({ type: "ellipsis", marker: " ", lineNum: "⋯", content: "⋯" });
      } else if (marker === "+") {
        result.push({ type: "add", marker: "+", lineNum, content });
      } else if (marker === "-") {
        result.push({ type: "remove", marker: "−", lineNum, content });
      } else {
        result.push({ type: "context", marker: " ", lineNum, content });
      }
    } else {
      // Fallback for non-standard lines
      result.push({ type: "context", marker: " ", lineNum: "", content: raw });
    }
  }

  return result;
}

// ============================================================================
// Bash Tool Renderer
// ============================================================================

interface BashResultProps {
  result: unknown;
  command?: string;
}

export function BashResult({ result, command }: BashResultProps) {
  const r = result as Record<string, unknown> | null;
  if (!r) return null;

  const content = extractText(r);
  if (!content) return null;

  return (
    <div className="omp-tool-result-bash">
      {command && (
        <div className="omp-bash-command">
          <Icon name="terminal" className="omp-bash-icon" />
          <code>{command}</code>
        </div>
      )}
      <pre className="omp-bash-output">{content}</pre>
    </div>
  );
}

// ============================================================================
// Find Tool Renderer
// ============================================================================

interface FindResultProps {
  result: unknown;
}

export function FindResult({ result }: FindResultProps) {
  const r = result as Record<string, unknown> | null;
  if (!r) return null;

  const content = extractText(r);
  const details = r.details as Record<string, unknown> | undefined;
  const fileCount = details?.fileCount as number | undefined;
  const files = details?.files as string[] | undefined;

  const displayFiles = files || (content ? content.split("\n").filter(Boolean) : []);

  return (
    <div className="omp-tool-result-find">
      {fileCount != null && (
        <div className="omp-find-summary">{fileCount} files found</div>
      )}
      <div className="omp-find-list">
        {displayFiles.slice(0, 30).map((f) => (
          <div key={f} className="omp-find-item">
            <a
              href="#"
              className="omp-file-link"
              onClick={(e) => { e.preventDefault(); openFileInEditor(f); }}
            >
              {f}
            </a>
          </div>
        ))}
        {displayFiles.length > 30 && (
          <div className="omp-find-more">...and {displayFiles.length - 30} more</div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Generic fallback renderer
// ============================================================================

interface GenericResultProps {
  result: unknown;
}

export function GenericResult({ result }: GenericResultProps) {
  const [showRaw, setShowRaw] = useState(false);
  const r = result as Record<string, unknown> | null;
  if (!r) return null;

  const content = extractText(r);
  const details = r.details as Record<string, unknown> | undefined;

  return (
    <div className="omp-tool-result-generic">
      {content && <ClickableText text={content} className="omp-tool-result-text" />}
      {details && (
        <details className="omp-tool-details">
          <summary>Details</summary>
          <pre className="omp-tool-details-json">{JSON.stringify(details, null, 2)}</pre>
        </details>
      )}
      <button className="omp-tool-raw-btn" onClick={() => setShowRaw(!showRaw)}>
        {showRaw ? "Hide raw" : "Show raw"}
      </button>
      {showRaw && (
        <pre className="omp-tool-raw-json">{JSON.stringify(result, null, 2)}</pre>
      )}
    </div>
  );
}

// ============================================================================
// Helpers
// ============================================================================

function extractText(r: Record<string, unknown>): string | null {
  if (Array.isArray(r.content)) {
    const texts = r.content
      .filter((b: any) => b?.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text as string);
    if (texts.length > 0) return texts.join("\n");
  }
  if (typeof r.text === "string") return r.text;
  if (typeof r.content === "string") return r.content;
  return null;
}
