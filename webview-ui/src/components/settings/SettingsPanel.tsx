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

const TABS = [
  { id: "models", label: "Models", icon: "codicon-symbol-class" },
  { id: "providers", label: "Providers", icon: "codicon-plug" },
  { id: "agents", label: "Agents", icon: "codicon-organization" },
  { id: "interaction", label: "Interaction", icon: "codicon-comment-discussion" },
  { id: "skills", label: "Skills", icon: "codicon-sparkle" },
  { id: "mcp", label: "MCP", icon: "codicon-server-process" },
  { id: "context", label: "Context", icon: "codicon-database" },
  { id: "memory", label: "Memory", icon: "codicon-brain" },
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
          <i className={`codicon ${tab.icon}`} />
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
