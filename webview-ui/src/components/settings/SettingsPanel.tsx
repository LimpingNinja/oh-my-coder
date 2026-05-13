import { SettingsProvider, useSettings } from "./SettingsContext";
import { SaveBar } from "./SaveBar";
import { ModelsTab } from "./tabs/ModelsTab";
import { InteractionTab } from "./tabs/InteractionTab";

const TABS = [
  { id: "models", label: "Models", icon: "codicon-symbol-class" },
  { id: "providers", label: "Providers", icon: "codicon-plug" },
  { id: "agents", label: "Agents", icon: "codicon-organization" },
  { id: "interaction", label: "Interaction", icon: "codicon-comment-discussion" },
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
    case "interaction":
      return <InteractionTab />;
    default:
      return (
        <div className="omp-settings-tab-content">
          <h2>{TABS.find((t) => t.id === activeTab)?.label}</h2>
          <p className="omp-settings-placeholder">Settings coming soon...</p>
        </div>
      );
  }
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
      </div>
    </SettingsProvider>
  );
}
