import { useState } from "react";
import type { ToolCall } from "../state/store";

interface ToolBlockProps {
  toolCall: ToolCall;
}

export function ToolBlock({ toolCall }: ToolBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const { toolName, status, intent, result, isError } = toolCall;

  const statusIcon =
    status === "running" ? "⟳" : status === "error" ? "✗" : "✓";
  const statusClass = `omp-tool-block omp-tool-${status}`;

  const resultStr = result != null
    ? typeof result === "string" ? result : JSON.stringify(result, null, 2)
    : null;

  return (
    <div className={statusClass}>
      <button className="omp-tool-header" onClick={() => setIsExpanded(!isExpanded)}>
        <span className={`omp-tool-chevron${isExpanded ? " open" : ""}`}>▶</span>
        <span className="omp-tool-icon">{statusIcon}</span>
        <span className="omp-tool-name">{toolName}</span>
        {intent && <span className="omp-tool-intent"> — {intent}</span>}
      </button>
      {isExpanded && resultStr && (
        <div className="omp-tool-result">
          <pre>{resultStr}</pre>
        </div>
      )}
      {!isExpanded && isError && resultStr && (
        <div className="omp-tool-error-preview">
          {resultStr.slice(0, 120)}
        </div>
      )}
    </div>
  );
}
