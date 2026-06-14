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
  const [expanded, setExpanded] = useState(true);
  const r = result as Record<string, unknown> | null;
  if (!r) return null;

  const details = r.details as Record<string, unknown> | undefined;
  const matchCount = details?.matchCount as number | undefined;
  const fileCount = details?.fileCount as number | undefined;
  const fileMatches = details?.fileMatches as Array<{ path: string; count: number }> | undefined;
  const truncated = details?.truncated as boolean | undefined;
  const displayContent = details?.displayContent as string | undefined;
  const rawContent = extractText(r);

  // Parse displayContent into structured file groups with match lines
  const groups = parseSearchDisplayContent(displayContent || rawContent || "", fileMatches);

  return (
    <div className="omp-tool-result-search">
      {/* Summary bar */}
      <div className="omp-search-header">
        <span className="omp-search-stat">
          <strong>{matchCount ?? "?"}</strong> {matchCount === 1 ? "match" : "matches"}
        </span>
        <span className="omp-search-stat">
          in <strong>{fileCount ?? fileMatches?.length ?? "?"}</strong> {fileCount === 1 ? "file" : "files"}
        </span>
        {truncated && <span className="omp-search-truncated">(truncated)</span>}
        {groups.length > 0 && (
          <button className="omp-search-toggle" onClick={() => setExpanded(!expanded)}>
            <Icon name={expanded ? "chevron-down" : "chevron-right"} />
          </button>
        )}
      </div>

      {/* File match groups with inline snippets */}
      {expanded && groups.length > 0 && (
        <div className="omp-search-groups">
          {groups.map((group, gi) => (
            <div key={gi} className="omp-search-group">
              <div className="omp-search-group-header">
                <Icon name="file" className="omp-search-file-icon" />
                <a
                  href="#"
                  className="omp-file-link"
                  onClick={(e) => { e.preventDefault(); openFileInEditor(group.path); }}
                >
                  {group.path}
                </a>
                {group.count > 0 && (
                  <span className="omp-search-group-count">{group.count}</span>
                )}
              </div>
              {group.lines.length > 0 && (
                <div className="omp-search-snippet">
                  {group.lines.map((line, li) => (
                    <div
                      key={li}
                      className={`omp-search-line ${line.isMatch ? "omp-search-line--match" : ""}`}
                    >
                      <span className="omp-search-line-num">{line.lineNum}</span>
                      <span className="omp-search-line-content">{line.content}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Fallback: file list without snippets (when no displayContent) */}
      {!expanded && fileMatches && fileMatches.length > 0 && (
        <div className="omp-search-file-list">
          {fileMatches.map((fm) => (
            <div key={fm.path} className="omp-search-file-item">
              <a
                href="#"
                className="omp-file-link"
                onClick={(e) => { e.preventDefault(); openFileInEditor(fm.path); }}
              >
                {fm.path}
              </a>
              <span className="omp-search-group-count">{fm.count}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface SearchGroup {
  path: string;
  count: number;
  lines: Array<{ lineNum: string; content: string; isMatch: boolean }>;
}

/** Parse OMP's displayContent format into structured groups */
function parseSearchDisplayContent(text: string, fileMatches?: Array<{ path: string; count: number }>): SearchGroup[] {
  const groups: SearchGroup[] = [];
  let currentDir = "";
  let currentPath = "";
  let currentLines: SearchGroup["lines"] = [];

  for (const raw of text.split("\n")) {
    // Directory header: "# dir/"
    if (raw.startsWith("# ")) {
      currentDir = raw.slice(2).trim().replace(/\/$/, "");
      continue;
    }

    // File header: "## filename"
    if (raw.startsWith("## ")) {
      if (currentPath && currentLines.length > 0) {
        groups.push({ path: currentPath, count: currentLines.filter((l) => l.isMatch).length, lines: currentLines });
      }
      const fileName = raw.slice(3).trim();
      currentPath = currentDir ? `${currentDir}/${fileName}` : fileName;
      currentLines = [];
      continue;
    }

    // Match line: "*linenum│content" or " linenum│content"
    const lineMatch = raw.match(/^([* ])?\s*(\d+)│(.*)$/);
    if (lineMatch) {
      const isMatch = lineMatch[1] === "*";
      currentLines.push({
        lineNum: lineMatch[2]!,
        content: lineMatch[3] ?? "",
        isMatch,
      });
      continue;
    }

    // Hashline format fallback: "*linenum hash|content" or " linenum hash|content"
    const hashMatch = raw.match(/^([* ])(\d+)[a-z]{2,4}\|(.*)$/);
    if (hashMatch) {
      const isMatch = hashMatch[1] === "*";
      currentLines.push({
        lineNum: hashMatch[2]!,
        content: hashMatch[3] ?? "",
        isMatch,
      });
    }
  }

  // Push last group
  if (currentPath && currentLines.length > 0) {
    groups.push({ path: currentPath, count: currentLines.filter((l) => l.isMatch).length, lines: currentLines });
  }

  // If no groups were parsed but we have fileMatches metadata, create groups from that
  if (groups.length === 0 && fileMatches) {
    for (const fm of fileMatches) {
      groups.push({ path: fm.path, count: fm.count, lines: [] });
    }
  }

  // If we still have ungrouped lines (no ## header, single file), wrap them
  if (groups.length === 0 && currentLines.length > 0) {
    groups.push({ path: "", count: currentLines.filter((l) => l.isMatch).length, lines: currentLines });
  }

  return groups;
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
  const lines = pairReplacementLines(parseDiffLines(diff));

  return (
    <div className="omp-diff-view">
      {lines.map((line, i) => (
        <div
          key={i}
          className={`omp-diff-line omp-diff-${line.type}${line.segments ? " omp-diff-replace" : ""}`}
        >
          <span className="omp-diff-gutter">{line.lineNum || ""}</span>
          <span className="omp-diff-marker">{line.marker}</span>
          <span className="omp-diff-content">
            {line.segments
              ? line.segments.map((segment, segmentIndex) => (
                  <span
                    key={segmentIndex}
                    className={segment.changed ? "omp-diff-content-changed" : undefined}
                  >
                    {segment.text}
                  </span>
                ))
              : line.content}
          </span>
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

interface DiffSegment {
  text: string;
  changed: boolean;
}

interface RenderDiffLine extends DiffLine {
  segments?: DiffSegment[];
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

function pairReplacementLines(lines: DiffLine[]): RenderDiffLine[] {
  const paired: RenderDiffLine[] = [];

  for (let i = 0; i < lines.length; i++) {
    const current = lines[i]!;
    const next = lines[i + 1];
    const isReplacementPair =
      next &&
      ((current.type === "remove" && next.type === "add") ||
        (current.type === "add" && next.type === "remove"));

    if (isReplacementPair) {
      const oldLine = current.type === "remove" ? current : next!;
      const newLine = current.type === "add" ? current : next!;
      const [oldSegments, newSegments] = buildChangedSegments(oldLine.content, newLine.content);

      paired.push({ ...current, segments: current.type === "remove" ? oldSegments : newSegments });
      paired.push({ ...next!, segments: next!.type === "remove" ? oldSegments : newSegments });
      i++;
      continue;
    }

    paired.push(current);
  }

  return paired;
}

function buildChangedSegments(oldText: string, newText: string): [DiffSegment[], DiffSegment[]] {
  let prefix = 0;
  while (
    prefix < oldText.length &&
    prefix < newText.length &&
    oldText[prefix] === newText[prefix]
  ) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < oldText.length - prefix &&
    suffix < newText.length - prefix &&
    oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  ) {
    suffix++;
  }

  return [
    splitDiffSegments(oldText, prefix, suffix),
    splitDiffSegments(newText, prefix, suffix),
  ];
}

function splitDiffSegments(text: string, prefix: number, suffix: number): DiffSegment[] {
  const segments: DiffSegment[] = [];
  const before = text.slice(0, prefix);
  const changed = text.slice(prefix, text.length - suffix);
  const after = suffix > 0 ? text.slice(text.length - suffix) : "";

  if (before) segments.push({ text: before, changed: false });
  if (changed) segments.push({ text: changed, changed: true });
  if (after) segments.push({ text: after, changed: false });
  if (segments.length === 0) segments.push({ text, changed: false });

  return segments;
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
  const [expanded, setExpanded] = useState(true);
  const r = result as Record<string, unknown> | null;
  if (!r) return null;

  const content = extractText(r);
  const details = r.details as Record<string, unknown> | undefined;
  const fileCount = details?.fileCount as number | undefined;
  const files = details?.files as string[] | undefined;

  const displayFiles = files || (content ? content.split("\n").filter(Boolean) : []);
  const count = fileCount ?? displayFiles.length;

  return (
    <div className="omp-tool-result-find">
      <div className="omp-find-header">
        <span className="omp-find-stat">
          <strong>{count}</strong> {count === 1 ? "file" : "files"} found
        </span>
        {displayFiles.length > 5 && (
          <button className="omp-search-toggle" onClick={() => setExpanded(!expanded)}>
            <Icon name={expanded ? "chevron-down" : "chevron-right"} />
          </button>
        )}
      </div>
      {expanded && (
        <div className="omp-find-list">
          {displayFiles.slice(0, 50).map((f) => (
            <div key={f} className="omp-find-item">
              <Icon name={getFileIcon(f)} className="omp-find-file-icon" />
              <a
                href="#"
                className="omp-file-link"
                onClick={(e) => { e.preventDefault(); openFileInEditor(f); }}
              >
                {f}
              </a>
            </div>
          ))}
          {displayFiles.length > 50 && (
            <div className="omp-find-more">...and {displayFiles.length - 50} more</div>
          )}
        </div>
      )}
    </div>
  );
}

/** Get a codicon name based on file extension */
function getFileIcon(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (path.endsWith("/")) return "folder";
  const iconMap: Record<string, string> = {
    ts: "file-code", tsx: "file-code", js: "file-code", jsx: "file-code",
    py: "file-code", rb: "file-code", rs: "file-code", go: "file-code",
    c: "file-code", h: "file-code", cpp: "file-code", java: "file-code",
    json: "json", yaml: "file-code", yml: "file-code", toml: "file-code",
    md: "markdown", txt: "file-text", html: "file-code", css: "file-code",
    svg: "file-media", png: "file-media", jpg: "file-media", gif: "file-media",
    sh: "terminal", bash: "terminal",
  };
  return iconMap[ext] || "file";
}

// ============================================================================
// Generic fallback renderer (smart JSON formatting)
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

  // If we only have text content and no structured details, render as text
  if (content && !details) {
    return (
      <div className="omp-tool-result-generic">
        <ClickableText text={content} className="omp-generic-text" />
      </div>
    );
  }

  // If we have structured details, render them smartly
  return (
    <div className="omp-tool-result-generic">
      {content && <ClickableText text={content} className="omp-generic-text" />}
      {details && <SmartJson data={details} />}
      <button className="omp-tool-raw-btn" onClick={() => setShowRaw(!showRaw)}>
        {showRaw ? "Hide raw" : "Raw JSON"}
      </button>
      {showRaw && (
        <pre className="omp-tool-raw-json">{JSON.stringify(result, null, 2)}</pre>
      )}
    </div>
  );
}

/** Smart JSON renderer — renders objects/arrays in a readable format */
function SmartJson({ data }: { data: unknown }) {
  if (data === null || data === undefined) return null;

  // Array of objects → render as compact list
  if (Array.isArray(data)) {
    if (data.length === 0) return null;
    if (typeof data[0] === "object" && data[0] !== null) {
      return (
        <div className="omp-smart-json-list">
          {data.slice(0, 20).map((item, i) => (
            <SmartJsonItem key={i} data={item} />
          ))}
          {data.length > 20 && (
            <div className="omp-smart-json-more">...and {data.length - 20} more items</div>
          )}
        </div>
      );
    }
    // Array of primitives
    return (
      <div className="omp-smart-json-list">
        {data.slice(0, 30).map((item, i) => (
          <div key={i} className="omp-smart-json-primitive">{String(item)}</div>
        ))}
      </div>
    );
  }

  // Object → render as key-value pairs
  if (typeof data === "object") {
    const entries = Object.entries(data as Record<string, unknown>);
    if (entries.length === 0) return null;
    return (
      <div className="omp-smart-json-kv">
        {entries.map(([key, value]) => (
          <div key={key} className="omp-smart-json-row">
            <span className="omp-smart-json-key">{key}</span>
            <span className="omp-smart-json-value">{formatJsonValue(value)}</span>
          </div>
        ))}
      </div>
    );
  }

  return <span className="omp-smart-json-primitive">{String(data)}</span>;
}

/** Render a single object from an array as a compact card */
function SmartJsonItem({ data }: { data: unknown }) {
  if (!data || typeof data !== "object") {
    return <div className="omp-smart-json-primitive">{String(data)}</div>;
  }
  const entries = Object.entries(data as Record<string, unknown>);
  // Find a "title" field (name, path, title, label, id, file)
  const titleKey = entries.find(([k]) =>
    ["name", "path", "title", "label", "file", "filePath"].includes(k),
  );
  const rest = entries.filter(([k]) => k !== titleKey?.[0]);

  return (
    <div className="omp-smart-json-item">
      {titleKey && (
        <span className="omp-smart-json-item-title">{formatJsonValue(titleKey[1])}</span>
      )}
      {rest.slice(0, 4).map(([key, value]) => (
        <span key={key} className="omp-smart-json-item-meta">
          {key}: {formatJsonValue(value)}
        </span>
      ))}
    </div>
  );
}

function formatJsonValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    if (value.length > 80) return value.slice(0, 77) + "...";
    return value;
  }
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (typeof value === "object") return `{${Object.keys(value as object).length} fields}`;
  return String(value);
}

// ============================================================================
// Web Search Result Renderer
// ============================================================================

interface WebSearchResultProps {
  result: unknown;
}

export function WebSearchResult({ result }: WebSearchResultProps) {
  const r = result as Record<string, unknown> | null;
  if (!r) return null;

  const content = extractText(r);
  if (!content) return null;

  // Parse "[N] Title\n    url" format
  const entries = parseWebSearchResults(content);

  if (entries.length === 0) {
    return (
      <div className="omp-tool-result-websearch">
        <pre className="omp-generic-text">{content}</pre>
      </div>
    );
  }

  return (
    <div className="omp-tool-result-websearch">
      {entries.map((entry, i) => (
        <div key={i} className="omp-websearch-entry">
          <div className="omp-websearch-title">
            <span className="omp-websearch-num">{entry.num}</span>
            <span>{entry.title}</span>
          </div>
          {entry.url && (
            <a className="omp-websearch-url" href={entry.url} target="_blank" rel="noreferrer">
              {entry.url}
            </a>
          )}
          {entry.snippet && (
            <div className="omp-websearch-snippet">{entry.snippet}</div>
          )}
        </div>
      ))}
    </div>
  );
}

function parseWebSearchResults(text: string): Array<{ num: string; title: string; url?: string; snippet?: string }> {
  const entries: Array<{ num: string; title: string; url?: string; snippet?: string }> = [];
  const lines = text.split("\n");
  let i = 0;

  while (i < lines.length) {
    const titleMatch = lines[i]!.match(/^\[(\d+)\]\s*(.+)/);
    if (titleMatch) {
      const entry: { num: string; title: string; url?: string; snippet?: string } = {
        num: titleMatch[1]!,
        title: titleMatch[2]!,
      };
      i++;
      // Next line(s) may be URL and/or snippet
      while (i < lines.length && !lines[i]!.match(/^\[\d+\]/)) {
        const trimmed = lines[i]!.trim();
        if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
          entry.url = trimmed;
        } else if (trimmed) {
          entry.snippet = (entry.snippet ? entry.snippet + " " : "") + trimmed;
        }
        i++;
      }
      entries.push(entry);
    } else {
      i++;
    }
  }

  return entries;
}

// ============================================================================
// Todo Write Result Renderer
// ============================================================================

interface TodoWriteResultProps {
  result: unknown;
}

export function TodoWriteResult({ result }: TodoWriteResultProps) {
  const r = result as Record<string, unknown> | null;
  if (!r) return null;

  const content = extractText(r);
  const details = r.details as Record<string, unknown> | undefined;

  // Try to parse todos from details or content
  const todos = parseTodoItems(details, content);

  if (todos.length === 0 && content) {
    return (
      <div className="omp-tool-result-todo">
        <pre className="omp-generic-text">{content}</pre>
      </div>
    );
  }

  return (
    <div className="omp-tool-result-todo">
      {todos.map((item, i) => (
        <div key={i} className={`omp-todo-item omp-todo-${item.status}`}>
          <Icon name={getTodoIcon(item.status)} className="omp-todo-icon" />
          <span className="omp-todo-text">{item.content}</span>
          {item.priority && (
            <span className={`omp-todo-priority omp-todo-priority--${item.priority}`}>{item.priority}</span>
          )}
        </div>
      ))}
    </div>
  );
}

function getTodoIcon(status: string): string {
  switch (status) {
    case "completed": return "pass-filled";
    case "in_progress": return "sync~spin";
    case "cancelled": return "circle-slash";
    default: return "circle-large-outline";
  }
}

function parseTodoItems(details: Record<string, unknown> | undefined, content: string | null): Array<{ content: string; status: string; priority?: string }> {
  // Try details.todos array
  if (details?.todos && Array.isArray(details.todos)) {
    return (details.todos as Array<Record<string, unknown>>).map((t) => ({
      content: (t.content as string) || "",
      status: (t.status as string) || "pending",
      priority: t.priority as string | undefined,
    }));
  }

  // Try to parse from text content (e.g., "- [x] item" or "pending: item")
  if (!content) return [];
  const items: Array<{ content: string; status: string; priority?: string }> = [];
  for (const line of content.split("\n")) {
    const checkMatch = line.match(/^[-*]\s*\[([ xX~])\]\s*(.+)/);
    if (checkMatch) {
      const mark = checkMatch[1]!;
      const status = mark === "x" || mark === "X" ? "completed" : mark === "~" ? "cancelled" : "pending";
      items.push({ content: checkMatch[2]!, status });
      continue;
    }
    const statusMatch = line.match(/^(pending|in_progress|completed|cancelled):\s*(.+)/i);
    if (statusMatch) {
      items.push({ content: statusMatch[2]!, status: statusMatch[1]!.toLowerCase() });
    }
  }
  return items;
}

// ============================================================================
// VS Code Bridge Tool Result Renderer
// ============================================================================

interface VscodeResultProps {
  result: unknown;
}

export function VscodeResult({ result }: VscodeResultProps) {
  const r = result as Record<string, unknown> | null;
  if (!r) return null;

  const content = extractText(r);
  if (!content) return null;

  // Parse the JSON content from the bridge (it's JSON-stringified in the text)
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Not JSON — render as text
    return (
      <div className="omp-tool-result-vscode">
        <ClickableText text={content} className="omp-generic-text" />
      </div>
    );
  }

  if (!parsed || typeof parsed !== "object") {
    return (
      <div className="omp-tool-result-vscode">
        <pre className="omp-generic-text">{content}</pre>
      </div>
    );
  }

  return (
    <div className="omp-tool-result-vscode">
      <SmartJson data={parsed} />
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
