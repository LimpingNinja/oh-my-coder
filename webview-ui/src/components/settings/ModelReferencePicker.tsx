import { useMemo, useState } from "react";
import { ModelSelector, type ModelSelectorExtraSection } from "../ModelSelector";
import type { ModelEntry } from "../../types/modelInfo";

export const THINKING_LEVEL_OPTIONS = ["minimal", "low", "medium", "high", "max"] as const;

export function modelRefFromEntry(model: ModelEntry): string {
  return `${model.provider}/${model.id}`;
}

export function splitThinkingSuffix(value: string): { modelRef: string; thinkingLevel: string } {
  const idx = value.lastIndexOf(":");
  if (idx <= 0 || idx === value.length - 1) return { modelRef: value, thinkingLevel: "" };
  return { modelRef: value.slice(0, idx), thinkingLevel: value.slice(idx + 1) };
}

export function joinThinkingSuffix(modelRef: string, thinkingLevel: string): string {
  if (!modelRef) return "";
  return thinkingLevel ? `${modelRef}:${thinkingLevel}` : modelRef;
}

export function ModelReferencePicker({
  value,
  defaultModel = "",
  roleNames = [],
  allowUnset = false,
  allowRoles = false,
  placeholder = "Use default",
  onChange,
}: {
  value: string;
  defaultModel?: string;
  roleNames?: string[];
  allowUnset?: boolean;
  allowRoles?: boolean;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const label = value || defaultModel || placeholder;
  const extraSections = useMemo<ModelSelectorExtraSection[]>(() => {
    const sections: ModelSelectorExtraSection[] = [];
    if (allowUnset) {
      sections.push({
        title: "Special",
        options: [
          {
            value: "",
            label: "<unset>",
            description: "Use configured default",
            icon: "codicon-circle-slash",
          },
        ],
      });
    }
    if (allowRoles && roleNames.length > 0) {
      sections.push({
        title: "Model Roles",
        options: roleNames.map((role) => ({
          value: `pi/${role}`,
          label: `pi/${role}`,
          description: "Named model role",
          icon: "codicon-symbol-class",
        })),
      });
    }
    return sections;
  }, [allowRoles, allowUnset, roleNames]);

  return (
    <div className="omp-settings-model-picker">
      <button
        type="button"
        className={`omp-settings-model-picker-btn${value ? " omp-settings-model-picker-btn--set" : ""}`}
        onClick={() => setOpen(true)}
        title={
          value ? `Selected: ${value}` : defaultModel ? `Default: ${defaultModel}` : "Choose model"
        }
      >
        <i className="codicon codicon-symbol-class" />
        <span>{label}</span>
        <i className="codicon codicon-chevron-down" />
      </button>
      {value && allowUnset && (
        <button
          type="button"
          className="omp-settings-icon-btn"
          onClick={() => onChange("")}
          title="Clear override"
        >
          <i className="codicon codicon-close" />
        </button>
      )}
      <ModelSelector
        open={open}
        onClose={() => setOpen(false)}
        currentModel={value || defaultModel}
        extraSections={extraSections}
        onSelectValue={onChange}
      />
    </div>
  );
}
