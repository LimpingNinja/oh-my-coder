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

interface DiscoveredMcpServer {
  name: string;
  type: "stdio" | "http" | "sse";
  status: "configured" | "connected" | "disconnected" | "error";
  enabled: boolean;
  source: string;
  sourcePath: string;
  config: {
    command?: string;
    url?: string;
    args?: string[];
  };
}

const SUB_TABS = ["Discovery", "Settings"] as const;
type SubTab = (typeof SUB_TABS)[number];

const STATUS_COLORS: Record<string, string> = {
  configured: "var(--omp-success, #4ec9b0)",
  connected: "var(--omp-success, #4ec9b0)",
  disconnected: "var(--vscode-editorWarning-foreground, #cca700)",
  error: "var(--omp-error, #f44747)",
};

export function McpTab() {
  const [subTab, setSubTab] = useState<SubTab>("Discovery");
  const { config, draft, updateSetting } = useSettings();
  const mcpServers = ((useSettings() as Record<string, unknown>).mcpServers ?? []) as DiscoveredMcpServer[];

  const get = (key: string) =>
    getSettingValue(draft as Record<string, unknown>, config as Record<string, unknown>, key);

  const getBool = (key: string, defaultValue: boolean): boolean =>
    (get(key) ?? defaultValue) as boolean;

  const notificationsEnabled = getBool("mcp.notifications", false);

  return (
    <div>
      <div className="omp-settings-subtabs">
        {SUB_TABS.map((tab) => (
          <button
            key={tab}
            className={`omp-settings-subtab${subTab === tab ? " omp-settings-subtab--active" : ""}`}
            onClick={() => setSubTab(tab)}
          >
            {tab}
          </button>
        ))}
      </div>
      <div className="omp-settings-subtab-content">
        {subTab === "Discovery" && (
          <div>
            <div className="omp-settings-section">
              <h3 className="omp-settings-section-title">Discovered Servers</h3>
              {mcpServers.length === 0 ? (
                <p className="omp-settings-section-desc">
                  No MCP servers detected. Servers will appear when .mcp.json or config.yml mcpServers are found.
                </p>
              ) : (
                <div className="omp-mcp-server-list">
                  {mcpServers.map((server) => (
                    <McpServerCard key={`${server.name}-${server.sourcePath}`} server={server} />
                  ))}
                </div>
              )}
            </div>
            <p className="omp-settings-footer-note">
              Server connection status requires a running session.
            </p>
            <div className="omp-settings-footer">
              <button
                className="omp-settings-btn-small"
                onClick={() => getVSCodeAPI().postMessage({ type: "settings.openConfigFile" })}
              >
                Open Config File
              </button>
            </div>
          </div>
        )}
        {subTab === "Settings" && (
          <div className="omp-settings-section">
            <SettingsRow
              title="Project Config"
              description="Load .mcp.json from the project root"
            >
              <input
                type="checkbox"
                className="omp-settings-toggle"
                checked={getBool("mcp.enableProjectConfig", true)}
                onChange={(e) => updateSetting("mcp.enableProjectConfig", e.target.checked)}
              />
            </SettingsRow>
            <SettingsRow
              title="Discovery Mode"
              description="Hide MCP tools behind discovery mode"
            >
              <input
                type="checkbox"
                className="omp-settings-toggle"
                checked={getBool("mcp.discoveryMode", false)}
                onChange={(e) => updateSetting("mcp.discoveryMode", e.target.checked)}
              />
            </SettingsRow>
            <SettingsRow
              title="Notifications"
              description="Inject MCP resource update notifications"
              last={!notificationsEnabled}
            >
              <input
                type="checkbox"
                className="omp-settings-toggle"
                checked={notificationsEnabled}
                onChange={(e) => updateSetting("mcp.notifications", e.target.checked)}
              />
            </SettingsRow>
            {notificationsEnabled && (
              <SettingsRow
                title="Notification Debounce (ms)"
                description="Debounce window for MCP notifications"
                last
              >
                <select
                  className="omp-settings-select"
                  value={String(get("mcp.notificationDebounceMs") ?? 500)}
                  onChange={(e) =>
                    updateSetting("mcp.notificationDebounceMs", parseInt(e.target.value))
                  }
                >
                  <option value="100">100</option>
                  <option value="250">250</option>
                  <option value="500">500</option>
                  <option value="1000">1000</option>
                  <option value="2000">2000</option>
                </select>
              </SettingsRow>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function McpServerCard({ server }: { server: DiscoveredMcpServer }) {
  const [hovered, setHovered] = useState(false);
  const statusColor = STATUS_COLORS[server.status] ?? STATUS_COLORS.configured;
  const displayCommand = server.config.command
    ? [server.config.command, ...(server.config.args ?? [])].join(" ")
    : server.config.url ?? "";

  return (
    <div
      className="omp-mcp-server-card"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="omp-mcp-server-card-top">
        <span className="omp-mcp-server-card-name">{server.name}</span>
        <span className={`omp-skill-badge omp-skill-badge--${server.type}`}>
          {server.type.toUpperCase()}
        </span>
        <span className="omp-mcp-server-status">
          <span
            className="omp-provider-status-dot"
            style={{ background: statusColor }}
          />
          <span className="omp-provider-status-label">{server.status}</span>
        </span>
        {hovered && (
          <button
            className="omp-settings-btn-small"
            onClick={() => getVSCodeAPI().postMessage({ type: "settings.openConfigFile" })}
          >
            Open Config
          </button>
        )}
      </div>
      <div className="omp-mcp-server-card-meta">
        <span className="omp-mcp-server-source">{server.source}</span>
      </div>
      {displayCommand && (
        <div className="omp-mcp-server-card-command">{displayCommand}</div>
      )}
    </div>
  );
}
