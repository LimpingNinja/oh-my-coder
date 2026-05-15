import { useState, useEffect, useRef, useCallback, type CSSProperties } from "react";
import { getVSCodeAPI } from "../vscode";
import { getModelIcon } from "../utils/providerIcons";
import { toggleFavoriteModel, useAppState } from "../state/store";
import { ModelPreviewCard } from "./ModelPreviewCard";
import type { ModelEntry } from "../types/modelInfo";
import { formatCompactContext, formatModelName, getModelContext } from "../utils/modelPreviewUtils";

export interface ModelSelectorExtraOption {
  value: string;
  label: string;
  description?: string;
  icon?: string;
}

export interface ModelSelectorExtraSection {
  title: string;
  options: ModelSelectorExtraOption[];
}

interface ModelSelectorProps {
  open: boolean;
  onClose: () => void;
  currentModel?: string;
  onSelectModel?: (model: ModelEntry) => void;
  onSelectValue?: (value: string) => void;
  extraSections?: ModelSelectorExtraSection[];
}

interface PreviewState {
  key: string;
  style: CSSProperties;
  placement: "left" | "right";
}

/**
 * Searchable model selector dropdown.
 * Opens above the model pill, shows available models from the runtime.
 */
export function ModelSelector({
  open,
  onClose,
  currentModel,
  onSelectModel,
  onSelectValue,
  extraSections = [],
}: ModelSelectorProps) {
  const [search, setSearch] = useState("");
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [preview, setPreview] = useState<PreviewState | undefined>();
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestId = useRef(0);
  const vscode = getVSCodeAPI();
  const { webviewPrefs } = useAppState();
  const favoriteKeys = webviewPrefs.models.favorites;

  // Fetch models when opened — use request counter to ignore stale responses
  useEffect(() => {
    if (!open) return;
    setSearch("");
    setPreview(undefined);
    setLoading(true);

    const thisRequest = ++requestId.current;

    // Request models from extension host
    vscode.postMessage({ type: "runtime.getAvailableModels" });

    // Listen for response — only accept if this is still the active request
    function handleMessage(event: MessageEvent) {
      const msg = event.data;
      if (msg?.type === "runtime.availableModels") {
        if (thisRequest !== requestId.current) return; // Stale response, ignore
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

  useEffect(() => {
    if (!open) return;
    const clearPreview = () => setPreview(undefined);
    window.addEventListener("resize", clearPreview);
    window.addEventListener("scroll", clearPreview, true);
    return () => {
      window.removeEventListener("resize", clearPreview);
      window.removeEventListener("scroll", clearPreview, true);
    };
  }, [open]);

  const filtered = models.filter((m) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      m.id.toLowerCase().includes(q) ||
      m.provider.toLowerCase().includes(q) ||
      (m.name && m.name.toLowerCase().includes(q))
    );
  });

  const previewModel = preview?.key ? filtered.find((m) => modelKey(m) === preview.key) : undefined;
  const currentModelEntry = models.find((m) => isCurrentModel(m, currentModel));
  const currentModelLabel = currentModelEntry
    ? currentModelEntry.name || formatModelName(currentModelEntry.id)
    : formatCurrentModelLabel(currentModel);

  const handleSelect = useCallback(
    (model: ModelEntry) => {
      if (onSelectValue) {
        onSelectValue(modelKey(model));
      } else if (onSelectModel) {
        onSelectModel(model);
      } else {
        vscode.postMessage({
          type: "runtime.setModel",
          provider: model.provider,
          modelId: model.id,
        });
      }
      onClose();
    },
    [onClose, onSelectModel, onSelectValue],
  );

  const handleSelectValue = useCallback(
    (value: string) => {
      onSelectValue?.(value);
      onClose();
    },
    [onClose, onSelectValue],
  );

  const handleToggleFavorite = useCallback((e: React.MouseEvent, model: ModelEntry) => {
    e.stopPropagation();
    toggleFavoriteModel(`${model.provider}/${model.id}`);
  }, []);

  const handlePreview = useCallback((model: ModelEntry, target: HTMLElement) => {
    setPreview({
      key: modelKey(model),
      ...calculatePreviewPlacement(target.getBoundingClientRect()),
    });
  }, []);

  if (!open) return null;

  const visibleExtraSections = extraSections
    .map((section) => ({
      ...section,
      options: section.options.filter((option) => optionMatches(option, search)),
    }))
    .filter((section) => section.options.length > 0);

  // Split filtered models into favorites and the rest
  const favoriteModels = filtered.filter((m) => favoriteKeys.includes(`${m.provider}/${m.id}`));
  const nonFavoriteModels = filtered.filter((m) => !favoriteKeys.includes(`${m.provider}/${m.id}`));

  return (
    <>
      <div className="omp-send-popup-backdrop" onClick={onClose} />
      <div className="omp-model-selector" onMouseLeave={() => setPreview(undefined)}>
        <div className="omp-model-selector-search">
          <i className="codicon codicon-search" />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search models..."
            value={search}
            onFocus={() => setPreview(undefined)}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="omp-model-selector-list">
          {loading && <div className="omp-model-selector-loading">Loading models...</div>}
          {!loading && filtered.length === 0 && visibleExtraSections.length === 0 && (
            <div className="omp-model-selector-empty">No models found</div>
          )}

          {visibleExtraSections.map((section) => (
            <div
              key={section.title}
              className="omp-model-selector-group omp-model-selector-extra-group"
            >
              <div className="omp-model-selector-provider">{section.title}</div>
              {section.options.map((option) => (
                <button
                  key={`${section.title}:${option.value}`}
                  className={`omp-model-selector-item${option.value === currentModel ? " omp-model-selector-item--active" : ""}`}
                  onClick={() => handleSelectValue(option.value)}
                >
                  <span className="omp-model-selector-icon">
                    <i className={`codicon ${option.icon ?? "codicon-symbol-class"}`} />
                  </span>
                  <span className="omp-model-selector-name">{option.label}</span>
                  {option.description && (
                    <span className="omp-model-selector-meta">{option.description}</span>
                  )}
                  {option.value === currentModel && <i className="codicon codicon-check" />}
                </button>
              ))}
            </div>
          ))}

          {/* Favorites section */}
          {!loading && favoriteModels.length > 0 && (
            <div className="omp-model-selector-group omp-model-selector-favorites">
              <div className="omp-model-selector-provider">Favorites</div>
              {favoriteModels.map((m) => (
                <ModelRow
                  key={`fav-${m.provider}/${m.id}`}
                  model={m}
                  isCurrent={isCurrentModel(m, currentModel)}
                  isFavorite={true}
                  onSelect={handleSelect}
                  onPreview={handlePreview}
                  onToggleFavorite={handleToggleFavorite}
                />
              ))}
            </div>
          )}

          {/* Recommended / grouped section */}
          {!loading &&
            groupByProvider(nonFavoriteModels).map((group) => (
              <div key={group.provider} className="omp-model-selector-group">
                <div className="omp-model-selector-provider">{group.provider}</div>
                {group.models.map((m) => (
                  <ModelRow
                    key={`${m.provider}/${m.id}`}
                    model={m}
                    isCurrent={isCurrentModel(m, currentModel)}
                    isFavorite={favoriteKeys.includes(`${m.provider}/${m.id}`)}
                    onSelect={handleSelect}
                    onPreview={handlePreview}
                    onToggleFavorite={handleToggleFavorite}
                  />
                ))}
              </div>
            ))}
        </div>
        {preview && previewModel && (
          <div
            className={`omp-model-preview-popover omp-model-preview-popover--${preview.placement}`}
            style={preview.style}
          >
            <ModelPreviewCard
              model={previewModel}
              isCurrent={isCurrentModel(previewModel, currentModel)}
              currentModelLabel={currentModelLabel}
              currentModelEntry={currentModelEntry}
            />
          </div>
        )}
      </div>
    </>
  );
}

// ── Model Row ──────────────────────────────────────────────────────────────

interface ModelRowProps {
  model: ModelEntry;
  isCurrent: boolean;
  isFavorite: boolean;
  onSelect: (model: ModelEntry) => void;
  onPreview: (model: ModelEntry, target: HTMLElement) => void;
  onToggleFavorite: (e: React.MouseEvent, model: ModelEntry) => void;
}

function ModelRow({
  model,
  isCurrent,
  isFavorite,
  onSelect,
  onPreview,
  onToggleFavorite,
}: ModelRowProps) {
  const displayName = model.name || formatModelName(model.id);
  const context = getModelContext(model);

  return (
    <button
      className={`omp-model-selector-item ${isCurrent ? "omp-model-selector-item--active" : ""}`}
      onClick={() => onSelect(model)}
      onFocus={(e) => onPreview(model, e.currentTarget)}
      onMouseEnter={(e) => onPreview(model, e.currentTarget)}
    >
      <span
        className="omp-model-selector-icon"
        dangerouslySetInnerHTML={{ __html: getModelIcon(model.id, model.provider) }}
      />
      <span className="omp-model-selector-name">{displayName}</span>
      <span className="omp-model-selector-meta">
        {model.reasoning ? "Reasoning" : ""}
        {context ? `${model.reasoning ? " · " : ""}${formatCompactContext(context)}` : ""}
      </span>
      {isCurrent && <i className="codicon codicon-check" />}
      <span
        className={`omp-model-fav-star ${isFavorite ? "omp-model-fav-star--active" : ""}`}
        onClick={(e) => onToggleFavorite(e, model)}
        title={isFavorite ? "Remove from favorites" : "Add to favorites"}
        role="button"
        aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
      >
        <i className={`codicon ${isFavorite ? "codicon-star-full" : "codicon-star-empty"}`} />
      </span>
    </button>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────

function isCurrentModel(m: ModelEntry, currentModel?: string): boolean {
  if (!currentModel) return false;
  return currentModel === modelKey(m) || currentModel.includes(m.id);
}

function modelKey(model: ModelEntry): string {
  return `${model.provider}/${model.id}`;
}

function optionMatches(option: ModelSelectorExtraOption, search: string): boolean {
  if (!search) return true;
  const query = search.toLowerCase();
  return (
    option.value.toLowerCase().includes(query) ||
    option.label.toLowerCase().includes(query) ||
    (option.description?.toLowerCase().includes(query) ?? false)
  );
}

function formatCurrentModelLabel(currentModel?: string): string | undefined {
  if (!currentModel) return undefined;
  const id = currentModel.includes("/") ? currentModel.split("/").pop() : currentModel;
  return id ? formatModelName(id) : currentModel;
}

function calculatePreviewPlacement(anchor: DOMRect): Omit<PreviewState, "key"> {
  const gap = 8;
  const margin = 8;
  const width = Math.min(250, Math.max(180, window.innerWidth - margin * 2));
  const maxHeight = Math.min(350, window.innerHeight - margin * 2);
  const rightLeft = anchor.right + gap;
  const leftLeft = anchor.left - gap - width;
  const rightSpace = window.innerWidth - rightLeft - margin;
  const leftSpace = leftLeft - margin;
  const placement = rightSpace >= width || rightSpace >= leftSpace ? "right" : "left";
  const rawLeft = placement === "right" ? rightLeft : leftLeft;
  const left = clamp(rawLeft, margin, Math.max(margin, window.innerWidth - width - margin));
  const top = clamp(
    anchor.top - 12,
    margin,
    Math.max(margin, window.innerHeight - maxHeight - margin),
  );

  return {
    placement,
    style: {
      left,
      top,
      width,
      maxHeight,
    },
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
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
