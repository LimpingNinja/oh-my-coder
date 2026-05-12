import { useAppState, setScreen } from "./state/store";
import { useEffect } from "react";
import { useMessageHandler } from "./hooks/useMessages";
import { HomeScreen } from "./components/HomeScreen";
import { HistoryScreen } from "./components/HistoryScreen";
import { ActiveScreen } from "./components/ActiveScreen";

export function App() {
  useMessageHandler();

  // Listen for ui.trigger events to navigate screens
  useEffect(() => {
    function handleUiTrigger(e: Event) {
      const action = (e as CustomEvent<{ action: string }>).detail?.action;
      if (action === "openHistory") {
        setScreen("history");
      }
    }
    window.addEventListener("omp:uiTrigger", handleUiTrigger);
    return () => window.removeEventListener("omp:uiTrigger", handleUiTrigger);
  }, []);
  const { screen } = useAppState();

  switch (screen) {
    case "home":
      return <HomeScreen />;
    case "history":
      return <HistoryScreen />;
    case "active":
      return <ActiveScreen />;
  }
}
