import * as vscode from "vscode";
import type { SlashExecutionResult, SlashCommand } from "./types.ts";

export interface SlashDispatcherDeps {
  rpc: {
    send(command: Record<string, unknown>): Promise<unknown>;
    prompt(text: string): Promise<void>;
  };
  isConnected: () => boolean;
  executeVscodeCommand: (command: string, ...args: unknown[]) => Thenable<unknown>;
  postToWebview: (message: unknown) => void;
  openSettingsPanel: (tab: "root" | "agents" | "mcp" | "tools" | "context" | "memory") => void;
  openHelpUrl: string;
}

export class SlashDispatcher {
  private readonly deps: SlashDispatcherDeps;

  constructor(deps: SlashDispatcherDeps) {
    this.deps = deps;
  }

  async execute(command: SlashCommand, args: string, raw: string): Promise<SlashExecutionResult> {
    try {
      if ((command.route.kind === "rpc" || command.route.kind === "passThrough") && !this.deps.isConnected()) {
        return { ok: false, command: command.name, message: "Runtime is not connected" };
      }
      switch (command.route.kind) {
        case "rpc":
          return this.executeRpc(command, args, raw);
        case "host":
          return this.executeHost(command, args);
        case "webview":
          return this.executeWebview(command);
        case "config":
          this.deps.openSettingsPanel(command.route.tab);
          return { ok: true, command: command.name, message: `Opened ${command.route.tab} settings` };
        case "blocked":
          return { ok: false, command: command.name, message: command.route.reason };
        case "passThrough":
          await this.deps.rpc.prompt(raw);
          return { ok: true, command: command.name };
        default:
          return { ok: false, command: command.name, message: "Unsupported command route" };
      }
    } catch (error) {
      return {
        ok: false,
        command: command.name,
        message: error instanceof Error ? error.message : "Command failed",
      };
    }
  }

  private async executeRpc(command: SlashCommand, args: string, raw: string): Promise<SlashExecutionResult> {
    const rpcType = command.route.kind === "rpc" ? command.route.rpcType : undefined;
    if (!rpcType) {
      return { ok: false, command: command.name, message: "Invalid RPC route" };
    }

    switch (rpcType) {
      case "compact": {
        await this.deps.rpc.send({ type: "compact", customInstructions: args || undefined });
        return { ok: true, command: command.name };
      }
      case "set_model": {
        const value = args.trim();
        const slash = value.indexOf("/");
        if (slash < 1 || slash === value.length - 1) {
          return {
            ok: false,
            command: command.name,
            message: "Usage: /model <provider/model>",
          };
        }
        const provider = value.slice(0, slash);
        const modelId = value.slice(slash + 1);
        await this.deps.rpc.send({ type: "set_model", provider, modelId });
        return { ok: true, command: command.name };
      }
      case "set_thinking_level": {
        if (!args.trim()) {
          return {
            ok: false,
            command: command.name,
            message: "Usage: /thinking <off|minimal|low|medium|high|max>",
          };
        }
        await this.deps.rpc.send({ type: "set_thinking_level", level: args.trim() });
        return { ok: true, command: command.name };
      }
      case "set_steering_mode": {
        const mode = args.trim().toLowerCase();
        if (mode !== "all" && mode !== "one") {
          return { ok: false, command: command.name, message: "Usage: /steer <all|one>" };
        }
        const steerValue = mode === "one" ? "one-at-a-time" : "all";
        await this.deps.rpc.send({ type: "set_steering_mode", mode: steerValue });
        return { ok: true, command: command.name };
      }
      case "set_follow_up_mode": {
        const mode = args.trim().toLowerCase();
        if (mode !== "all" && mode !== "one") {
          return { ok: false, command: command.name, message: "Usage: /followup <all|one>" };
        }
        const followUpValue = mode === "one" ? "one-at-a-time" : "all";
        await this.deps.rpc.send({ type: "set_follow_up_mode", mode: followUpValue });
        return { ok: true, command: command.name };
      }
      case "set_interrupt_mode": {
        const mode = args.trim();
        if (mode !== "immediate" && mode !== "wait") {
          return {
            ok: false,
            command: command.name,
            message: "Usage: /interrupt <immediate|wait>",
          };
        }
        await this.deps.rpc.send({ type: "set_interrupt_mode", mode });
        return { ok: true, command: command.name };
      }
      case "abort": {
        await this.deps.rpc.send({ type: "abort" });
        return { ok: true, command: command.name };
      }
      case "export_html": {
        await this.deps.rpc.send({ type: "export_html", outputPath: args || undefined });
        return { ok: true, command: command.name };
      }
      case "set_session_name": {
        if (!args.trim()) {
          return { ok: false, command: command.name, message: "Usage: /rename <name>" };
        }
        await this.deps.rpc.send({ type: "set_session_name", name: args.trim() });
        return { ok: true, command: command.name };
      }
      case "handoff": {
        await this.deps.rpc.send({ type: "handoff", customInstructions: args || undefined });
        return { ok: true, command: command.name };
      }
      case "get_commands": {
        await this.deps.rpc.send({ type: "get_commands" });
        return { ok: true, command: command.name };
      }
      case "get_available_models": {
        await this.deps.rpc.send({ type: "get_available_models" });
        return { ok: true, command: command.name };
      }
      case "cycle_model": {
        await this.deps.rpc.send({ type: "cycle_model" });
        return { ok: true, command: command.name };
      }
      case "cycle_thinking_level": {
        await this.deps.rpc.send({ type: "cycle_thinking_level" });
        return { ok: true, command: command.name };
      }
      case "set_auto_compaction": {
        const val = args.trim().toLowerCase();
        if (val !== "on" && val !== "off") {
          return { ok: false, command: command.name, message: "Usage: /auto-compact <on|off>" };
        }
        await this.deps.rpc.send({ type: "set_auto_compaction", enabled: val === "on" });
        return { ok: true, command: command.name };
      }
      case "set_auto_retry": {
        const val = args.trim().toLowerCase();
        if (val !== "on" && val !== "off") {
          return { ok: false, command: command.name, message: "Usage: /auto-retry <on|off>" };
        }
        await this.deps.rpc.send({ type: "set_auto_retry", enabled: val === "on" });
        return { ok: true, command: command.name };
      }
      case "abort_retry": {
        await this.deps.rpc.send({ type: "abort_retry" });
        return { ok: true, command: command.name };
      }
      case "new_session": {
        await this.deps.rpc.send({ type: "new_session" });
        return { ok: true, command: command.name };
      }
      case "get_last_assistant_text": {
        await this.deps.rpc.send({ type: "get_last_assistant_text" });
        return { ok: true, command: command.name };
      }
      case "get_messages": {
        await this.deps.rpc.send({ type: "get_messages" });
        return { ok: true, command: command.name };
      }
      case "get_session_stats": {
        await this.deps.rpc.send({ type: "get_session_stats" });
        return { ok: true, command: command.name };
      }
      default:
        return { ok: false, command: command.name, message: "RPC command type not yet implemented" };
    }
  }

  private async executeHost(command: SlashCommand, _args: string): Promise<SlashExecutionResult> {
    const action = command.route.kind === "host" ? command.route.action : undefined;
    if (!action) {
      return { ok: false, command: command.name, message: "Invalid host route" };
    }

    switch (action) {
      case "openChat":
        await this.deps.executeVscodeCommand("omp.openChat");
        return { ok: true, command: command.name };
      case "newSession":
        await this.deps.executeVscodeCommand("omp.newSession");
        return { ok: true, command: command.name };
      case "resumeSession":
        await this.deps.executeVscodeCommand("omp.resumeSession");
        return { ok: true, command: command.name };
      case "focusInput":
        await this.deps.executeVscodeCommand("omp.focusInput");
        return { ok: true, command: command.name };
      case "copyLast": {
        const result = await this.deps.rpc.send({ type: "get_last_assistant_text" });
        const text =
          typeof result === "object" &&
          result !== null &&
          "text" in result &&
          typeof (result as { text?: unknown }).text === "string"
            ? (result as { text: string }).text
            : "";
        await vscode.env.clipboard.writeText(text);
        return { ok: true, command: command.name, message: "Copied last assistant message" };
      }
      case "dumpJson": {
        const messages = await this.deps.rpc.send({ type: "get_messages" });
        await vscode.env.clipboard.writeText(JSON.stringify(messages, null, 2));
        return { ok: true, command: command.name, message: "Copied message JSON" };
      }
      case "openSessionFile":
        await this.deps.executeVscodeCommand("omp.openCurrentSessionInEditor");
        return { ok: true, command: command.name };
      case "showDiagnostics":
        await this.deps.executeVscodeCommand("omp.showDiagnosticsLog");
        return { ok: true, command: command.name };
      case "openHelpUrl":
        await vscode.env.openExternal(vscode.Uri.parse(this.deps.openHelpUrl));
        return { ok: true, command: command.name };
      case "clearComposer":
        this.deps.postToWebview({ type: "composer.clear" });
        return { ok: true, command: command.name };
      case "cycleRoles":
        await this.deps.executeVscodeCommand("omp.cycleRoles");
        return { ok: true, command: command.name };
      default:
        return { ok: false, command: command.name, message: "Unknown host action" };
    }
  }

  private async executeWebview(command: SlashCommand): Promise<SlashExecutionResult> {
    const action = command.route.kind === "webview" ? command.route.action : undefined;
    if (!action) {
      return { ok: false, command: command.name, message: "Invalid webview route" };
    }

    this.deps.postToWebview({ type: "ui.trigger", action });
    return { ok: true, command: command.name };
  }
}
