import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { TranscriptMessage } from "../state/store";
import { ToolBlock } from "./ToolBlock";
import { ThinkingBlock } from "./ThinkingBlock";
import { CodeBlock } from "./CodeBlock";

interface MessageBubbleProps {
  message: TranscriptMessage;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const { role, content, thinking, streaming, toolCalls, isError } = message;

  const roleLabel = isError ? "Error" : role === "user" ? "You" : role === "assistant" ? "Assistant" : "System";
  const roleClass = `omp-msg omp-msg-${role}${streaming ? " omp-msg-streaming" : ""}${isError ? " omp-msg-error" : ""}`;

  return (
    <div className={roleClass} data-msg-id={message.id}>
      <div className={`omp-msg-role${isError ? " omp-msg-role-error" : ""}`}>
        {roleLabel}
        {streaming && <span className="omp-streaming-dot" />}
      </div>

      {/* Thinking block */}
      {thinking && <ThinkingBlock content={thinking} defaultOpen={!!streaming} />}

      {/* Content */}
      {content && (
        <div className="omp-msg-content">
          {role === "user" ? (
            // User messages: plain text, no markdown
            <span>{content}</span>
          ) : (
            // Assistant/system messages: full markdown
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                code: ({ className, children, ...props }) => {
                  const match = /language-(\w+)/.exec(className || "");
                  const isBlock = !props.node?.position?.start || 
                    (props.node?.position?.start.line !== props.node?.position?.end.line);
                  
                  if (match || isBlock) {
                    return (
                      <CodeBlock language={match?.[1] || "text"}>
                        {String(children).replace(/\n$/, "")}
                      </CodeBlock>
                    );
                  }
                  return <code className="omp-inline-code">{children}</code>;
                },
                pre: ({ children }) => <>{children}</>,
              }}
            >
              {content}
            </ReactMarkdown>
          )}
        </div>
      )}

      {/* Tool calls */}
      {toolCalls && toolCalls.length > 0 && (
        <div className="omp-tool-list">
          {toolCalls.map((tc) => (
            <ToolBlock key={tc.toolCallId} toolCall={tc} />
          ))}
        </div>
      )}
    </div>
  );
}
