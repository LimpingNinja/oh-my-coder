/**
 * TurnView — renders a single turn in the transcript.
 * User turns: right-aligned text bubble.
 * Agent turns: sequential events rendered by type (no role labels).
 */

import type { Turn, TurnEvent } from "../state/turns";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolBlock } from "./ToolBlock";
import { CodeBlock } from "./CodeBlock";
import { Icon } from "./Icon";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useState, useCallback } from "react";

interface TurnViewProps {
  turn: Turn;
}

export function TurnView({ turn }: TurnViewProps) {
  if (turn.kind === "user") {
    return <UserTurn text={turn.text} />;
  }
  return <AgentTurn turn={turn} />;
}

function UserTurn({ text }: { text: string }) {
  return (
    <div className="omp-turn omp-turn-user">
      <div className="omp-msg-content omp-user-bubble">{text}</div>
    </div>
  );
}

function AgentTurn({ turn }: { turn: Extract<Turn, { kind: "agent" }> }) {
  const [copied, setCopied] = useState(false);

  // Collect all text for copy
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
      {/* Action bar — shown when turn is complete and has text */}
      {!turn.active && fullText && (
        <div className="omp-msg-actions">
          <button className="omp-msg-action-btn" onClick={handleCopy} title="Copy response">
            <Icon name={copied ? "check" : "copy"} />
          </button>
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
        <div className={`omp-msg-content omp-agent-text${event.streaming ? " omp-streaming" : ""}`}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              code: ({ className, children, ...props }: any) => {
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

    case "tool_result":
      // Tool results are rendered inline in the tool_call block, not separately
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
