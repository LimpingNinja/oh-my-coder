import { useRef, useCallback, useImperativeHandle, useEffect, forwardRef, type KeyboardEvent } from "react";

export interface ComposerHandle {
  /** Get the current trimmed value and clear the textarea */
  consumeValue: () => string;
  /** Set the textarea value (for set_editor_text from runtime) */
  setValue: (text: string) => void;
}

interface ComposerProps {
  onSubmit: (content: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { onSubmit, placeholder = "Type a message...", disabled },
  ref,
) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const consumeValue = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return "";
    const content = textarea.value.trim();
    if (content) {
      textarea.value = "";
      textarea.style.height = "auto";
    }
    return content;
  }, []);

  const setValue = useCallback((text: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.value = text;
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 120) + "px";
    textarea.focus();
  }, []);

  useImperativeHandle(ref, () => ({ consumeValue, setValue }));

  // Listen for runtime set_editor_text events
  useEffect(() => {
    function handleSetText(e: Event) {
      const detail = (e as CustomEvent<{ text: string }>).detail;
      if (detail?.text != null) setValue(detail.text);
    }
    window.addEventListener("omp:setEditorText", handleSetText);
    return () => window.removeEventListener("omp:setEditorText", handleSetText);
  }, [setValue]);

  const handleSubmit = useCallback(() => {
    if (disabled) return;
    const content = consumeValue();
    if (content) onSubmit(content);
  }, [onSubmit, disabled, consumeValue]);

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
      </div>
    </div>
  );
});
