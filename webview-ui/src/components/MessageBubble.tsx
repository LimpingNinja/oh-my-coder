import { useState, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { TranscriptMessage } from "../state/store";
import { ToolBlock } from "./ToolBlock";
import { ThinkingBlock } from "./ThinkingBlock";
import { CodeBlock } from "./CodeBlock";
import { Icon } from "./Icon";

interface MessageBubbleProps {
  message: TranscriptMessage;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const { role, content, thinking, streaming, toolCalls, isError } = message;
  const [showStats, setShowStats] = useState(false);
  const [copied, setCopied] = useState(false);

  const roleLabel = isError
    ? "Error"
    : role === "user"
      ? "You"
      : role === "assistant"
        ? "Assistant"
        : "System";
  const roleClass = `omp-msg omp-msg-${role}${streaming ? " omp-msg-streaming" : ""}${isError ? " omp-msg-error" : ""}`;

  const handleCopy = useCallback(() => {
    if (!content) return;
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [content]);

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
            <span>{content}</span>
          ) : (
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

      {/* Action bar for assistant messages */}
      {role === "assistant" && !streaming && content && (
        <div className="omp-msg-actions">
          <button
            className="omp-msg-action-btn"
            onClick={handleCopy}
            title="Copy response"
          >
            <Icon name={copied ? "check" : "copy"} />
          </button>
          {message.timestamp && (
            <button
              className="omp-msg-action-btn"
              onClick={() => setShowStats(!showStats)}
              title="Response statistics"
            >
              <Icon name="pulse" />
            </button>
          )}
        </div>
      )}

      {/* Response stats panel */}
      {showStats && (
        <div className="omp-msg-stats">
          <div className="omp-msg-stats-header">RESPONSE STATISTICS</div>
          <div className="omp-msg-stats-grid">
            {message.model && (
              <div className="omp-msg-stats-item">
                <span className="omp-msg-stats-label">Model</span>
                <span className="omp-msg-stats-value">{message.model}</span>
              </div>
            )}
            {message.timestamp && (
              <div className="omp-msg-stats-item">
                <span className="omp-msg-stats-label">Time</span>
                <span className="omp-msg-stats-value">
                  {new Date(message.timestamp).toLocaleTimeString()}
                </span>
              </div>
            )}
          </div>
          {(message.inputTokens != null || message.outputTokens != null) && (
            <>
              <div className="omp-msg-stats-header">TOKEN USAGE</div>
              <div className="omp-msg-stats-grid">
                {message.inputTokens != null && (
                  <div className="omp-msg-stats-item">
                    <span className="omp-msg-stats-label">Input tokens</span>
                    <span className="omp-msg-stats-value">{message.inputTokens.toLocaleString()}</span>
                  </div>
                )}
                {message.outputTokens != null && (
                  <div className="omp-msg-stats-item">
                    <span className="omp-msg-stats-label">Output tokens</span>
                    <span className="omp-msg-stats-value">{message.outputTokens.toLocaleString()}</span>
                  </div>
                )}
                {message.cacheReadTokens != null && (
                  <div className="omp-msg-stats-item">
                    <span className="omp-msg-stats-label">Cached input</span>
                    <span className="omp-msg-stats-value">{message.cacheReadTokens.toLocaleString()}</span>
                  </div>
                )}
              </div>
            </>
          )}
          {!message.model && !message.inputTokens && (
            <div className="omp-msg-stats-unavailable">
              Response statistics not available for this message.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
