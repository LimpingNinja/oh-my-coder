import { getVSCodeAPI } from "../vscode";

const THINKING_LEVELS = [
  { value: "off", label: "Off", description: "No reasoning" },
  { value: "minimal", label: "Minimal", description: "Brief internal thought" },
  { value: "low", label: "Low", description: "Light reasoning" },
  { value: "medium", label: "Medium", description: "Balanced reasoning" },
  { value: "high", label: "High", description: "Deep reasoning" },
  { value: "xhigh", label: "Extra High", description: "Maximum reasoning effort" },
] as const;

interface ThinkingSelectorProps {
  open: boolean;
  onClose: () => void;
  currentLevel?: string;
}

/**
 * Thinking level picker dropdown.
 * Shows all available levels with the current one highlighted.
 */
export function ThinkingSelector({ open, onClose, currentLevel }: ThinkingSelectorProps) {
  const vscode = getVSCodeAPI();

  if (!open) return null;

  const handleSelect = (level: string) => {
    vscode.postMessage({ type: "runtime.setThinkingLevel", level });
    onClose();
  };

  return (
    <>
      <div className="omp-send-popup-backdrop" onClick={onClose} />
      <div className="omp-thinking-selector">
        {THINKING_LEVELS.map((lvl) => {
          const isActive = currentLevel === lvl.value;
          return (
            <button
              key={lvl.value}
              className={`omp-thinking-selector-item ${isActive ? "omp-thinking-selector-item--active" : ""}`}
              onClick={() => handleSelect(lvl.value)}
            >
              <span className="omp-thinking-selector-label">{lvl.label}</span>
              <span className="omp-thinking-selector-desc">{lvl.description}</span>
              {isActive && <i className="codicon codicon-check" />}
            </button>
          );
        })}
      </div>
    </>
  );
}
