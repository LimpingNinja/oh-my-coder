import { useSettings } from "../SettingsContext";
import { SettingsRow } from "../SettingsRow";

const resolveKey = (source: Record<string, unknown>, key: string): unknown => {
  const parts = key.split(".");
  let cur: unknown = source;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
};

const getSettingValue = (
  draft: Record<string, unknown>,
  config: Record<string, unknown>,
  key: string
): unknown => {
  if (key in draft) return draft[key];
  const draftVal = resolveKey(draft, key);
  if (draftVal !== undefined) return draftVal;
  if (key in config) return config[key];
  return resolveKey(config, key);
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface ToolToggle {
  key: string;
  label: string;
  description: string;
  defaultValue: boolean;
}

const TOOL_TOGGLES: ToolToggle[] = [
  { key: "find.enabled", label: "Find", description: "File search by name or glob", defaultValue: true },
  { key: "search.enabled", label: "Search", description: "Regex content search", defaultValue: true },
  { key: "astGrep.enabled", label: "AST Grep", description: "Structural code search", defaultValue: true },
  { key: "astEdit.enabled", label: "AST Edit", description: "Structural code rewrites", defaultValue: true },
  { key: "irc.enabled", label: "IRC", description: "Agent-to-agent messaging", defaultValue: true },
  { key: "notebook.enabled", label: "Notebook", description: "Notebook inspection and editing", defaultValue: true },
  { key: "fetch.enabled", label: "Fetch URLs", description: "Fetch and read URL content", defaultValue: true },
  { key: "web_search.enabled", label: "Web Search", description: "Internet search tool", defaultValue: true },
  { key: "browser.enabled", label: "Browser", description: "Browser automation", defaultValue: true },
  { key: "github.enabled", label: "GitHub CLI", description: "GitHub operations", defaultValue: false },
  { key: "renderMermaid.enabled", label: "Mermaid", description: "Mermaid diagram rendering", defaultValue: false },
  { key: "debug.enabled", label: "Debug", description: "Debugger integration", defaultValue: true },
  { key: "calc.enabled", label: "Calculator", description: "Expression evaluation", defaultValue: false },
  { key: "recipe.enabled", label: "Recipe", description: "Task runner integration", defaultValue: true },
  { key: "inspect_image.enabled", label: "Inspect Image", description: "Image inspection with vision", defaultValue: false },
  { key: "checkpoint.enabled", label: "Checkpoint", description: "Checkpoint and rewind support", defaultValue: false },
];

export function ToolsTab() {
  const { config, draft, updateSetting } = useSettings();

  const get = (key: string): string | boolean | number | undefined =>
    getSettingValue(
      draft as Record<string, unknown>,
      config as Record<string, unknown>,
      key
    ) as string | boolean | number | undefined;

  const toggle = (key: string, defaultValue: boolean): boolean =>
    (get(key) ?? defaultValue) as boolean;

  const select = (key: string, defaultValue: string | number): string =>
    String(get(key) ?? defaultValue);

  // Conditional visibility flags
  const todoEnabled = toggle("todo.enabled", true);
  const todoReminders = toggle("todo.reminders", true);
  const asyncEnabled = toggle("async.enabled", false);
  const browserEnabled = toggle("browser.enabled", true);

  return (
    <div>
      {/* § Tool Toggles */}
      <div className="omp-settings-section">
        <h3 className="omp-settings-section-title">Tool Toggles</h3>
        <p className="omp-settings-section-desc">Enable or disable individual tools</p>
        <div className="omp-settings-toggle-grid">
          {TOOL_TOGGLES.map((t) => (
            <label key={t.key} className="omp-settings-toggle-cell" title={t.description}>
              <input
                type="checkbox"
                className="omp-settings-toggle"
                checked={toggle(t.key, t.defaultValue)}
                onChange={(e) => updateSetting(t.key, e.target.checked)}
              />
              <span>{t.label}</span>
            </label>
          ))}
        </div>
      </div>

      {/* § Task Tracking */}
      <div className="omp-settings-section">
        <h3 className="omp-settings-section-title">Task Tracking</h3>
        <p className="omp-settings-section-desc">TODO list and task reminder behavior</p>
        <SettingsRow title="TODO Enabled" description="Enable the TODO tracking system">
          <input
            type="checkbox"
            className="omp-settings-toggle"
            checked={toggle("todo.enabled", true)}
            onChange={(e) => updateSetting("todo.enabled", e.target.checked)}
          />
        </SettingsRow>
        <SettingsRow title="TODO Reminders" description="Inject reminders of open TODOs">
          <input
            type="checkbox"
            className="omp-settings-toggle"
            checked={toggle("todo.reminders", true)}
            onChange={(e) => updateSetting("todo.reminders", e.target.checked)}
          />
        </SettingsRow>
        {todoReminders && (
          <SettingsRow title="Max Reminders" description="Maximum concurrent TODO reminders shown">
            <select
              className="omp-settings-select"
              value={select("todo.reminders.max", 3)}
              onChange={(e) => updateSetting("todo.reminders.max", Number(e.target.value))}
            >
              <option value="1">1</option>
              <option value="2">2</option>
              <option value="3">3</option>
              <option value="5">5</option>
            </select>
          </SettingsRow>
        )}
        <SettingsRow title="TODO Eager" description="Proactively create TODOs from conversation" last>
          <input
            type="checkbox"
            className="omp-settings-toggle"
            checked={toggle("todo.eager", false)}
            onChange={(e) => updateSetting("todo.eager", e.target.checked)}
          />
        </SettingsRow>
      </div>

      {/* § Artifact Thresholds */}
      <div className="omp-settings-section">
        <h3 className="omp-settings-section-title">Artifact Thresholds</h3>
        <p className="omp-settings-section-desc">Artifact spill and tail behavior</p>
        <SettingsRow title="Spill Threshold (KB)" description="Size in KB before output spills to artifact">
          <select
            className="omp-settings-select"
            value={select("tools.artifactSpillThreshold", 50)}
            onChange={(e) => updateSetting("tools.artifactSpillThreshold", Number(e.target.value))}
          >
            <option value="1">1</option>
            <option value="2.5">2.5</option>
            <option value="5">5</option>
            <option value="10">10</option>
            <option value="20">20</option>
            <option value="30">30</option>
            <option value="50">50</option>
            <option value="75">75</option>
            <option value="100">100</option>
            <option value="200">200</option>
            <option value="500">500</option>
            <option value="1000">1000</option>
          </select>
        </SettingsRow>
        <SettingsRow title="Tail Bytes (KB)" description="Bytes to keep from tail of spilled artifact">
          <select
            className="omp-settings-select"
            value={select("tools.artifactTailBytes", 20)}
            onChange={(e) => updateSetting("tools.artifactTailBytes", Number(e.target.value))}
          >
            <option value="1">1</option>
            <option value="2.5">2.5</option>
            <option value="5">5</option>
            <option value="10">10</option>
            <option value="20">20</option>
            <option value="50">50</option>
            <option value="100">100</option>
            <option value="200">200</option>
          </select>
        </SettingsRow>
        <SettingsRow title="Tail Lines" description="Lines to keep from tail of spilled artifact" last>
          <select
            className="omp-settings-select"
            value={select("tools.artifactTailLines", 500)}
            onChange={(e) => updateSetting("tools.artifactTailLines", Number(e.target.value))}
          >
            <option value="50">50</option>
            <option value="100">100</option>
            <option value="250">250</option>
            <option value="500">500</option>
            <option value="1000">1000</option>
            <option value="2500">2500</option>
            <option value="5000">5000</option>
          </select>
        </SettingsRow>
      </div>

      {/* § Tool Execution */}
      <div className="omp-settings-section">
        <h3 className="omp-settings-section-title">Tool Execution</h3>
        <p className="omp-settings-section-desc">Execution limits and tracing behavior</p>
        <SettingsRow title="Intent Tracing" description="Include intent annotations in tool calls">
          <input
            type="checkbox"
            className="omp-settings-toggle"
            checked={toggle("tools.intentTracing", true)}
            onChange={(e) => updateSetting("tools.intentTracing", e.target.checked)}
          />
        </SettingsRow>
        <SettingsRow title="Max Timeout (s)" description="Global tool timeout cap. 0 means no limit." last>
          <select
            className="omp-settings-select"
            value={select("tools.maxTimeout", 0)}
            onChange={(e) => updateSetting("tools.maxTimeout", Number(e.target.value))}
          >
            <option value="0">No limit</option>
            <option value="30">30</option>
            <option value="60">60</option>
            <option value="120">120</option>
            <option value="300">300</option>
            <option value="600">600</option>
          </select>
        </SettingsRow>
      </div>

      {/* § Async & Background */}
      <div className="omp-settings-section">
        <h3 className="omp-settings-section-title">Async &amp; Background</h3>
        <p className="omp-settings-section-desc">Background execution and async polling</p>
        <SettingsRow title="Async Enabled" description="Allow asynchronous tool execution">
          <input
            type="checkbox"
            className="omp-settings-toggle"
            checked={toggle("async.enabled", false)}
            onChange={(e) => updateSetting("async.enabled", e.target.checked)}
          />
        </SettingsRow>
        {asyncEnabled && (
          <SettingsRow title="Poll Wait Duration" description="How long to wait between async polls">
            <select
              className="omp-settings-select"
              value={select("async.pollWaitDuration", "30s")}
              onChange={(e) => updateSetting("async.pollWaitDuration", e.target.value)}
            >
              <option value="5s">5s</option>
              <option value="10s">10s</option>
              <option value="30s">30s</option>
              <option value="1m">1m</option>
              <option value="5m">5m</option>
            </select>
          </SettingsRow>
        )}
        <SettingsRow title="Bash Auto Background" description="Automatically background long-running shell commands" last>
          <input
            type="checkbox"
            className="omp-settings-toggle"
            checked={toggle("bash.autoBackground.enabled", false)}
            onChange={(e) => updateSetting("bash.autoBackground.enabled", e.target.checked)}
          />
        </SettingsRow>
      </div>

      {/* § Browser (conditional on browser.enabled) */}
      {browserEnabled && (
        <div className="omp-settings-section">
          <h3 className="omp-settings-section-title">Browser</h3>
          <p className="omp-settings-section-desc">Browser tool configuration</p>
          <SettingsRow title="Headless" description="Run browser in headless mode">
            <input
              type="checkbox"
              className="omp-settings-toggle"
              checked={toggle("browser.headless", true)}
              onChange={(e) => updateSetting("browser.headless", e.target.checked)}
            />
          </SettingsRow>
          <SettingsRow title="Screenshot Directory" description="Directory for saved screenshots (empty for default)" last>
            <input
              type="text"
              className="omp-settings-input"
              value={String(get("browser.screenshotDir") ?? "")}
              placeholder="Default"
              onChange={(e) => updateSetting("browser.screenshotDir", e.target.value || null)}
            />
          </SettingsRow>
        </div>
      )}

      {/* § Search Context */}
      <div className="omp-settings-section">
        <h3 className="omp-settings-section-title">Search Context</h3>
        <p className="omp-settings-section-desc">Context lines around search matches</p>
        <SettingsRow title="Context Before" description="Lines of context before each match">
          <select
            className="omp-settings-select"
            value={select("search.contextBefore", 1)}
            onChange={(e) => updateSetting("search.contextBefore", Number(e.target.value))}
          >
            <option value="0">0</option>
            <option value="1">1</option>
            <option value="2">2</option>
            <option value="3">3</option>
            <option value="4">4</option>
            <option value="5">5</option>
          </select>
        </SettingsRow>
        <SettingsRow title="Context After" description="Lines of context after each match" last>
          <select
            className="omp-settings-select"
            value={select("search.contextAfter", 3)}
            onChange={(e) => updateSetting("search.contextAfter", Number(e.target.value))}
          >
            <option value="0">0</option>
            <option value="1">1</option>
            <option value="2">2</option>
            <option value="3">3</option>
            <option value="5">5</option>
            <option value="10">10</option>
          </select>
        </SettingsRow>
      </div>


      {/* § Marketplace */}
      <div className="omp-settings-section">
        <h3 className="omp-settings-section-title">Marketplace</h3>
        <p className="omp-settings-section-desc">Tool marketplace settings</p>
        <SettingsRow title="Auto Update" description="How marketplace tools are updated" last>
          <select
            className="omp-settings-select"
            value={select("marketplace.autoUpdate", "notify")}
            onChange={(e) => updateSetting("marketplace.autoUpdate", e.target.value)}
          >
            <option value="off">Off</option>
            <option value="notify">Notify</option>
            <option value="auto">Auto</option>
          </select>
        </SettingsRow>
      </div>

      {/* § Dev */}
      <div className="omp-settings-section">
        <h3 className="omp-settings-section-title">Dev</h3>
        <p className="omp-settings-section-desc">Developer and debugging options</p>
        <SettingsRow title="Auto QA" description="Automatically run QA checks after agent responses" last>
          <input
            type="checkbox"
            className="omp-settings-toggle"
            checked={toggle("dev.autoqa", false)}
            onChange={(e) => updateSetting("dev.autoqa", e.target.checked)}
          />
        </SettingsRow>
      </div>
    </div>
  );
}
