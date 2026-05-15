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
  if (key in draft) return draft[key];
  const draftNestedValue = resolveKey(draft, key);
  if (draftNestedValue !== undefined) return draftNestedValue;
  if (key in config) return config[key];
  return resolveKey(config, key);
};

export function InteractionTab() {
  const { config, draft, updateSetting } = useSettings();
  const get = (key: string) =>
    getSettingValue(draft as Record<string, unknown>, config as Record<string, unknown>, key) as
      | string
      | boolean
      | number
      | undefined;


  const getBool = (key: string, defaultValue: boolean): boolean => {
    const value = get(key);
    return typeof value === "boolean" ? value : defaultValue;
  };

  const sttEnabled = getBool("stt.enabled", false);

  return (
    <div>
      {/* § Conversation Flow */}
      <div className="omp-settings-section">
        <h3 className="omp-settings-section-title">Conversation Flow</h3>
        <p className="omp-settings-section-desc">
          How messages are queued and delivered during streaming
        </p>
        <SettingsRow title="Steering Mode" description="How steering messages are dispatched">
          <select
            className="omp-settings-select"
            value={String(get("steeringMode") ?? "one-at-a-time")}
            onChange={(e) => updateSetting("steeringMode", e.target.value)}
          >
            <option value="all">All</option>
            <option value="one-at-a-time">One at a time</option>
          </select>
        </SettingsRow>
        <SettingsRow title="Follow-Up Mode" description="How follow-up messages are dispatched">
          <select
            className="omp-settings-select"
            value={String(get("followUpMode") ?? "one-at-a-time")}
            onChange={(e) => updateSetting("followUpMode", e.target.value)}
          >
            <option value="all">All</option>
            <option value="one-at-a-time">One at a time</option>
          </select>
        </SettingsRow>
        <SettingsRow title="Interrupt Mode" description="When to interrupt a running stream">
          <select
            className="omp-settings-select"
            value={String(get("interruptMode") ?? "immediate")}
            onChange={(e) => updateSetting("interruptMode", e.target.value)}
          >
            <option value="immediate">Immediate</option>
            <option value="wait">Wait</option>
          </select>
        </SettingsRow>
        <SettingsRow title="Loop Mode" description="Behavior when the agent completes a loop">
          <select
            className="omp-settings-select"
            value={String(get("loop.mode") ?? "prompt")}
            onChange={(e) => updateSetting("loop.mode", e.target.value)}
          >
            <option value="prompt">Prompt</option>
            <option value="compact">Compact</option>
            <option value="reset">Reset</option>
          </select>
        </SettingsRow>
        <SettingsRow title="Double-Escape Action" description="Action when pressing Escape twice with empty input" last>
          <select
            className="omp-settings-select"
            value={String(get("doubleEscapeAction") ?? "tree")}
            onChange={(e) => updateSetting("doubleEscapeAction", e.target.value)}
          >
            <option value="branch">Branch</option>
            <option value="tree">Tree</option>
            <option value="none">None</option>
          </select>
        </SettingsRow>
      </div>

      {/* § Startup */}
      <div className="omp-settings-section">
        <h3 className="omp-settings-section-title">Startup</h3>
        <p className="omp-settings-section-desc">Behavior on session initialization</p>
        <SettingsRow title="Auto Resume" description="Resume previous session on startup">
          <input
            type="checkbox"
            className="omp-settings-toggle"
            checked={!!get("autoResume")}
            onChange={(e) => updateSetting("autoResume", e.target.checked)}
          />
        </SettingsRow>
        <SettingsRow title="Quiet Startup" description="Suppress startup banner messages">
          <input
            type="checkbox"
            className="omp-settings-toggle"
            checked={!!get("startup.quiet")}
            onChange={(e) => updateSetting("startup.quiet", e.target.checked)}
          />
        </SettingsRow>
        <SettingsRow title="Check for Updates" description="Check for new versions on startup">
          <input
            type="checkbox"
            className="omp-settings-toggle"
            checked={getBool("startup.checkUpdate", true)}
            onChange={(e) => updateSetting("startup.checkUpdate", e.target.checked)}
          />
        </SettingsRow>
        <SettingsRow title="Collapse Changelog" description="Show condensed changelog after updates" last>
          <input
            type="checkbox"
            className="omp-settings-toggle"
            checked={getBool("collapseChangelog", false)}
            onChange={(e) => updateSetting("collapseChangelog", e.target.checked)}
          />
        </SettingsRow>
      </div>

      {/* § Notifications */}
      <div className="omp-settings-section">
        <h3 className="omp-settings-section-title">Notifications</h3>
        <p className="omp-settings-section-desc">Alerts and timeout behavior</p>
        <SettingsRow title="Completion Notify" description="Notify when a task completes">
          <select
            className="omp-settings-select"
            value={String(get("completion.notify") ?? "on")}
            onChange={(e) => updateSetting("completion.notify", e.target.value)}
          >
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
        </SettingsRow>
        <SettingsRow title="Ask Timeout" description="Seconds before an ask prompt times out">
          <select
            className="omp-settings-select"
            value={String(get("ask.timeout") ?? 30)}
            onChange={(e) => updateSetting("ask.timeout", Number(e.target.value))}
          >
            <option value="0">Disabled</option>
            <option value="15">15s</option>
            <option value="30">30s</option>
            <option value="60">60s</option>
            <option value="120">120s</option>
          </select>
        </SettingsRow>
        <SettingsRow title="Ask Notify" description="Notify when a prompt requires input" last>
          <select
            className="omp-settings-select"
            value={String(get("ask.notify") ?? "on")}
            onChange={(e) => updateSetting("ask.notify", e.target.value)}
          >
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
        </SettingsRow>
      </div>

      {/* § Input */}
      <div className="omp-settings-section">
        <h3 className="omp-settings-section-title">Input</h3>
        <p className="omp-settings-section-desc">Autocomplete and input behavior</p>
        <SettingsRow
          title="Autocomplete Max Visible"
          description="Maximum number of autocomplete suggestions shown"
        >
          <select
            className="omp-settings-select"
            value={String(get("autocompleteMaxVisible") ?? 5)}
            onChange={(e) => updateSetting("autocompleteMaxVisible", Number(e.target.value))}
          >
            <option value="3">3</option>
            <option value="5">5</option>
            <option value="7">7</option>
            <option value="10">10</option>
            <option value="15">15</option>
            <option value="20">20</option>
          </select>
        </SettingsRow>
        <SettingsRow title="Session Tree Filter" description="Default filter mode when opening the session tree" last>
          <select
            className="omp-settings-select"
            value={String(get("treeFilterMode") ?? "default")}
            onChange={(e) => updateSetting("treeFilterMode", e.target.value)}
          >
            <option value="default">Default</option>
            <option value="no-tools">No tools</option>
            <option value="user-only">User only</option>
            <option value="labeled-only">Labeled only</option>
            <option value="all">All</option>
          </select>
        </SettingsRow>
      </div>

      {/* § Speech */}
      <div className="omp-settings-section">
        <h3 className="omp-settings-section-title">Speech</h3>
        <p className="omp-settings-section-desc">Speech-to-text input configuration</p>
        <SettingsRow title="Speech-to-Text" description="Enable speech-to-text input via microphone" last={!sttEnabled}>
          <input
            type="checkbox"
            className="omp-settings-toggle"
            checked={sttEnabled}
            onChange={(e) => updateSetting("stt.enabled", e.target.checked)}
          />
        </SettingsRow>
        {sttEnabled && (
          <SettingsRow title="Speech Model" description="Whisper model size" last>
            <select
              className="omp-settings-select"
              value={String(get("stt.modelName") ?? "base.en")}
              onChange={(e) => updateSetting("stt.modelName", e.target.value)}
            >
              <option value="tiny">tiny</option>
              <option value="tiny.en">tiny.en</option>
              <option value="base">base</option>
              <option value="base.en">base.en</option>
              <option value="small">small</option>
              <option value="small.en">small.en</option>
              <option value="medium">medium</option>
              <option value="medium.en">medium.en</option>
              <option value="large">large</option>
            </select>
          </SettingsRow>
        )}
      </div>
    </div>
  );
}
