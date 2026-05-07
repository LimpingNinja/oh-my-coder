/**
 * TurnView — renders a single turn in the transcript.
 * User turns: right-aligned text bubble.
 * Agent turns: sequential events rendered by type (no role labels).
 */

import type { Turn, TurnEvent, ToolCallEvent, TaskProgress } from "../state/turns";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolBlock } from "./ToolBlock";
import { CodeBlock } from "./CodeBlock";
import { Icon } from "./Icon";
import { ClickableText } from "./ClickableText";
import { extractResultText, stripTaskSummaryXml } from "../utils/resultParser";
import { getVSCodeAPI } from "../vscode";
import { getState } from "../state/store";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useState, useCallback } from "react";

interface TurnViewProps {
  turn: Turn;
}

export function TurnView({ turn }: TurnViewProps) {
  if (turn.kind === "user") {
    return <UserTurn text={turn.text} queuedAs={turn.queuedAs} />;
  }
  return <AgentTurn turn={turn} />;
}

function UserTurn({ text, queuedAs }: { text: string; queuedAs?: "steer" | "followUp" }) {
  const bubbleClass = queuedAs
    ? `omp-msg-content omp-user-bubble omp-user-bubble--queued`
    : "omp-msg-content omp-user-bubble";

  return (
    <div className="omp-turn omp-turn-user">
      <div className={bubbleClass}>
        {queuedAs && (
          <span className="omp-queued-badge">
            <i className={`codicon ${queuedAs === "steer" ? "codicon-milestone" : "codicon-git-compare"}`} />
            {queuedAs === "steer" ? "Steering" : "Follow-up"}
          </span>
        )}
        {text}
      </div>
    </div>
  );
}

function AgentTurn({ turn }: { turn: Extract<Turn, { kind: "agent" }> }) {
  const [copied, setCopied] = useState(false);
  const [showStats, setShowStats] = useState(false);

  const fullText = turn.events
    .filter((e) => e.kind === "text")
    .map((e) => e.content)
    .join("\n");

  const handleCopy = useCallback(() => {
    if (!fullText) return;
    navigator.clipboard.writeText(fullText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [fullText]);

  return (
    <div className="omp-turn omp-turn-agent">
      {turn.events.map((event, idx) => (
        <EventView key={idx} event={event} />
      ))}

      {/* Action bar — shown when turn is complete and has content */}
      {!turn.active && fullText && (
        <div className="omp-msg-actions">
          <button className="omp-msg-action-btn" onClick={handleCopy} title="Copy response">
            <Icon name={copied ? "check" : "copy"} />
          </button>
          <button
            className="omp-msg-action-btn"
            onClick={() => setShowStats(!showStats)}
            title="Response details"
          >
            <Icon name="pulse" />
          </button>
        </div>
      )}

      {/* Stats panel */}
      {showStats && (
        <div className="omp-msg-stats">
          <div className="omp-msg-stats-header">RESPONSE DETAILS</div>
          <div className="omp-msg-stats-grid">
            <div className="omp-msg-stats-item">
              <span className="omp-msg-stats-label">Time</span>
              <span className="omp-msg-stats-value">
                {new Date(turn.timestamp).toLocaleTimeString()}
              </span>
            </div>
            <div className="omp-msg-stats-item">
              <span className="omp-msg-stats-label">Events</span>
              <span className="omp-msg-stats-value">{turn.events.length}</span>
            </div>
            <div className="omp-msg-stats-item">
              <span className="omp-msg-stats-label">Tools</span>
              <span className="omp-msg-stats-value">
                {turn.events.filter((e) => e.kind === "tool_call").length}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function EventView({ event }: { event: TurnEvent }) {
  switch (event.kind) {
    case "thinking":
      return <ThinkingBlock content={event.content} defaultOpen={event.streaming} />;

    case "text":
      return (
        <div className={`omp-agent-text${event.streaming ? " omp-streaming" : ""}`}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              code: ({ className, children }: any) => {
                const match = /language-(\w+)/.exec(className || "");
                const inline = !match && !String(children).includes("\n");
                if (!inline) {
                  return (
                    <CodeBlock language={match?.[1] || "text"}>
                      {String(children).replace(/\n$/, "")}
                    </CodeBlock>
                  );
                }
                return <code className="omp-inline-code">{children}</code>;
              },
              pre: ({ children }: any) => <>{children}</>,
            }}
          >
            {event.content}
          </ReactMarkdown>
        </div>
      );

    case "tool_call":
      return <ToolCallView event={event} />;

    case "tool_result":
      return null;

    case "compaction":
      return (
        <div className="omp-status-block">
          <Icon name={event.active ? "loading~spin" : "check"} />
          <span>Compacting context{event.active ? "..." : " — done"}</span>
        </div>
      );

    case "retry":
      return (
        <div className="omp-status-block">
          <Icon name={event.active ? "loading~spin" : "check"} />
          <span>Retrying{event.active ? "..." : " — done"}</span>
        </div>
      );

    case "error":
      return (
        <div className="omp-error-block">
          <Icon name="error" />
          <span>{event.message}</span>
        </div>
      );
  }
}

/** Renders a tool call — with special handling for task/agent spawns */
function ToolCallView({ event }: { event: ToolCallEvent }) {
  const isTask = isTaskTool(event.toolName);

  if (isTask) {
    return <TaskBlock event={event} />;
  }

  return (
    <ToolBlock
      toolCall={{
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
        status: event.status === "streaming" ? "running" : event.status,
        intent: event.intent,
        result: event.result,
        isError: event.isError,
      }}
    />
  );
}

/** Check if a tool is a task/agent spawn */
function isTaskTool(name: string): boolean {
  return (
    name === "task" ||
    name === "spawn_agent" ||
    name === "quick_task" ||
    name.startsWith("task_") ||
    name.includes("agent")
  );
}

/** Task/Agent spawn block — live action feed with parsed results */
function TaskBlock({ event }: { event: ToolCallEvent }) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [showRawResult, setShowRawResult] = useState(false);
  const args = event.args as Record<string, unknown> | null;

  const agentType = (args?.subagent_type as string) || (args?.agent as string) || "quick_task";
  const agentCount = event.progress?.length || (Array.isArray((args as any)?.tasks) ? (args as any).tasks.length : undefined);

  // Header text: "agent launched" while running, "completed" when done
  const headerText = event.status === "running"
    ? `${agentType} agent launched`
    : event.status === "error"
      ? `${agentType} agent failed`
      : `${agentType} completed`;

  const statusIcon =
    event.status === "running" ? "sync~spin"
    : event.status === "error" ? "error"
    : "pass-filled";

  // Parse final result
  const resultText = extractResultText(event.result);
  const resultSummary = resultText ? stripTaskSummaryXml(resultText) : null;

  return (
    <div className={`omp-task-block omp-task-${event.status}`}>
      <button className="omp-task-header" onClick={() => setIsExpanded(!isExpanded)}>
        <Icon name={isExpanded ? "chevron-down" : "chevron-right"} className="omp-task-chevron" />
        <Icon name={statusIcon} className={`omp-task-status omp-tool-status-${event.status}`} />
        <span className={`omp-task-header-text${event.status === "running" ? " omp-shimmer" : ""}`}>{headerText}</span>
        {agentCount && <span className="omp-task-count">({agentCount})</span>}
        <span className="omp-task-popout" title="Open full log">
          <Icon name="link-external" />
        </span>
      </button>

      {isExpanded && (
        <div className="omp-task-body">
          {/* Sub-agent progress rows */}
          {event.progress && event.progress.length > 0 && (
            <div className="omp-task-agents">
              {event.progress.map((p) => (
                <SubAgentRow key={p.id || p.index} progress={p} />
              ))}
            </div>
          )}

          {/* Context when no progress yet */}
          {(!event.progress || event.progress.length === 0) && event.status === "running" && (
            <div className="omp-task-waiting">
              <Icon name="sync~spin" className="omp-task-waiting-icon" />
              <span>Initializing agents...</span>
            </div>
          )}

          {/* Parsed result summary */}
          {resultSummary && event.status !== "running" && (
            <div className="omp-task-result">
              <div className="omp-task-result-summary">{resultSummary}</div>
              <button className="omp-tool-raw-btn" onClick={() => setShowRawResult(!showRawResult)}>
                {showRawResult ? "Hide raw" : "View raw"}
              </button>
              {showRawResult && (
                <pre className="omp-tool-raw-json">
                  {typeof event.result === "string" ? event.result : JSON.stringify(event.result, null, 2)}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Individual sub-agent row with live action feed */
function SubAgentRow({ progress: p }: { progress: TaskProgress }) {
  const [isExpanded, setIsExpanded] = useState(p.status === "running");

  const statusIcon =
    p.status === "running" ? "sync~spin"
    : p.status === "completed" ? "pass-filled"
    : p.status === "failed" ? "error"
    : "circle-outline";

  // Primary label is the description/task
  const label = p.description || p.task?.slice(0, 60) || `Agent ${p.index + 1}`;
  // Secondary is the ID
  const agentId = p.id;

  return (
    <div className={`omp-subagent omp-subagent-${p.status}`}>
      <button className="omp-subagent-header" onClick={() => setIsExpanded(!isExpanded)}>
        <Icon name={isExpanded ? "chevron-down" : "chevron-right"} className="omp-subagent-chevron" />
        <Icon name={statusIcon} className="omp-subagent-status" />
        <div className="omp-subagent-info">
          <span className={`omp-subagent-label${p.status === "running" ? " omp-shimmer" : ""}`}>{label}</span>
          {agentId && <span className="omp-subagent-id">{agentId}</span>}
        </div>
        {p.status === "completed" && p.durationMs && (
          <span className="omp-subagent-meta">
            {p.tokens ? `${(p.tokens / 1000000).toFixed(1)}M · ` : ""}
            {formatDuration(p.durationMs)}
          </span>
        )}
        {p.status === "running" && p.toolCount != null && p.toolCount > 0 && (
          <span className="omp-subagent-meta">{p.toolCount} tools</span>
        )}
      </button>

      {isExpanded && (
        <div className="omp-subagent-body">
          {/* Current tool (active, at top) */}
          {p.currentTool && (
            <div className="omp-action-item omp-action-active">
              <Icon name={getToolIcon(p.currentTool)} className="omp-action-icon" />
              <span className="omp-action-tool omp-shimmer">{getToolLabel(p.currentTool)}</span>
              {p.currentToolArgs && (
                <ClickableText text={p.currentToolArgs} className="omp-action-args" />
              )}
            </div>
          )}
          {/* Recent completed tools */}
          {p.recentTools && p.recentTools.length > 0 && (
            <div className="omp-action-list">
              {[...p.recentTools].reverse().map((t, i) => (
                <div key={i} className="omp-action-item">
                  <Icon name={getToolIcon(t.tool)} className="omp-action-icon" />
                  <span className="omp-action-tool">{getToolLabel(t.tool)}</span>
                  {t.args && <ClickableText text={t.args} className="omp-action-args" />}
                </div>
              ))}
            </div>
          )}
          {/* Waiting state */}
          {!p.currentTool && (!p.recentTools || p.recentTools.length === 0) && p.status === "running" && (
            <div className="omp-action-item omp-action-waiting">
              <Icon name="sync~spin" className="omp-action-icon" />
              <span className="omp-action-tool">Starting...</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function getToolIcon(name: string): string {
  if (name.includes("read") || name.includes("Read")) return "eye";
  if (name.includes("write") || name.includes("Write") || name.includes("edit") || name.includes("Edit")) return "edit";
  if (name.includes("bash") || name.includes("shell") || name.includes("Shell") || name.includes("execute")) return "terminal";
  if (name.includes("search") || name.includes("Search") || name.includes("grep") || name.includes("find")) return "search";
  if (name.includes("list") || name.includes("glob")) return "folder";
  return "gear";
}

function getToolLabel(name: string): string {
  // Capitalize and shorten common tool names
  const map: Record<string, string> = {
    read_file: "Read", read: "Read", jetbrains_read_file: "Read",
    write_to_file: "Write", edit_file: "Edit", apply_diff: "Edit",
    execute_command: "Shell", bash: "Shell", jetbrains_execute_terminal_command: "Shell",
    search_files: "Search", grep: "Search", jetbrains_search_in_files_by_text: "Search",
    list_files: "List", glob: "List", jetbrains_find_files_by_name_keyword: "Find",
    jetbrains_get_file_text_by_path: "Read", jetbrains_search_symbol: "Search",
  };
  return map[name] || name.split("_").pop() || name;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m${rem}s` : `${m}m`;
}
