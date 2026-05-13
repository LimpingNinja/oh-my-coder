import { useState, useMemo } from "react";
import { useAppState } from "../state/store";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Icon } from "./Icon";

interface ThinkingBlockProps {
  content: string;
  defaultOpen?: boolean;
}

export function ThinkingBlock({ content, defaultOpen = false }: ThinkingBlockProps) {
  const { displaySettings } = useAppState();
  const [isOpen, setIsOpen] = useState(defaultOpen);

  const preview = useMemo(() => {
    const firstLine = content.split("\n")[0] || "";
    return firstLine.length > 80 ? firstLine.slice(0, 80) + "…" : firstLine;
  }, [content]);

  if (displaySettings.hideThinkingBlock) {
    return (
      <div className="omp-thinking-block omp-thinking-hidden">
        <span className="omp-thinking-label">Thinking…</span>
      </div>
    );
  }

  return (
    <div className="omp-thinking-block">
      <button className="omp-thinking-header" onClick={() => setIsOpen(!isOpen)}>
        <Icon name={isOpen ? "chevron-down" : "chevron-right"} className="omp-thinking-chevron" />
        <Icon name="lightbulb" className="omp-thinking-icon" />
        <span className="omp-thinking-label">Reasoning</span>
        {!isOpen && <span className="omp-thinking-preview">{preview}</span>}
      </button>
      {isOpen && (
        <div className="omp-thinking-content">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}
