import { SettingsProvider, useSettings } from "./SettingsContext";
import { SaveBar } from "./SaveBar";
import { ModelsTab } from "./tabs/ModelsTab";
import { InteractionTab } from "./tabs/InteractionTab";
import { AgentsTab } from "./tabs/AgentsTab";
import { ProvidersTab } from "./tabs/ProvidersTab";
import { ContextTab } from "./tabs/ContextTab";
import { MemoryTab } from "./tabs/MemoryTab";
import { ToolsTab } from "./tabs/ToolsTab";
import { EditingTab } from "./tabs/EditingTab";
import { SkillsTab } from "./tabs/SkillsTab";
import { McpTab } from "./tabs/McpTab";
import { OmcSettingsTab } from "./tabs/OmcSettingsTab";

const BRAIN_SVG = `<svg width="16" height="16" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M13.332 8.7487C11.4911 8.7487 9.9987 7.25631 9.9987 5.41536M6.66536 11.2487C8.50631 11.2487 9.9987 12.7411 9.9987 14.582M9.9987 2.78209L9.9987 17.0658M16.004 15.0475C17.1255 14.5876 17.9154 13.4849 17.9154 12.1978C17.9154 11.3363 17.5615 10.5575 16.9913 9.9987C17.5615 9.43991 17.9154 8.66108 17.9154 7.79962C17.9154 6.21199 16.7136 4.90504 15.1702 4.73878C14.7858 3.21216 13.4039 2.08203 11.758 2.08203C11.1171 2.08203 10.5162 2.25337 9.9987 2.55275C9.48117 2.25337 8.88032 2.08203 8.23944 2.08203C6.59353 2.08203 5.21157 3.21216 4.82722 4.73878C3.28377 4.90504 2.08203 6.21199 2.08203 7.79962C2.08203 8.66108 2.43585 9.43991 3.00609 9.9987C2.43585 10.5575 2.08203 11.3363 2.08203 12.1978C2.08203 13.4849 2.87191 14.5876 3.99339 15.0475C4.46688 16.7033 5.9917 17.9154 7.79962 17.9154C8.61335 17.9154 9.36972 17.6698 9.9987 17.2488C10.6277 17.6698 11.384 17.9154 12.1978 17.9154C14.0057 17.9154 15.5305 16.7033 16.004 15.0475Z" stroke="currentColor"/></svg>`;

const TABS = [
  { id: "models", label: "Models", icon: "codicon-symbol-class" },
  { id: "providers", label: "Providers", icon: "codicon-plug" },
  { id: "agents", label: "Agents", icon: "codicon-organization" },
  { id: "interaction", label: "Interaction", icon: "codicon-comment-discussion" },
  { id: "skills", label: "Skills", icon: "codicon-sparkle" },
  { id: "mcp", label: "MCP", icon: "codicon-server-process" },
  { id: "context", label: "Context", icon: "codicon-database" },
  { id: "memory", label: "Memory", icon: "__svg" },
  { id: "tools", label: "Tools", icon: "codicon-tools" },
  { id: "editing", label: "Editing", icon: "codicon-edit" },
  { id: "notifications", label: "Notifications", icon: "codicon-bell" },
  { id: "omc", label: "OMC Settings", icon: "codicon-settings-gear" },
] as const;

function SettingsTabList() {
  const { activeTab, setActiveTab } = useSettings();
  return (
    <nav>
      {TABS.map((tab) => (
        <button
          key={tab.id}
          className={`omp-settings-tab-btn${activeTab === tab.id ? " omp-settings-tab-btn--active" : ""}`}
          onClick={() => setActiveTab(tab.id)}
        >
          {tab.icon === "__svg" ? (
            <span className="omp-settings-tab-icon-svg" dangerouslySetInnerHTML={{ __html: BRAIN_SVG }} />
          ) : (
            <i className={`codicon ${tab.icon}`} />
          )}
          {tab.label}
        </button>
      ))}
    </nav>
  );
}

function SettingsTabContent() {
  const { activeTab } = useSettings();
  switch (activeTab) {
    case "models":
      return <ModelsTab />;
    case "providers":
      return <ProvidersTab />;
    case "interaction":
      return <InteractionTab />;
    case "agents":
      return <AgentsTab />;
    case "skills":
      return <SkillsTab />;
    case "mcp":
      return <McpTab />;
    case "context":
      return <ContextTab />;
    case "memory":
      return <MemoryTab />;
    case "tools":
      return <ToolsTab />;
    case "editing":
      return <EditingTab />;
    case "omc":
      return <OmcSettingsTab />;
    default:
      return (
        <div className="omp-settings-tab-content">
          <h2>{TABS.find((t) => t.id === activeTab)?.label}</h2>
          <p className="omp-settings-placeholder">Settings coming soon...</p>
        </div>
      );
  }
}

function ReadOnlyDiscoveryStub({ title, description }: { title: string; description: string }) {
  return (
    <div className="omp-settings-tab-content">
      <h2>{title}</h2>
      <p className="omp-settings-placeholder">{description}</p>
    </div>
  );
}

function SessionRequiredOverlay() {
  const { bridgeAvailable } = useSettings();
  if (bridgeAvailable !== false) return null;

  return (
    <div className="omp-settings-session-overlay">
      <div className="omp-settings-session-card">
        <i className="codicon codicon-debug-start" />
        <h2>Start a session to configure settings</h2>
        <p>
          OMC settings are applied through the running OMP runtime. Start or resume a session first,
          then this panel will unlock automatically.
        </p>
      </div>
    </div>
  );
}

export function SettingsPanel() {
  return (
    <SettingsProvider>
      <div className="omp-settings">
        <div className="omp-settings-sidebar">
          <SettingsTabList />
        </div>
        <div className="omp-settings-content">
          <SettingsTabContent />
        </div>
        <SaveBar />
        <SessionRequiredOverlay />
      </div>
    </SettingsProvider>
  );
}
