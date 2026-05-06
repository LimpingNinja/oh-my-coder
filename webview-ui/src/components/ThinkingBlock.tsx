import { useState } from "react";

interface ThinkingBlockProps {
  content: string;
  defaultOpen?: boolean;
}

export function ThinkingBlock({ content, defaultOpen = false }: ThinkingBlockProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className="omp-thinking-block">
      <button className="omp-thinking-header" onClick={() => setIsOpen(!isOpen)}>
        <span className={`omp-thinking-chevron${isOpen ? " open" : ""}`}>▶</span>
        <span className="omp-thinking-icon">💡</span>
        <span className="omp-thinking-label">Thinking</span>
      </button>
      {isOpen && (
        <div className="omp-thinking-content">
          {content}
        </div>
      )}
    </div>
  );
}
