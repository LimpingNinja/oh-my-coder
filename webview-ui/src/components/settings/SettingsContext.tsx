import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { getVSCodeAPI } from "../../vscode";

interface SettingsContextValue {
  config: Record<string, unknown>;
  draft: Record<string, unknown>;
  isDirty: boolean;
  error: string | null;
  activeTab: string;
  setActiveTab: (tab: string) => void;
  updateSetting: (key: string, value: unknown) => void;
  save: () => void;
  discard: () => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used within SettingsProvider");
  return ctx;
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("models");
  const vscode = useRef(getVSCodeAPI());

  useEffect(() => {
    vscode.current.postMessage({ type: "settings.load" });

    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (!msg || typeof msg !== "object") return;
      switch (msg.type) {
        case "settings.loaded":
          setConfig(msg.config ?? {});
          setDraft({});
          setError(null);
          break;
        case "settings.updated":
          setConfig(msg.config ?? {});
          setDraft({});
          setError(null);
          break;
        case "settings.updateFailed":
          setError(msg.error ?? "Save failed");
          break;
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
    setError(null);
  }, []);

  return (
    <SettingsContext.Provider
      value={{ config, draft, isDirty, error, activeTab, setActiveTab, updateSetting, save, discard }}
    >
      {children}
    </SettingsContext.Provider>
  );
}
