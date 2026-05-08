import { useRef, useCallback, useImperativeHandle, useEffect, forwardRef, type KeyboardEvent } from "react";

const MAX_HISTORY = 50;
const historyStore: string[] = [];

/**
 * Seed the composer history from hydrated user messages.
 * Replaces any existing history. Keeps the most recent MAX_HISTORY entries.
 */
export function seedComposerHistory(messages: string[]) {
  historyStore.length = 0;
  const start = Math.max(0, messages.length - MAX_HISTORY);
  for (let i = start; i < messages.length; i++) {
    historyStore.push(messages[i]);
  }
}

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
  const historyIndex = useRef(-1);
  const draft = useRef("");

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
    if (content) {
      // Add to history (dedup consecutive duplicates)
      if (historyStore[historyStore.length - 1] !== content) {
        historyStore.push(content);
        if (historyStore.length > MAX_HISTORY) historyStore.shift();
      }
      historyIndex.current = -1;
      onSubmit(content);
    }
  }, [onSubmit, disabled, consumeValue]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
        return;
      }

      const textarea = textareaRef.current;
      if (!textarea) return;

      // Up arrow history — when cursor is at the start
      if (e.key === "ArrowUp" && textarea.selectionStart === 0 && textarea.selectionEnd === 0) {
        if (historyStore.length === 0) return;
        e.preventDefault();

        // Save draft on first up
        if (historyIndex.current === -1) {
          draft.current = textarea.value;
        }

        const nextIdx = Math.min(historyIndex.current + 1, historyStore.length - 1);
        historyIndex.current = nextIdx;
        textarea.value = historyStore[historyStore.length - 1 - nextIdx] ?? "";
        textarea.style.height = "auto";
        textarea.style.height = Math.min(textarea.scrollHeight, 120) + "px";
        textarea.setSelectionRange(0, 0);
        return;
      }

      // Down arrow — when in history and cursor is at the end
      if (e.key === "ArrowDown" && historyIndex.current >= 0 &&
          textarea.selectionStart === textarea.value.length) {
        e.preventDefault();
        historyIndex.current -= 1;

        if (historyIndex.current < 0) {
          textarea.value = draft.current;
        } else {
          textarea.value = historyStore[historyStore.length - 1 - historyIndex.current] ?? "";
        }
        textarea.style.height = "auto";
        textarea.style.height = Math.min(textarea.scrollHeight, 120) + "px";
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        return;
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
