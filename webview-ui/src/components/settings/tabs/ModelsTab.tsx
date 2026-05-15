import { useState } from "react";
import { useSettings } from "../SettingsContext";
import { SettingsRow } from "../SettingsRow";
import {
  joinThinkingSuffix,
  ModelReferencePicker,
  splitThinkingSuffix,
  THINKING_LEVEL_OPTIONS,
} from "../ModelReferencePicker";

const SUB_TABS = ["Roles", "Model", "Sampling", "Retries"] as const;
type SubTab = (typeof SUB_TABS)[number];

let lastSubTab: SubTab = "Roles";

const resolveKey = (source: Record<string, unknown>, key: string): unknown => {
  const parts = key.split(".");
  let value: unknown = source;

  for (const part of parts) {
    if (value == null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[part];
  }

  return value;
};

const getSettingValue = (
  draft: Record<string, unknown>,
  config: Record<string, unknown>,
  key: string,
): unknown => {
  if (key in draft) return draft[key];
  const draftNestedValue = resolveKey(draft, key);
  if (draftNestedValue !== undefined) return draftNestedValue;
  if (key in config) return config[key];
  return resolveKey(config, key);
};

export function ModelsTab() {
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
        {subTab === "Model" && <ModelSubTab />}
        {subTab === "Sampling" && <SamplingSubTab />}
        {subTab === "Retries" && <RetriesSubTab />}
        {subTab === "Roles" && <RolesSubTab />}
      </div>
    </div>
  );
}

function ModelSubTab() {
  const { config, draft, updateSetting } = useSettings();
  const get = (key: string) =>
    getSettingValue(draft as Record<string, unknown>, config as Record<string, unknown>, key) as
      | string
      | boolean
      | number
      | undefined;

  return (
    <div className="omp-settings-section">
      <SettingsRow title="Thinking Level" description="Reasoning depth for thinking-capable models">
        <select
          className="omp-settings-select"
          value={String(get("defaultThinkingLevel") ?? "high")}
          onChange={(e) => updateSetting("defaultThinkingLevel", e.target.value)}
        >
          <option value="off">Off</option>
          <option value="minimal">Minimal</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="xhigh">Extra High</option>
        </select>
      </SettingsRow>
      <SettingsRow
        title="Hide Thinking Blocks"
        description="Hide thinking blocks in assistant responses"
      >
        <input
          type="checkbox"
          className="omp-settings-toggle"
          checked={!!get("hideThinkingBlock")}
          onChange={(e) => updateSetting("hideThinkingBlock", e.target.checked)}
        />
      </SettingsRow>
      <SettingsRow
        title="Repeat Tool Descriptions"
        description="Include full tool descriptions in every system prompt"
      >
        <input
          type="checkbox"
          className="omp-settings-toggle"
          checked={!!get("repeatToolDescriptions")}
          onChange={(e) => updateSetting("repeatToolDescriptions", e.target.checked)}
        />
      </SettingsRow>
      <SettingsRow title="Service Tier" description="OpenAI processing priority" last>
        <select
          className="omp-settings-select"
          value={String(get("serviceTier") ?? "none")}
          onChange={(e) => updateSetting("serviceTier", e.target.value)}
        >
          <option value="none">None (omit)</option>
          <option value="auto">Auto</option>
          <option value="default">Default</option>
          <option value="flex">Flex</option>
          <option value="scale">Scale</option>
          <option value="priority">Priority</option>
        </select>
      </SettingsRow>
    </div>
  );
}

function NumberPreset({
  settingKey,
  label,
  description,
  presets,
  last,
}: {
  settingKey: string;
  label: string;
  description: string;
  presets: Array<{ value: number; label: string }>;
  last?: boolean;
}) {
  const { config, draft, updateSetting } = useSettings();
  const current = getSettingValue(
    draft as Record<string, unknown>,
    config as Record<string, unknown>,
    settingKey,
  );

  return (
    <SettingsRow title={label} description={description} last={last}>
      <select
        className="omp-settings-select"
        value={String(current ?? -1)}
        onChange={(e) => updateSetting(settingKey, parseFloat(e.target.value))}
      >
        {presets.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
      </select>
    </SettingsRow>
  );
}

function SamplingSubTab() {
  return (
    <div className="omp-settings-section">
      <NumberPreset
        settingKey="temperature"
        label="Temperature"
        description="Sampling temperature (-1 = provider default)"
        presets={[
          { value: -1, label: "Default" },
          { value: 0, label: "0 (Deterministic)" },
          { value: 0.2, label: "0.2 (Focused)" },
          { value: 0.5, label: "0.5 (Balanced)" },
          { value: 0.7, label: "0.7 (Creative)" },
          { value: 1, label: "1.0 (Maximum)" },
        ]}
      />
      <NumberPreset
        settingKey="topP"
        label="Top P"
        description="Nucleus sampling cutoff (-1 = provider default)"
        presets={[
          { value: -1, label: "Default" },
          { value: 0.1, label: "0.1" },
          { value: 0.3, label: "0.3" },
          { value: 0.5, label: "0.5" },
          { value: 0.9, label: "0.9" },
          { value: 1, label: "1.0" },
        ]}
      />
      <NumberPreset
        settingKey="topK"
        label="Top K"
        description="Sample from top-K tokens (-1 = provider default)"
        presets={[
          { value: -1, label: "Default" },
          { value: 1, label: "1 (Greedy)" },
          { value: 20, label: "20" },
          { value: 40, label: "40" },
          { value: 100, label: "100" },
        ]}
      />
      <NumberPreset
        settingKey="minP"
        label="Min P"
        description="Minimum probability threshold (-1 = provider default)"
        presets={[
          { value: -1, label: "Default" },
          { value: 0.01, label: "0.01" },
          { value: 0.05, label: "0.05" },
          { value: 0.1, label: "0.1" },
        ]}
      />
      <NumberPreset
        settingKey="presencePenalty"
        label="Presence Penalty"
        description="Penalty for already-present tokens (-1 = provider default)"
        presets={[
          { value: -1, label: "Default" },
          { value: 0, label: "0 (None)" },
          { value: 0.5, label: "0.5" },
          { value: 1, label: "1.0" },
          { value: 2, label: "2.0" },
        ]}
      />
      <NumberPreset
        settingKey="repetitionPenalty"
        label="Repetition Penalty"
        description="Penalty for repeated tokens (-1 = provider default)"
        presets={[
          { value: -1, label: "Default" },
          { value: 0.8, label: "0.8" },
          { value: 1, label: "1.0 (None)" },
          { value: 1.1, label: "1.1" },
          { value: 1.2, label: "1.2" },
          { value: 1.5, label: "1.5" },
        ]}
        last
      />
    </div>
  );
}

function RetriesSubTab() {
  const { config, draft, updateSetting } = useSettings();
  const get = (key: string) =>
    getSettingValue(draft as Record<string, unknown>, config as Record<string, unknown>, key);

  return (
    <div className="omp-settings-section">
      <SettingsRow title="Max Retries" description="Maximum retry attempts on API errors">
        <select
          className="omp-settings-select"
          value={String(get("retry.maxRetries") ?? 3)}
          onChange={(e) => updateSetting("retry.maxRetries", parseInt(e.target.value))}
        >
          <option value="1">1</option>
          <option value="2">2</option>
          <option value="3">3</option>
          <option value="5">5</option>
          <option value="10">10</option>
        </select>
      </SettingsRow>
      <SettingsRow
        title="Fallback Revert Policy"
        description="When to return to primary model after fallback"
        last
      >
        <select
          className="omp-settings-select"
          value={String(get("retry.fallbackRevertPolicy") ?? "cooldown-expiry")}
          onChange={(e) => updateSetting("retry.fallbackRevertPolicy", e.target.value)}
        >
          <option value="cooldown-expiry">Cooldown Expiry</option>
          <option value="never">Never</option>
        </select>
      </SettingsRow>
    </div>
  );
}

function ModelRoleValueEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const { modelRef, thinkingLevel } = splitThinkingSuffix(value);
  return (
    <div className="omp-settings-model-role-editor">
      <ModelReferencePicker
        value={modelRef}
        placeholder="Choose model"
        onChange={(nextModel) => onChange(joinThinkingSuffix(nextModel, thinkingLevel))}
      />
      <select
        className="omp-settings-select omp-settings-thinking-select"
        value={thinkingLevel}
        onChange={(event) => onChange(joinThinkingSuffix(modelRef, event.target.value))}
        disabled={!modelRef}
      >
        <option value="">Thinking: unset</option>
        {THINKING_LEVEL_OPTIONS.map((level) => (
          <option key={level} value={level}>
            {level}
          </option>
        ))}
      </select>
    </div>
  );
}

function RolesSubTab() {
  const { config, draft, updateSetting } = useSettings();

  // Get current values (draft overrides config)
  const getRoles = (): Record<string, string> => {
    const d = draft.modelRoles as Record<string, string> | undefined;
    const c = config.modelRoles as Record<string, string> | undefined;
    return d ?? c ?? {};
  };
  const getCycleOrder = (): string[] => {
    const d = draft.cycleOrder as string[] | undefined;
    const c = config.cycleOrder as string[] | undefined;
    return d ?? c ?? ["smol", "default", "slow"];
  };
  const getEnabledModels = (): string[] => {
    const d = draft.enabledModels as string[] | undefined;
    const c = config.enabledModels as string[] | undefined;
    return d ?? c ?? [];
  };

  const roles = getRoles();
  const cycleOrder = getCycleOrder();
  const enabledModels = getEnabledModels();

  // Role editing
  const updateRole = (roleName: string, modelValue: string) => {
    const updated = { ...roles, [roleName]: modelValue };
    updateSetting("modelRoles", updated);
  };

  const removeRole = (roleName: string) => {
    const updated = { ...roles };
    delete updated[roleName];
    updateSetting("modelRoles", updated);
  };

  const [newRoleName, setNewRoleName] = useState("");
  const addRole = () => {
    if (!newRoleName.trim()) return;
    const updated = { ...roles, [newRoleName.trim()]: "" };
    updateSetting("modelRoles", updated);
    setNewRoleName("");
  };

  // Cycle order editing
  const moveCycleItem = (index: number, direction: -1 | 1) => {
    const arr = [...cycleOrder];
    const newIdx = index + direction;
    if (newIdx < 0 || newIdx >= arr.length) return;
    [arr[index], arr[newIdx]] = [arr[newIdx], arr[index]];
    updateSetting("cycleOrder", arr);
  };

  const removeCycleItem = (index: number) => {
    updateSetting(
      "cycleOrder",
      cycleOrder.filter((_, i) => i !== index),
    );
  };

  const [newCycleRole, setNewCycleRole] = useState("");
  const addCycleItem = () => {
    if (!newCycleRole.trim()) return;
    updateSetting("cycleOrder", [...cycleOrder, newCycleRole.trim()]);
    setNewCycleRole("");
  };

  return (
    <div>
      {/* Model Roles Section */}
      <div className="omp-settings-section">
        <h3 className="omp-settings-section-title">Model Roles</h3>
        <p className="omp-settings-section-desc">
          Assign models to named roles for quick switching
        </p>
        <div className="omp-settings-roles-editor">
          {Object.entries(roles).map(([role, model]) => (
            <div key={role} className="omp-settings-role-edit-row">
              <span className="omp-settings-role-name">{role}</span>
              <ModelRoleValueEditor value={model} onChange={(value) => updateRole(role, value)} />
              <button
                className="omp-settings-icon-btn"
                onClick={() => removeRole(role)}
                title="Remove role"
              >
                <i className="codicon codicon-trash" />
              </button>
            </div>
          ))}
          <div className="omp-settings-role-add">
            <input
              type="text"
              className="omp-settings-input omp-settings-input--small"
              value={newRoleName}
              onChange={(e) => setNewRoleName(e.target.value)}
              placeholder="New role name"
              onKeyDown={(e) => e.key === "Enter" && addRole()}
            />
            <button className="omp-settings-btn-small" onClick={addRole}>
              Add Role
            </button>
          </div>
        </div>
      </div>

      {/* Cycle Order Section */}
      <div className="omp-settings-section">
        <h3 className="omp-settings-section-title">Cycle Order</h3>
        <p className="omp-settings-section-desc">Order when cycling roles with /cycle-roles</p>
        <div className="omp-settings-cycle-editor">
          {cycleOrder.map((role, i) => (
            <div key={`${role}-${i}`} className="omp-settings-cycle-edit-row">
              <span className="omp-settings-cycle-edit-name">{role}</span>
              <button
                className="omp-settings-icon-btn"
                onClick={() => moveCycleItem(i, -1)}
                disabled={i === 0}
                title="Move up"
              >
                <i className="codicon codicon-arrow-up" />
              </button>
              <button
                className="omp-settings-icon-btn"
                onClick={() => moveCycleItem(i, 1)}
                disabled={i === cycleOrder.length - 1}
                title="Move down"
              >
                <i className="codicon codicon-arrow-down" />
              </button>
              <button
                className="omp-settings-icon-btn"
                onClick={() => removeCycleItem(i)}
                title="Remove"
              >
                <i className="codicon codicon-close" />
              </button>
            </div>
          ))}
          <div className="omp-settings-role-add">
            <select
              className="omp-settings-select"
              value={newCycleRole}
              onChange={(e) => setNewCycleRole(e.target.value)}
            >
              <option value="">Add role to cycle...</option>
              {Object.keys(roles)
                .filter((r) => !cycleOrder.includes(r))
                .map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
            </select>
            <button
              className="omp-settings-btn-small"
              onClick={addCycleItem}
              disabled={!newCycleRole}
            >
              Add
            </button>
          </div>
        </div>
      </div>

      {/* Enabled Models Section */}
      <div className="omp-settings-section">
        <h3 className="omp-settings-section-title">Enabled Models</h3>
        <p className="omp-settings-section-desc">
          Models available for cycling (empty = all available)
        </p>
        <div className="omp-settings-enabled-models">
          {enabledModels.length === 0 ? (
            <p className="omp-settings-placeholder">All models enabled (no filter)</p>
          ) : (
            enabledModels.map((model, i) => (
              <div key={model} className="omp-settings-enabled-model-row">
                <span>{model}</span>
                <button
                  className="omp-settings-icon-btn"
                  onClick={() =>
                    updateSetting(
                      "enabledModels",
                      enabledModels.filter((_, idx) => idx !== i),
                    )
                  }
                  title="Remove"
                >
                  <i className="codicon codicon-close" />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
