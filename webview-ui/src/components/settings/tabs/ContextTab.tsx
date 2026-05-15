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

export function ContextTab() {
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

  const idleEnabled = getBool("compaction.idleEnabled", false);
  const ttsrEnabled = getBool("ttsr.enabled", true);
  const compactionStrategy = String(get("compaction.strategy") ?? "context-full");

  return (
    <div>
      {/* § Compaction */}
      <div className="omp-settings-section">
        <h3 className="omp-settings-section-title">Compaction</h3>
        <p className="omp-settings-section-desc">Context window compaction behavior</p>
        <SettingsRow title="Enabled" description="Enable context compaction">
          <input
            type="checkbox"
            className="omp-settings-toggle"
            checked={getBool("compaction.enabled", true)}
            onChange={(e) => updateSetting("compaction.enabled", e.target.checked)}
          />
        </SettingsRow>
        <SettingsRow title="Strategy" description="Compaction strategy to use">
          <select
            className="omp-settings-select"
            value={String(get("compaction.strategy") ?? "context-full")}
            onChange={(e) => updateSetting("compaction.strategy", e.target.value)}
          >
            <option value="context-full">Context Full</option>
            <option value="handoff">Handoff</option>
            <option value="off">Off</option>
          </select>
        </SettingsRow>
        <SettingsRow title="Threshold Percent" description="Context usage percent that triggers compaction">
          <select
            className="omp-settings-select"
            value={String(get("compaction.thresholdPercent") ?? -1)}
            onChange={(e) => updateSetting("compaction.thresholdPercent", Number(e.target.value))}
          >
            <option value="-1">Default</option>
            <option value="10">10%</option>
            <option value="20">20%</option>
            <option value="30">30%</option>
            <option value="40">40%</option>
            <option value="50">50%</option>
            <option value="60">60%</option>
            <option value="70">70%</option>
            <option value="75">75%</option>
            <option value="80">80%</option>
            <option value="85">85%</option>
            <option value="90">90%</option>
            <option value="95">95%</option>
          </select>
        </SettingsRow>
        <SettingsRow title="Threshold Tokens" description="Token count that triggers compaction">
          <select
            className="omp-settings-select"
            value={String(get("compaction.thresholdTokens") ?? -1)}
            onChange={(e) => updateSetting("compaction.thresholdTokens", Number(e.target.value))}
          >
            <option value="-1">Default</option>
            <option value="25000">25,000</option>
            <option value="50000">50,000</option>
            <option value="100000">100,000</option>
            <option value="150000">150,000</option>
            <option value="200000">200,000</option>
            <option value="300000">300,000</option>
            <option value="500000">500,000</option>
          </select>
        </SettingsRow>
        <SettingsRow title="Remote Enabled" description="Allow remote compaction service">
          <input
            type="checkbox"
            className="omp-settings-toggle"
            checked={getBool("compaction.remoteEnabled", true)}
            onChange={(e) => updateSetting("compaction.remoteEnabled", e.target.checked)}
          />
        </SettingsRow>
        {compactionStrategy === "handoff" && (
          <SettingsRow title="Handoff Save to Disk" description="Save handoff summaries to disk" last>
            <input
              type="checkbox"
              className="omp-settings-toggle"
              checked={!!get("compaction.handoffSaveToDisk")}
              onChange={(e) => updateSetting("compaction.handoffSaveToDisk", e.target.checked)}
            />
          </SettingsRow>
        )}
      </div>

      {/* § Idle Compaction */}
      <div className="omp-settings-section">
        <h3 className="omp-settings-section-title">Idle Compaction</h3>
        <p className="omp-settings-section-desc">Compact context during idle periods</p>
        <SettingsRow
          title="Idle Enabled"
          description="Enable compaction during idle"
          last={!idleEnabled}
        >
          <input
            type="checkbox"
            className="omp-settings-toggle"
            checked={idleEnabled}
            onChange={(e) => updateSetting("compaction.idleEnabled", e.target.checked)}
          />
        </SettingsRow>
        {idleEnabled && (
          <>
            <SettingsRow title="Idle Threshold Tokens" description="Token count for idle compaction">
              <select
                className="omp-settings-select"
                value={String(get("compaction.idleThresholdTokens") ?? 200000)}
                onChange={(e) => updateSetting("compaction.idleThresholdTokens", Number(e.target.value))}
              >
                <option value="100000">100,000</option>
                <option value="200000">200,000</option>
                <option value="300000">300,000</option>
                <option value="400000">400,000</option>
                <option value="500000">500,000</option>
                <option value="600000">600,000</option>
                <option value="700000">700,000</option>
                <option value="800000">800,000</option>
                <option value="900000">900,000</option>
              </select>
            </SettingsRow>
            <SettingsRow title="Idle Timeout" description="Seconds of idle before compaction triggers" last>
              <select
                className="omp-settings-select"
                value={String(get("compaction.idleTimeoutSeconds") ?? 300)}
                onChange={(e) => updateSetting("compaction.idleTimeoutSeconds", Number(e.target.value))}
              >
                <option value="60">60s</option>
                <option value="120">120s</option>
                <option value="300">300s</option>
                <option value="600">600s</option>
                <option value="1800">1800s</option>
                <option value="3600">3600s</option>
              </select>
            </SettingsRow>
          </>
        )}
      </div>

      {/* § Context Promotion */}
      <div className="omp-settings-section">
        <h3 className="omp-settings-section-title">Context Promotion</h3>
        <p className="omp-settings-section-desc">Promote context across sessions</p>
        <SettingsRow title="Enabled" description="Enable context promotion" last>
          <input
            type="checkbox"
            className="omp-settings-toggle"
            checked={getBool("contextPromotion.enabled", true)}
            onChange={(e) => updateSetting("contextPromotion.enabled", e.target.checked)}
          />
        </SettingsRow>
      </div>

      {/* § TTSR */}
      <div className="omp-settings-section">
        <h3 className="omp-settings-section-title">TTSR</h3>
        <p className="omp-settings-section-desc">Turn-taking and system reminder settings</p>
        <SettingsRow title="Enabled" description="Enable TTSR" last={!ttsrEnabled}>
          <input
            type="checkbox"
            className="omp-settings-toggle"
            checked={ttsrEnabled}
            onChange={(e) => updateSetting("ttsr.enabled", e.target.checked)}
          />
        </SettingsRow>
        {ttsrEnabled && (
          <>
            <SettingsRow title="Context Mode" description="How TTSR handles context">
              <select
                className="omp-settings-select"
                value={String(get("ttsr.contextMode") ?? "discard")}
                onChange={(e) => updateSetting("ttsr.contextMode", e.target.value)}
              >
                <option value="discard">Discard</option>
                <option value="keep">Keep</option>
              </select>
            </SettingsRow>
            <SettingsRow title="Interrupt Mode" description="When TTSR interrupts">
              <select
                className="omp-settings-select"
                value={String(get("ttsr.interruptMode") ?? "always")}
                onChange={(e) => updateSetting("ttsr.interruptMode", e.target.value)}
              >
                <option value="never">Never</option>
                <option value="prose-only">Prose Only</option>
                <option value="tool-only">Tool Only</option>
                <option value="always">Always</option>
              </select>
            </SettingsRow>
            <SettingsRow title="Repeat Mode" description="How TTSR reminders repeat">
              <select
                className="omp-settings-select"
                value={String(get("ttsr.repeatMode") ?? "once")}
                onChange={(e) => updateSetting("ttsr.repeatMode", e.target.value)}
              >
                <option value="once">Once</option>
                <option value="after-gap">After Gap</option>
              </select>
            </SettingsRow>
            <SettingsRow title="Repeat Gap" description="Turns between repeated reminders" last>
              <select
                className="omp-settings-select"
                value={String(get("ttsr.repeatGap") ?? 10)}
                onChange={(e) => updateSetting("ttsr.repeatGap", Number(e.target.value))}
              >
                <option value="5">5</option>
                <option value="10">10</option>
                <option value="15">15</option>
                <option value="20">20</option>
                <option value="30">30</option>
              </select>
            </SettingsRow>
          </>
        )}
      </div>

      {/* § Branch Summaries */}
      <div className="omp-settings-section">
        <h3 className="omp-settings-section-title">Branch Summaries</h3>
        <p className="omp-settings-section-desc">Summarize context at branch points</p>
        <SettingsRow title="Enabled" description="Enable branch summaries" last>
          <input
            type="checkbox"
            className="omp-settings-toggle"
            checked={!!get("branchSummary.enabled")}
            onChange={(e) => updateSetting("branchSummary.enabled", e.target.checked)}
          />
        </SettingsRow>
      </div>
    </div>
  );
}
