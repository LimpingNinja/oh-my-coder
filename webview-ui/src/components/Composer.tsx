import { useRef, useCallback, useImperativeHandle, useEffect, forwardRef, type ClipboardEvent, type KeyboardEvent } from "react";
import { addComposerImageAttachment, type ComposerFileContext, type ComposerImageAttachment } from "../state/store";

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
  fileContexts?: ComposerFileContext[];
  onRemoveFileContext?: (id: string) => void;
  imageAttachments?: ComposerImageAttachment[];
  onRemoveImageAttachment?: (id: string) => void;
  dragActive?: boolean;
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  {
    onSubmit,
    placeholder = "Type a message...",
    disabled,
    fileContexts = [],
    onRemoveFileContext,
    imageAttachments = [],
    onRemoveImageAttachment,
    dragActive = false,
  },
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

  const handlePaste = useCallback(async (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imageItems = items.filter((item) => item.type.startsWith("image/"));
    if (imageItems.length === 0) return;

    e.preventDefault();
    const files = imageItems
      .map((item) => item.getAsFile())
      .filter((file): file is File => !!file);
    await attachImageFiles(files, { source: "paste" });
  }, []);

  return (
    <div className={`omp-composer-container${dragActive ? " omp-composer-container--drag-active" : ""}`}>
      {(fileContexts.length > 0 || imageAttachments.length > 0) && (
        <div className="omp-composer-context-bar" aria-label="Attached chat context">
          {fileContexts.map((context) => (
            <div key={context.id} className="omp-context-chip">
              <i className="codicon codicon-file-code" />
              <span className="omp-context-chip-text" title={context.path}>
                {formatFileContext(context)}
              </span>
              <button
                type="button"
                className="omp-context-chip-remove"
                onClick={() => onRemoveFileContext?.(context.id)}
                title="Remove from chat context"
                aria-label="Remove from chat context"
              >
                <i className="codicon codicon-close" />
              </button>
            </div>
          ))}
          {imageAttachments.map((attachment) => (
            <div key={attachment.id} className="omp-context-chip omp-context-chip--image">
              <img
                src={`data:${attachment.mediaType};base64,${attachment.data}`}
                alt={attachment.label ?? "Pasted chat attachment"}
                className="omp-context-chip-image"
              />
              <span className="omp-context-chip-text" title={attachment.label ?? "Pasted image"}>
                {attachment.label ?? "Pasted image"}
              </span>
              <button
                type="button"
                className="omp-context-chip-remove"
                onClick={() => onRemoveImageAttachment?.(attachment.id)}
                title="Remove image attachment"
                aria-label="Remove image attachment"
              >
                <i className="codicon codicon-close" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div
        className={`omp-composer${dragActive ? " omp-composer--drag-active" : ""}`}
      >
        <textarea
          ref={textareaRef}
          rows={1}
          placeholder={placeholder}
          disabled={disabled}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          onPaste={handlePaste}
          autoFocus
        />
      </div>
    </div>
  );
});

function formatFileContext(context: ComposerFileContext): string {
  const basename = context.path.split(/[/\\]/).pop() ?? context.path;
  if (context.line != null && context.endLine != null && context.endLine !== context.line) {
    return `${basename}:${context.line}-${context.endLine}`;
  }
  if (context.line != null) {
    return `${basename}:${context.line}`;
  }
  return basename;
}

export async function attachImageFiles(files: File[], options: { source?: "paste" | "drop" } = {}): Promise<void> {
  for (const file of files) {
    try {
      const data = await readFileAsDataUrl(file);
      const base64 = data.split(",", 2)[1] ?? "";
      const label = options.source === "drop" ? formatDroppedImageLabel(file) : undefined;
      addComposerImageAttachment({
        data: base64,
        mediaType: file.type || guessMediaType(file.name),
        ...(label ? { label } : {}),
      });
    } catch {
      // Skip unreadable drag payloads without cancelling the rest of the batch.
    }
  }
}

function formatDroppedImageLabel(file: File): string | undefined {
  const name = file.name.trim();
  return name.length > 0 ? name : undefined;
}

export function collectImageFiles(dt: DataTransfer | null | undefined): File[] {
  if (!dt) return [];
  const seen = new Set<string>();
  const results: File[] = [];

  for (const file of Array.from(dt.files ?? [])) {
    if (looksLikeImage(file)) {
      const key = `${file.name}-${file.size}-${file.lastModified}`;
      if (!seen.has(key)) { seen.add(key); results.push(file); }
    }
  }

  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (!file || !looksLikeImage(file)) continue;
    const key = `${file.name}-${file.size}-${file.lastModified}`;
    if (!seen.has(key)) { seen.add(key); results.push(file); }
  }

  return results;
}

export function hasFileDrag(dt: DataTransfer | null | undefined): boolean {
  if (!dt) return false;
  return dt.types?.includes("Files") ||
    (dt.files && dt.files.length > 0) ||
    (dt.items && dt.items.length > 0);
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read pasted image"));
    reader.readAsDataURL(file);
  });
}

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp|svg|ico|tiff?)$/i;

/** Accept a file if its MIME says image, or if MIME is empty but filename looks like an image. */
function looksLikeImage(file: File): boolean {
  if (file.type.startsWith("image/")) return true;
  // In VS Code webviews, file.type can be empty — fall back to extension check
  if (!file.type && file.name && IMAGE_EXTENSIONS.test(file.name)) return true;
  // Last resort: accept files with no type AND no name (clipboard blobs)
  if (!file.type && !file.name) return true;
  return false;
}

/** Guess MIME from filename when file.type is empty. */
function guessMediaType(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    svg: "image/svg+xml",
    ico: "image/x-icon",
    tif: "image/tiff",
    tiff: "image/tiff",
  };
  return map[ext ?? ""] ?? "image/png";
}
