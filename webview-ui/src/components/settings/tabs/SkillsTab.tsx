import { useState } from "react";
import { getVSCodeAPI } from "../../../vscode";
import { useSettings } from "../SettingsContext";
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

interface DiscoveredSkill {
  name: string;
  description?: string;
  source: "prompt" | "skill";
  location: "user" | "project";
  path: string;
}

type SubTab = "detected" | "settings";

export function SkillsTab() {
  const [subTab, setSubTab] = useState<SubTab>("detected");
  const { config, draft, updateSetting } = useSettings();
  const skills = ((useSettings() as Record<string, unknown>).skills ?? []) as DiscoveredSkill[];

  const get = (key: string) =>
    getSettingValue(draft as Record<string, unknown>, config as Record<string, unknown>, key);

  const getBool = (key: string, defaultValue: boolean): boolean =>
    (get(key) ?? defaultValue) as boolean;

  const userSkills = skills.filter((s) => s.location === "user");
  const projectSkills = skills.filter((s) => s.location === "project");

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
            {skills.length === 0 ? (
              <p className="omp-settings-section-desc">
                No skills detected. Skills will appear when the runtime discovers command files.
              </p>
            ) : (
              <>
                {userSkills.length > 0 && (
                  <SkillGroup title="User" skills={userSkills} />
                )}
                {projectSkills.length > 0 && (
                  <SkillGroup title="Project" skills={projectSkills} />
                )}
              </>
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

function SkillGroup({ title, skills }: { title: string; skills: DiscoveredSkill[] }) {
  return (
    <div className="omp-settings-section" style={{ marginTop: 12 }}>
      <h4 className="omp-settings-section-title" style={{ fontSize: 12, textTransform: "uppercase", opacity: 0.7 }}>
        {title}
      </h4>
      {skills.map((skill) => (
        <SkillRow key={skill.path} skill={skill} />
      ))}
    </div>
  );
}

function SkillRow({ skill }: { skill: DiscoveredSkill }) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      className="omp-skill-row"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="omp-skill-row-top">
        <span className="omp-skill-row-name">{skill.name}</span>
        <span className={`omp-skill-badge omp-skill-badge--${skill.source}`}>
          {skill.source === "prompt" ? "PROMPT" : "SKILL"}
        </span>
        <span className={`omp-skill-badge omp-skill-badge--${skill.location}`}>
          {skill.location === "user" ? "USER" : "PROJECT"}
        </span>
        {hovered && (
          <button
            className="omp-settings-btn-small"
            onClick={() => getVSCodeAPI().postMessage({ type: "openFile", path: skill.path })}
          >
            Open
          </button>
        )}
      </div>
      {skill.description && (
        <div className="omp-skill-row-desc">{skill.description}</div>
      )}
      <div className="omp-skill-row-path">{skill.path}</div>
    </div>
  );
}
