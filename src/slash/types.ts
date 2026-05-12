export type SlashTier = 1 | 2 | 3 | 4 | 5 | 6;

export type SlashSource = "omc" | "runtime";

export type RuntimeCommandSource = "extension" | "prompt" | "skill";

export interface RuntimeDiscoveredCommand {
  name: string;
  description?: string;
  source: RuntimeCommandSource;
  location?: string;
  path?: string;
  sourceInfo?: {
    location?: string;
    path?: string;
  };
}

export type SlashRouteKind =
  | "rpc"
  | "host"
  | "webview"
  | "passThrough"
  | "config"
  | "blocked";

export interface SlashRpcRoute {
  kind: "rpc";
  rpcType:
    | "compact"
    | "set_model"
    | "set_thinking_level"
    | "set_steering_mode"
    | "set_follow_up_mode"
    | "set_interrupt_mode"
    | "set_auto_compaction"
    | "set_auto_retry"
    | "abort_retry"
    | "abort"
    | "abort_and_prompt"
    | "new_session"
    | "cycle_model"
    | "cycle_thinking_level"
    | "get_available_models"
    | "bash"
    | "abort_bash"
    | "get_session_stats"
    | "export_html"
    | "switch_session"
    | "branch"
    | "get_branch_messages"
    | "get_last_assistant_text"
    | "set_session_name"
    | "handoff"
    | "get_messages"
    | "get_commands";
}

export interface SlashHostRoute {
  kind: "host";
  action:
    | "openChat"
    | "newSession"
    | "resumeSession"
    | "focusInput"
    | "copyLast"
    | "dumpJson"
    | "openSessionFile"
    | "showDiagnostics"
    | "openHelpUrl"
    | "clearComposer"
    | "cycleRoles";
}

export interface SlashWebviewRoute {
  kind: "webview";
  action:
    | "openModelSelector"
    | "openThinkingSelector"
    | "openHistory"
    | "openSlashHelp"
    | "focusInput"
    | "cycleModel";
}

export interface SlashPassThroughRoute {
  kind: "passThrough";
}

export interface SlashConfigRoute {
  kind: "config";
  tab: "root" | "agents" | "mcp" | "tools" | "context" | "memory";
}

export interface SlashBlockedRoute {
  kind: "blocked";
  reason: string;
}

export type SlashRoute =
  | SlashRpcRoute
  | SlashHostRoute
  | SlashWebviewRoute
  | SlashPassThroughRoute
  | SlashConfigRoute
  | SlashBlockedRoute;

export interface SlashCommand {
  name: string;
  description: string;
  tier: SlashTier;
  source: SlashSource;
  aliases?: string[];
  route: SlashRoute;
  acceptsArgs?: boolean;
  argsHint?: string;
  noArgsRedirect?: string;
  phase: 1 | 2 | 3 | 4 | 5;
  runtimeMeta?: {
    source?: RuntimeCommandSource;
    location?: string;
    path?: string;
  };
}

export interface ParsedSlashInput {
  isSlash: boolean;
  raw: string;
  command: string;
  args: string;
}

export interface SlashExecutionResult {
  ok: boolean;
  command: string;
  message?: string;
}
