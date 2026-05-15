import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { getVSCodeAPI } from "../../vscode";

interface AgentDefinition {
  name: string;
  description: string;
  systemPrompt: string;
  tools?: string[];
  spawns?: string[] | "*";
  model?: string | string[];
  thinkingLevel?: string;
  source: string;
  filePath?: string;
}

export interface ProviderStatusEntry {
  id: string;
  name: string;
  authMethod: "apiKey" | "oauth" | "none";
  envVars: string[];
  envVarsSet: Record<string, boolean>;
  hasConfigKey: boolean;
  hasConfigBaseUrl: boolean;
  configured: boolean;
  modelsAvailable: number;
}

export interface DiscoveredSkill {
  name: string;
  description: string;
  source: string;
  location: string;
  path: string;
}

export interface DiscoveredMcpServer {
  name: string;
  type: string;
  status: string;
  enabled: boolean;
  source: string;
  sourcePath: string;
  config: Record<string, unknown>;
}

interface SettingsContextValue {
  config: Record<string, unknown>;
  draft: Record<string, unknown>;
  isDirty: boolean;
  error: string | null;
  conflict: boolean;
  activeTab: string;
  setActiveTab: (tab: string) => void;
  updateSetting: (key: string, value: unknown) => void;
  save: () => void;
  discard: () => void;
  resolveConflict: (action: "reload" | "keep") => void;
  agents: AgentDefinition[];
  bridgeAvailable: boolean | undefined;
  providerStatus: ProviderStatusEntry[];
  skills: DiscoveredSkill[];
  mcpServers: DiscoveredMcpServer[];
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used within SettingsProvider");
  return ctx;
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [activeTab, setActiveTab] = useState("models");
  const [bridgeAvailable, setBridgeAvailable] = useState<boolean | undefined>(undefined);
  const [providerStatus, setProviderStatus] = useState<ProviderStatusEntry[]>([]);
  const [skills, setSkills] = useState<DiscoveredSkill[]>([]);
  const [mcpServers, setMcpServers] = useState<DiscoveredMcpServer[]>([]);
  const vscode = useRef(getVSCodeAPI());
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => {
    vscode.current.postMessage({ type: "settings.load" });

    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (!msg || typeof msg !== "object") return;
      switch (msg.type) {
        case "settings.loaded":
          setConfig(msg.config ?? {});
          setAgents(Array.isArray(msg.agents) ? msg.agents : []);
          setBridgeAvailable(msg.bridgeAvailable === true);
          setProviderStatus(Array.isArray(msg.providerStatus) ? msg.providerStatus : []);
          setSkills(Array.isArray(msg.skills) ? msg.skills : []);
          setMcpServers(Array.isArray(msg.mcpServers) ? msg.mcpServers : []);
          // If draft is dirty, preserve it and signal conflict instead of discarding
          if (Object.keys(draftRef.current).length > 0) {
            setConflict(true);
          } else {
            setDraft({});
            setError(null);
          }
          break;
        case "settings.updated":
          setConfig(msg.config ?? {});
          setProviderStatus(Array.isArray(msg.providerStatus) ? msg.providerStatus : []);
          setSkills(Array.isArray(msg.skills) ? msg.skills : []);
          setMcpServers(Array.isArray(msg.mcpServers) ? msg.mcpServers : []);
          setDraft({});
          setConflict(false);
          setError(null);
          break;
        case "settings.updateFailed":
          setError(msg.message ?? "Save failed");
          break;
        case "settings.navigate": {
          const tab = typeof msg.tab === "string" ? msg.tab : "";
          if (tab) setActiveTab(tab);
          break;
        }
      }
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const isDirty = Object.keys(draft).length > 0;

  const updateSetting = useCallback((key: string, value: unknown) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setError(null);
  }, []);

  const save = useCallback(() => {
    vscode.current.postMessage({ type: "settings.save", config: draft });
  }, [draft]);

  const discard = useCallback(() => {
    setDraft({});
    setConflict(false);
    setError(null);
  }, []);

  const resolveConflict = useCallback((action: "reload" | "keep") => {
    if (action === "reload") {
      setDraft({});
    }
    setConflict(false);
  }, []);

  return (
    <SettingsContext.Provider
      value={{
        config,
        draft,
        isDirty,
        error,
        conflict,
        activeTab,
        setActiveTab,
        updateSetting,
        save,
        discard,
        resolveConflict,
        agents,
        bridgeAvailable,
        providerStatus,
        skills,
        mcpServers,
      }}
    >
      {children}
    </SettingsContext.Provider>
  );
}
