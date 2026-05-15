import { useSettings } from "../SettingsContext";
import { SettingsRow } from "../SettingsRow";

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
  key: string
): unknown => {
  // Flat dot-path key in draft takes priority (set by updateSetting)
  if (key in draft) return draft[key];
  const draftNestedValue = resolveKey(draft, key);
  if (draftNestedValue !== undefined) return draftNestedValue;
  if (key in config) return config[key];
  return resolveKey(config, key);
};

export function MemoryTab() {
  const { config, draft, updateSetting } = useSettings();

  const get = (key: string): string | boolean | number | undefined =>
    getSettingValue(draft as Record<string, unknown>, config as Record<string, unknown>, key) as
      | string
      | boolean
      | number
      | undefined;

  const getBool = (key: string, defaultValue: boolean): boolean => {
    const v = get(key);
    if (typeof v === "boolean") return v;
    return defaultValue;
  };

  const backend = String(get("memory.backend") ?? "off");

  return (
    <div>
      {/* § Backend */}
      <div className="omp-settings-section">
        <h3 className="omp-settings-section-title">Backend</h3>
        <p className="omp-settings-section-desc">Memory storage backend</p>
        <SettingsRow title="Backend" description="Memory backend to use" last>
          <select
            className="omp-settings-select"
            value={backend}
            onChange={(e) => updateSetting("memory.backend", e.target.value)}
          >
            <option value="off">Off</option>
            <option value="local">Local</option>
            <option value="hindsight">Hindsight</option>
          </select>
        </SettingsRow>
      </div>

      {/* § Hindsight Configuration — conditional */}
      {backend === "hindsight" && (
        <div className="omp-settings-section">
          <h3 className="omp-settings-section-title">Hindsight Configuration</h3>
          <p className="omp-settings-section-desc">Hindsight memory service configuration</p>
          <SettingsRow title="API URL" description="Hindsight server URL">
            <input
              type="text"
              className="omp-settings-input"
              value={String(get("hindsight.apiUrl") ?? "http://localhost:8888")}
              onChange={(e) => updateSetting("hindsight.apiUrl", e.target.value || null)}
              placeholder="http://localhost:8888"
            />
          </SettingsRow>
          <SettingsRow title="Bank ID" description="Memory bank identifier">
            <input
              type="text"
              className="omp-settings-input"
              value={String(get("hindsight.bankId") ?? "")}
              onChange={(e) => updateSetting("hindsight.bankId", e.target.value || null)}
              placeholder="default"
            />
          </SettingsRow>
          <SettingsRow title="Scoping" description="Memory isolation model">
            <select
              className="omp-settings-select"
              value={String(get("hindsight.scoping") ?? "per-project-tagged")}
              onChange={(e) => updateSetting("hindsight.scoping", e.target.value)}
            >
              <option value="global">Global</option>
              <option value="per-project">Per Project</option>
              <option value="per-project-tagged">Per Project Tagged</option>
            </select>
          </SettingsRow>
          <SettingsRow title="Auto Recall" description="Recall memories on first turn">
            <input
              type="checkbox"
              className="omp-settings-toggle"
              checked={getBool("hindsight.autoRecall", true)}
              onChange={(e) => updateSetting("hindsight.autoRecall", e.target.checked)}
            />
          </SettingsRow>
          <SettingsRow title="Auto Retain" description="Retain session content at intervals">
            <input
              type="checkbox"
              className="omp-settings-toggle"
              checked={getBool("hindsight.autoRetain", true)}
              onChange={(e) => updateSetting("hindsight.autoRetain", e.target.checked)}
            />
          </SettingsRow>
          <SettingsRow title="Retain Mode" description="Retention strategy">
            <select
              className="omp-settings-select"
              value={String(get("hindsight.retainMode") ?? "full-session")}
              onChange={(e) => updateSetting("hindsight.retainMode", e.target.value)}
            >
              <option value="full-session">Full Session</option>
              <option value="last-turn">Last Turn</option>
            </select>
          </SettingsRow>
          <SettingsRow title="Mental Models" description="Load mental models at boot">
            <input
              type="checkbox"
              className="omp-settings-toggle"
              checked={getBool("hindsight.mentalModelsEnabled", true)}
              onChange={(e) => updateSetting("hindsight.mentalModelsEnabled", e.target.checked)}
            />
          </SettingsRow>
          <SettingsRow title="Auto Seed Mental Models" description="Auto-create built-in mental models" last>
            <input
              type="checkbox"
              className="omp-settings-toggle"
              checked={getBool("hindsight.mentalModelAutoSeed", true)}
              onChange={(e) => updateSetting("hindsight.mentalModelAutoSeed", e.target.checked)}
            />
          </SettingsRow>
        </div>
      )}

      {/* § Local Memory — conditional */}
      {backend === "local" && (
        <div className="omp-settings-section">
          <h3 className="omp-settings-section-title">Local Memory</h3>
          <p className="omp-settings-section-desc">
            Local memory stores conversation summaries on disk. No additional configuration
            required.
          </p>
        </div>
      )}

      {/* Footer note */}
      <p className="omp-settings-footer-note">
        Memory backend changes require a session restart.
      </p>
    </div>
  );
}
