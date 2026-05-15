import { useState } from "react";
import { getVSCodeAPI } from "../../../vscode";
import { useSettings, type DiscoveredSkill } from "../SettingsContext";
import { SettingsRow } from "../SettingsRow";

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
  const [filter, setFilter] = useState("");
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

  if (newSkillScope) {
    return (
      <SkillEditView
        scope={newSkillScope}
        onBack={() => setNewSkillScope(null)}
      />
    );
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
                  <SkillRow key={skill.path} skill={skill} />
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
    </div>
  );
}

function SkillEditView({
  scope,
  onBack,
}: {
  scope: "global" | "project";
  onBack: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [globsText, setGlobsText] = useState("");
  const [alwaysApply, setAlwaysApply] = useState(false);
  const [content, setContent] = useState("");

  const saveSkill = () => {
    const globs = globsText
      .split(",")
      .map((g) => g.trim())
      .filter(Boolean);
    getVSCodeAPI().postMessage({
      type: "settings.skill.write",
      scope,
      skill: {
        name,
        description,
        globs: globs.length > 0 ? globs : undefined,
        alwaysApply: alwaysApply || undefined,
        content,
      },
    });
    onBack();
  };

  return (
    <div className="omp-settings-agent-edit">
      <button onClick={onBack} className="omp-settings-back-btn">
        <i className="codicon codicon-arrow-left" /> Back to list
      </button>
      <div className="omp-settings-agent-edit-heading">
        <h3 className="omp-settings-agent-edit-title">New Skill</h3>
        <span className={`omp-settings-agent-badge badge-${scope === "global" ? "global" : "project"}`}>
          {scope}
        </span>
      </div>

      <div className="omp-settings-section">
        <SettingsRow title="Name" description="Skill identifier (becomes the filename)">
          <input
            className="omp-settings-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-skill"
          />
        </SettingsRow>
        <SettingsRow title="Description" description="Short description shown in skill listings">
          <textarea
            className="omp-settings-textarea"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this skill does"
            rows={2}
          />
        </SettingsRow>
        <SettingsRow title="Globs" description="Comma-separated file globs for activation (optional)">
          <input
            className="omp-settings-input"
            value={globsText}
            onChange={(e) => setGlobsText(e.target.value)}
            placeholder="**/*.ts, src/**/*.tsx"
          />
        </SettingsRow>
        <SettingsRow title="Always Apply" description="Apply this skill to every conversation" last>
          <input
            type="checkbox"
            className="omp-settings-toggle"
            checked={alwaysApply}
            onChange={(e) => setAlwaysApply(e.target.checked)}
          />
        </SettingsRow>
      </div>

      <div className="omp-settings-section">
        <label className="omp-settings-row-title">Content</label>
        <textarea
          className="omp-settings-textarea"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={12}
          placeholder="Skill instructions / command content..."
        />
      </div>

      <div className="omp-settings-agent-actions">
        <button
          className="omp-settings-btn-small"
          onClick={saveSkill}
          disabled={!name.trim() || !description.trim()}
        >
          Save Skill
        </button>
      </div>
    </div>
  );
}

function SkillRow({ skill }: { skill: DiscoveredSkill }) {
  const canDelete = skill.location === "user" || skill.location === "project";

  const deleteSkill = () => {
    const ok = window.confirm(`Delete skill "${skill.name}"?\n\n${skill.path}`);
    if (!ok) return;
    getVSCodeAPI().postMessage({ type: "settings.skill.delete", path: skill.path });
  };

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
            <button
              type="button"
              className="omp-settings-icon-btn"
              onClick={() => getVSCodeAPI().postMessage({ type: "openFile", path: skill.path })}
              title="Open file"
            >
              <i className="codicon codicon-go-to-file" />
            </button>
            {canDelete && (
              <button
                type="button"
                className="omp-settings-icon-btn"
                onClick={deleteSkill}
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
      </div>
    </div>
  );
}
