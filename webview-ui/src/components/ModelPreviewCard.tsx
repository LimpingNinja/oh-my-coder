import type { ModelEntry } from "../types/modelInfo";
import { getModelIcon } from "../utils/providerIcons";
import {
  blendedCost,
  classifyCost,
  costTierLabel,
  cacheReadCost,
  formatContext,
  formatModelName,
  formatPrice,
  hasPricing,
  inputCost,
  isModelFree,
  getModelContext,
  getModelDescription,
  outputCost,
  outputPressurePercent,
  resolvePricing,
} from "../utils/modelPreviewUtils";

interface ModelPreviewCardProps {
  model?: ModelEntry;
  isCurrent?: boolean;
  currentModelLabel?: string;
  currentModelEntry?: ModelEntry;
}

export function ModelPreviewCard({ model, isCurrent = false, currentModelLabel, currentModelEntry }: ModelPreviewCardProps) {
  if (!model) {
    return (
      <aside className="omp-model-preview omp-model-preview--empty" aria-hidden="true">
        Hover a model for details
      </aside>
    );
  }

  const displayName = model.name || formatModelName(model.id);
  const pricing = resolvePricing(model);
  const context = pricing?.context ?? getModelContext(model);
  const tier = classifyCost(model);
  const tierLabel = costTierLabel(tier);
  const description = getModelDescription(model);
  const free = isModelFree(model);
  const input = inputCost(model);
  const output = outputCost(model);
  const cacheRead = cacheReadCost(model);
  const blended = blendedCost(model);
  const pressure = outputPressurePercent(model);
  const capabilities = getCapabilities(model);

  return (
    <aside className="omp-model-preview" aria-label={`${displayName} model details`}>
      <div className="omp-model-preview-header">
        <span
          className="omp-model-preview-icon"
          dangerouslySetInnerHTML={{ __html: getModelIcon(model.id, model.provider) }}
        />
        <div className="omp-model-preview-heading">
          <div className="omp-model-preview-name-row">
            <span className="omp-model-preview-name">{displayName}</span>
            {isCurrent && <span className="omp-model-preview-pill omp-model-preview-pill--current">Current</span>}
            {free && <span className="omp-model-preview-pill omp-model-preview-pill--free">Free</span>}
          </div>
          <span className="omp-model-preview-provider">{model.provider}</span>
        </div>
      </div>

      {!isCurrent && currentModelLabel && (
        <div className="omp-model-preview-current">
          <span>Current</span>
          <strong>{currentModelLabel}</strong>
        </div>
      )}

      {(context || tierLabel) && (
        <div className="omp-model-preview-summary">
          {context && <span>{formatContext(context)}</span>}
          {tierLabel && <span className={`omp-model-preview-tier omp-model-preview-tier--${tier}`}>{tierLabel}</span>}
        </div>
      )}

      {capabilities.length > 0 && (
        <div className="omp-model-preview-caps">
          {capabilities.map((capability) => (
            <span key={capability} className="omp-model-preview-pill">{capability}</span>
          ))}
        </div>
      )}

      {hasPricing(model) && (
        <div className="omp-model-preview-grid" aria-label="Model pricing">
          <PricingRow label="Input" value={formatPrice(input)} />
          <PricingRow label="Output" value={formatPrice(output)} />
          <PricingRow label="Cached" value={formatPrice(cacheRead)} />
          <PricingRow label="Blended" value={formatPrice(blended)} tier={tier} />
        </div>
      )}

      {pricing?.note && <div className="omp-model-preview-note">{pricing.note}</div>}

      {pressure != null && (
        <div className="omp-model-preview-meter" aria-label="Output cost pressure">
          <div className="omp-model-preview-meter-track">
            <span
              className={`omp-model-preview-meter-fill omp-model-preview-tier-bg--${tier ?? "standard"}`}
              style={{ width: `${pressure}%` }}
            />
            {!isCurrent && currentModelEntry && (() => {
              const currentPressure = outputPressurePercent(currentModelEntry);
              if (currentPressure == null) return null;
              return (
                <span
                  className="omp-model-preview-meter-dot"
                  style={{ left: `${currentPressure}%` }}
                  title={currentModelLabel ?? "Current"}
                >
                  <span className="omp-model-preview-meter-dot-label">Current</span>
                </span>
              );
            })()}
          </div>
          <span className="omp-model-preview-meter-label">Blended cost (75/25)</span>
        </div>
      )}

      {description && <p className="omp-model-preview-description">{description}</p>}
    </aside>
  );
}

function PricingRow({ label, value, tier }: { label: string; value?: string; tier?: string }) {
  if (!value) return null;
  return (
    <>
      <span className="omp-model-preview-label">{label}</span>
      <span className={`omp-model-preview-value ${tier ? `omp-model-preview-tier--${tier}` : ""}`}>{value}</span>
    </>
  );
}

function getCapabilities(model: ModelEntry): string[] {
  const capabilities: string[] = [];
  if (model.reasoning) capabilities.push("Reasoning");
  if (model.type && model.type !== "language") capabilities.push(model.type);
  for (const modality of model.modalities?.input ?? []) {
    if (modality !== "text") capabilities.push(capitalize(modality));
  }
  return Array.from(new Set(capabilities));
}

function capitalize(value: string): string {
  return value.length > 0 ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}
