import { useState, useEffect, useRef, useCallback } from "react";
import { getVSCodeAPI } from "../vscode";
import { getModelIcon } from "../utils/providerIcons";

interface ModelSelectorProps {
  open: boolean;
  onClose: () => void;
  currentModel?: string;
}

interface ModelEntry {
  provider: string;
  id: string;
  // Extended fields from pi runtime (may or may not be present)
  name?: string;
  contextWindow?: number;
  reasoning?: boolean;
  type?: string;
}

/**
 * Searchable model selector dropdown.
 * Opens above the model pill, shows available models from the runtime.
 */
export function ModelSelector({ open, onClose, currentModel }: ModelSelectorProps) {
  const [search, setSearch] = useState("");
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const vscode = getVSCodeAPI();

  // Fetch models when opened
  useEffect(() => {
    if (!open) return;
    setSearch("");
    setLoading(true);

    // Request models from extension host
    vscode.postMessage({ type: "runtime.getAvailableModels" });

    // Listen for response
    function handleMessage(event: MessageEvent) {
      const msg = event.data;
      if (msg?.type === "runtime.availableModels") {
        setModels((msg.models as ModelEntry[]) || []);
        setLoading(false);
      }
    }
    window.addEventListener("message", handleMessage);

    setTimeout(() => inputRef.current?.focus(), 100);

    return () => window.removeEventListener("message", handleMessage);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  const filtered = models.filter((m) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      m.id.toLowerCase().includes(q) ||
      m.provider.toLowerCase().includes(q) ||
      (m.name && m.name.toLowerCase().includes(q))
    );
  });

  const handleSelect = useCallback((model: ModelEntry) => {
    vscode.postMessage({ type: "runtime.setModel", provider: model.provider, modelId: model.id });
    onClose();
  }, [onClose]);

  if (!open) return null;

  return (
    <>
      <div className="omp-send-popup-backdrop" onClick={onClose} />
      <div className="omp-model-selector">
        <div className="omp-model-selector-search">
          <i className="codicon codicon-search" />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search models..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="omp-model-selector-list">
          {loading && (
            <div className="omp-model-selector-loading">Loading models...</div>
          )}
          {!loading && filtered.length === 0 && (
            <div className="omp-model-selector-empty">No models found</div>
          )}
          {!loading && groupByProvider(filtered).map((group) => (
            <div key={group.provider} className="omp-model-selector-group">
              <div className="omp-model-selector-provider">
                {group.provider}
              </div>
              {group.models.map((m) => {
                const displayName = m.name || formatModelName(m.id);
                const isCurrent = currentModel?.includes(m.id) || `${m.provider}/${m.id}` === currentModel;
                return (
                  <button
                    key={`${m.provider}/${m.id}`}
                    className={`omp-model-selector-item ${isCurrent ? "omp-model-selector-item--active" : ""}`}
                    onClick={() => handleSelect(m)}
                  >
                    <span
                      className="omp-model-selector-icon"
                      dangerouslySetInnerHTML={{ __html: getModelIcon(m.id, m.provider) }}
                    />
                    <span className="omp-model-selector-name">{displayName}</span>
                    <span className="omp-model-selector-meta">
                      {m.reasoning ? "Reasoning" : ""}
                      {m.contextWindow ? `${m.reasoning ? " · " : ""}${formatCtx(m.contextWindow)}` : ""}
                    </span>
                    {isCurrent && <i className="codicon codicon-check" />}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function formatModelName(id: string): string {
  // Remove date suffixes and shorten
  return id.replace(/-\d{8}$/, "");
}

function formatCtx(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(0)}M ctx`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}k ctx`;
  return `${tokens} ctx`;
}

function groupByProvider(models: ModelEntry[]): { provider: string; models: ModelEntry[] }[] {
  const groups = new Map<string, ModelEntry[]>();
  for (const m of models) {
    const existing = groups.get(m.provider);
    if (existing) {
      existing.push(m);
    } else {
      groups.set(m.provider, [m]);
    }
  }
  return Array.from(groups.entries()).map(([provider, models]) => ({ provider, models }));
}
