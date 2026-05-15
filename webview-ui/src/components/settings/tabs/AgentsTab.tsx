import { useState } from "react";
import { getVSCodeAPI } from "../../../vscode";
import { ModelReferencePicker, THINKING_LEVEL_OPTIONS } from "../ModelReferencePicker";
import { useSettings } from "../SettingsContext";
import { SettingsRow } from "../SettingsRow";
import { DeleteConfirmOverlay } from "../DeleteConfirmOverlay";

const SUB_TABS = ["Agents", "Delegation"] as const;
type SubTab = (typeof SUB_TABS)[number];

let lastSubTab: SubTab = "Agents";

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

export function AgentsTab() {
  const [subTab, setSubTab] = useState<SubTab>(lastSubTab);

  return (
    <div>
      <div className="omp-settings-subtabs">
        {SUB_TABS.map((tab) => (
          <button
            key={tab}
            className={`omp-settings-subtab${subTab === tab ? " omp-settings-subtab--active" : ""}`}
            onClick={() => {
              lastSubTab = tab;
              setSubTab(tab);
            }}
          >
            {tab}
          </button>
        ))}
      </div>
      <div className="omp-settings-subtab-content">
        {subTab === "Agents" && <AgentsSubTab />}
        {subTab === "Delegation" && <DelegationSubTab />}
      </div>
    </div>
  );
}

// ── Agents sub-tab ──────────────────────────────────────────────────────────

interface AgentDef {
  name: string;
  description: string;
  systemPrompt: string;
  tools?: string[];
  spawns?: string[] | "*";
  model?: string | string[];
  thinkingLevel?: string;
  source: string;
  filePath?: string;
}

const BUILTIN_MODEL_ROLE_NAMES = ["default", "smol", "slow", "task", "plan"] as const;

const agentDefaultModel = (agent: AgentDef): string => {
  if (Array.isArray(agent.model)) return agent.model.join(", ");
  return agent.model ?? "";
};

const getModelRoleNames = (
  config: Record<string, unknown>,
  draft: Record<string, unknown>,
  agents: AgentDef[],
): string[] => {
  const names: string[] = [];
  const seen = new Set<string>();
  const add = (name: string) => {
    const clean = name.trim();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    names.push(clean);
  };

  for (const name of BUILTIN_MODEL_ROLE_NAMES) add(name);
  const roles =
    (resolveKey(draft, "modelRoles") as Record<string, string> | undefined) ??
    (resolveKey(config, "modelRoles") as Record<string, string> | undefined) ??
    {};
  for (const name of Object.keys(roles)) add(name);

  const cycleOrder =
    (resolveKey(draft, "cycleOrder") as string[] | undefined) ??
    (resolveKey(config, "cycleOrder") as string[] | undefined) ??
    [];
  for (const name of cycleOrder) add(name);

  for (const agent of agents) {
    const models = Array.isArray(agent.model) ? agent.model : agent.model ? [agent.model] : [];
    for (const model of models) {
      if (model.startsWith("pi/")) add(model.slice(3));
    }
  }
  return names;
};

const displaySource = (agent: AgentDef): "global" | "project" | "bundled" | "config" => {
  if (agent.source === "user") return "global";
  if (agent.source === "global") return "global";
  if (agent.source === "project") return "project";
  if (agent.source === "bundled") return "bundled";
  return "config";
};

const agentScope = (agent: AgentDef): "global" | "project" =>
  displaySource(agent) === "project" ? "project" : "global";

const canEditAgent = (agent: AgentDef): boolean => {
  const source = displaySource(agent);
  return source === "global" || source === "project";
};

const parseTools = (value: string): string[] | undefined => {
  const tools = value
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);
  return tools.length > 0 ? tools : undefined;
};

function AgentsSubTab() {
  const { agents, config, draft, updateSetting } = useSettings();
  const [selectedAgent, setSelectedAgent] = useState<AgentDef | null>(null);
  const [newAgentScope, setNewAgentScope] = useState<"global" | "project" | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AgentDef | null>(null);

  const getOverrides = (): Record<string, string> => {
    const key = "task.agentModelOverrides";
    if (key in (draft as Record<string, unknown>)) return (draft as Record<string, unknown>)[key] as Record<string, string> ?? {};
    const d = resolveKey(draft as Record<string, unknown>, key) as Record<string, string> | undefined;
    if (d !== undefined) return d;
    if (key in (config as Record<string, unknown>)) return (config as Record<string, unknown>)[key] as Record<string, string> ?? {};
    const c = resolveKey(config as Record<string, unknown>, key) as Record<string, string> | undefined;
    return c ?? {};
  };

  const getDisabledAgents = (): string[] => {
    const key = "task.disabledAgents";
    if (key in (draft as Record<string, unknown>)) return (draft as Record<string, unknown>)[key] as string[] ?? [];
    const d = resolveKey(draft as Record<string, unknown>, key) as string[] | undefined;
    if (d !== undefined) return d;
    if (key in (config as Record<string, unknown>)) return (config as Record<string, unknown>)[key] as string[] ?? [];
    const c = resolveKey(config as Record<string, unknown>, key) as string[] | undefined;
    return c ?? [];
  };

  const overrides = getOverrides();
  const disabledAgents = getDisabledAgents();

  // Build agent list: discovered agents + any config-referenced agents not in discovered list
  const buildAgentList = (): AgentDef[] => {
    const result = [...agents];
    const knownNames = new Set(agents.map((a) => a.name));
    // Add agents from overrides that aren't in discovered list
    for (const name of Object.keys(overrides)) {
      if (!knownNames.has(name)) {
        result.push({
          name,
          description: "From config (model override set)",
          systemPrompt: "",
          source: "config",
        });
        knownNames.add(name);
      }
    }
    // Add disabled agents that aren't in discovered list
    for (const name of disabledAgents) {
      if (!knownNames.has(name)) {
        result.push({
          name,
          description: "From config (disabled)",
          systemPrompt: "",
          source: "config",
        });
        knownNames.add(name);
      }
    }
    return result;
  };

  const allAgents = buildAgentList();

  const modelRoleNames = getModelRoleNames(
    config as Record<string, unknown>,
    draft as Record<string, unknown>,
    allAgents,
  );
  const updateOverride = (agentName: string, model: string) => {
    const updated = { ...overrides, [agentName]: model };
    if (!model) delete updated[agentName];
    updateSetting("task.agentModelOverrides", updated);
  };

  const deleteAgent = (agent: AgentDef) => {
    if (!agent.filePath || !canEditAgent(agent)) return;
    setPendingDelete(agent);
  };

  if (newAgentScope) {
    const newAgent: AgentDef = {
      name: "",
      description: "",
      systemPrompt: "",
      source: newAgentScope === "global" ? "user" : "project",
    };
    return (
      <AgentEditView
        agent={newAgent}
        onBack={() => setNewAgentScope(null)}
        overrides={overrides}
        onUpdateOverride={updateOverride}
        modelRoleNames={modelRoleNames}
        isNew
        scope={newAgentScope}
      />
    );
  }
  if (selectedAgent) {
    return (
      <AgentEditView
        agent={selectedAgent}
        onBack={() => setSelectedAgent(null)}
        overrides={overrides}
        onUpdateOverride={updateOverride}
        modelRoleNames={modelRoleNames}
      />
    );
  }

  return (
    <>
      <AgentListView
        agents={allAgents}
        overrides={overrides}
        disabledAgents={disabledAgents}
        modelRoleNames={modelRoleNames}
        onSelect={setSelectedAgent}
        onCreate={setNewAgentScope}
        onUpdateOverride={updateOverride}
        onDelete={deleteAgent}
        onToggleDisabled={(name, disabled) => {
          const updated = disabled
            ? [...disabledAgents, name]
            : disabledAgents.filter((n) => n !== name);
          updateSetting("task.disabledAgents", updated);
        }}
      />
      {pendingDelete && (
        <DeleteConfirmOverlay
          type="agent"
          name={pendingDelete.name}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            getVSCodeAPI().postMessage({ type: "settings.agent.delete", filePath: pendingDelete.filePath! });
            setPendingDelete(null);
          }}
        />
      )}
    </>
  );
}

function AgentListView({
  agents,
  overrides,
  disabledAgents,
  modelRoleNames,
  onSelect,
  onCreate,
  onUpdateOverride,
  onDelete,
  onToggleDisabled,
}: {
  agents: AgentDef[];
  overrides: Record<string, string>;
  disabledAgents: string[];
  modelRoleNames: string[];
  onSelect: (a: AgentDef) => void;
  onCreate: (scope: "global" | "project") => void;
  onUpdateOverride: (agentName: string, model: string) => void;
  onDelete: (agent: AgentDef) => void;
  onToggleDisabled: (name: string, disabled: boolean) => void;
}) {
  const [search, setSearch] = useState("");
  const filteredAgents = agents.filter((agent) => {
    if (!search) return true;
    const query = search.toLowerCase();
    return (
      agent.name.toLowerCase().includes(query) || agent.description.toLowerCase().includes(query)
    );
  });
  const createActions = (
    <div className="omp-settings-agent-actions">
      <button className="omp-settings-btn-small" onClick={() => onCreate("global")}>
        Add Global Agent
      </button>
      <button className="omp-settings-btn-small" onClick={() => onCreate("project")}>
        Add Project Agent
      </button>
    </div>
  );

  if (filteredAgents.length === 0) {
    return (
      <div className="omp-settings-section">
        {createActions}
        <input
          className="omp-settings-input omp-settings-agent-filter"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Filter agents..."
        />
        <p className="omp-settings-placeholder">
          {agents.length === 0 ? (
            <>
              No agents discovered. Global agents are loaded from <code>~/.omp/agents/</code>;
              project agents from <code>.omp/agents/</code>.
            </>
          ) : (
            "No agents match the current filter."
          )}
        </p>
      </div>
    );
  }

  return (
    <div className="omp-settings-agent-list">
      {createActions}
      <input
        className="omp-settings-input omp-settings-agent-filter"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Filter agents..."
      />
      <div className="omp-settings-agent-overrides">
        {filteredAgents.map((agent) => {
          const override = overrides[agent.name] ?? "";
          const defaultModel = agentDefaultModel(agent);
          const canDelete = canEditAgent(agent) && !!agent.filePath;
          return (
            <div key={`${agent.source}:${agent.name}`} className="omp-settings-agent-override-row">
              <div className="omp-settings-agent-override-meta">
                <div className="omp-settings-agent-info">
                  <span className="omp-settings-agent-name">{agent.name}</span>
                  <span className={`omp-settings-agent-badge badge-${displaySource(agent)}`}>
                    {displaySource(agent)}
                  </span>
                  <div className="omp-settings-agent-row-actions">
                    <button
                      type="button"
                      className="omp-settings-icon-btn"
                      onClick={() => onSelect(agent)}
                      title="Edit agent"
                    >
                      <i className="codicon codicon-edit" />
                    </button>
                    {canDelete && (
                      <button
                        type="button"
                        className="omp-settings-icon-btn"
                        onClick={() => onDelete(agent)}
                        title="Delete agent"
                      >
                        <i className="codicon codicon-trash" />
                      </button>
                    )}
                  </div>
                </div>
                {agent.description && (
                  <span className="omp-settings-agent-desc">{agent.description}</span>
                )}
                {defaultModel && (
                  <span className="omp-settings-agent-default">Default: {defaultModel}</span>
                )}
              </div>
              <div className="omp-settings-agent-override-picker">
                <ModelReferencePicker
                  value={override}
                  defaultModel={defaultModel}
                  roleNames={modelRoleNames}
                  allowUnset
                  allowRoles
                  onChange={(value) => onUpdateOverride(agent.name, value)}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* § Disabled Agents */}
      {agents.length > 0 && (
        <div className="omp-settings-section" style={{ marginTop: 24 }}>
          <h3 className="omp-settings-section-title">Agent Availability</h3>
          <p className="omp-settings-section-desc">Uncheck agents to prevent delegation to them</p>
          <div className="omp-settings-toggle-grid">
            {agents.map((agent) => (
              <label key={`disable-${agent.name}`} className="omp-settings-toggle-cell" title={agent.description}>
                <input
                  type="checkbox"
                  className="omp-settings-toggle"
                  checked={!disabledAgents.includes(agent.name)}
                  onChange={(e) => onToggleDisabled(agent.name, !e.target.checked)}
                />
                <span>{agent.name}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function AgentEditView({
  agent,
  onBack,
  overrides,
  onUpdateOverride,
  modelRoleNames,
  isNew = false,
  scope,
}: {
  agent: AgentDef;
  onBack: () => void;
  overrides: Record<string, string>;
  onUpdateOverride: (name: string, model: string) => void;
  modelRoleNames: string[];
  isNew?: boolean;
  scope?: "global" | "project";
}) {
  const editable = isNew || canEditAgent(agent);
  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.description);
  const [systemPrompt, setSystemPrompt] = useState(agent.systemPrompt);
  const [toolsText, setToolsText] = useState(agent.tools?.join(", ") ?? "");
  const [thinkingLevel, setThinkingLevel] = useState(agent.thinkingLevel ?? "");

  const ALL_TOOL_NAMES = [
    "read", "search", "find", "edit", "write", "bash",
    "ast_grep", "ast_edit", "lsp", "debug", "eval",
    "browser", "web_search", "fetch", "github",
    "task", "irc", "recipe", "checkpoint", "notebook",
    "render_mermaid", "inspect_image", "calc", "generate_image",
    "todo_write", "question", "yield",
  ];

  const selectedTools = new Set(
    toolsText.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean)
  );
  const saveAgent = () => {
    getVSCodeAPI().postMessage({
      type: "settings.agent.write",
      scope: scope ?? agentScope(agent),
      filePath: isNew ? undefined : agent.filePath,
      agent: {
        name,
        description,
        systemPrompt,
        tools: parseTools(toolsText),
        model: agent.model,
        thinkingLevel: thinkingLevel || undefined,
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
        <h3 className="omp-settings-agent-edit-title">{isNew ? "New Agent" : agent.name}</h3>
        <span className={`omp-settings-agent-badge badge-${displaySource(agent)}`}>
          {displaySource(agent)}
        </span>
      </div>

      {!editable && (
        <p className="omp-settings-placeholder">
          This agent is read-only. Bundled agents and config-only fallback entries cannot be edited
          here.
        </p>
      )}

      <div className="omp-settings-section">
        <SettingsRow
          title="Name"
          description={
            isNew
              ? "Agent identifier used by task delegation"
              : "Existing agent names are not renamed here"
          }
        >
          <input
            className="omp-settings-input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            readOnly={!isNew}
            placeholder="agent-name"
          />
        </SettingsRow>
        <SettingsRow title="Description" description="Short description shown in the agent picker">
          <input
            className="omp-settings-input"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            readOnly={!editable}
            placeholder="What this agent does"
          />
        </SettingsRow>
      </div>

      <div className="omp-settings-section">
        <label className="omp-settings-row-title">System Prompt</label>
        <textarea
          className="omp-settings-textarea"
          readOnly={!editable}
          value={systemPrompt}
          onChange={(event) => setSystemPrompt(event.target.value)}
          rows={14}
          placeholder="Agent instructions..."
        />
      </div>

      {!isNew && (
        <div className="omp-settings-section">
          <SettingsRow
            title="Model Override"
            description="Override the default model and thinking level for this agent"
            last
          >
            <div className="omp-agent-model-thinking-row">
              <ModelReferencePicker
                value={overrides[agent.name] ?? ""}
                defaultModel={agentDefaultModel(agent)}
                roleNames={modelRoleNames}
                allowUnset
                allowRoles
                onChange={(value) => onUpdateOverride(agent.name, value)}
              />
              <select
                className="omp-settings-select omp-agent-thinking-select"
                value={thinkingLevel}
                onChange={(event) => setThinkingLevel(event.target.value)}
                disabled={!editable}
                title="Thinking level"
              >
                <option value="">Thinking: Unset</option>
                {THINKING_LEVEL_OPTIONS.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            </div>
          </SettingsRow>
        </div>
      )}

      <div className="omp-settings-section">
        <label className="omp-edit-form-label">
          Tools {toolsText ? "" : <span className="omp-edit-form-hint" style={{ display: "inline", marginLeft: 8 }}>All tools allowed</span>}
        </label>
        <div className="omp-agent-tools-tags">
          {ALL_TOOL_NAMES.map((tool) => {
            const selected = selectedTools.has(tool);
            return (
              <button
                key={tool}
                type="button"
                className={`omp-agent-tool-tag${selected ? " omp-agent-tool-tag--active" : ""}`}
                onClick={() => {
                  if (!editable) return;
                  const next = new Set(selectedTools);
                  if (selected) next.delete(tool); else next.add(tool);
                  const arr = Array.from(next);
                  setToolsText(arr.join(", "));
                }}
                disabled={!editable}
              >
                {tool}
              </button>
            );
          })}
        </div>
      </div>

      {agent.filePath && (
        <div className="omp-settings-section">
          <SettingsRow title="Source File" description={agent.filePath} last>
            <span className={`omp-settings-agent-badge badge-${displaySource(agent)}`}>
              {displaySource(agent)}
            </span>
          </SettingsRow>
        </div>
      )}

      {editable && (
        <div className="omp-settings-agent-actions">
          <button className="omp-settings-btn-small" onClick={saveAgent}>
            Save Agent
          </button>
        </div>
      )}
    </div>
  );
}

// ── Delegation sub-tab ──────────────────────────────────────────────────────

function DelegationSubTab() {
  const { config, draft, updateSetting } = useSettings();
  const get = (key: string) =>
    getSettingValue(draft as Record<string, unknown>, config as Record<string, unknown>, key);

  return (
    <div className="omp-settings-section">
      <SettingsRow title="Eager Delegation" description="Eagerly delegate tasks to sub-agents">
        <input
          type="checkbox"
          className="omp-settings-toggle"
          checked={!!get("task.eager")}
          onChange={(e) => updateSetting("task.eager", e.target.checked)}
        />
      </SettingsRow>
      <SettingsRow
        title="Simple Task Mode"
        description="How simple tasks are handled by sub-agents"
      >
        <select
          className="omp-settings-select"
          value={String(get("task.simple") ?? "default")}
          onChange={(e) => updateSetting("task.simple", e.target.value)}
        >
          <option value="default">Default</option>
          <option value="schema-free">Schema-free</option>
          <option value="independent">Independent</option>
        </select>
      </SettingsRow>
      <SettingsRow title="Max Concurrency" description="Maximum concurrent sub-agent tasks">
        <select
          className="omp-settings-select"
          value={String(get("task.maxConcurrency") ?? 32)}
          onChange={(e) => updateSetting("task.maxConcurrency", parseInt(e.target.value))}
        >
          <option value="0">Unlimited</option>
          <option value="1">1</option>
          <option value="2">2</option>
          <option value="4">4</option>
          <option value="8">8</option>
          <option value="16">16</option>
          <option value="32">32</option>
          <option value="64">64</option>
        </select>
      </SettingsRow>
      <SettingsRow
        title="Max Recursion Depth"
        description="Maximum depth of nested sub-agent delegation"
      >
        <select
          className="omp-settings-select"
          value={String(get("task.maxRecursionDepth") ?? 2)}
          onChange={(e) => updateSetting("task.maxRecursionDepth", parseInt(e.target.value))}
        >
          <option value="-1">Unlimited</option>
          <option value="0">0</option>
          <option value="1">1</option>
          <option value="2">2</option>
          <option value="3">3</option>
        </select>
      </SettingsRow>
      <SettingsRow
        title="Isolation Mode"
        description="Filesystem isolation strategy for sub-agents"
      >
        <select
          className="omp-settings-select"
          value={String(get("task.isolation.mode") ?? "none")}
          onChange={(e) => updateSetting("task.isolation.mode", e.target.value)}
        >
          <option value="none">None</option>
          <option value="worktree">Worktree</option>
          <option value="fuse-overlay">FUSE Overlay</option>
          <option value="fuse-projfs">FUSE ProjFS</option>
        </select>
      </SettingsRow>
      <SettingsRow title="Isolation Merge" description="How isolated changes are merged back">
        <select
          className="omp-settings-select"
          value={String(get("task.isolation.merge") ?? "patch")}
          onChange={(e) => updateSetting("task.isolation.merge", e.target.value)}
        >
          <option value="patch">Patch</option>
          <option value="branch">Branch</option>
        </select>
      </SettingsRow>
      <SettingsRow title="Isolation Commits" description="Commit message style for isolated work">
        <select
          className="omp-settings-select"
          value={String(get("task.isolation.commits") ?? "generic")}
          onChange={(e) => updateSetting("task.isolation.commits", e.target.value)}
        >
          <option value="generic">Generic</option>
          <option value="ai">AI</option>
        </select>
      </SettingsRow>
      <SettingsRow
        title="Todo Clear Delay"
        description="Delay before completed todos are cleared"
        last
      >
        <select
          className="omp-settings-select"
          value={String(get("tasks.todoClearDelay") ?? 60)}
          onChange={(e) => updateSetting("tasks.todoClearDelay", parseInt(e.target.value))}
        >
          <option value="0">Instant</option>
          <option value="60">1 minute</option>
          <option value="300">5 minutes</option>
          <option value="900">15 minutes</option>
          <option value="1800">30 minutes</option>
          <option value="3600">1 hour</option>
          <option value="-1">Never</option>
        </select>
      </SettingsRow>
    </div>
  );
}

