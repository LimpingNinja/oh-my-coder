import { useState } from "react";

const SCOPE_TYPES = ["text", "thinking", "tool"] as const;
type ScopeType = (typeof SCOPE_TYPES)[number];

const TOOL_NAMES = [
  "read", "search", "find", "edit", "write", "bash",
  "ast_grep", "ast_edit", "lsp", "debug", "eval",
  "browser", "web_search", "fetch", "github",
  "task", "irc", "recipe", "checkpoint", "notebook",
  "render_mermaid", "inspect_image", "calc", "generate_image",
  "todo_write", "question", "yield",
];

interface ScopeBuilderProps {
  tokens: string[];
  onChange: (tokens: string[]) => void;
  disabled?: boolean;
}

export function ScopeBuilder({ tokens, onChange, disabled }: ScopeBuilderProps) {
  const [adding, setAdding] = useState(false);
  const [scopeType, setScopeType] = useState<ScopeType>("tool");
  const [toolName, setToolName] = useState("edit");
  const [toolGlob, setToolGlob] = useState("");

  const removeToken = (index: number) => {
    onChange(tokens.filter((_, i) => i !== index));
  };

  const addToken = () => {
    let token: string;
    if (scopeType === "text" || scopeType === "thinking") {
      token = scopeType;
    } else {
      token = toolGlob.trim()
        ? `tool:${toolName}(${toolGlob.trim()})`
        : `tool:${toolName}`;
    }
    if (!tokens.includes(token)) {
      onChange([...tokens, token]);
    }
    setAdding(false);
    setToolGlob("");
  };

  return (
    <div className="omp-scope-builder">
      {tokens.length > 0 && (
        <div className="omp-scope-builder-chips">
          {tokens.map((token, i) => (
            <span key={i} className="omp-tag-input-chip">
              <span className="omp-tag-input-chip-text">{token}</span>
              {!disabled && (
                <button
                  type="button"
                  className="omp-tag-input-chip-remove"
                  onClick={() => removeToken(i)}
                  aria-label={`Remove ${token}`}
                >
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      {!disabled && !adding && (
        <button
          type="button"
          className="omp-settings-btn-small"
          onClick={() => setAdding(true)}
          style={{ marginTop: 4 }}
        >
          + Add Scope
        </button>
      )}

      {adding && (
        <div className="omp-scope-builder-form">
          <select
            className="omp-settings-select"
            value={scopeType}
            onChange={(e) => setScopeType(e.target.value as ScopeType)}
          >
            {SCOPE_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>

          {scopeType === "tool" && (
            <>
              <select
                className="omp-settings-select"
                value={toolName}
                onChange={(e) => setToolName(e.target.value)}
              >
                {TOOL_NAMES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
              <input
                type="text"
                className="omp-settings-input"
                value={toolGlob}
                onChange={(e) => setToolGlob(e.target.value)}
                placeholder="Optional glob (e.g. *.ts)"
                style={{ flex: 1 }}
              />
            </>
          )}

          <button
            type="button"
            className="omp-settings-btn-small"
            onClick={addToken}
          >
            Add
          </button>
          <button
            type="button"
            className="omp-settings-btn-small"
            onClick={() => setAdding(false)}
            style={{ opacity: 0.7 }}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
