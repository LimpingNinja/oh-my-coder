import { useCallback, useEffect, useRef, useState } from "react";
import { SettingsRow } from "../SettingsRow";
import { getVSCodeAPI } from "../../../vscode";

export function OmcSettingsTab() {
  const [path, setPath] = useState("");
  const [saved, setSaved] = useState(false);
  const loadedRef = useRef(false);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg?.type === "settings.omc.loaded") {
        setPath(msg.settings.path ?? "");
        loadedRef.current = true;
      } else if (msg?.type === "settings.omc.updated") {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    };
    window.addEventListener("message", handler);
    getVSCodeAPI().postMessage({ type: "settings.omc.load" });
    return () => window.removeEventListener("message", handler);
  }, []);

  const handleSave = useCallback(() => {
    const value = path.trim() || null;
    getVSCodeAPI().postMessage({ type: "settings.omc.save", settings: { path: value } });
  }, [path]);

  return (
    <div className="omp-settings-tab-content">
      <h2>OMC Settings</h2>
      <p className="omp-settings-placeholder" style={{ marginBottom: 12 }}>
        VS Code extension settings. These configure the OMC extension itself, not the OMP runtime or
        agent behavior.
      </p>
      <SettingsRow
        title="OMP Binary Path"
        description="Path to the omp binary. Leave empty to use the default from PATH."
        last
      >
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input
            type="text"
            className="omp-settings-input"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/usr/local/bin/omp"
            style={{ flex: 1, minWidth: 200 }}
          />
          <button className="omp-settings-btn" onClick={handleSave}>
            {saved ? "Saved ✓" : "Save"}
          </button>
        </div>
      </SettingsRow>
    </div>
  );
}
