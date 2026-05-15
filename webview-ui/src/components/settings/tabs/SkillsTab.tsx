import { useState } from "react";
import { getVSCodeAPI } from "../../../vscode";
import { useSettings, type DiscoveredSkill } from "../SettingsContext";
import { SettingsRow } from "../SettingsRow";
import { DeleteConfirmOverlay } from "../DeleteConfirmOverlay";

const resolveKey = (source: Record<string, unknown>, key: string): unknown => {
  const parts = key.split(".");
  let current: unknown = source;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
};

const getSettingValue = (
  draft: Record<string, unknown>,
  config: Record<string, unknown>,
  key: string,
): unknown => {
  if (key in draft) return draft[key];
  const draftNested = resolveKey(draft, key);
  if (draftNested !== undefined) return draftNested;
  if (key in config) return config[key];
  return resolveKey(config, key);
};

type SubTab = "detected" | "settings";

export function SkillsTab() {
  const [subTab, setSubTab] = useState<SubTab>("detected");
  const [newSkillScope, setNewSkillScope] = useState<"global" | "project" | null>(null);
  const [editingSkill, setEditingSkill] = useState<DiscoveredSkill | null>(null);
  const [filter, setFilter] = useState("");
  const [pendingDelete, setPendingDelete] = useState<DiscoveredSkill | null>(null);
  const { config, draft, updateSetting, skills } = useSettings();

  const get = (key: string) =>
    getSettingValue(draft as Record<string, unknown>, config as Record<string, unknown>, key);

  const getBool = (key: string, defaultValue: boolean): boolean =>
    (get(key) ?? defaultValue) as boolean;

  const filteredSkills = skills.filter((s) => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return s.name.toLowerCase().includes(q) || (s.description ?? "").toLowerCase().includes(q);
  });

  if (editingSkill) {
    return (
      <SkillEditView
        scope={editingSkill.location === "project" ? "project" : "global"}
        existing={editingSkill}
        onBack={() => setEditingSkill(null)}
      />
    );
  }

  if (newSkillScope) {
    return <SkillEditView scope={newSkillScope} onBack={() => setNewSkillScope(null)} />;
  }

  return (
    <div>
      <div className="omp-settings-subtabs">
        <button
          className={`omp-settings-subtab${subTab === "detected" ? " omp-settings-subtab--active" : ""}`}
          onClick={() => setSubTab("detected")}
        >
          Detected Skills
        </button>
        <button
          className={`omp-settings-subtab${subTab === "settings" ? " omp-settings-subtab--active" : ""}`}
          onClick={() => setSubTab("settings")}
        >
          Settings
        </button>
      </div>

      <div className="omp-settings-subtab-content">
        {subTab === "detected" && (
          <div className="omp-settings-section">
            <h3 className="omp-settings-section-title">Discovered Skills</h3>
            <div className="omp-settings-agent-actions">
              <button className="omp-settings-btn-small" onClick={() => setNewSkillScope("global")}>
                Add Global Skill
              </button>
              <button className="omp-settings-btn-small" onClick={() => setNewSkillScope("project")}>
                Add Project Skill
              </button>
            </div>
            <input
              className="omp-settings-input omp-settings-agent-filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter skills..."
            />
            {filteredSkills.length === 0 ? (
              <p className="omp-settings-section-desc">
                {skills.length === 0
                  ? "No skills detected. Skills will appear when the runtime discovers command files."
                  : "No skills match the current filter."}
              </p>
            ) : (
              <div className="omp-settings-agent-overrides">
                {filteredSkills.map((skill) => (
                  <SkillRow key={skill.path} skill={skill} onEdit={setEditingSkill} onDelete={setPendingDelete} />
                ))}
              </div>
            )}
          </div>
        )}

        {subTab === "settings" && (
          <div className="omp-settings-section">
            <h3 className="omp-settings-section-title">Skill Sources</h3>
            <p className="omp-settings-section-desc">Configure where skills are loaded from</p>
            <SettingsRow title="Skill Commands" description="Register skills as /skill:name slash commands">
              <input
                type="checkbox"
                className="omp-settings-toggle"
                checked={getBool("skills.enableSkillCommands", true)}
                onChange={(e) => updateSetting("skills.enableSkillCommands", e.target.checked)}
              />
            </SettingsRow>
            <SettingsRow title="Claude User Commands" description="Load from ~/.claude/commands/">
              <input
                type="checkbox"
                className="omp-settings-toggle"
                checked={getBool("commands.enableClaudeUser", true)}
                onChange={(e) => updateSetting("commands.enableClaudeUser", e.target.checked)}
              />
            </SettingsRow>
            <SettingsRow title="Claude Project Commands" description="Load from .claude/commands/">
              <input
                type="checkbox"
                className="omp-settings-toggle"
                checked={getBool("commands.enableClaudeProject", true)}
                onChange={(e) => updateSetting("commands.enableClaudeProject", e.target.checked)}
              />
            </SettingsRow>
            <SettingsRow title="Opencode User Commands" description="Load from ~/.config/opencode/commands/">
              <input
                type="checkbox"
                className="omp-settings-toggle"
                checked={getBool("commands.enableOpencodeUser", true)}
                onChange={(e) => updateSetting("commands.enableOpencodeUser", e.target.checked)}
              />
            </SettingsRow>
            <SettingsRow title="Opencode Project Commands" description="Load from .opencode/commands/" last>
              <input
                type="checkbox"
                className="omp-settings-toggle"
                checked={getBool("commands.enableOpencodeProject", true)}
                onChange={(e) => updateSetting("commands.enableOpencodeProject", e.target.checked)}
              />
            </SettingsRow>
          </div>
        )}
      </div>
      {pendingDelete && (
        <DeleteConfirmOverlay
          type="skill"
          name={pendingDelete.name}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            getVSCodeAPI().postMessage({ type: "settings.skill.delete", path: pendingDelete.path });
            setPendingDelete(null);
          }}
        />
      )}
    </div>
  );
}

// ─── Skill Edit View ─────────────────────────────────────────────────────────

interface FrontmatterField {
  key: string;
  label: string;
  type: "text" | "toggle" | "globs" | "tools";
  description: string;
  placeholder?: string;
}

const AVAILABLE_FRONTMATTER: FrontmatterField[] = [
  { key: "description", label: "Description", type: "text", description: "Short description shown in skill listings (max 1024 chars)", placeholder: "What this skill does and when to use it" },
  { key: "globs", label: "File Globs", type: "globs", description: "Activate this skill for matching files (comma-separated)", placeholder: "**/*.ts, src/**/*.tsx" },
  { key: "alwaysApply", label: "Always Apply", type: "toggle", description: "Include this skill in every conversation regardless of context" },
  { key: "license", label: "License", type: "text", description: "License name or reference to bundled file", placeholder: "MIT" },
  { key: "compatibility", label: "Compatibility", type: "text", description: "Environment requirements (max 500 chars)", placeholder: "Node.js >= 18, macOS or Linux" },
  { key: "allowed-tools", label: "Allowed Tools", type: "tools", description: "Pre-approved tools when this skill is active (space-delimited)", placeholder: "read search bash" },
  { key: "disable-model-invocation", label: "Disable Model Invocation", type: "toggle", description: "Hide from system prompt; only available via explicit /skill:name command" },
];

const ALL_TOOL_NAMES = [
  "read", "search", "find", "edit", "write", "bash",
  "ast_grep", "ast_edit", "lsp", "debug", "eval",
  "browser", "web_search", "fetch", "github",
  "task", "irc", "recipe", "checkpoint", "notebook",
  "render_mermaid", "inspect_image", "calc", "generate_image",
  "todo_write", "question", "yield",
];

function SkillEditView({
  scope,
  existing,
  onBack,
}: {
  scope: "global" | "project";
  existing?: DiscoveredSkill;
  onBack: () => void;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  const [content, setContent] = useState("");
  const [activeFields, setActiveFields] = useState<Set<string>>(
    new Set(existing?.description ? ["description"] : ["description"])
  );
  const [fieldValues, setFieldValues] = useState<Record<string, string | boolean>>({
    description: existing?.description ?? "",
    globs: "",
    alwaysApply: false,
  });

  const toggleField = (key: string) => {
    setActiveFields((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const updateField = (key: string, value: string | boolean) => {
    setFieldValues((prev) => ({ ...prev, [key]: value }));
  };

  const save = () => {
    if (!name.trim()) return;
    const globs = typeof fieldValues.globs === "string"
      ? fieldValues.globs.split(",").map((g) => g.trim()).filter(Boolean)
      : [];
    const allowedToolsRaw = typeof fieldValues["allowed-tools"] === "string"
      ? fieldValues["allowed-tools"].split(/[\s,]+/).filter(Boolean)
      : [];

    getVSCodeAPI().postMessage({
      type: "settings.skill.write",
      scope,
      skill: {
        name: name.trim(),
        description: activeFields.has("description") ? String(fieldValues.description || "") : undefined,
        globs: activeFields.has("globs") && globs.length > 0 ? globs : undefined,
        alwaysApply: activeFields.has("alwaysApply") && fieldValues.alwaysApply ? true : undefined,
        allowedTools: activeFields.has("allowed-tools") && allowedToolsRaw.length > 0 ? allowedToolsRaw : undefined,
        content,
      },
    });
    onBack();
  };

  const inactiveFields = AVAILABLE_FRONTMATTER.filter((f) => !activeFields.has(f.key));

  return (
    <div className="omp-edit-form">
      <button onClick={onBack} className="omp-settings-back-btn">
        <i className="codicon codicon-arrow-left" /> Back to list
      </button>

      <div className="omp-edit-form-header">
        <h3 className="omp-edit-form-title">New Skill</h3>
        <span className={`omp-settings-agent-badge badge-${scope === "global" ? "user" : "project"}`}>
          {scope}
        </span>
      </div>

      {/* Name field — always visible */}
      <div className="omp-edit-form-field">
        <label className="omp-edit-form-label">Name <span className="omp-edit-form-required">*</span></label>
        <p className="omp-edit-form-hint">Becomes the filename (e.g. my-skill.md)</p>
        <input
          className="omp-edit-form-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="my-skill"
        />
      </div>

      {/* Active frontmatter fields */}
      <div className="omp-edit-form-section">
        <div className="omp-edit-form-section-header">
          <span className="omp-edit-form-section-title">Frontmatter</span>
          {inactiveFields.length > 0 && (
            <div className="omp-edit-form-add-field">
              <select
                className="omp-edit-form-add-select"
                value=""
                onChange={(e) => {
                  if (e.target.value) toggleField(e.target.value);
                  e.target.value = "";
                }}
              >
                <option value="">+ Add field</option>
                {inactiveFields.map((f) => (
                  <option key={f.key} value={f.key}>{f.label}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        {AVAILABLE_FRONTMATTER.filter((f) => activeFields.has(f.key)).map((field) => (
          <div key={field.key} className="omp-edit-form-field">
            <div className="omp-edit-form-field-header">
              <label className="omp-edit-form-label">{field.label}</label>
              <button
                className="omp-edit-form-remove-btn"
                onClick={() => toggleField(field.key)}
                title="Remove field"
              >
                <i className="codicon codicon-close" />
              </button>
            </div>
            <p className="omp-edit-form-hint">{field.description}</p>
            {field.type === "text" && (
              <input
                className="omp-edit-form-input"
                value={String(fieldValues[field.key] ?? "")}
                onChange={(e) => updateField(field.key, e.target.value)}
                placeholder={field.placeholder}
              />
            )}
            {field.type === "globs" && (
              <input
                className="omp-edit-form-input"
                value={String(fieldValues[field.key] ?? "")}
                onChange={(e) => updateField(field.key, e.target.value)}
                placeholder={field.placeholder}
              />
            )}
            {field.type === "toggle" && (
              <label className="omp-edit-form-toggle-row">
                <input
                  type="checkbox"
                  className="omp-settings-toggle"
                  checked={!!fieldValues[field.key]}
                  onChange={(e) => updateField(field.key, e.target.checked)}
                />
                <span className="omp-edit-form-toggle-label">Enabled</span>
              </label>
            )}
            {field.type === "tools" && (
              <div className="omp-agent-tools-tags">
                {ALL_TOOL_NAMES.map((tool) => {
                  const currentVal = String(fieldValues[field.key] ?? "");
                  const selected = new Set(currentVal.split(/[\s,]+/).filter(Boolean));
                  const isActive = selected.has(tool);
                  return (
                    <button
                      key={tool}
                      type="button"
                      className={`omp-agent-tool-tag${isActive ? " omp-agent-tool-tag--active" : ""}`}
                      onClick={() => {
                        const next = new Set(selected);
                        if (isActive) next.delete(tool); else next.add(tool);
                        updateField(field.key, Array.from(next).join(" "));
                      }}
                    >
                      {tool}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Content */}
      <div className="omp-edit-form-field">
        <label className="omp-edit-form-label">Content <span className="omp-edit-form-required">*</span></label>
        <p className="omp-edit-form-hint">The skill instructions (markdown body after frontmatter)</p>
        <textarea
          className="omp-edit-form-textarea"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={14}
          placeholder="Write the skill instructions here..."
        />
      </div>

      {/* Save */}
      <div className="omp-edit-form-actions">
        <button
          className="omp-edit-form-save"
          onClick={save}
          disabled={!name.trim()}
        >
          Create Skill
        </button>
        <button className="omp-edit-form-cancel" onClick={onBack}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── Skill Row ───────────────────────────────────────────────────────────────

function SkillRow({ skill, onEdit, onDelete }: { skill: DiscoveredSkill; onEdit: (s: DiscoveredSkill) => void; onDelete: (s: DiscoveredSkill) => void }) {
  const canEdit = skill.location === "user" || skill.location === "project";

  return (
    <div className="omp-settings-agent-override-row omp-settings-agent-override-row--simple">
      <div className="omp-settings-agent-override-meta">
        <div className="omp-settings-agent-info">
          <span className="omp-settings-agent-name">{skill.name}</span>
          <span className={`omp-settings-agent-badge badge-${skill.source === "prompt" ? "bundled" : "config"}`}>
            {skill.source === "prompt" ? "PROMPT" : "SKILL"}
          </span>
          <span className={`omp-settings-agent-badge badge-${skill.location === "user" ? "user" : "project"}`}>
            {skill.location === "user" ? "USER" : "PROJECT"}
          </span>
          <div className="omp-settings-agent-row-actions">
            {canEdit && (
              <button
                type="button"
                className="omp-settings-icon-btn"
                onClick={() => onEdit(skill)}
                title="Edit skill"
              >
                <i className="codicon codicon-edit" />
              </button>
            )}
            <button
              type="button"
              className="omp-settings-icon-btn"
              onClick={() => getVSCodeAPI().postMessage({ type: "openFile", path: skill.path })}
              title="Open in editor"
            >
              <i className="codicon codicon-go-to-file" />
            </button>
            {canEdit && (
              <button
                type="button"
                className="omp-settings-icon-btn"
                onClick={() => onDelete(skill)}
                title="Delete skill"
              >
                <i className="codicon codicon-trash" />
              </button>
            )}
          </div>
        </div>
        {skill.description && (
          <span className="omp-settings-agent-desc">{skill.description}</span>
        )}
        <span className="omp-settings-agent-desc" style={{ fontFamily: "var(--vscode-editor-font-family, monospace)", fontSize: 10, opacity: 0.7 }}>
          {skill.path}
        </span>
      </div>
    </div>
  );
}
