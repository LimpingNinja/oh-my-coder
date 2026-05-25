import { useEffect, useState } from "react";
import { getVSCodeAPI } from "../../../vscode";
import { SettingsRow } from "../SettingsRow";
import { TagInput } from "../TagInput";
import { ScopeBuilder } from "../ScopeBuilder";
import { DeleteConfirmOverlay } from "../DeleteConfirmOverlay";

// ── Types ────────────────────────────────────────────────────────────────────

interface RuleDef {
  name: string;
  description?: string;
  globs?: string[];
  alwaysApply?: boolean;
  condition?: string[];
  scope?: string[];
  interruptMode?: "never" | "prose-only" | "tool-only" | "always";
  content: string;
  source: "global" | "project";
}

// ── Main Component ───────────────────────────────────────────────────────────

export function SteeringSubTab() {
  // AGENTS.md state
  const [agentsMdScope, setAgentsMdScope] = useState<"global" | "project">("global");
  const [globalAgentsMd, setGlobalAgentsMd] = useState("");
  const [projectAgentsMd, setProjectAgentsMd] = useState("");
  const [agentsMdDirty, setAgentsMdDirty] = useState(false);

  // Rules state
  const [rules, setRules] = useState<RuleDef[]>([]);
  const [editingRule, setEditingRule] = useState<RuleDef | null>(null);
  const [creatingRule, setCreatingRule] = useState(false);
  const [deletingRule, setDeletingRule] = useState<RuleDef | null>(null);

  // Load AGENTS.md on mount
  useEffect(() => {
    getVSCodeAPI().postMessage({ type: "settings.agentsMd.load" });
    loadRulesFromDisk();

    function handleMessage(event: MessageEvent) {
      const msg = event.data;
      if (msg?.type === "settings.agentsMd.loaded") {
        setGlobalAgentsMd(msg.global ?? "");
        setProjectAgentsMd(msg.project ?? "");
        setAgentsMdDirty(false);
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  async function loadRulesFromDisk() {
    // Rules are loaded via the bridge's /settings endpoint as part of settings.loaded
    // For now we scan from the filesystem via a message round-trip
    // The rules will be populated from the settings context if available
  }

  const currentAgentsMd = agentsMdScope === "global" ? globalAgentsMd : projectAgentsMd;
  const setCurrentAgentsMd = (value: string) => {
    if (agentsMdScope === "global") setGlobalAgentsMd(value);
    else setProjectAgentsMd(value);
    setAgentsMdDirty(true);
  };

  const saveAgentsMd = () => {
    getVSCodeAPI().postMessage({
      type: "settings.agentsMd.save",
      scope: agentsMdScope,
      content: currentAgentsMd,
    });
    setAgentsMdDirty(false);
  };

  // ── Edit view ──────────────────────────────────────────────────────────────

  if (creatingRule || editingRule) {
    return (
      <RuleEditView
        rule={editingRule}
        onBack={() => { setCreatingRule(false); setEditingRule(null); }}
      />
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div>
      {/* § AGENTS.md */}
      <div className="omp-settings-section">
        <h3 className="omp-settings-section-title">AGENTS.md</h3>
        <p className="omp-settings-section-desc">
          High-level instructions injected into the system prompt. Applies to all sessions.
        </p>

        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <button
            type="button"
            className={`omp-settings-subtab${agentsMdScope === "global" ? " omp-settings-subtab--active" : ""}`}
            onClick={() => setAgentsMdScope("global")}
          >
            Global (~/.omp/agent/)
          </button>
          <button
            type="button"
            className={`omp-settings-subtab${agentsMdScope === "project" ? " omp-settings-subtab--active" : ""}`}
            onClick={() => setAgentsMdScope("project")}
          >
            Project (.omp/)
          </button>
        </div>

        <textarea
          className="omp-settings-textarea"
          value={currentAgentsMd}
          onChange={(e) => setCurrentAgentsMd(e.target.value)}
          rows={12}
          placeholder={`# ${agentsMdScope === "global" ? "Global" : "Project"} agent instructions\n\nWrite markdown here...`}
        />

        {agentsMdDirty && (
          <button
            className="omp-settings-btn-small"
            style={{ marginTop: 8 }}
            onClick={saveAgentsMd}
          >
            Save AGENTS.md
          </button>
        )}
      </div>

      {/* § Rules */}
      <div className="omp-settings-section">
        <h3 className="omp-settings-section-title">Rules</h3>
        <p className="omp-settings-section-desc">
          Conditional rules with frontmatter. Stored in ~/.omp/agent/rules/ (global) or .omp/rules/ (project).
        </p>

        {rules.length > 0 && (
          <div className="omp-provider-configured-list">
            {rules.map((rule) => (
              <div key={`${rule.source}:${rule.name}`} className="omp-provider-configured-card">
                <div className="omp-provider-configured-card-main">
                  <div className="omp-provider-configured-card-top">
                    <span className="omp-provider-configured-card-name">{rule.name}</span>
                    {rule.description && (
                      <span className="omp-provider-configured-card-meta">{rule.description}</span>
                    )}
                    <span className={`omp-settings-agent-badge badge-${rule.source}`}>
                      {rule.source}
                    </span>
                    {rule.alwaysApply && (
                      <span className="omp-provider-config-badge">always</span>
                    )}
                    {rule.globs && rule.globs.length > 0 && (
                      <span className="omp-provider-config-badge">{rule.globs.join(", ")}</span>
                    )}
                    <div className="omp-settings-agent-row-actions">
                      <button
                        type="button"
                        className="omp-settings-icon-btn"
                        onClick={() => setEditingRule(rule)}
                        title="Edit rule"
                      >
                        <i className="codicon codicon-edit" />
                      </button>
                      <button
                        type="button"
                        className="omp-settings-icon-btn"
                        onClick={() => setDeletingRule(rule)}
                        title="Delete rule"
                      >
                        <i className="codicon codicon-trash" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        <button
          className="omp-settings-btn-small"
          style={{ marginTop: 8 }}
          onClick={() => setCreatingRule(true)}
        >
          + New Rule
        </button>
      </div>

      {/* Delete confirmation */}
      {deletingRule && (
        <DeleteConfirmOverlay
          type="rule"
          name={deletingRule.name}
          onCancel={() => setDeletingRule(null)}
          onConfirm={() => {
            getVSCodeAPI().postMessage({
              type: "settings.rule.delete",
              scope: deletingRule.source,
              name: deletingRule.name,
            });
            setRules(rules.filter((r) => r !== deletingRule));
            setDeletingRule(null);
          }}
        />
      )}
    </div>
  );
}

// ── RuleEditView ─────────────────────────────────────────────────────────────

const INTERRUPT_MODE_OPTIONS = [
  { value: "", label: "Unset (inherit global)" },
  { value: "never", label: "Never" },
  { value: "prose-only", label: "Prose Only" },
  { value: "tool-only", label: "Tool Only" },
  { value: "always", label: "Always" },
];

function RuleEditView({
  rule,
  onBack,
}: {
  rule: RuleDef | null;
  onBack: () => void;
}) {
  const isNew = !rule;
  const [name, setName] = useState(rule?.name ?? "");
  const [description, setDescription] = useState(rule?.description ?? "");
  const [globs, setGlobs] = useState<string[]>(rule?.globs ?? []);
  const [alwaysApply, setAlwaysApply] = useState(rule?.alwaysApply ?? false);
  const [condition, setCondition] = useState<string[]>(rule?.condition ?? []);
  const [scope, setScope] = useState<string[]>(rule?.scope ?? []);
  const [interruptMode, setInterruptMode] = useState(rule?.interruptMode ?? "");
  const [content, setContent] = useState(rule?.content ?? "");
  const [ruleScope, setRuleScope] = useState<"global" | "project">(rule?.source ?? "global");

  const canSave = name.trim().length > 0 && content.trim().length > 0;

  const handleSave = () => {
    if (!canSave) return;
    getVSCodeAPI().postMessage({
      type: "settings.rule.write",
      scope: ruleScope,
      rule: {
        name: name.trim(),
        description: description.trim() || undefined,
        globs: globs.length > 0 ? globs : undefined,
        alwaysApply: alwaysApply || undefined,
        condition: condition.length > 0 ? condition : undefined,
        scope: scope.length > 0 ? scope : undefined,
        interruptMode: (interruptMode as RuleDef["interruptMode"]) || undefined,
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
        <h3 className="omp-settings-agent-edit-title">
          {isNew ? "New Rule" : rule.name}
        </h3>
        <span className={`omp-settings-agent-badge badge-${ruleScope}`}>
          {ruleScope}
        </span>
      </div>

      <div className="omp-settings-section">
        <SettingsRow title="Name" description="Rule identifier (used as filename)">
          <input
            className="omp-settings-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            readOnly={!isNew}
            placeholder="my-rule"
          />
        </SettingsRow>
        <SettingsRow title="Description" description="Short description (shown when agent requests rules)">
          <input
            className="omp-settings-input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this rule enforces"
          />
        </SettingsRow>
        {isNew && (
          <SettingsRow title="Scope" description="Where to save this rule">
            <select
              className="omp-settings-select"
              value={ruleScope}
              onChange={(e) => setRuleScope(e.target.value as "global" | "project")}
            >
              <option value="global">Global (~/.omp/agent/rules/)</option>
              <option value="project">Project (.omp/rules/)</option>
            </select>
          </SettingsRow>
        )}
        <SettingsRow title="Always Apply" description="Include in every session regardless of context" last>
          <input
            type="checkbox"
            className="omp-settings-toggle"
            checked={alwaysApply}
            onChange={(e) => setAlwaysApply(e.target.checked)}
          />
        </SettingsRow>
      </div>

      <div className="omp-settings-section">
        <label className="omp-settings-row-title">Globs</label>
        <p className="omp-settings-section-desc" style={{ marginBottom: 4 }}>
          File patterns that activate this rule (Enter or comma to add)
        </p>
        <TagInput
          tags={globs}
          onChange={setGlobs}
          placeholder="*.ts, src/**/*.rs"
        />
      </div>

      <div className="omp-settings-section">
        <label className="omp-settings-row-title">Condition</label>
        <p className="omp-settings-section-desc" style={{ marginBottom: 4 }}>
          Regex patterns that trigger TTSR interruption
        </p>
        <TagInput
          tags={condition}
          onChange={setCondition}
          placeholder="error|warn|TODO"
        />
      </div>

      <div className="omp-settings-section">
        <label className="omp-settings-row-title">Stream Scope</label>
        <p className="omp-settings-section-desc" style={{ marginBottom: 4 }}>
          Which parts of the output stream this rule monitors
        </p>
        <ScopeBuilder
          tokens={scope}
          onChange={setScope}
        />
      </div>

      <div className="omp-settings-section">
        <SettingsRow title="Interrupt Mode" description="When to interrupt the stream for this rule" last>
          <select
            className="omp-settings-select"
            value={interruptMode}
            onChange={(e) => setInterruptMode(e.target.value)}
          >
            {INTERRUPT_MODE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </SettingsRow>
      </div>

      <div className="omp-settings-section">
        <label className="omp-settings-row-title">Content</label>
        <textarea
          className="omp-settings-textarea"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={14}
          placeholder="Rule instructions in markdown..."
        />
      </div>

      <div className="omp-settings-agent-actions">
        <button
          className="omp-settings-btn-small"
          onClick={handleSave}
          disabled={!canSave}
        >
          {isNew ? "Create Rule" : "Save Rule"}
        </button>
      </div>
    </div>
  );
}
