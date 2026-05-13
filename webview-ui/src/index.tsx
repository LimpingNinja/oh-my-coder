import { createRoot } from "react-dom/client";
import { App } from "./App";
import { SettingsPanel } from "./components/settings/SettingsPanel";
import "@vscode/codicons/dist/codicon.css";
import "./styles/index.css";

const container = document.getElementById("omp-app");
if (container) {
  const route = container.getAttribute("data-route");
  const root = createRoot(container);
  if (route === "settings") {
    root.render(<SettingsPanel />);
  } else {
    root.render(<App />);
  }
}
