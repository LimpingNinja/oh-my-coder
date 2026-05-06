import { useState, useMemo } from "react";
import type { ToolCall } from "../state/store";
import { CodeBlock } from "./CodeBlock";
import { Icon } from "./Icon";

interface ToolBlockProps {
  toolCall: ToolCall;
}

/** Map tool names to codicon names and labels */
function getToolDisplay(toolName: string): { icon: string; label: string } {
  const map: Record<string, { icon: string; label: string }> = {
    write_to_file: { icon: "new-file", label: "Write" },
    create_file: { icon: "new-file", label: "Write" },
    edit_file: { icon: "edit", label: "Edit" },
    apply_diff: { icon: "diff", label: "Edit" },
    replace_in_file: { icon: "replace", label: "Edit" },
    read_file: { icon: "file", label: "Read" },
    list_files: { icon: "folder", label: "List" },
    search_files: { icon: "search", label: "Search" },
    execute_command: { icon: "terminal", label: "Shell" },
    bash: { icon: "terminal", label: "Shell" },
    browser_action: { icon: "globe", label: "Browser" },
    ask_followup_question: { icon: "comment-discussion", label: "Ask" },
    attempt_completion: { icon: "check-all", label: "Complete" },
  };

  if (toolName.startsWith("mcp__")) {
    const parts = toolName.split("_");
    return { icon: "zap", label: `MCP ${parts.slice(2).join("_")}` };
  }

  return map[toolName] || { icon: "gear", label: toolName };
}

/** Extract filename from tool args if present */
function extractFilename(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const a = args as Record<string, unknown>;
  if (typeof a.path === "string") return a.path;
  if (typeof a.filePath === "string") return a.filePath;
  if (typeof a.file_path === "string") return a.file_path;
  if (typeof a.pathInProject === "string") return a.pathInProject;
  return null;
}

/** Extract line count from content if present */
function extractLineCount(args: unknown, result: unknown): number | null {
  // Try from result
  if (result && typeof result === "string") {
    const lines = result.split("\n").length;
    if (lines > 1) return lines;
  }
  // Try from args content
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    const content = a.content || a.newText || a.text;
    if (typeof content === "string") {
      return content.split("\n").length;
    }
  }
  return null;
}

/** Extract displayable content from args (for write/edit operations) */
function extractContent(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const a = args as Record<string, unknown>;
  if (typeof a.content === "string") return a.content;
  if (typeof a.newText === "string") return a.newText;
  if (typeof a.command === "string") return a.command;
  if (typeof a.diff === "string") return a.diff;
  return null;
}

/** Guess language from filename */
function guessLanguage(filename: string | null): string {
  if (!filename) return "text";
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    py: "python", rb: "ruby", rs: "rust", go: "go", lua: "lua",
    c: "c", h: "c", cpp: "cpp", hpp: "cpp", cs: "csharp",
    java: "java", kt: "kotlin", swift: "swift", sh: "bash",
    yml: "yaml", yaml: "yaml", json: "json", toml: "toml",
    md: "markdown", html: "html", css: "css", sql: "sql",
    cmake: "cmake", txt: "text",
  };
  return map[ext] || "text";
}

/** Format result text for display */
function formatResult(result: unknown): string | null {
  if (result == null) return null;
  if (typeof result === "string") return result;
  if (typeof result === "object") {
    // Try to extract text content from content blocks
    if (Array.isArray(result)) {
      const texts = result
        .filter((b: any) => b?.type === "text" && typeof b.text === "string")
        .map((b: any) => b.text);
      if (texts.length > 0) return texts.join("\n");
    }
    const r = result as Record<string, unknown>;
    if (typeof r.text === "string") return r.text;
    if (typeof r.content === "string") return r.content;
    return JSON.stringify(result, null, 2);
  }
  return String(result);
}

export function ToolBlock({ toolCall }: ToolBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const { toolName, status, args, intent, result, isError } = toolCall;

  const display = useMemo(() => getToolDisplay(toolName), [toolName]);
  const filename = useMemo(() => extractFilename(args), [args]);
  const lineCount = useMemo(() => extractLineCount(args, result), [args, result]);
  const content = useMemo(() => extractContent(args), [args]);
  const resultText = useMemo(() => formatResult(result), [result]);
  const language = useMemo(() => guessLanguage(filename), [filename]);

  const statusIcon = status === "running" ? "loading~spin" : status === "error" ? "error" : "pass";
  const statusClass = `omp-tool-block omp-tool-${status}`;

  // Build the header summary line
  const headerParts: string[] = [];
  if (filename) {
    const basename = filename.split("/").pop() || filename;
    headerParts.push(basename);
  }
  if (lineCount && lineCount > 1) {
    headerParts.push(`(${lineCount} lines)`);
  }
  const headerSummary = headerParts.join(" ");

  return (
    <div className={statusClass}>
      <button className="omp-tool-header" onClick={() => setIsExpanded(!isExpanded)}>
        <Icon name={isExpanded ? "chevron-down" : "chevron-right"} className="omp-tool-chevron" />
        <Icon name={statusIcon} className={`omp-tool-status-icon omp-tool-status-${status}`} />
        <Icon name={display.icon} className="omp-tool-action-icon" />
        <span className="omp-tool-label">{display.label}</span>
        {headerSummary && <span className="omp-tool-filename">{headerSummary}</span>}
        {intent && !filename && <span className="omp-tool-intent">{intent}</span>}
      </button>

      {isExpanded && (
        <div className="omp-tool-body">
          {/* Show content for write/edit operations */}
          {content && (
            <CodeBlock language={language}>{content}</CodeBlock>
          )}

          {/* Show result for completed operations */}
          {!content && resultText && !isError && (
            <div className="omp-tool-result-content">
              {resultText.includes("\n") || resultText.length > 120 ? (
                <CodeBlock language={language}>{resultText}</CodeBlock>
              ) : (
                <p className="omp-tool-result-text">{resultText}</p>
              )}
            </div>
          )}

          {/* Show error for failed operations */}
          {isError && resultText && (
            <div className="omp-tool-error-content">
              <pre>{resultText.slice(0, 500)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
