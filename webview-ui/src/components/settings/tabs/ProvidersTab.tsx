import { useCallback, useEffect, useRef, useState } from "react";
import { useSettings } from "../SettingsContext";
import { SettingsRow } from "../SettingsRow";
import { getVSCodeAPI } from "../../../vscode";
import type { ModelEntry } from "../../../types/modelInfo";
import { getProviderIcon } from "../../../utils/providerIcons";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Provider status entry from the runtime bridge. */
interface ProviderStatusEntry {
  id: string;
  name: string;
  authMethod: "apiKey" | "oauth" | "none";
  badgeLabel: string;
  envVars: string[];
  envVarsSet: Record<string, boolean>;
  hasConfigKey: boolean;
  hasConfigBaseUrl: boolean;
  configured: boolean;
  modelsAvailable: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  const draftNested = resolveKey(draft, key);
  if (draftNested !== undefined) return draftNested;
  if (key in config) return config[key];
  return resolveKey(config, key);
};

/** Derive partial-configuration status from env vars. */
function deriveStatusClass(entry: ProviderStatusEntry): "configured" | "partial" | "unconfigured" {
  if (entry.configured) return "configured";
  // Check if some but not all env vars are set
  const vars = entry.envVars;
  if (vars.length > 1) {
    const setCount = vars.filter((v) => entry.envVarsSet[v]).length;
    if (setCount > 0 && setCount < vars.length) return "partial";
  }
  return "unconfigured";
}

function statusLabel(status: "configured" | "partial" | "unconfigured"): string {
  switch (status) {
    case "configured": return "Configured";
    case "partial": return "Partially configured";
    case "unconfigured": return "Not configured";
  }
}

/** Capitalize a provider ID as a fallback display name. */
function fallbackName(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1).replace(/-/g, " ");
}

/** Get provider SVG icon from shared icon utility. */
function renderProviderIcon(id: string): string {
  return getProviderIcon(id);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ProvidersTab() {
  const { config, draft, updateSetting } = useSettings();

  // Access providerStatus from context (added by peer agent).
  // Cast to access optional field not yet in the TS interface during development.
  const providerStatus = (useSettings() as unknown as { providerStatus?: ProviderStatusEntry[] }).providerStatus;

  const get = (key: string) =>
    getSettingValue(draft as Record<string, unknown>, config as Record<string, unknown>, key) as
      | string
      | boolean
      | number
      | string[]
      | undefined;

  // -------------------------------------------------------------------------
  // Edit view navigation state
  // -------------------------------------------------------------------------
  const [editingProvider, setEditingProvider] = useState<string | null>(null);

  // -------------------------------------------------------------------------
  // Fallback: Available models from runtime (used when bridge unavailable)
  // -------------------------------------------------------------------------
  const [models, setModels] = useState<ModelEntry[]>([]);
  const requestId = useRef(0);
  const hasBridgeStatus = Array.isArray(providerStatus) && providerStatus.length > 0;

  useEffect(() => {
    // Only fetch models if bridge status is unavailable
    if (hasBridgeStatus) return;
    const thisRequest = ++requestId.current;
    const vscode = getVSCodeAPI();
    vscode.postMessage({ type: "runtime.getAvailableModels" });

    function handleMessage(event: MessageEvent) {
      const msg = event.data;
      if (msg?.type === "runtime.availableModels") {
        if (thisRequest !== requestId.current) return;
        setModels((msg.models as ModelEntry[]) || []);
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [hasBridgeStatus]);

  // -------------------------------------------------------------------------
  // Derive provider grid data
  // -------------------------------------------------------------------------

  const disabledProviders = (() => {
    const val = get("disabledProviders");
    return Array.isArray(val) ? (val as string[]) : [];
  })();

  // Fallback: model-count-only derivation
  const providerModelCounts = new Map<string, number>();
  if (!hasBridgeStatus) {
    for (const m of models) {
      providerModelCounts.set(m.provider, (providerModelCounts.get(m.provider) ?? 0) + 1);
    }
  }

  // Build the list of provider IDs to show
  const allProviderIds = hasBridgeStatus
    ? Array.from(new Set([...providerStatus!.map((p) => p.id), ...disabledProviders])).sort()
    : Array.from(new Set([...providerModelCounts.keys(), ...disabledProviders])).sort();

  // Quick lookup for bridge status entries
  const statusById = new Map<string, ProviderStatusEntry>();
  if (hasBridgeStatus) {
    for (const entry of providerStatus!) {
      statusById.set(entry.id, entry);
    }
  }

  const toggleProvider = useCallback(
    (providerId: string, enabled: boolean) => {
      const current = (() => {
        const raw = getSettingValue(
          draft as Record<string, unknown>,
          config as Record<string, unknown>,
          "disabledProviders"
        );
        return Array.isArray(raw) ? (raw as string[]) : [];
      })();

      const next = enabled
        ? current.filter((id) => id !== providerId)
        : current.includes(providerId)
          ? current
          : [...current, providerId];

      updateSetting("disabledProviders", next);
    },
    [draft, config, updateSetting]
  );

  // -------------------------------------------------------------------------
  // Split providers into configured vs unconfigured
  // -------------------------------------------------------------------------

  const configuredProviders: string[] = [];
  const unconfiguredProviders: string[] = [];

  if (hasBridgeStatus) {
    for (const id of allProviderIds) {
      const entry = statusById.get(id);
      if (entry && entry.configured) {
        configuredProviders.push(id);
      } else {
        unconfiguredProviders.push(id);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Edit view
  // -------------------------------------------------------------------------

  if (editingProvider) {
    const entry = statusById.get(editingProvider);
    return (
      <ProviderEditView
        providerId={editingProvider}
        entry={entry ?? null}
        get={get}
        updateSetting={updateSetting}
        onBack={() => setEditingProvider(null)}
      />
    );
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div>
      {/* § Available Providers */}
      <div className="omp-settings-section">
        <h3 className="omp-settings-section-title">Available Providers</h3>
        <p className="omp-settings-section-desc">
          {hasBridgeStatus
            ? "Provider authentication and configuration status. Toggle to enable or disable."
            : "Providers discovered from available models. Toggle to enable or disable."}
        </p>

        {allProviderIds.length === 0 ? (
          <p className="omp-settings-section-desc" style={{ marginTop: 8 }}>
            No providers detected. Models will appear once the runtime reports available models.
          </p>
        ) : !hasBridgeStatus ? (
          /* Fallback: model-count-only view (no bridge status) */
          <div className="omp-provider-configured-list">
            {allProviderIds.map((id) => {
              const isDisabled = disabledProviders.includes(id);
              const count = providerModelCounts.get(id) ?? 0;
              return (
                <div key={id} className="omp-provider-configured-card">
                  <div className="omp-provider-configured-card-main">
                    <div className="omp-provider-configured-card-top">
                      <span className="omp-provider-configured-card-name">
                        {fallbackName(id)}
                      </span>
                      <span className="omp-provider-configured-card-meta">
                        {count > 0 ? `${count} model${count > 1 ? "s" : ""} detected` : "No models detected"}
                      </span>
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    className="omp-settings-toggle"
                    checked={!isDisabled}
                    onChange={(e) => toggleProvider(id, e.target.checked)}
                    title={isDisabled ? "Enable provider" : "Disable provider"}
                  />
                </div>
              );
            })}
          </div>
        ) : (
          <>
            {/* Section 1: Configured Providers */}
            {configuredProviders.length > 0 && (
              <div className="omp-provider-configured-list">
                {configuredProviders.map((id) => {
                  const entry = statusById.get(id)!;
                  const isDisabled = disabledProviders.includes(id);
                  const status = deriveStatusClass(entry);
                  return (
                    <div key={id} className="omp-provider-configured-card">
                      <span className="omp-provider-icon" dangerouslySetInnerHTML={{ __html: renderProviderIcon(id) }} />
                      <div className="omp-provider-configured-card-main">
                        <div className="omp-provider-configured-card-top">
                          <span className="omp-provider-configured-card-name">
                            {entry.name || fallbackName(id)}
                          </span>
                          {entry.modelsAvailable > 0 && (
                            <span className="omp-provider-configured-card-meta">
                              {entry.modelsAvailable} model{entry.modelsAvailable > 1 ? "s" : ""}
                            </span>
                          )}
                          {(entry.hasConfigKey || entry.hasConfigBaseUrl) && (
                            <div className="omp-provider-config-badges">
                              {entry.hasConfigBaseUrl && (
                                <span className="omp-provider-config-badge">Custom endpoint</span>
                              )}
                              {entry.hasConfigKey && (
                                <span className="omp-provider-config-badge">Config API key</span>
                              )}
                            </div>
                          )}
                        </div>
                        <div className="omp-provider-configured-card-status">
                          <span className={`omp-provider-status-dot omp-provider-status-dot--${status}`} />
                          <span className="omp-provider-status-label">{statusLabel(status)}</span>
                          <span className="omp-provider-auth-badge">
                            {entry.badgeLabel}
                          </span>
                        </div>
                        {entry.envVars.length > 0 && (
                          <ul className="omp-provider-env-list">
                            {entry.envVars.map((v) => (
                              <li key={v}>
                                <span className="omp-provider-env-indicator">
                                  {entry.envVarsSet[v] ? "✓" : "✗"}
                                </span>
                                <span>{v}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                      <div className="omp-provider-configured-card-actions">
                        <button
                          className="omp-settings-icon-btn codicon codicon-edit"
                          title="Edit provider configuration"
                          onClick={() => setEditingProvider(id)}
                        />
                      </div>
                      <input
                        type="checkbox"
                        className="omp-settings-toggle"
                        checked={!isDisabled}
                        onChange={(e) => toggleProvider(id, e.target.checked)}
                        title={isDisabled ? "Enable provider" : "Disable provider"}
                      />
                    </div>
                  );
                })}
              </div>
            )}

            {/* Section 2: Unconfigured Providers */}
            {unconfiguredProviders.length > 0 && (
              <div className="omp-provider-unconfigured-list">
                {unconfiguredProviders.map((id) => {
                  const isDisabled = disabledProviders.includes(id);
                  const entry = statusById.get(id);
                  return (
                    <div key={id} className="omp-provider-unconfigured-row">
                      <span className="omp-provider-icon" dangerouslySetInnerHTML={{ __html: renderProviderIcon(id) }} />
                      <div className="omp-provider-unconfigured-info">
                        <span className="omp-provider-unconfigured-name">
                          {entry?.name || fallbackName(id)}
                        </span>
                        <span className="omp-provider-unconfigured-status">
                          <span className="omp-provider-status-dot omp-provider-status-dot--unconfigured" />
                          Not Configured
                        </span>
                      </div>
                      <button
                        className="omp-provider-unconfigured-connect"
                        onClick={() => setEditingProvider(id)}
                      >
                        + Connect
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      {/* § Search & Image Providers */}
      <div className="omp-settings-section">
        <h3 className="omp-settings-section-title">Search &amp; Image Providers</h3>
        <p className="omp-settings-section-desc">Web search and image generation backends</p>
        <SettingsRow title="Web Search" description="Provider used for web searches">
          <select
            className="omp-settings-select"
            value={String(get("providers.webSearch") ?? "auto")}
            onChange={(e) => updateSetting("providers.webSearch", e.target.value)}
          >
            <option value="auto">Auto</option>
            <option value="exa">Exa</option>
            <option value="brave">Brave</option>
            <option value="jina">Jina</option>
            <option value="kimi">Kimi</option>
            <option value="zai">Zai</option>
            <option value="perplexity">Perplexity</option>
            <option value="anthropic">Anthropic</option>
            <option value="gemini">Gemini</option>
            <option value="codex">Codex</option>
            <option value="tavily">Tavily</option>
            <option value="kagi">Kagi</option>
            <option value="synthetic">Synthetic</option>
            <option value="parallel">Parallel</option>
            <option value="searxng">SearXNG</option>
          </select>
        </SettingsRow>
        <SettingsRow title="Image" description="Provider used for image generation" last>
          <select
            className="omp-settings-select"
            value={String(get("providers.image") ?? "auto")}
            onChange={(e) => updateSetting("providers.image", e.target.value)}
          >
            <option value="auto">Auto</option>
            <option value="openai">OpenAI</option>
            <option value="gemini">Gemini</option>
            <option value="openrouter">OpenRouter</option>
          </select>
        </SettingsRow>
      </div>

      {/* § Connection Settings */}
      <div className="omp-settings-section">
        <h3 className="omp-settings-section-title">Connection Settings</h3>
        <p className="omp-settings-section-desc">Transport, API format, and security settings</p>
        <SettingsRow title="OpenAI WebSockets" description="Use WebSockets for OpenAI connections">
          <select
            className="omp-settings-select"
            value={String(get("providers.openaiWebsockets") ?? "auto")}
            onChange={(e) => updateSetting("providers.openaiWebsockets", e.target.value)}
          >
            <option value="auto">Auto</option>
            <option value="off">Off</option>
            <option value="on">On</option>
          </select>
        </SettingsRow>
        <SettingsRow title="Kimi API Format" description="API format for Kimi provider">
          <select
            className="omp-settings-select"
            value={String(get("providers.kimiApiFormat") ?? "anthropic")}
            onChange={(e) => updateSetting("providers.kimiApiFormat", e.target.value)}
          >
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </SettingsRow>
        <SettingsRow title="Parallel Fetch" description="Enable parallel fetching across providers">
          <input
            type="checkbox"
            className="omp-settings-toggle"
            checked={(get("providers.parallelFetch") ?? true) === true}
            onChange={(e) => updateSetting("providers.parallelFetch", e.target.checked)}
          />
        </SettingsRow>
        <SettingsRow title="Hide Secrets" description="Obfuscate secrets before sending to providers" last>
          <input
            type="checkbox"
            className="omp-settings-toggle"
            checked={!!get("secrets.enabled")}
            onChange={(e) => updateSetting("secrets.enabled", e.target.checked)}
          />
        </SettingsRow>
      </div>

      {/* § Exa Search */}
      <div className="omp-settings-section">
        <h3 className="omp-settings-section-title">Exa Search</h3>
        <p className="omp-settings-section-desc">Exa search provider features</p>
        <SettingsRow title="Enabled" description="Master toggle for Exa tools">
          <input
            type="checkbox"
            className="omp-settings-toggle"
            checked={(get("exa.enabled") ?? true) === true}
            onChange={(e) => updateSetting("exa.enabled", e.target.checked)}
          />
        </SettingsRow>
        <SettingsRow title="Enable Search" description="Basic search, deep search, code search, crawl">
          <input
            type="checkbox"
            className="omp-settings-toggle"
            checked={(get("exa.enableSearch") ?? true) === true}
            onChange={(e) => updateSetting("exa.enableSearch", e.target.checked)}
          />
        </SettingsRow>
        <SettingsRow title="Enable Researcher" description="AI-powered deep research">
          <input
            type="checkbox"
            className="omp-settings-toggle"
            checked={!!get("exa.enableResearcher")}
            onChange={(e) => updateSetting("exa.enableResearcher", e.target.checked)}
          />
        </SettingsRow>
        <SettingsRow title="Enable Websets" description="Webset management and enrichment" last>
          <input
            type="checkbox"
            className="omp-settings-toggle"
            checked={!!get("exa.enableWebsets")}
            onChange={(e) => updateSetting("exa.enableWebsets", e.target.checked)}
          />
        </SettingsRow>
      </div>

      {/* § SearXNG */}
      <div className="omp-settings-section">
        <h3 className="omp-settings-section-title">SearXNG</h3>
        <p className="omp-settings-section-desc">Self-hosted SearXNG search engine</p>
        <SettingsRow title="Endpoint" description="Self-hosted SearXNG base URL" last>
          <input
            type="text"
            className="omp-settings-input"
            placeholder="https://searxng.example.com"
            value={String(get("searxng.endpoint") ?? "")}
            onChange={(e) => updateSetting("searxng.endpoint", e.target.value || null)}
          />
        </SettingsRow>
      </div>

      {/* Footer */}
      <div className="omp-settings-section">
        <button
          className="omp-settings-btn"
          onClick={() => getVSCodeAPI().postMessage({ type: "settings.openConfigFile" })}
        >
          Open Config File
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ProviderEditView
// ---------------------------------------------------------------------------

/** Known default endpoints for providers (used as placeholders). */
const PROVIDER_DEFAULT_ENDPOINTS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  google: "https://generativelanguage.googleapis.com",
  openrouter: "https://openrouter.ai/api/v1",
  groq: "https://api.groq.com/openai/v1",
  mistral: "https://api.mistral.ai/v1",
  deepseek: "https://api.deepseek.com",
  together: "https://api.together.xyz/v1",
  fireworks: "https://api.fireworks.ai/inference/v1",
  perplexity: "https://api.perplexity.ai",
  xai: "https://api.x.ai/v1",
  ollama: "http://localhost:11434",
  lmstudio: "http://localhost:1234/v1",
};

function ProviderEditView({
  providerId,
  entry,
  get,
  updateSetting,
  onBack,
}: {
  providerId: string;
  entry: ProviderStatusEntry | null;
  get: (key: string) => string | boolean | number | string[] | undefined;
  updateSetting: (key: string, value: unknown) => void;
  onBack: () => void;
}) {
  const authMethod = entry?.authMethod ?? "apiKey";
  const badgeLabel = entry?.badgeLabel ?? "API Key";
  const displayName = entry?.name || fallbackName(providerId);
  const isAmazonBedrock = providerId === "amazon-bedrock";

  const apiKeySettingKey = `providers.${providerId}.apiKey`;
  const baseUrlSettingKey = `providers.${providerId}.baseUrl`;

  const [apiKey, setApiKey] = useState<string>(String(get(apiKeySettingKey) ?? ""));
  const [baseUrl, setBaseUrl] = useState<string>(String(get(baseUrlSettingKey) ?? ""));
  const [showKey, setShowKey] = useState(false);

  const defaultEndpoint = PROVIDER_DEFAULT_ENDPOINTS[providerId] ?? "";

  const handleApiKeyChange = (value: string) => {
    setApiKey(value);
    updateSetting(apiKeySettingKey, value || null);
  };

  const handleBaseUrlChange = (value: string) => {
    setBaseUrl(value);
    updateSetting(baseUrlSettingKey, value || null);
  };

  return (
    <div className="omp-settings-agent-edit">
      <button onClick={onBack} className="omp-settings-back-btn">
        <i className="codicon codicon-arrow-left" /> Back to list
      </button>
      <div className="omp-settings-agent-edit-heading">
        <h3 className="omp-settings-agent-edit-title">{displayName}</h3>
        <span className="omp-provider-auth-badge">
          {badgeLabel}
        </span>
      </div>

      {/* ─── Amazon Bedrock: AWS credential chain ─── */}
      {isAmazonBedrock && (
        <>
          <div className="omp-settings-section">
            <p className="omp-settings-section-desc">
              Uses AWS credential chain. Set <code>AWS_ACCESS_KEY_ID</code>,{" "}
              <code>AWS_SECRET_ACCESS_KEY</code>, <code>AWS_REGION</code>, and optionally{" "}
              <code>AWS_SESSION_TOKEN</code> as environment variables.
            </p>
          </div>
          {entry && entry.envVars.length > 0 && (
            <div className="omp-settings-section">
              <h4 className="omp-settings-section-title" style={{ fontSize: 13 }}>Environment Variables</h4>
              <div className="omp-provider-edit-status">
                <ul className="omp-provider-env-list">
                  {entry.envVars.map((v) => (
                    <li key={v}>
                      <span className="omp-provider-env-indicator">
                        {entry.envVarsSet[v] ? "✓" : "✗"}
                      </span>
                      <span>{v}</span>
                      <span className="omp-provider-edit-status-label">
                        {entry.envVarsSet[v] ? "Set" : "Not set"}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </>
      )}

      {/* ─── OAuth providers ─── */}
      {!isAmazonBedrock && authMethod === "oauth" && (
        <>
          <div className="omp-settings-section">
            <p className="omp-settings-section-desc">
              This provider uses OAuth. Authenticate via the CLI with{" "}
              <code>/login {providerId}</code> command.
            </p>
          </div>
          {/* Some OAuth providers may support custom base URL */}
          {defaultEndpoint && (
            <div className="omp-settings-section">
              <SettingsRow
                title="Base URL"
                description="Custom endpoint override"
                last
              >
                <input
                  type="text"
                  className="omp-settings-input"
                  value={baseUrl}
                  onChange={(e) => handleBaseUrlChange(e.target.value)}
                  placeholder={defaultEndpoint}
                />
              </SettingsRow>
            </div>
          )}
        </>
      )}

      {/* ─── Local providers (authMethod === "none") ─── */}
      {!isAmazonBedrock && authMethod === "none" && (
        <>
          <div className="omp-settings-section">
            <p className="omp-settings-section-desc">
              Local provider — no authentication required.
            </p>
          </div>
          <div className="omp-settings-section">
            <SettingsRow
              title="Base URL"
              description="Local server endpoint"
              last
            >
              <input
                type="text"
                className="omp-settings-input"
                value={baseUrl}
                onChange={(e) => handleBaseUrlChange(e.target.value)}
                placeholder={defaultEndpoint || "http://localhost:11434"}
              />
            </SettingsRow>
          </div>
        </>
      )}

      {/* ─── API Key providers (standard) ─── */}
      {!isAmazonBedrock && authMethod === "apiKey" && (
        <>
          <div className="omp-settings-section">
            <SettingsRow
              title="API Key"
              description={`Authentication key for ${displayName}`}
            >
              <div style={{ display: "flex", gap: 4, alignItems: "center", width: "100%" }}>
                <input
                  type={showKey ? "text" : "password"}
                  className="omp-settings-input"
                  value={apiKey}
                  onChange={(e) => handleApiKeyChange(e.target.value)}
                  placeholder="Enter API key or $ENV_VAR reference"
                  style={{ flex: 1 }}
                />
                <button
                  className="omp-provider-password-toggle"
                  onClick={() => setShowKey(!showKey)}
                  title={showKey ? "Hide API key" : "Show API key"}
                  type="button"
                >
                  <i className={`codicon codicon-${showKey ? "eye-closed" : "eye"}`} />
                </button>
              </div>
            </SettingsRow>
          </div>
          <div className="omp-settings-section">
            <SettingsRow
              title="Base URL"
              description="Custom endpoint override"
              last
            >
              <input
                type="text"
                className="omp-settings-input"
                value={baseUrl}
                onChange={(e) => handleBaseUrlChange(e.target.value)}
                placeholder={defaultEndpoint || "https://api.example.com/v1"}
              />
            </SettingsRow>
          </div>
          {/* Env var status (read-only) */}
          {entry && entry.envVars.length > 0 && (
            <div className="omp-settings-section">
              <h4 className="omp-settings-section-title" style={{ fontSize: 13 }}>Environment Variables</h4>
              <div className="omp-provider-edit-status">
                <ul className="omp-provider-env-list">
                  {entry.envVars.map((v) => (
                    <li key={v}>
                      <span className="omp-provider-env-indicator">
                        {entry.envVarsSet[v] ? "✓" : "✗"}
                      </span>
                      <span>{v}</span>
                      <span className="omp-provider-edit-status-label">
                        {entry.envVarsSet[v] ? "Set" : "Not set"}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
