import { useState, useMemo } from "react";
import type { ToolCall } from "../state/store";
import { Icon } from "./Icon";
import { ClickableText } from "./ClickableText";
import { openFileInEditor } from "../utils/resultParser";
import {
  ReadResult,
  SearchResult,
  EditResult,
  BashResult,
  FindResult,
  GenericResult,
} from "./tools/ToolResults";

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
    read: { icon: "file", label: "Read" },
    list_files: { icon: "folder", label: "List" },
    find: { icon: "folder", label: "Find" },
    search_files: { icon: "search", label: "Search" },
    search: { icon: "search", label: "Search" },
    execute_command: { icon: "terminal", label: "Shell" },
    bash: { icon: "terminal", label: "Shell" },
    browser_action: { icon: "globe", label: "Browser" },
    ask_followup_question: { icon: "comment-discussion", label: "Ask" },
    attempt_completion: { icon: "check-all", label: "Complete" },
  };

  if (toolName.startsWith("mcp__")) {
    const parts = toolName.replace("mcp__", "").split("_");
    return { icon: "zap", label: parts.slice(1).join("_") || "MCP" };
  }

  return map[toolName] || { icon: "gear", label: toolName };
}

function extractFilename(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const a = args as Record<string, unknown>;
  return (a.path || a.filePath || a.file_path || a.pathInProject) as string | null;
}

function extractCommand(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const a = args as Record<string, unknown>;
  return (a.command || a.cmd) as string | null;
}

/** Get just the basename from a path for the header */
function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

/** Determine which tool category for result rendering */
function getToolCategory(toolName: string): "read" | "search" | "edit" | "bash" | "find" | "generic" {
  if (["read", "read_file", "jetbrains_read_file", "jetbrains_get_file_text_by_path"].includes(toolName)) return "read";
  if (["search", "search_files", "jetbrains_search_in_files_by_text", "jetbrains_search_in_files_by_regex", "jetbrains_search_text", "jetbrains_search_regex"].includes(toolName)) return "search";
  if (["edit", "edit_file", "apply_diff", "replace_in_file", "write_to_file", "write", "create_file", "jetbrains_replace_text_in_file"].includes(toolName)) return "edit";
  if (["bash", "execute_command", "shell", "jetbrains_execute_terminal_command"].includes(toolName)) return "bash";
  if (["find", "list_files", "glob", "jetbrains_find_files_by_glob", "jetbrains_find_files_by_name_keyword"].includes(toolName)) return "find";
  return "generic";
}

export function ToolBlock({ toolCall }: ToolBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const { toolName, status, args, intent, result, isError } = toolCall;

  // Question tool: suppress the block while running (the UiRequestTurn cards handle it).
  // Always render a stable element (never null) to avoid React hook ordering issues.
  if (toolName === "question" && status === "running") {
    return <div className="omp-tool-block omp-tool-hidden" aria-hidden="true" />;
  }

  // Question tool completed: render the Q&A summary
  if (toolName === "question" && (status === "completed" || status === "error")) {
    return <QuestionToolSummary result={result} isError={isError} isExpanded={isExpanded} setIsExpanded={setIsExpanded} />;
  }

  const display = useMemo(() => getToolDisplay(toolName), [toolName]);
  const filename = useMemo(() => extractFilename(args), [args]);
  const command = useMemo(() => extractCommand(args), [args]);
  const category = useMemo(() => getToolCategory(toolName), [toolName]);

  const statusIcon =
    status === "running" ? "sync~spin"
    : status === "error" ? "error"
    : status === "cancelled" ? "circle-slash"
    : "pass";

  // Build header display text
  let headerText = "";
  if (filename) {
    headerText = basename(filename);
    // Add range info from args if present
    const a = args as Record<string, unknown> | null;
    if (a?.sel) headerText += `:${a.sel}`;
    else if (a?.startLine) headerText += `:${a.startLine}${a.endLine ? `-${a.endLine}` : ""}`;
  } else if (command) {
    headerText = command.length > 50 ? command.slice(0, 50) + "…" : command;
  }

  return (
    <div className={`omp-tool-block omp-tool-${status}`}>
      <div
        className="omp-tool-header"
        role="button"
        tabIndex={0}
        onClick={() => setIsExpanded(!isExpanded)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setIsExpanded(!isExpanded); }}
      >
        <Icon name={isExpanded ? "chevron-down" : "chevron-right"} className="omp-tool-chevron" />
        <Icon name={statusIcon} className={`omp-tool-status-icon omp-tool-status-${status}`} />
        <Icon name={display.icon} className="omp-tool-action-icon" />
        <span className={`omp-tool-label${status === "running" ? " omp-shimmer" : ""}`}>{display.label}</span>
        {filename ? (
          <a
            href="#"
            className="omp-file-link omp-tool-filename"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              openFileInEditor(filename);
            }}
            title={`Open ${filename}`}
          >
            {headerText}
          </a>
        ) : headerText ? (
          <span className="omp-tool-header-text">{headerText}</span>
        ) : intent ? (
          <span className="omp-tool-intent">{intent}</span>
        ) : null}
      </div>

      {isExpanded && (
        <div className="omp-tool-body">
          {/* Tool-specific result renderer */}
          {result != null && !isError && renderResult(category, result, filename, command)}

          {/* Error display */}
          {isError && result != null && (
            <div className="omp-tool-error-content">
              <pre>{typeof result === "string" ? result : JSON.stringify(result, null, 2)}</pre>
            </div>
          )}

          {/* No result yet (running) */}
          {result == null && status === "running" && (
            <div className="omp-tool-running-msg">
              <Icon name="sync~spin" /> Running...
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function renderResult(
  category: "read" | "search" | "edit" | "bash" | "find" | "generic",
  result: unknown,
  filename: string | null,
  command: string | null,
) {
  switch (category) {
    case "read":
      return <ReadResult result={result} filename={filename} />;
    case "search":
      return <SearchResult result={result} />;
    case "edit":
      return <EditResult result={result} filename={filename} />;
    case "bash":
      return <BashResult result={result} command={command || undefined} />;
    case "find":
      return <FindResult result={result} />;
    default:
      return <GenericResult result={result} />;
  }
}

// ── Question Tool Summary ────────────────────────────────────────────────────

interface QuestionToolSummaryProps {
  result: unknown;
  isError?: boolean;
  isExpanded: boolean;
  setIsExpanded: (v: boolean) => void;
}

function QuestionToolSummary({ result, isError, isExpanded, setIsExpanded }: QuestionToolSummaryProps) {
  const answers = parseQuestionResults(result);
  const total = answers.length;

  if (isError || total === 0) {
    return (
      <div className="omp-tool-block omp-tool-error">
        <div className="omp-tool-header" role="button" tabIndex={0} onClick={() => setIsExpanded(!isExpanded)}>
          <Icon name={isExpanded ? "chevron-down" : "chevron-right"} className="omp-tool-chevron" />
          <Icon name="error" className="omp-tool-status-icon omp-tool-status-error" />
          <Icon name="comment-discussion" className="omp-tool-action-icon" />
          <span className="omp-question-summary-title">Questions</span>
          <span className="omp-question-summary-count">cancelled</span>
        </div>
      </div>
    );
  }

  return (
    <div className="omp-tool-block omp-tool-completed">
      <div
        className="omp-tool-header"
        role="button"
        tabIndex={0}
        onClick={() => setIsExpanded(!isExpanded)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setIsExpanded(!isExpanded); }}
      >
        <Icon name={isExpanded ? "chevron-down" : "chevron-right"} className="omp-tool-chevron" />
        <Icon name="pass" className="omp-tool-status-icon omp-tool-status-completed" />
        <Icon name="comment-discussion" className="omp-tool-action-icon" />
        <span className="omp-question-summary-title">Questions</span>
        <span className="omp-question-summary-count">{total} answered</span>
      </div>
      {isExpanded && (
        <div className="omp-tool-body omp-question-summary-body">
          {answers.map((a, i) => (
            <div key={i} className="omp-question-summary-item">
              <div className="omp-question-summary-q">{a.question}</div>
              <span className="omp-ui-answer-badge">{a.answer}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function parseQuestionResults(result: unknown): Array<{ question: string; answer: string }> {
  if (!result) return [];
  const r = result as Record<string, unknown>;
  // Try details.results (our bridge format)
  if (r.details && typeof r.details === "object") {
    const details = r.details as Record<string, unknown>;
    if (Array.isArray(details.results)) {
      return details.results.map((item: any) => ({
        question: item.question ?? "",
        answer: item.answer ?? item.selectedOptions?.[0] ?? "",
      }));
    }
  }
  // Fallback: parse from content text ("Q\n→ A\n\nQ\n→ A" format)
  if (r.content && Array.isArray(r.content)) {
    const text = (r.content as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text)
      .join("\n");
    const pairs = text.split("\n\n").filter(Boolean);
    return pairs.map((pair) => {
      const lines = pair.split("\n");
      const question = lines[0] ?? "";
      const answer = lines[1]?.replace(/^→\s*/, "") ?? "";
      return { question, answer };
    });
  }
  return [];
}
