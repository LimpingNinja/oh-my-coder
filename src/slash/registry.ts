import type {
  ParsedSlashInput,
  RuntimeDiscoveredCommand,
  SlashCommand,
} from "./types.ts";

const BLOCKED_REASON =
  "This command is TUI-only in oh-my-pi and has no RPC equivalent yet.";

const STATIC_COMMANDS: SlashCommand[] = [
  {
    name: "compact",
    description: "Compact current conversation context",
    tier: 1,
    source: "omc",
    route: { kind: "rpc", rpcType: "compact" },
    acceptsArgs: true,
    argsHint: "[custom instructions]",
    phase: 1,
  },
  {
    name: "model",
    description: "Set model as provider/model",
    tier: 1,
    source: "omc",
    route: { kind: "rpc", rpcType: "set_model" },
    noArgsRedirect: "models",
    acceptsArgs: true,
    argsHint: "<provider/model>",
    phase: 1,
  },
  {
    name: "models",
    description: "Open model selector",
    tier: 3,
    source: "omc",
    route: { kind: "webview", action: "openModelSelector" },
    acceptsArgs: false,
    phase: 2,
  },
  {
    name: "thinking",
    description: "Set thinking level",
    tier: 1,
    source: "omc",
    route: { kind: "rpc", rpcType: "set_thinking_level" },
    noArgsRedirect: "thinking-picker",
    acceptsArgs: true,
    argsHint: "<off|minimal|low|medium|high|xhigh>",
    phase: 1,
  },
  {
    name: "thinking-picker",
    description: "Open thinking selector",
    tier: 3,
    source: "omc",
    route: { kind: "webview", action: "openThinkingSelector" },
    acceptsArgs: false,
    phase: 2,
  },
  {
    name: "model-picker",
    description: "Open model selector",
    tier: 3,
    source: "omc",
    route: { kind: "webview", action: "openModelSelector" },
    acceptsArgs: false,
    phase: 2,
  },
  {
    name: "steer",
    description: "Set steering mode",
    tier: 1,
    source: "omc",
    route: { kind: "rpc", rpcType: "set_steering_mode" },
    acceptsArgs: true,
    argsHint: "<all|one>",
    phase: 1,
  },
  {
    name: "followup",
    description: "Set follow-up mode",
    tier: 1,
    source: "omc",
    route: { kind: "rpc", rpcType: "set_follow_up_mode" },
    acceptsArgs: true,
    argsHint: "<all|one>",
    phase: 1,
  },
  {
    name: "interrupt",
    description: "Set interrupt mode",
    tier: 1,
    source: "omc",
    route: { kind: "rpc", rpcType: "set_interrupt_mode" },
    acceptsArgs: true,
    argsHint: "<immediate|wait>",
    phase: 1,
  },
  {
    name: "abort",
    description: "Abort active assistant response",
    tier: 1,
    source: "omc",
    route: { kind: "rpc", rpcType: "abort" },
    acceptsArgs: false,
    phase: 1,
  },
  {
    name: "cycle-model",
    description: "Cycle through favorite models",
    tier: 3,
    source: "omc",
    route: { kind: "webview", action: "cycleModel" },
    acceptsArgs: false,
    phase: 2,
  },
  {
    name: "cycle-roles",
    description: "Cycle through model roles",
    tier: 2,
    source: "omc",
    route: { kind: "host", action: "cycleRoles" },
    acceptsArgs: false,
    phase: 2,
  },
  {
    name: "cycle-thinking",
    description: "Cycle thinking level",
    tier: 1,
    source: "omc",
    route: { kind: "rpc", rpcType: "cycle_thinking_level" },
    acceptsArgs: false,
    phase: 2,
  },
  {
    name: "auto-compact",
    description: "Toggle auto compaction",
    tier: 1,
    source: "omc",
    route: { kind: "rpc", rpcType: "set_auto_compaction" },
    acceptsArgs: true,
    argsHint: "<on|off>",
    phase: 2,
  },
  {
    name: "auto-retry",
    description: "Toggle auto retry",
    tier: 1,
    source: "omc",
    route: { kind: "rpc", rpcType: "set_auto_retry" },
    acceptsArgs: true,
    argsHint: "<on|off>",
    phase: 2,
  },
  {
    name: "retry-abort",
    description: "Abort active retry",
    tier: 1,
    source: "omc",
    route: { kind: "rpc", rpcType: "abort_retry" },
    acceptsArgs: false,
    phase: 2,
  },
  {
    name: "new-session",
    description: "Start new runtime session",
    tier: 1,
    source: "omc",
    route: { kind: "rpc", rpcType: "new_session" },
    acceptsArgs: false,
    phase: 2,
  },
  {
    name: "stats",
    description: "Show session statistics",
    tier: 1,
    source: "omc",
    route: { kind: "rpc", rpcType: "get_session_stats" },
    acceptsArgs: false,
    phase: 2,
  },
  {
    name: "export-html",
    description: "Export transcript to HTML",
    tier: 1,
    source: "omc",
    route: { kind: "rpc", rpcType: "export_html" },
    acceptsArgs: true,
    argsHint: "[output path]",
    phase: 1,
  },
  {
    name: "handoff",
    description: "Create handoff package",
    tier: 1,
    source: "omc",
    route: { kind: "rpc", rpcType: "handoff" },
    acceptsArgs: true,
    argsHint: "[custom instructions]",
    phase: 1,
  },
  {
    name: "rename",
    description: "Rename current session",
    tier: 1,
    source: "omc",
    route: { kind: "rpc", rpcType: "set_session_name" },
    acceptsArgs: true,
    argsHint: "<new name>",
    phase: 1,
  },
  {
    name: "commands-refresh",
    description: "Refresh slash command catalog from runtime",
    tier: 1,
    source: "omc",
    route: { kind: "rpc", rpcType: "get_commands" },
    acceptsArgs: false,
    phase: 1,
  },
  {
    name: "new",
    description: "Start a new OMC session",
    tier: 2,
    source: "omc",
    route: { kind: "host", action: "newSession" },
    acceptsArgs: false,
    phase: 1,
  },
  {
    name: "resume",
    description: "Resume an existing session",
    tier: 2,
    source: "omc",
    route: { kind: "host", action: "resumeSession" },
    acceptsArgs: false,
    phase: 2,
  },
  {
    name: "copy-last",
    description: "Copy last assistant message",
    tier: 2,
    source: "omc",
    route: { kind: "host", action: "copyLast" },
    acceptsArgs: false,
    phase: 1,
  },
  {
    name: "open-chat",
    description: "Focus OMC chat view",
    tier: 2,
    source: "omc",
    route: { kind: "host", action: "openChat" },
    acceptsArgs: false,
    phase: 2,
  },
  {
    name: "open-session-file",
    description: "Open current session in editor",
    tier: 2,
    source: "omc",
    route: { kind: "host", action: "openSessionFile" },
    acceptsArgs: false,
    phase: 2,
  },
  {
    name: "dump-json",
    description: "Copy full message history JSON",
    tier: 2,
    source: "omc",
    route: { kind: "host", action: "dumpJson" },
    acceptsArgs: false,
    phase: 2,
  },
  {
    name: "diagnostics",
    description: "Show OMC diagnostics output channel",
    tier: 2,
    source: "omc",
    route: { kind: "host", action: "showDiagnostics" },
    acceptsArgs: false,
    phase: 1,
  },
  {
    name: "help",
    description: "Open OMC documentation",
    tier: 2,
    source: "omc",
    route: { kind: "host", action: "openHelpUrl" },
    acceptsArgs: false,
    phase: 1,
  },
  {
    name: "history",
    description: "Open session history UI",
    tier: 3,
    source: "omc",
    route: { kind: "webview", action: "openHistory" },
    acceptsArgs: false,
    phase: 2,
  },
  {
    name: "settings",
    description: "Open OMC settings panel",
    tier: 5,
    source: "omc",
    route: { kind: "config", tab: "root" },
    acceptsArgs: false,
    phase: 3,
  },
  {
    name: "agents",
    description: "Open agent management settings",
    tier: 5,
    source: "omc",
    route: { kind: "config", tab: "agents" },
    acceptsArgs: false,
    phase: 3,
  },
  {
    name: "mcp",
    description: "Open MCP settings",
    tier: 5,
    source: "omc",
    route: { kind: "config", tab: "mcp" },
    acceptsArgs: false,
    phase: 4,
  },
  {
    name: "tools",
    description: "Open tools settings",
    tier: 5,
    source: "omc",
    route: { kind: "config", tab: "tools" },
    acceptsArgs: false,
    phase: 4,
  },
  {
    name: "context",
    description: "Open context settings",
    tier: 5,
    source: "omc",
    route: { kind: "config", tab: "context" },
    acceptsArgs: false,
    phase: 4,
  },
  {
    name: "plan",
    description: "Plan mode (TUI only)",
    tier: 6,
    source: "omc",
    route: { kind: "blocked", reason: BLOCKED_REASON },
    acceptsArgs: false,
    phase: 5,
  },
  {
    name: "loop",
    description: "Loop mode (TUI only)",
    tier: 6,
    source: "omc",
    route: { kind: "blocked", reason: BLOCKED_REASON },
    acceptsArgs: false,
    phase: 5,
  },
  {
    name: "fast",
    description: "Fast mode (TUI only)",
    tier: 6,
    source: "omc",
    route: { kind: "blocked", reason: BLOCKED_REASON },
    acceptsArgs: false,
    phase: 5,
  },
];

export function parseSlashInput(input: string): ParsedSlashInput {
  const raw = input.trim();
  if (!raw.startsWith("/")) {
    return { isSlash: false, raw, command: "", args: "" };
  }

  const withoutLeading = raw.slice(1);
  if (withoutLeading.length === 0) {
    return { isSlash: true, raw, command: "", args: "" };
  }

  const firstSpace = withoutLeading.search(/\s/);
  if (firstSpace < 0) {
    return {
      isSlash: true,
      raw,
      command: normalizeCommandName(withoutLeading),
      args: "",
    };
  }

  return {
    isSlash: true,
    raw,
    command: normalizeCommandName(withoutLeading.slice(0, firstSpace)),
    args: withoutLeading.slice(firstSpace + 1).trim(),
  };
}

export function normalizeCommandName(name: string): string {
  const v = name.trim().replace(/^\/+/, "").toLowerCase();
  return v;
}

export function mergeSlashCatalog(
  runtimeCommands: RuntimeDiscoveredCommand[],
): SlashCommand[] {
  const byName = new Map<string, SlashCommand>();

  for (const staticCommand of STATIC_COMMANDS) {
    byName.set(staticCommand.name, staticCommand);
    for (const alias of staticCommand.aliases ?? []) {
      byName.set(normalizeCommandName(alias), staticCommand);
    }
  }

  for (const runtimeCommand of runtimeCommands) {
    const key = normalizeCommandName(runtimeCommand.name);
    const existing = byName.get(key);

    if (existing) {
      if (!existing.runtimeMeta) {
        existing.runtimeMeta = {
          source: runtimeCommand.source,
          location: runtimeCommand.location ?? runtimeCommand.sourceInfo?.location,
          path: runtimeCommand.path ?? runtimeCommand.sourceInfo?.path,
        };
      }
      continue;
    }

    const runtimeAsSlash: SlashCommand = {
      name: key,
      description:
        runtimeCommand.description ??
        `Runtime-discovered ${runtimeCommand.source} command`,
      tier: 4,
      source: "runtime",
      route: { kind: "passThrough" },
      acceptsArgs: true,
      argsHint: "[args]",
      phase: 1,
      runtimeMeta: {
        source: runtimeCommand.source,
        location: runtimeCommand.location ?? runtimeCommand.sourceInfo?.location,
        path: runtimeCommand.path ?? runtimeCommand.sourceInfo?.path,
      },
    };

    byName.set(key, runtimeAsSlash);
  }

  const unique = new Map<string, SlashCommand>();
  for (const [name, cmd] of byName.entries()) {
    if (!unique.has(name) && cmd.name === name) {
      unique.set(name, cmd);
    }
  }

  return [...unique.values()].sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    return a.name.localeCompare(b.name);
  });
}

export function findSlashCommand(
  catalog: SlashCommand[],
  commandName: string,
): SlashCommand | undefined {
  const key = normalizeCommandName(commandName);
  return catalog.find((item) => {
    if (item.name === key) return true;
    return (item.aliases ?? []).some((alias) => normalizeCommandName(alias) === key);
  });
}

export function resolveSlashCommand(
  catalog: SlashCommand[],
  commandName: string,
  args: string,
): SlashCommand | undefined {
  const primary = findSlashCommand(catalog, commandName);
  if (!primary) return undefined;
  if (primary.noArgsRedirect && !args.trim()) {
    return findSlashCommand(catalog, primary.noArgsRedirect) ?? primary;
  }
  return primary;
}
