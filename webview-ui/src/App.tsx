import { useAppState } from "./state/store";
import { useMessageHandler } from "./hooks/useMessages";
import { HomeScreen } from "./components/HomeScreen";
import { HistoryScreen } from "./components/HistoryScreen";
import { ActiveScreen } from "./components/ActiveScreen";

export function App() {
  useMessageHandler();
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
