import { useRef, useCallback, type KeyboardEvent } from "react";

interface ComposerProps {
  onSubmit: (content: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

export function Composer({ onSubmit, placeholder = "Type a message...", disabled }: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const content = textarea.value.trim();
    if (!content || disabled) return;
    onSubmit(content);
    textarea.value = "";
    textarea.style.height = "auto";
  }, [onSubmit, disabled]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  const handleInput = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 120) + "px";
  }, []);

  return (
    <div className="omp-composer-container">
      <div className="omp-composer">
        <textarea
          ref={textareaRef}
          rows={1}
          placeholder={placeholder}
          disabled={disabled}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          autoFocus
        />
        <button className="omp-composer-send" onClick={handleSubmit} disabled={disabled} title="Send">
          ▶
        </button>
      </div>
    </div>
  );
}
