import { useState } from "react";
import { getVSCodeAPI } from "../../../vscode";
import { useSettings, type DiscoveredMcpServer } from "../SettingsContext";
import { SettingsRow } from "../SettingsRow";
import { DeleteConfirmOverlay } from "../DeleteConfirmOverlay";

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


const SUB_TABS = ["Discovery", "Settings"] as const;
type SubTab = (typeof SUB_TABS)[number];

const STATUS_COLORS: Record<string, string> = {
  configured: "var(--omp-success, #4ec9b0)",
  connected: "var(--omp-success, #4ec9b0)",
  disconnected: "var(--vscode-editorWarning-foreground, #cca700)",
  error: "var(--omp-error, #f44747)",
};

/** Returns true if the server comes from an OMP-managed config (editable). */
function isOmpManaged(server: DiscoveredMcpServer): boolean {
  const p = server.sourcePath;
  if (p.includes(".omp/") || p.includes(".omp\\")) return true;
  if (p.endsWith(".mcp.json")) return true;
  return false;
}

export function McpTab() {
  const [subTab, setSubTab] = useState<SubTab>("Discovery");
  const [newServerScope, setNewServerScope] = useState<"global" | "project" | null>(null);
  const [editingServer, setEditingServer] = useState<DiscoveredMcpServer | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DiscoveredMcpServer | null>(null);
  const [reloading, setReloading] = useState(false);
  const { config, draft, updateSetting, mcpServers } = useSettings();

  const get = (key: string) =>
    getSettingValue(draft as Record<string, unknown>, config as Record<string, unknown>, key);

  const getBool = (key: string, defaultValue: boolean): boolean =>
    (get(key) ?? defaultValue) as boolean;

  const notificationsEnabled = getBool("mcp.notifications", false);

  const deleteServer = (server: DiscoveredMcpServer) => {
    setPendingDelete(server);
  };

  const confirmDelete = () => {
    if (!pendingDelete) return;
    const scope = pendingDelete.sourcePath.includes(".omp/agent/mcp.json") || pendingDelete.sourcePath.includes(".omp\\agent\\mcp.json")
      ? "global" as const
      : "project" as const;
    getVSCodeAPI().postMessage({ type: "settings.mcp.delete", scope, name: pendingDelete.name });
    setPendingDelete(null);
  };

  if (newServerScope) {
    return (
      <McpServerEditView
        scope={newServerScope}
        onBack={() => setNewServerScope(null)}
      />
    );
  }

  if (editingServer) {
    const scope = editingServer.sourcePath.includes(".omp/agent/mcp.json") || editingServer.sourcePath.includes(".omp\\agent\\mcp.json")
      ? "global" as const
      : "project" as const;
    return (
      <McpServerEditView
        scope={scope}
        server={editingServer}
        onBack={() => setEditingServer(null)}
      />
    );
  }

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
              <div className="omp-settings-section-header-row">
                <h3 className="omp-settings-section-title">Discovered Servers</h3>
                <button
                  className={`omp-settings-icon-btn${reloading ? " omp-settings-icon-btn--spin" : ""}`}
                  onClick={() => {
                    setReloading(true);
                    getVSCodeAPI().postMessage({ type: "settings.mcp.reload" });
                    setTimeout(() => setReloading(false), 3000);
                  }}
                  title="Reload MCP servers"
                  disabled={reloading}
                >
                  <i className="codicon codicon-refresh" />
                </button>
              </div>
              <div className="omp-settings-agent-actions">
                <button className="omp-settings-btn-small" onClick={() => setNewServerScope("global")}>
                  Add Global Server
                </button>
                <button className="omp-settings-btn-small" onClick={() => setNewServerScope("project")}>
                  Add Project Server
                </button>
              </div>
              {mcpServers.length === 0 ? (
                <p className="omp-settings-section-desc">
                  No MCP servers detected. Servers will appear when .mcp.json or config.yml mcpServers are found.
                </p>
              ) : (
                <div className="omp-settings-agent-overrides">
                  {mcpServers.map((server) => (
                    <McpServerCard
                      key={`${server.name}-${server.sourcePath}`}
                      server={server}
                      onEdit={setEditingServer}
                      onDelete={deleteServer}
                    />
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
      {pendingDelete && (
        <DeleteConfirmOverlay
          type="server"
          name={pendingDelete.name}
          onCancel={() => setPendingDelete(null)}
          onConfirm={confirmDelete}
        />
      )}
    </div>
  );
}

type McpServerType = "stdio" | "http" | "sse";

function McpServerEditView({
  scope,
  server,
  onBack,
}: {
  scope: "global" | "project";
  server?: DiscoveredMcpServer;
  onBack: () => void;
}) {
  const cfg = (server?.config ?? {}) as Record<string, unknown>;
  const initialType: McpServerType = server
    ? (server.type as McpServerType) || "stdio"
    : "stdio";

  const [name, setName] = useState(server?.name ?? "");
  const [serverType, setServerType] = useState<McpServerType>(initialType);
  const [command, setCommand] = useState(String(cfg.command ?? ""));
  const [argsText, setArgsText] = useState(
    Array.isArray(cfg.args) ? (cfg.args as string[]).join(", ") : ""
  );
  const [envText, setEnvText] = useState(() => {
    const env = cfg.env as Record<string, string> | undefined;
    if (!env || typeof env !== "object") return "";
    return Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n");
  });
  const [url, setUrl] = useState(String(cfg.url ?? ""));
  const [headersText, setHeadersText] = useState(() => {
    const headers = cfg.headers as Record<string, string> | undefined;
    if (!headers || typeof headers !== "object") return "";
    return Object.entries(headers).map(([k, v]) => `${k}=${v}`).join("\n");
  });
  const [timeoutText, setTimeoutText] = useState(
    cfg.timeout ? String(cfg.timeout) : ""
  );
  const [enabled, setEnabled] = useState(server?.enabled ?? true);

  const isEditing = !!server;

  const saveServer = () => {
    const args = argsText
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean);
    const timeout = timeoutText ? parseInt(timeoutText, 10) : undefined;

    // Parse env from key=value lines
    const env: Record<string, string> = {};
    for (const line of envText.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
      }
    }

    // Parse headers from key=value lines
    const headers: Record<string, string> = {};
    for (const line of headersText.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        headers[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
      }
    }

    getVSCodeAPI().postMessage({
      type: "settings.mcp.write",
      scope,
      server: {
        name,
        type: serverType,
        command: serverType === "stdio" ? command : undefined,
        args: serverType === "stdio" && args.length > 0 ? args : undefined,
        url: serverType !== "stdio" ? url : undefined,
        env: serverType === "stdio" && Object.keys(env).length > 0 ? env : undefined,
        headers: serverType !== "stdio" && Object.keys(headers).length > 0 ? headers : undefined,
        timeout: timeout && timeout > 0 ? timeout : undefined,
        enabled,
      },
    });
    onBack();
  };

  const isValid = name.trim() && (serverType === "stdio" ? command.trim() : url.trim());

  return (
    <div className="omp-settings-agent-edit">
      <button onClick={onBack} className="omp-settings-back-btn">
        <i className="codicon codicon-arrow-left" /> Back to list
      </button>
      <div className="omp-settings-agent-edit-heading">
        <h3 className="omp-settings-agent-edit-title">
          {isEditing ? server.name : "New MCP Server"}
        </h3>
        <span className={`omp-settings-agent-badge badge-${scope === "global" ? "global" : "project"}`}>
          {scope}
        </span>
      </div>

      <div className="omp-settings-section">
        {!isEditing && (
          <SettingsRow title="Server Name" description="Identifier for this MCP server">
            <input
              className="omp-settings-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-server"
            />
          </SettingsRow>
        )}
        <SettingsRow title="Type" description="Transport protocol">
          <select
            className="omp-settings-select"
            value={serverType}
            onChange={(e) => setServerType(e.target.value as McpServerType)}
          >
            <option value="stdio">stdio</option>
            <option value="http">http</option>
            <option value="sse">sse</option>
          </select>
        </SettingsRow>

        {serverType === "stdio" && (
          <>
            <SettingsRow title="Command" description="Executable to launch">
              <input
                className="omp-settings-input"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="npx -y @modelcontextprotocol/server"
              />
            </SettingsRow>
            <SettingsRow title="Arguments" description="Comma-separated command arguments">
              <input
                className="omp-settings-input"
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
                placeholder="--port, 3000"
              />
            </SettingsRow>
            <SettingsRow title="Environment Variables" description="One KEY=VALUE per line">
              <textarea
                className="omp-settings-textarea"
                value={envText}
                onChange={(e) => setEnvText(e.target.value)}
                placeholder={"API_KEY=xxx\nNODE_ENV=production"}
                rows={3}
              />
            </SettingsRow>
          </>
        )}

        {serverType !== "stdio" && (
          <>
            <SettingsRow title="URL" description="Server endpoint URL">
              <input
                className="omp-settings-input"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="http://localhost:3000/mcp"
              />
            </SettingsRow>
            <SettingsRow title="Headers" description="One KEY=VALUE per line">
              <textarea
                className="omp-settings-textarea"
                value={headersText}
                onChange={(e) => setHeadersText(e.target.value)}
                placeholder={"Authorization=Bearer xxx"}
                rows={3}
              />
            </SettingsRow>
          </>
        )}

        <SettingsRow title="Timeout" description="Connection timeout in seconds (optional)">
          <input
            className="omp-settings-input"
            type="number"
            value={timeoutText}
            onChange={(e) => setTimeoutText(e.target.value)}
            placeholder="30"
          />
        </SettingsRow>
        <SettingsRow title="Enabled" description="Enable or disable this server" last>
          <input
            type="checkbox"
            className="omp-settings-toggle"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
        </SettingsRow>
      </div>

      <div className="omp-settings-agent-actions">
        <button
          className="omp-settings-btn-small"
          onClick={saveServer}
          disabled={!isValid}
        >
          {isEditing ? "Save Changes" : "Save Server"}
        </button>
      </div>
    </div>
  );
}

function McpServerCard({
  server,
  onEdit,
  onDelete,
}: {
  server: DiscoveredMcpServer;
  onEdit: (server: DiscoveredMcpServer) => void;
  onDelete: (server: DiscoveredMcpServer) => void;
}) {
  const statusColor = STATUS_COLORS[server.status] ?? STATUS_COLORS.configured;
  const cfg = server.config as Record<string, unknown>;
  const displayCommand = cfg.command
    ? [cfg.command, ...((cfg.args as string[]) ?? [])].join(" ")
    : (cfg.url as string) ?? "";

  const managed = isOmpManaged(server);

  // Derive source badge
  const sourceLevel = server.source.toLowerCase().includes("project") ? "project" : "user";

  return (
    <div className="omp-settings-agent-override-row omp-settings-agent-override-row--simple">
      <div className="omp-settings-agent-override-meta">
        <div className="omp-settings-agent-info">
          <span
            className="omp-provider-status-dot"
            style={{ background: statusColor }}
            title={server.status}
          />
          <span className="omp-settings-agent-name">{server.name}</span>
          <span className={`omp-settings-agent-badge badge-${server.type}`}>
            {server.type.toUpperCase()}
          </span>
          <span className={`omp-settings-agent-badge badge-${sourceLevel}`}>
            {sourceLevel.toUpperCase()}
          </span>
          <div className="omp-settings-agent-row-actions">
            {managed ? (
              <>
                <button
                  type="button"
                  className="omp-settings-icon-btn"
                  onClick={() => onEdit(server)}
                  title="Edit server"
                >
                  <i className="codicon codicon-edit" />
                </button>
                <button
                  type="button"
                  className="omp-settings-icon-btn"
                  onClick={() => onDelete(server)}
                  title="Delete server"
                >
                  <i className="codicon codicon-trash" />
                </button>
              </>
            ) : (
              <span className="omp-mcp-autodiscovered-badge">Auto-discovered</span>
            )}
          </div>
        </div>
        <div className="omp-mcp-server-meta">
          {displayCommand && (
            <span className="omp-settings-agent-desc">{displayCommand}</span>
          )}
          {server.toolCount != null && server.toolCount > 0 && (
            <span className="omp-mcp-tool-count">{server.toolCount} tool{server.toolCount > 1 ? "s" : ""}</span>
          )}
        </div>
      </div>
      {managed && (
        <input
          type="checkbox"
          className="omp-settings-toggle"
          checked={server.enabled}
          title={server.enabled ? "Disable server" : "Enable server"}
          onChange={() => {
            // Toggle enabled state by rewriting the server config
            getVSCodeAPI().postMessage({
              type: "settings.mcp.write",
              scope: server.sourcePath.includes(".omp/agent/mcp.json") || server.sourcePath.includes(".omp\\agent\\mcp.json")
                ? "global"
                : "project",
              server: {
                name: server.name,
                type: server.type as "stdio" | "http" | "sse",
                ...server.config,
                enabled: !server.enabled,
              },
            });
          }}
        />
      )}
    </div>
  );
}
