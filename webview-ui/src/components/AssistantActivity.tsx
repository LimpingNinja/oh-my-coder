import type { FooterRuntimeContext } from "../state/store";
import type { Turn, TurnEvent, ToolCallEvent } from "../state/turns";
import { getAssetUri } from "../utils/assets";

interface AssistantActivityProps {
  turns: Turn[];
  runtime: FooterRuntimeContext;
}

interface ActivityState {
  title: string;
  detail?: string;
  tone: "thinking" | "writing" | "tool" | "agents";
}

export function AssistantActivity({ turns, runtime }: AssistantActivityProps) {
  const activity = getAssistantActivity(turns, runtime);
  if (!activity) return null;

  return (
    <div className={`omp-assistant-activity omp-assistant-activity--${activity.tone}`} aria-live="polite">
      <div className="omp-activity-mark" aria-hidden="true">
        <img src={getAssetUri("logoIcon")} alt="" />
        <span className="omp-activity-mark-shine" />
      </div>
      <div className="omp-activity-copy">
        <span className="omp-activity-title omp-shimmer">{activity.title}</span>
        {activity.detail && <span className="omp-activity-detail">{activity.detail}</span>}
      </div>
    </div>
  );
}

function getAssistantActivity(turns: Turn[], runtime: FooterRuntimeContext): ActivityState | null {
  const active = [...turns].reverse().find((turn): turn is Extract<Turn, { kind: "agent" }> => (
    turn.kind === "agent" && turn.active
  ));

  if (!active && runtime.state !== "streaming" && runtime.state !== "tool" && runtime.state !== "compacting") {
    return null;
  }

  const events = active?.events ?? [];
  const task = findRunningTool(events, true);
  if (task) {
    return {
      title: "Orchestrating agents...",
      detail: task.intent || formatToolLabel(task.toolName),
      tone: "agents",
    };
  }

  const tool = findRunningTool(events, false);
  if (tool || runtime.state === "tool") {
    return {
      title: tool ? `Running ${formatToolLabel(tool.toolName)}...` : "Running tools...",
      detail: tool?.intent,
      tone: "tool",
    };
  }

  if (events.some((event) => event.kind === "text" && event.streaming)) {
    return { title: "Writing response...", tone: "writing" };
  }

  if (events.some((event) => event.kind === "thinking" && event.streaming)) {
    return { title: "Considering next steps...", tone: "thinking" };
  }

  if (runtime.state === "compacting") {
    return { title: "Compacting context...", tone: "thinking" };
  }

  return { title: "Thinking...", tone: "thinking" };
}

function findRunningTool(events: TurnEvent[], taskOnly: boolean): ToolCallEvent | undefined {
  return events.find((event): event is ToolCallEvent => {
    if (event.kind !== "tool_call") return false;
    if (event.status !== "running" && event.status !== "streaming") return false;
    return taskOnly ? isTaskTool(event.toolName) : !isTaskTool(event.toolName);
  });
}

function isTaskTool(name: string): boolean {
  return name === "task" ||
    name === "spawn_agent" ||
    name === "quick_task" ||
    name.startsWith("task_") ||
    name.includes("agent");
}

function formatToolLabel(name: string): string {
  const map: Record<string, string> = {
    read: "Read",
    read_file: "Read",
    write: "Write",
    write_to_file: "Write",
    edit: "Edit",
    edit_file: "Edit",
    apply_diff: "Edit",
    bash: "Shell",
    execute_command: "Shell",
    shell: "Shell",
    grep: "Search",
    search: "Search",
    search_files: "Search",
    glob: "Find",
    list_files: "List",
    todo_write: "Todo",
    web_search: "Web search",
  };
  if (map[name]) return map[name];
  if (name.startsWith("mcp__")) return name.replace("mcp__", "").split("_").slice(0, 2).join(" ");
  return name.split("_").filter(Boolean).join(" ") || name;
}
