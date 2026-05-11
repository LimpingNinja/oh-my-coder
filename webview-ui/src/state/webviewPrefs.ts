import { getVSCodeAPI } from "../vscode";

const PREFS_VERSION = 1;

export interface WebviewPrefs {
  version: 1;
  chat: {
    headerDetailsOpen: boolean;
    todosExpanded: boolean;
    responseDetailsDefaultOpen: boolean;
  };
  models: {
    favorites: string[]; // "provider/modelId" keys
  };
}

export const DEFAULT_WEBVIEW_PREFS: WebviewPrefs = {
  version: PREFS_VERSION,
  chat: {
    headerDetailsOpen: true,
    todosExpanded: false,
    responseDetailsDefaultOpen: false,
  },
  models: {
    favorites: [],
  },
};

interface PersistedWebviewState {
  prefs?: unknown;
  [key: string]: unknown;
}

export function loadWebviewPrefs(): WebviewPrefs {
  const raw = getVSCodeAPI().getState() as PersistedWebviewState | undefined;
  return normalizeWebviewPrefs(raw?.prefs);
}

export function saveWebviewPrefs(prefs: WebviewPrefs): void {
  const vscode = getVSCodeAPI();
  const previous = (vscode.getState() as PersistedWebviewState | undefined) ?? {};
  vscode.setState({ ...previous, prefs: normalizeWebviewPrefs(prefs) });
}

export function normalizeWebviewPrefs(raw: unknown): WebviewPrefs {
  if (!raw || typeof raw !== "object") return DEFAULT_WEBVIEW_PREFS;

  const value = raw as Partial<WebviewPrefs>;
  if (value.version !== PREFS_VERSION) return DEFAULT_WEBVIEW_PREFS;

  return {
    version: PREFS_VERSION,
    chat: {
      headerDetailsOpen: readBool(value.chat?.headerDetailsOpen, DEFAULT_WEBVIEW_PREFS.chat.headerDetailsOpen),
      todosExpanded: readBool(value.chat?.todosExpanded, DEFAULT_WEBVIEW_PREFS.chat.todosExpanded),
      responseDetailsDefaultOpen: readBool(
        value.chat?.responseDetailsDefaultOpen,
        DEFAULT_WEBVIEW_PREFS.chat.responseDetailsDefaultOpen,
      ),
    },
    models: {
      favorites: readStringArray((value as any).models?.favorites, DEFAULT_WEBVIEW_PREFS.models.favorites),
    },
  };
}

function readBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  return value.filter((item): item is string => typeof item === "string");
}
