import { createBridge } from "./bridge/server.ts";
import type { BridgeContext } from "./bridge/types.ts";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as vscode from "vscode";
import { stringify as stringifyYaml } from "yaml";
import { findOmpBinary, createOmpEnvironment } from "./omp.ts";
import { OmpChatProvider } from "./webview/provider.ts";
import type {
  ChatAttachment,
  ExtensionToWebviewMessage,
  ChatFileContext,
  WebviewToExtensionMessage,
  OmpLaunchState,
  ProviderStatusEntry,
} from "./protocol/webviewMessages.ts";
import { EMPTY_HEADER_STATE } from "./protocol/footerTypes.ts";
import type { ChatHeaderState, ChatFooterItem } from "./protocol/footerTypes.ts";
import { listWorkspaceSessions, validateResumePath } from "./session/discovery.ts";
import {
  resolveWorkspaceScope,
  getEffectiveWorkspaceFolder,
  getOmpSessionDir,
} from "./session/workspaceScope.ts";
import type { OmpSessionListState, OmpSessionSummary } from "./session/types.ts";
import { OmpRpcControllerImpl } from "./rpc/controller.ts";
import type { OmpLaunchRequest } from "./rpc/types.ts";
import type {
  OmpAvailableModel,
  OmpRuntimeState,
  OmpStatePayload,
} from "./protocol/ompRpcTypes.ts";
import {
  OmpResumePathError,
  OmpStartupError,
  OmpStartupTimeoutError,
  OmpSpawnError,
} from "./rpc/errors.ts";
import { TranscriptManager } from "./transcript/manager.ts";
import { readHydrationFromJsonl } from "./transcript/turnMetadataReader.ts";
import { refreshCatalog, loadFromDisk, getCatalogEntries, isExpired } from "./models/catalog.ts";
import { parseSlashInput, mergeSlashCatalog, resolveSlashCommand } from "./slash/registry.ts";
import { SlashDispatcher } from "./slash/dispatcher.ts";
import type { RuntimeDiscoveredCommand, SlashCommand } from "./slash/types.ts";
import { expandCommand } from "./slash/expander.ts";
import {
  getOmpConfig,
  refreshOmpConfig,
  resolveAgentDir,
  writeOmpConfig,
  watchConfigFile,
  getOmpConfigPath,
} from "./config/ompConfig.ts";
import { SettingsEditorProvider } from "./settings/provider.ts";

let extensionUri: vscode.Uri;
let outputChannel: vscode.OutputChannel;

// Bridge state — populated during activation, disposed on deactivate.
let bridgeContext: BridgeContext | undefined;

// Webview provider — created during activation, disposed on deactivate.
let chatProvider: OmpChatProvider | undefined;

// RPC controller — owns the single active OMP process.
let rpcController: OmpRpcControllerImpl | undefined;

// Slash command state — merged static/runtime slash catalog and dispatcher.
let slashCatalog: SlashCommand[] = [];
let slashCatalogVersion = "0";
let slashDispatcher: SlashDispatcher | undefined;

// Discovered agent definitions — pushed from the bridge extension.
interface DiscoveredAgent {
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
interface ReverseAgentsResult {
  ok?: boolean;
  count?: number;
  error?: string;
  agents?: DiscoveredAgent[];
}
let discoveredAgents: DiscoveredAgent[] = [];

// Discovered skills/commands — fetched from the bridge extension.
interface DiscoveredSkill {
  name: string;
  description: string;
  source: string;
  location: string;
  path: string;
}
interface ReverseSkillsResult {
  ok?: boolean;
  count?: number;
  error?: string;
  skills?: DiscoveredSkill[];
}
let discoveredSkills: DiscoveredSkill[] = [];

// Discovered MCP servers — fetched from the bridge extension.
interface DiscoveredMcpServer {
  name: string;
  type: string;
  status: string;
  enabled: boolean;
  source: string;
  sourcePath: string;
  config: Record<string, unknown>;
}
interface ReverseMcpServersResult {
  ok?: boolean;
  count?: number;
  error?: string;
  servers?: DiscoveredMcpServer[];
}
let discoveredMcpServers: DiscoveredMcpServer[] = [];
interface ReverseModelsResult {
  ok?: boolean;
  count?: number;
  error?: string;
  models?: unknown;
}
const CURRENT_PHASE = 4;
// Session state — tracks the current session list and selection.
// These are owned by the extension host; the webview renders them.
let currentSessionListState: OmpSessionListState = { kind: "loading" };
let currentSessions: OmpSessionSummary[] = [];
let selectedSessionPath: string | undefined;

// Runtime state — tracks the current OMP process state for the webview.
let currentRuntimeState: OmpRuntimeState = { kind: "disconnected" };
let currentLaunchState: OmpLaunchState | undefined;
let currentActiveSessionPath: string | undefined;

// Transcript manager — owns transcript state for the active session.
let transcriptManager: TranscriptManager | undefined;

// Pending user attachments — stashed before prompt, consumed by bridge callback.
let pendingUserAttachments: {
  fileContexts: Array<{ path: string; line?: number; endLine?: number; languageId?: string }>;
} | null = null;

// Header state — tracks the header presentation state for the webview.
let currentHeaderState: ChatHeaderState = { ...EMPTY_HEADER_STATE };

// Accumulated session cost (from message_end usage data).
let sessionCostAccumulator = 0;
let sessionTokensInput = 0;
let sessionTokensOutput = 0;
let sessionTokensCacheRead = 0;

// Per-turn accumulators — reset at agent_start, emitted at agent_end.
let turnCostAccumulator = 0;
let turnTokensInput = 0;
let turnTokensOutput = 0;
let turnTokensCacheRead = 0;
let turnStartTimestamp = 0;

// Queue delivery modes from runtime state.
let currentSteeringMode: string = "one-at-a-time";
let currentFollowUpMode: string = "one-at-a-time";
let currentInterruptMode: string = "immediate";

// Cached available models from get_available_models.
let cachedAvailableModels: OmpAvailableModel[] = [];

// Model role cycling state (from config.yml).
let currentModelRole: string = "default";
let cachedModelRoles: Record<string, string> = {};
let cachedCycleOrder: string[] = ["smol", "default", "slow"];


// Save-in-flight guard: suppresses config watcher pushes during known saves (Rule 7).
let saveInFlight = false;
// Pending extension UI requests — buffered for webview delivery and response routing.
const pendingUiRequests = new Map<
  string,
  {
    request: import("./protocol/webviewMessages.ts").ExtensionUiRequestForWebview;
    timestamp: number;
  }
>();

/**
 * Start the OMP bridge server.
 *
 * Creates a local authenticated HTTP RPC endpoint that the OMP runtime
 * bridge extension uses to access VS Code editor/workspace capabilities.
 * Startup failures are logged to the output channel so the extension
 * remains usable (commands, webview) but the bridge is honestly down.
 */
async function startBridge(
  context: vscode.ExtensionContext,
): Promise<{ url: string; token: string } | undefined> {
  try {
    const bridge = await createBridge(
      context,
      undefined,
      () => ({
        model: currentHeaderState.details?.model,
        thinkingLevel: currentHeaderState.details?.thinkingLevel,
        contextPercent: currentHeaderState.contextPercent,
        tokens:
          turnTokensInput > 0 || turnTokensOutput > 0 || turnTokensCacheRead > 0
            ? { input: turnTokensInput, output: turnTokensOutput, cacheRead: turnTokensCacheRead }
            : undefined,
        costUsd: turnCostAccumulator > 0 ? turnCostAccumulator : undefined,
        durationMs: turnStartTimestamp > 0 ? Date.now() - turnStartTimestamp : undefined,
      }),
      () => {
        const result = pendingUserAttachments;
        pendingUserAttachments = null;
        return result;
      },
      (commands) => {
        outputChannel.appendLine(`[omp] Bridge pushed ${commands.length} runtime commands`);
        const runtimeCommands: RuntimeDiscoveredCommand[] = commands.map((cmd) => ({
          name: cmd.name,
          description: cmd.description,
          source: (cmd.source as "extension" | "prompt" | "skill") || "prompt",
          location: cmd.location,
          path: cmd.path,
        }));
        slashCatalog = mergeSlashCatalog(runtimeCommands);
        slashCatalogVersion = `${Date.now()}`;
        pushSlashCatalog();
      },
      (agents) => {
        outputChannel.appendLine(`[omp] Bridge pushed ${agents.length} agent definitions`);
        discoveredAgents = agents;
      },
      (port) => {
        outputChannel.appendLine(`[omp] Reverse bridge registered on port ${port}`);
        void (async () => {
          const config = await getOmpConfig();
          const settingsConfig = await getSettingsPanelConfig(config.raw);
          const agents = await fetchAgentsFromReverseBridge();
          const providerStatus = await fetchProviderStatusFromReverseBridge();
          const skills = await fetchSkillsFromReverseBridge();
          const mcpServers = await fetchMcpServersFromReverseBridge();
          const payload = {
            type: "settings.loaded" as const,
            config: settingsConfig,
            agents,
            bridgeAvailable: !!bridgeContext?.reverseBridgePort,
            providerStatus,
            skills,
            mcpServers,
          };
          postToWebview(payload);
          SettingsEditorProvider.postMessage(payload);
        })();
      },
    );
    bridgeContext = bridge;
    outputChannel.appendLine(`[omp] bridge started at ${bridge.url}`);
    return { url: bridge.url, token: bridge.token };
  } catch (error) {
    outputChannel.appendLine(
      `[omp] bridge startup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

interface EditableAgentPayload {
  name: string;
  description: string;
  systemPrompt: string;
  tools?: string[];
  model?: string | string[];
  thinkingLevel?: string;
}

function sanitizeAgentFileName(name: string): string {
  return name
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function getProjectAgentsDir(): string {
  const scope = resolveWorkspaceScope(vscode.workspace.workspaceFolders);
  const workspaceFolder = getEffectiveWorkspaceFolder(scope);
  if (!workspaceFolder) {
    throw new Error("No workspace folder is available for project agent creation.");
  }
  return path.join(workspaceFolder, ".omp", "agents");
}

function getGlobalAgentsDir(): string {
  return path.join(os.homedir(), ".omp", "agents");
}

function resolveAgentWritePath(
  scope: "global" | "project",
  agent: EditableAgentPayload,
  filePath?: string,
): string {
  const baseDir = scope === "global" ? getGlobalAgentsDir() : getProjectAgentsDir();
  const resolvedBase = path.resolve(baseDir);
  const target = filePath
    ? path.resolve(filePath)
    : path.join(resolvedBase, `${sanitizeAgentFileName(agent.name)}.md`);
  const relative = path.relative(resolvedBase, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Agent files can only be written inside the selected OMP agents directory.");
  }
  if (!target.endsWith(".md")) {
    throw new Error("Agent file must use a .md extension.");
  }
  return target;
}

function agentMarkdown(agent: EditableAgentPayload): string {
  const frontmatter: Record<string, unknown> = {
    name: agent.name.trim(),
    description: agent.description.trim(),
  };
  if (agent.tools && agent.tools.length > 0) frontmatter.tools = agent.tools;
  if (agent.model && (Array.isArray(agent.model) ? agent.model.length > 0 : agent.model.trim())) {
    frontmatter.model = agent.model;
  }
  if (agent.thinkingLevel?.trim()) frontmatter.thinkingLevel = agent.thinkingLevel.trim();
  const yaml = stringifyYaml(frontmatter).trimEnd();
  return `---\n${yaml}\n---\n${agent.systemPrompt.trimEnd()}\n`;
}

async function writeAgentDefinition(
  scope: "global" | "project",
  agent: EditableAgentPayload,
  filePath?: string,
): Promise<string> {
  if (!agent.name.trim()) throw new Error("Agent name is required.");
  if (!agent.description.trim()) throw new Error("Agent description is required.");
  const target = resolveAgentWritePath(scope, agent, filePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, agentMarkdown(agent), "utf-8");
  return target;
}

function resolveAgentDeletePath(filePath: string): string {
  const target = path.resolve(filePath);
  const allowedDirs = [getGlobalAgentsDir()];
  try {
    allowedDirs.push(getProjectAgentsDir());
  } catch {
    // No project folder; global deletion may still be valid.
  }
  for (const dir of allowedDirs) {
    const base = path.resolve(dir);
    const relative = path.relative(base, target);
    if (!relative.startsWith("..") && !path.isAbsolute(relative) && target.endsWith(".md")) {
      return target;
    }
  }
  throw new Error("Agent files can only be deleted from OMP global/project agents directories.");
}

async function deleteAgentDefinition(filePath: string): Promise<void> {
  await fs.unlink(resolveAgentDeletePath(filePath));
}


// ── Skill CRUD ─────────────────────────────────────────────────────────────────

interface EditableSkillPayload {
  name: string;
  description: string;
  globs?: string[];
  alwaysApply?: boolean;
  allowedTools?: string[];
  content: string;
}

function getGlobalSkillsDir(): string {
  return path.join(os.homedir(), ".omp", "agent", "commands");
}

function getProjectSkillsDir(): string {
  const scope = resolveWorkspaceScope(vscode.workspace.workspaceFolders);
  const workspaceFolder = getEffectiveWorkspaceFolder(scope);
  if (!workspaceFolder) {
    throw new Error("No workspace folder is available for project skill creation.");
  }
  return path.join(workspaceFolder, ".omp", "commands");
}

function skillMarkdown(skill: EditableSkillPayload): string {
  const frontmatter: Record<string, unknown> = {
    description: skill.description.trim(),
  };
  if (skill.globs && skill.globs.length > 0) frontmatter.globs = skill.globs;
  if (skill.alwaysApply) frontmatter.alwaysApply = true;
  if (skill.allowedTools && skill.allowedTools.length > 0) frontmatter["allowed-tools"] = skill.allowedTools;
  const yaml = stringifyYaml(frontmatter).trimEnd();
  return `---\n${yaml}\n---\n${skill.content.trimEnd()}\n`;
}

async function writeSkillDefinition(
  scope: "global" | "project",
  skill: EditableSkillPayload,
): Promise<string> {
  if (!skill.name.trim()) throw new Error("Skill name is required.");
  if (!skill.description.trim()) throw new Error("Skill description is required.");
  const baseDir = scope === "global" ? getGlobalSkillsDir() : getProjectSkillsDir();
  const resolvedBase = path.resolve(baseDir);
  const target = path.join(resolvedBase, `${sanitizeAgentFileName(skill.name)}.md`);
  const relative = path.relative(resolvedBase, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Skill files can only be written inside the OMP commands directory.");
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, skillMarkdown(skill), "utf-8");
  return target;
}

function resolveSkillDeletePath(filePath: string): string {
  const target = path.resolve(filePath);
  const allowedDirs = [getGlobalSkillsDir()];
  try {
    allowedDirs.push(getProjectSkillsDir());
  } catch {
    // No project folder; global deletion may still be valid.
  }
  for (const dir of allowedDirs) {
    const base = path.resolve(dir);
    const relative = path.relative(base, target);
    if (!relative.startsWith("..") && !path.isAbsolute(relative) && target.endsWith(".md")) {
      return target;
    }
  }
  throw new Error("Skill files can only be deleted from OMP global/project commands directories.");
}

async function deleteSkillDefinition(filePath: string): Promise<void> {
  await fs.unlink(resolveSkillDeletePath(filePath));
}

// ── MCP CRUD ──────────────────────────────────────────────────────────────────

interface EditableMcpServerPayload {
  name: string;
  type: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  timeout?: number;
}

function getMcpConfigPath(scope: "global" | "project"): string {
  if (scope === "global") {
    return path.join(os.homedir(), ".omp", "agent", "mcp.json");
  }
  const wsScope = resolveWorkspaceScope(vscode.workspace.workspaceFolders);
  const workspaceFolder = getEffectiveWorkspaceFolder(wsScope);
  if (!workspaceFolder) {
    throw new Error("No workspace folder is available for project MCP configuration.");
  }
  return path.join(workspaceFolder, ".mcp.json");
}

async function readMcpConfig(filePath: string): Promise<Record<string, unknown>> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return { mcpServers: {} };
  }
}

async function writeMcpServer(
  scope: "global" | "project",
  server: EditableMcpServerPayload,
): Promise<string> {
  if (!server.name.trim()) throw new Error("Server name is required.");
  const filePath = getMcpConfigPath(scope);
  const config = await readMcpConfig(filePath);
  if (!config.mcpServers || typeof config.mcpServers !== "object") {
    config.mcpServers = {};
  }
  const entry: Record<string, unknown> = { type: server.type };
  if (server.type === "stdio") {
    if (!server.command?.trim()) throw new Error("Command is required for stdio servers.");
    entry.command = server.command.trim();
    if (server.args && server.args.length > 0) entry.args = server.args;
  } else {
    if (!server.url?.trim()) throw new Error("URL is required for http/sse servers.");
    entry.url = server.url.trim();
  }
  if (server.timeout != null && server.timeout > 0) entry.timeout = server.timeout;
  (config.mcpServers as Record<string, unknown>)[server.name.trim()] = entry;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  return filePath;
}

async function deleteMcpServer(
  scope: "global" | "project",
  name: string,
): Promise<string> {
  if (!name.trim()) throw new Error("Server name is required.");
  const filePath = getMcpConfigPath(scope);
  const config = await readMcpConfig(filePath);
  if (config.mcpServers && typeof config.mcpServers === "object") {
    delete (config.mcpServers as Record<string, unknown>)[name.trim()];
  }
  await fs.writeFile(filePath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  return filePath;
}
async function resolveStartupModelDefaults(
  requestedModel?: string,
  requestedThinking?: string,
): Promise<{ model?: string; thinking?: string }> {
  if (requestedModel || requestedThinking) {
    return { model: requestedModel, thinking: requestedThinking };
  }

  const config = await getOmpConfig();
  const defaultRole = config.modelRoles.default?.trim();
  if (!defaultRole) {
    return { model: requestedModel, thinking: requestedThinking };
  }

  let model = defaultRole;
  let thinking = config.defaultThinkingLevel;
  const lastColon = defaultRole.lastIndexOf(":");
  const slash = defaultRole.indexOf("/");
  if (lastColon > slash) {
    model = defaultRole.slice(0, lastColon);
    thinking = defaultRole.slice(lastColon + 1) || thinking;
  }

  return { model, thinking };
}


const SETTINGS_PANEL_RUNTIME_KEYS = [
  "ask.notify",
  "ask.timeout",
  "async.enabled",
  "async.pollWaitDuration",
  "autocompleteMaxVisible",
  "autoResume",
  "bash.autoBackground.enabled",
  "astEdit.enabled",
  "astGrep.enabled",
  "bashInterceptor.enabled",
  "branchSummary.enabled",
  "browser.enabled",
  "browser.headless",
  "browser.screenshotDir",
  "calc.enabled",
  "checkpoint.enabled",
  "collapseChangelog",
  "commands.enableClaudeProject",
  "commands.enableClaudeUser",
  "commands.enableOpencodeProject",
  "commands.enableOpencodeUser",
  "compaction.enabled",
  "compaction.handoffSaveToDisk",
  "compaction.idleEnabled",
  "compaction.idleThresholdTokens",
  "compaction.idleTimeoutSeconds",
  "compaction.remoteEnabled",
  "compaction.strategy",
  "compaction.thresholdPercent",
  "compaction.thresholdTokens",
  "completion.notify",
  "contextPromotion.enabled",
  "cycleOrder",
  "debug.enabled",
  "defaultThinkingLevel",
  "dev.autoqa",
  "disabledProviders",
  "enabledModels",
  "doubleEscapeAction",
  "edit.blockAutoGenerated",
  "edit.fuzzyMatch",
  "edit.fuzzyThreshold",
  "edit.mode",
  "edit.streamingAbort",
  "eval.js",
  "eval.py",
  "exa.enabled",
  "exa.enableResearcher",
  "exa.enableSearch",
  "exa.enableWebsets",
  "fetch.enabled",
  "find.enabled",
  "followUpMode",
  "github.enabled",
  "hideThinkingBlock",
  "hindsight.apiUrl",
  "hindsight.autoRecall",
  "hindsight.autoRetain",
  "hindsight.bankId",
  "hindsight.mentalModelAutoSeed",
  "hindsight.mentalModelsEnabled",
  "hindsight.retainMode",
  "hindsight.scoping",
  "inspect_image.enabled",
  "interruptMode",
  "loop.mode",
  "irc.enabled",
  "lsp.diagnosticsOnEdit",
  "lsp.diagnosticsOnWrite",
  "lsp.enabled",
  "lsp.formatOnWrite",
  "marketplace.autoUpdate",
  "memory.backend",
  "mcp.discoveryMode",
  "mcp.enableProjectConfig",
  "mcp.notificationDebounceMs",
  "mcp.notifications",
  "modelProviderOrder",
  "modelRoles",
  "notebook.enabled",
  "presencePenalty",
  "minP",
  "providers.image",
  "providers.kimiApiFormat",
  "providers.openaiWebsockets",
  "providers.parallelFetch",
  "providers.webSearch",
  "python.kernelMode",
  "python.sharedGateway",
  "read.defaultLimit",
  "repeatToolDescriptions",
  "read.toolResultPreview",
  "readHashLines",
  "readLineNumbers",
  "recipe.enabled",
  "renderMermaid.enabled",
  "repetitionPenalty",
  "retry.fallbackRevertPolicy",
  "retry.maxRetries",
  "search.contextAfter",
  "search.contextBefore",
  "search.enabled",
  "searxng.endpoint",
  "secrets.enabled",
  "serviceTier",
  "startup.checkUpdate",
  "startup.quiet",
  "shellMinimizer.enabled",
  "skills.enableSkillCommands",
  "steeringMode",
  "stt.enabled",
  "stt.modelName",
  "task.agentModelOverrides",
  "task.disabledAgents",
  "task.eager",
  "task.isolation.commits",
  "task.isolation.merge",
  "task.isolation.mode",
  "task.maxConcurrency",
  "task.maxRecursionDepth",
  "task.simple",
  "tasks.todoClearDelay",
  "temperature",
  "todo.eager",
  "todo.enabled",
  "todo.reminders",
  "todo.reminders.max",
  "tools.artifactSpillThreshold",
  "tools.artifactTailBytes",
  "tools.artifactTailLines",
  "tools.intentTracing",
  "tools.maxTimeout",
  "topK",
  "topP",
  "treeFilterMode",
  "ttsr.contextMode",
  "ttsr.enabled",
  "ttsr.interruptMode",
  "ttsr.repeatGap",
  "ttsr.repeatMode",
  "web_search.enabled",
] as const;

async function callReverseBridge(path: string, body?: unknown): Promise<unknown> {
  const port = bridgeContext?.reverseBridgePort;
  if (!port) {
    outputChannel.appendLine("[omp] Reverse bridge not available");
    return undefined;
  }
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: body !== undefined ? "POST" : "GET",
      headers: {
        "content-type": "application/json",
        "x-omp-authorization": bridgeContext!.token,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: response.statusText }));
      outputChannel.appendLine(`[omp] Reverse bridge ${path} failed: ${JSON.stringify(err)}`);
      return undefined;
    }
    return await response.json();
  } catch (err) {
    outputChannel.appendLine(
      `[omp] Reverse bridge ${path} error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

async function getSettingsPanelConfig(rawConfig: Record<string, unknown>): Promise<Record<string, unknown>> {
  const runtimeSettings = await callReverseBridge("/get-settings", {
    keys: SETTINGS_PANEL_RUNTIME_KEYS,
  });

  if (!runtimeSettings || typeof runtimeSettings !== "object" || Array.isArray(runtimeSettings)) {
    return rawConfig;
  }

  return {
    ...rawConfig,
    ...(runtimeSettings as Record<string, unknown>),
  };
}

async function fetchAgentsFromReverseBridge(): Promise<DiscoveredAgent[]> {
  outputChannel.appendLine(
    `[omp] Fetching agents via reverse bridge (port=${bridgeContext?.reverseBridgePort ?? "none"})`,
  );
  const result = (await callReverseBridge("/agents")) as ReverseAgentsResult | undefined;
  if (!result) {
    outputChannel.appendLine("[omp] Agent discovery via reverse bridge returned no response");
    return discoveredAgents;
  }
  if (!result.ok) {
    outputChannel.appendLine(
      `[omp] Agent discovery via reverse bridge failed: ${result.error ?? "unknown error"}`,
    );
    return discoveredAgents;
  }
  if (!Array.isArray(result.agents)) {
    outputChannel.appendLine("[omp] Agent discovery via reverse bridge returned malformed payload");
    return discoveredAgents;
  }
  discoveredAgents = result.agents;
  const sources = discoveredAgents.reduce<Record<string, number>>((acc, agent) => {
    acc[agent.source] = (acc[agent.source] ?? 0) + 1;
    return acc;
  }, {});
  outputChannel.appendLine(
    `[omp] Agent discovery loaded ${discoveredAgents.length} agents via reverse bridge: ${JSON.stringify(sources)}`,
  );
  return discoveredAgents;
}

async function fetchProviderStatusFromReverseBridge(): Promise<ProviderStatusEntry[]> {
  const result = (await callReverseBridge("/provider-status")) as
    | { providers: ProviderStatusEntry[] }
    | undefined;
  if (!result || !Array.isArray(result.providers)) return [];
  return result.providers;
}

async function fetchSkillsFromReverseBridge(): Promise<DiscoveredSkill[]> {
  const result = (await callReverseBridge("/skills")) as ReverseSkillsResult | undefined;
  if (!result) return discoveredSkills;
  if (!result.ok) {
    outputChannel.appendLine(
      `[omp] Skills discovery via reverse bridge failed: ${result.error ?? "unknown error"}`,
    );
    return discoveredSkills;
  }
  if (!Array.isArray(result.skills)) return discoveredSkills;
  discoveredSkills = result.skills;
  outputChannel.appendLine(
    `[omp] Skills discovery loaded ${discoveredSkills.length} skills via reverse bridge`,
  );
  return discoveredSkills;
}

async function fetchMcpServersFromReverseBridge(): Promise<DiscoveredMcpServer[]> {
  const result = (await callReverseBridge("/mcp-servers")) as ReverseMcpServersResult | undefined;
  if (!result) return discoveredMcpServers;
  if (!result.ok) {
    outputChannel.appendLine(
      `[omp] MCP servers discovery via reverse bridge failed: ${result.error ?? "unknown error"}`,
    );
    return discoveredMcpServers;
  }
  if (!Array.isArray(result.servers)) return discoveredMcpServers;
  discoveredMcpServers = result.servers;
  outputChannel.appendLine(
    `[omp] MCP servers discovery loaded ${discoveredMcpServers.length} servers via reverse bridge`,
  );
  return discoveredMcpServers;
}

function normalizeAvailableModels(models: unknown): OmpAvailableModel[] {
  if (!Array.isArray(models)) return [];
  return models.filter((model): model is OmpAvailableModel => {
    if (typeof model !== "object" || model === null) return false;
    const record = model as Record<string, unknown>;
    return typeof record.provider === "string" && typeof record.id === "string";
  });
}

function mergeAvailableModels(
  primary: OmpAvailableModel[],
  secondary: OmpAvailableModel[],
): OmpAvailableModel[] {
  if (secondary.length === 0) return primary;
  const seen = new Set(primary.map((model) => `${model.provider}/${model.id}`));
  const merged = [...primary];
  for (const model of secondary) {
    const key = `${model.provider}/${model.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(model);
  }
  return merged;
}

async function fetchModelsFromReverseBridge(): Promise<OmpAvailableModel[]> {
  const result = (await callReverseBridge("/models")) as ReverseModelsResult | undefined;
  if (!result) return [];
  if (!result.ok) {
    outputChannel.appendLine(
      `[omp] Model discovery via reverse bridge failed: ${result.error ?? "unknown error"}`,
    );
    return [];
  }
  const models = normalizeAvailableModels(result.models);
  outputChannel.appendLine(
    `[omp] Model discovery loaded ${models.length} models via reverse bridge`,
  );
  return models;
}

function postAvailableModels(
  models: OmpAvailableModel[],
  source: "runtime" | "cache" | "refresh",
): void {
  const message = {
    type: "runtime.availableModels" as const,
    models,
    source,
    updatedAt: Date.now(),
  };
  postToWebview(message);
  SettingsEditorProvider.postMessage(message);
}

function refreshAvailableModels(source: "runtime" | "refresh" = "runtime"): void {
  outputChannel.appendLine(`[omp] getAvailableModels (${source})`);
  if (!rpcController?.isRunning()) {
    void fetchModelsFromReverseBridge().then((models) => {
      cachedAvailableModels = models;
      postAvailableModels(models, source);
    });
    return;
  }

  void rpcController
    .send<{ models: unknown }>({ type: "get_available_models" })
    .then(async (result) => {
      const rpcModels = normalizeAvailableModels(result?.models);
      const bridgeModels = await fetchModelsFromReverseBridge();
      cachedAvailableModels = mergeAvailableModels(rpcModels, bridgeModels);
      postAvailableModels(cachedAvailableModels, source);
      pushFooterState();
    })
    .catch((err) => {
      outputChannel.appendLine(`[omp] getAvailableModels failed: ${err}`);
      void fetchModelsFromReverseBridge().then((models) => {
        cachedAvailableModels = models;
        postAvailableModels(models, source);
      });
    });
}

/** Push the models.dev catalog to the webview. */
function pushModelCatalog(): void {
  const entries = getCatalogEntries();
  if (entries.length > 0) {
    postToWebview({ type: "runtime.modelCatalog", entries });
  }
}

/** Refresh the models.dev catalog from network (if expired or forced) and push to webview. */
function refreshModelCatalog(force = false): void {
  void refreshCatalog(force, (msg) => outputChannel.appendLine(msg)).then(() => {
    pushModelCatalog();
  });
}

/**
 * Handle a validated webview→extension message.
 *
 * Routes user intents to the appropriate host-side action.
 * Sessions.refresh, session.select, session.start, session.resume,
 * and chat.send are wired to real behavior.
 */
function handleWebviewMessage(message: WebviewToExtensionMessage): void {
  switch (message.type) {
    case "webview.ready":
      outputChannel.appendLine("[omp] webview ready — pushing initial state");
      pushInitialState();
      // Flush any buffered UI requests that arrived while webview was hidden
      for (const [, entry] of pendingUiRequests) {
        postToWebview({ type: "extensionUi.request", request: entry.request });
      }
      break;

    case "sessions.refresh":
      outputChannel.appendLine("[omp] sessions.refresh");
      refreshSessions();
      break;

    case "session.select": {
      outputChannel.appendLine(`[omp] session.select: ${message.sessionPath}`);
      // Empty path means "deselect" — show the new-session pane.
      selectedSessionPath = message.sessionPath || undefined;
      pushSelectionState();
      break;
    }
    case "session.start":
      outputChannel.appendLine("[omp] session.start");
      handleSessionStart(message.prompt, message.model, message.thinking);
      break;

    case "session.resume":
      outputChannel.appendLine(`[omp] session.resume: ${message.sessionPath}`);
      handleSessionResume(message.sessionPath, message.prompt);
      break;

    case "session.switch":
      outputChannel.appendLine(`[omp] session.switch: ${message.sessionPath}`);
      // Switch is the same as resume — launch the session
      handleSessionResume(message.sessionPath);
      break;

    case "session.rename": {
      const { sessionPath, title } = message;
      outputChannel.appendLine(`[omp] session.rename: ${sessionPath} → "${title}"`);
      if (rpcController?.isRunning() && title) {
        void rpcController
          .send({ type: "set_session_name", name: title })
          .then(() => {
            // Update header immediately
            currentHeaderState = { ...currentHeaderState, sessionName: title };
            postToWebview({ type: "header.state", state: currentHeaderState });
            // Refresh session list to reflect new name
            refreshSessions();
          })
          .catch((err) => {
            outputChannel.appendLine(`[omp] session.rename failed: ${err}`);
          });
      }
      break;
    }

    case "session.openTranscript": {
      const transcriptPath = message.sessionPath;
      outputChannel.appendLine(`[omp] session.openTranscript: ${transcriptPath}`);
      if (transcriptPath) {
        void (async () => {
          try {
            const uri = vscode.Uri.file(transcriptPath);
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, { preview: false });
          } catch (err) {
            outputChannel.appendLine(`[omp] openTranscript failed: ${err}`);
          }
        })();
      }
      break;
    }

    case "session.delete":
      outputChannel.appendLine(`[omp] session.delete: ${message.sessionPath}`);
      void handleSessionDelete(message.sessionPath);
      break;

    case "chat.send": {
      const slashParsed = parseSlashInput(message.content);
      if (slashParsed.isSlash && slashParsed.command) {
        const resolved = resolveSlashCommand(slashCatalog, slashParsed.command, slashParsed.args);
        const shouldHandleAsNormalChat =
          !resolved || (resolved.route.kind === "passThrough" && !resolved.runtimeMeta?.path);
        if (!shouldHandleAsNormalChat) {
          outputChannel.appendLine(`[omp] chat.send intercepted as slash: /${slashParsed.command}`);
          void handleSlashExecute({
            type: "slash.execute",
            raw: slashParsed.raw,
            command: slashParsed.command,
            args: slashParsed.args,
          });
          break;
        }
      }
      outputChannel.appendLine(
        `[omp] chat.send: ${message.sessionPath} (behavior: ${message.behavior ?? "auto"})`,
      );
      handleChatSend(
        message.sessionPath,
        message.content,
        message.behavior,
        message.fileContexts,
        message.attachments,
      );
      break;
    }

    case "slash.execute":
      void handleSlashExecute(message);
      break;

    case "slash.catalog.request":
      void (async () => {
        if (slashCatalog.length === 0) {
          await refreshSlashCatalogFromRuntime();
        }
        pushSlashCatalog();
      })();
      break;

    case "chat.abort":
      outputChannel.appendLine(`[omp] chat.abort: ${message.sessionPath}`);
      handleChatAbort();
      break;

    case "image.open": {
      const blobRef = message.blobRef as string | undefined;
      if (blobRef) {
        const match = blobRef.match(/^blob:sha256:([a-f0-9]+)$/);
        if (match?.[1]) {
          const blobPath = require("node:path").join(
            require("node:os").homedir(),
            ".omp",
            "agent",
            "blobs",
            match[1],
          );
          void vscode.commands.executeCommand("vscode.open", vscode.Uri.file(blobPath));
        }
      }
      break;
    }

    case "runtime.compact":
      outputChannel.appendLine("[omp] runtime.compact");
      if (rpcController?.isRunning()) {
        void rpcController.send({ type: "compact" as any });
      }
      break;

    case "runtime.getState":
      outputChannel.appendLine("[omp] runtime.getState");
      pushRuntimeState();
      break;

    case "runtime.setModel": {
      const { provider, modelId } = message;
      outputChannel.appendLine(`[omp] setModel: ${provider}/${modelId}`);
      if (rpcController?.isRunning()) {
        void rpcController.send({ type: "set_model", provider, modelId }).then(async () => {
          const state = await rpcController!.getState();
          currentRuntimeState = mapControllerState(state, currentActiveSessionPath);
          postToWebview({ type: "runtime.state", state: currentRuntimeState });
          updateHeaderFromOmpState(state);
          pushFooterState();
        });
      }
      break;
    }

    case "runtime.cycleModel":
      if (rpcController?.isRunning()) {
        void rpcController.send({ type: "cycle_model" }).then(() => {
          updateRuntimeStateFromController();
        });
      }
      break;

    case "runtime.getAvailableModels":
      refreshAvailableModels("runtime");
      break;

    case "runtime.refreshModelPricing":
      refreshAvailableModels("refresh");
      refreshModelCatalog(true);
      break;

    case "runtime.setThinkingLevel":
      outputChannel.appendLine(`[omp] setThinkingLevel: ${message.level}`);
      if (rpcController?.isRunning()) {
        void rpcController
          .send({ type: "set_thinking_level", level: message.level })
          .then(async () => {
            const state = await rpcController!.getState();
            currentRuntimeState = mapControllerState(state, currentActiveSessionPath);
            postToWebview({ type: "runtime.state", state: currentRuntimeState });
            updateHeaderFromOmpState(state);
            pushFooterState();
          });
      }
      break;

    case "runtime.cycleThinkingLevel":
      if (rpcController?.isRunning()) {
        void rpcController.send({ type: "cycle_thinking_level" }).then(async () => {
          const state = await rpcController!.getState();
          currentRuntimeState = mapControllerState(state, currentActiveSessionPath);
          postToWebview({ type: "runtime.state", state: currentRuntimeState });
          updateHeaderFromOmpState(state);
          pushFooterState();
        });
      }
      break;

    case "runtime.setSteeringMode":
      outputChannel.appendLine(`[omp] setSteeringMode: ${message.mode}`);
      if (rpcController?.isRunning()) {
        void rpcController.send({ type: "set_steering_mode", mode: message.mode }).then(() => {
          currentSteeringMode = message.mode;
          pushFooterState();
        });
      }
      break;

    case "runtime.setFollowUpMode":
      outputChannel.appendLine(`[omp] setFollowUpMode: ${message.mode}`);
      if (rpcController?.isRunning()) {
        void rpcController.send({ type: "set_follow_up_mode", mode: message.mode }).then(() => {
          currentFollowUpMode = message.mode;
          pushFooterState();
        });
      }
      break;

    case "runtime.setInterruptMode":
      outputChannel.appendLine(`[omp] setInterruptMode: ${message.mode}`);
      if (rpcController?.isRunning()) {
        void rpcController.send({ type: "set_interrupt_mode", mode: message.mode }).then(() => {
          currentInterruptMode = message.mode;
          pushFooterState();
        });
      }
      break;

    case "extensionUi.respond": {
      // Forward the user's response to the runtime via stdin
      if (!rpcController) break;
      const { requestId, response } = message as {
        requestId: string;
        response: Record<string, unknown>;
      };
      // Guard: ignore late responses for cancelled/expired requests
      if (!pendingUiRequests.has(requestId)) {
        outputChannel.appendLine(
          `[omp] extensionUi.respond: ignoring late response for ${requestId} (not pending)`,
        );
        break;
      }
      pendingUiRequests.delete(requestId);
      const uiResponse = {
        ...response,
        type: "extension_ui_response",
        id: requestId,
      } as import("./protocol/ompRpcTypes.ts").OmpExtensionUiResponse;
      void rpcController.sendUiResponse(uiResponse).catch((err) => {
        outputChannel.appendLine(`[omp] extensionUi.respond failed: ${err}`);
      });
      break;
    }

    case "input.focusRequested":
      outputChannel.appendLine("[omp] input.focusRequested");
      // The webview itself handles focus — just ensure the panel is visible
      focusChatView();
      break;

    case "openFile": {
      const filePath = message.path;
      const line = message.line;
      outputChannel.appendLine(`[omp] openFile: ${filePath}${line ? `:${line}` : ""}`);
      handleOpenFile(filePath, line, message.endLine);
      break;
    }

    case "runtime.setRole": {
      const role = message.role;
      outputChannel.appendLine(`[omp] setRole: ${role}`);
      if (!rpcController?.isRunning()) break;
      const modelPattern = cachedModelRoles[role];
      if (!modelPattern) break;

      // Parse "provider/modelId:thinkingLevel" pattern (same logic as cycleRoles)
      let thinkingLevel: string | undefined;
      let modelSpec = modelPattern;
      const lastColon = modelSpec.lastIndexOf(":");
      if (lastColon > 0 && modelSpec.indexOf("/") < lastColon) {
        thinkingLevel = modelSpec.slice(lastColon + 1);
        modelSpec = modelSpec.slice(0, lastColon);
      }

      const slash = modelSpec.indexOf("/");
      let provider: string;
      let modelId: string;
      if (slash > 0) {
        provider = modelSpec.slice(0, slash);
        modelId = modelSpec.slice(slash + 1);
      } else {
        const match = cachedAvailableModels.find((m) => m.id.includes(modelSpec));
        if (!match) break;
        provider = match.provider;
        modelId = match.id;
      }

      void (async () => {
        await rpcController!.send({ type: "set_model", provider, modelId });
        if (thinkingLevel) {
          await rpcController!.send({ type: "set_thinking_level", level: thinkingLevel } as any);
        }
        currentModelRole = role;
        try {
          const state = await rpcController!.getState();
          currentRuntimeState = mapControllerState(state, currentActiveSessionPath);
          postToWebview({ type: "runtime.state", state: currentRuntimeState });
          if (state.steeringMode) currentSteeringMode = state.steeringMode;
          if (state.followUpMode) currentFollowUpMode = state.followUpMode;
          if (state.interruptMode) currentInterruptMode = state.interruptMode;
          updateHeaderFromOmpState(state);
          pushFooterState();
        } catch {}
      })();
      break;
    }

    case "settings.load":
      outputChannel.appendLine("[omp] settings.load");
      void (async () => {
        const config = await getOmpConfig();
        const settingsConfig = await getSettingsPanelConfig(config.raw);
        const agents = await fetchAgentsFromReverseBridge();
        const providerStatus = await fetchProviderStatusFromReverseBridge();
        const skills = await fetchSkillsFromReverseBridge();
        const mcpServers = await fetchMcpServersFromReverseBridge();
        const payload = {
          type: "settings.loaded" as const,
          config: settingsConfig,
          agents,
          bridgeAvailable: !!bridgeContext?.reverseBridgePort,
          providerStatus,
          skills,
          mcpServers,
        };
        postToWebview(payload);
        SettingsEditorProvider.postMessage(payload);
      })();
      break;

    case "settings.save":
      outputChannel.appendLine("[omp] settings.save");
      void (async () => {
        try {
          saveInFlight = true;
          const updated = await writeOmpConfig(message.config);

          // Apply to running runtime via reverse bridge (instant)
          const result = await callReverseBridge("/settings", message.config);
          if (result) {
            outputChannel.appendLine(
              `[omp] Reverse bridge applied settings: ${JSON.stringify(result)}`,
            );
          }

          // Refresh UI state and push footer with known values
          const savedPatch = message.config as Record<string, unknown>;
          if (typeof savedPatch.steeringMode === "string") currentSteeringMode = savedPatch.steeringMode;
          if (typeof savedPatch.followUpMode === "string") currentFollowUpMode = savedPatch.followUpMode;
          if (typeof savedPatch.interruptMode === "string") currentInterruptMode = savedPatch.interruptMode;
          pushFooterState();

          if (rpcController?.isRunning()) {
            try {
              const state = await rpcController.getState();
              currentRuntimeState = mapControllerState(state, currentActiveSessionPath);
              postToWebview({ type: "runtime.state", state: currentRuntimeState });
              updateHeaderFromOmpState(state);
            } catch {}
            cachedModelRoles = updated.modelRoles;
            cachedCycleOrder = updated.cycleOrder;
          }

          const settingsConfig = await getSettingsPanelConfig(updated.raw);
          const providerStatus = await fetchProviderStatusFromReverseBridge();
          const skills = await fetchSkillsFromReverseBridge();
          const mcpServers = await fetchMcpServersFromReverseBridge();
          postToWebview({ type: "settings.updated", config: settingsConfig, providerStatus, skills, mcpServers });
          SettingsEditorProvider.postMessage({ type: "settings.updated", config: settingsConfig, providerStatus, skills, mcpServers });
          postToWebview({
            type: "display.settings",
            hideThinkingBlock: !!updated.raw.hideThinkingBlock,
            showTokenUsage: !!updated.raw["display.showTokenUsage"],
          } as any);
          saveInFlight = false;
        } catch (err) {
          saveInFlight = false;
          const msg = err instanceof Error ? err.message : String(err);
          postToWebview({ type: "settings.updateFailed", message: msg });
          SettingsEditorProvider.postMessage({ type: "settings.updateFailed", message: msg });
        }
      })();
      break;

    case "settings.discard":
      // No-op on host — webview handles draft discard locally
      break;

    case "settings.openConfigFile":
      outputChannel.appendLine("[omp] settings.openConfigFile");
      void (async () => {
        const configFilePath = getOmpConfigPath();
        try {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(configFilePath));
          await vscode.window.showTextDocument(doc);
        } catch (err) {
          outputChannel.appendLine(`[omp] failed to open config file: ${err}`);
        }
      })();
      break;

    case "settings.agent.write":
      outputChannel.appendLine("[omp] settings.agent.write");
      void (async () => {
        try {
          const filePath = await writeAgentDefinition(
            message.scope,
            message.agent,
            message.filePath,
          );
          outputChannel.appendLine(`[omp] wrote agent definition: ${filePath}`);
          const config = await getOmpConfig();
          const settingsConfig = await getSettingsPanelConfig(config.raw);
          const agents = await fetchAgentsFromReverseBridge();
          const providerStatus = await fetchProviderStatusFromReverseBridge();
          const skills = await fetchSkillsFromReverseBridge();
          const mcpServers = await fetchMcpServersFromReverseBridge();
          const payload = {
            type: "settings.loaded" as const,
            config: settingsConfig,
            agents,
            bridgeAvailable: !!bridgeContext?.reverseBridgePort,
            providerStatus,
            skills,
            mcpServers,
          };
          postToWebview(payload);
          SettingsEditorProvider.postMessage(payload);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          postToWebview({ type: "settings.updateFailed", message: msg });
          SettingsEditorProvider.postMessage({ type: "settings.updateFailed", message: msg });
        }
      })();
      break;

    case "settings.agent.delete":
      outputChannel.appendLine("[omp] settings.agent.delete");
      void (async () => {
        try {
          await deleteAgentDefinition(message.filePath);
          outputChannel.appendLine(`[omp] deleted agent definition: ${message.filePath}`);
          const config = await getOmpConfig();
          const settingsConfig = await getSettingsPanelConfig(config.raw);
          const agents = await fetchAgentsFromReverseBridge();
          const providerStatus = await fetchProviderStatusFromReverseBridge();
          const skills = await fetchSkillsFromReverseBridge();
          const mcpServers = await fetchMcpServersFromReverseBridge();
          const payload = {
            type: "settings.loaded" as const,
            config: settingsConfig,
            agents,
            bridgeAvailable: !!bridgeContext?.reverseBridgePort,
            providerStatus,
            skills,
            mcpServers,
          };
          postToWebview(payload);
          SettingsEditorProvider.postMessage(payload);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          postToWebview({ type: "settings.updateFailed", message: msg });
          SettingsEditorProvider.postMessage({ type: "settings.updateFailed", message: msg });
        }
      })();
      break;

    case "settings.skill.write":
      outputChannel.appendLine("[omp] settings.skill.write");
      void (async () => {
        try {
          const filePath = await writeSkillDefinition(message.scope, message.skill);
          outputChannel.appendLine(`[omp] wrote skill definition: ${filePath}`);
          const config = await getOmpConfig();
          const settingsConfig = await getSettingsPanelConfig(config.raw);
          const agents = await fetchAgentsFromReverseBridge();
          const providerStatus = await fetchProviderStatusFromReverseBridge();
          const skills = await fetchSkillsFromReverseBridge();
          const mcpServers = await fetchMcpServersFromReverseBridge();
          const payload = {
            type: "settings.loaded" as const,
            config: settingsConfig,
            agents,
            bridgeAvailable: !!bridgeContext?.reverseBridgePort,
            providerStatus,
            skills,
            mcpServers,
          };
          postToWebview(payload);
          SettingsEditorProvider.postMessage(payload);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          postToWebview({ type: "settings.updateFailed", message: msg });
          SettingsEditorProvider.postMessage({ type: "settings.updateFailed", message: msg });
        }
      })();
      break;

    case "settings.skill.delete":
      outputChannel.appendLine("[omp] settings.skill.delete");
      void (async () => {
        try {
          await deleteSkillDefinition(message.path);
          outputChannel.appendLine(`[omp] deleted skill: ${message.path}`);
          const config = await getOmpConfig();
          const settingsConfig = await getSettingsPanelConfig(config.raw);
          const agents = await fetchAgentsFromReverseBridge();
          const providerStatus = await fetchProviderStatusFromReverseBridge();
          const skills = await fetchSkillsFromReverseBridge();
          const mcpServers = await fetchMcpServersFromReverseBridge();
          const payload = {
            type: "settings.loaded" as const,
            config: settingsConfig,
            agents,
            bridgeAvailable: !!bridgeContext?.reverseBridgePort,
            providerStatus,
            skills,
            mcpServers,
          };
          postToWebview(payload);
          SettingsEditorProvider.postMessage(payload);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          postToWebview({ type: "settings.updateFailed", message: msg });
          SettingsEditorProvider.postMessage({ type: "settings.updateFailed", message: msg });
        }
      })();
      break;

    case "settings.mcp.write":
      outputChannel.appendLine("[omp] settings.mcp.write");
      void (async () => {
        try {
          const filePath = await writeMcpServer(message.scope, message.server);
          outputChannel.appendLine(`[omp] wrote MCP server to: ${filePath}`);
          await callReverseBridge("/mcp-reload");
          const config = await getOmpConfig();
          const settingsConfig = await getSettingsPanelConfig(config.raw);
          const agents = await fetchAgentsFromReverseBridge();
          const providerStatus = await fetchProviderStatusFromReverseBridge();
          const skills = await fetchSkillsFromReverseBridge();
          const mcpServers = await fetchMcpServersFromReverseBridge();
          const payload = {
            type: "settings.loaded" as const,
            config: settingsConfig,
            agents,
            bridgeAvailable: !!bridgeContext?.reverseBridgePort,
            providerStatus,
            skills,
            mcpServers,
          };
          postToWebview(payload);
          SettingsEditorProvider.postMessage(payload);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          postToWebview({ type: "settings.updateFailed", message: msg });
          SettingsEditorProvider.postMessage({ type: "settings.updateFailed", message: msg });
        }
      })();
      break;

    case "settings.mcp.delete":
      outputChannel.appendLine("[omp] settings.mcp.delete");
      void (async () => {
        try {
          const filePath = await deleteMcpServer(message.scope, message.name);
          outputChannel.appendLine(`[omp] deleted MCP server from: ${filePath}`);
          await callReverseBridge("/mcp-reload");
          const config = await getOmpConfig();
          const settingsConfig = await getSettingsPanelConfig(config.raw);
          const agents = await fetchAgentsFromReverseBridge();
          const providerStatus = await fetchProviderStatusFromReverseBridge();
          const skills = await fetchSkillsFromReverseBridge();
          const mcpServers = await fetchMcpServersFromReverseBridge();
          const payload = {
            type: "settings.loaded" as const,
            config: settingsConfig,
            agents,
            bridgeAvailable: !!bridgeContext?.reverseBridgePort,
            providerStatus,
            skills,
            mcpServers,
          };
          postToWebview(payload);
          SettingsEditorProvider.postMessage(payload);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          postToWebview({ type: "settings.updateFailed", message: msg });
          SettingsEditorProvider.postMessage({ type: "settings.updateFailed", message: msg });
        }
      })();
      break;

    case "settings.omc.load": {
      const ompPath = vscode.workspace.getConfiguration("omp").get<string>("path") ?? "";
      const payload = { type: "settings.omc.loaded" as const, settings: { path: ompPath } };
      postToWebview(payload);
      SettingsEditorProvider.postMessage(payload);
      break;
    }

    case "settings.omc.save":
      outputChannel.appendLine("[omp] settings.omc.save");
      void (async () => {
        const value = message.settings.path;
        await vscode.workspace
          .getConfiguration("omp")
          .update("path", value === null ? undefined : value, vscode.ConfigurationTarget.Global);
        const payload = { type: "settings.omc.updated" as const };
        postToWebview(payload);
        SettingsEditorProvider.postMessage(payload);
      })();
      break;

    default: {
      // Exhaustive check — if a new message type is added to the union
      // but not handled here, TypeScript will flag it at compile time.
      const _exhaustive: never = message;
      outputChannel.appendLine(
        `[omp] unhandled webview message: ${(_exhaustive as WebviewToExtensionMessage).type}`,
      );
      break;
    }
  }
}

// ============================================================================
// Session lifecycle handlers
// ============================================================================

/**
 * Start a new OMP session from the launch composer.
 *
 * Chooses the effective workspace folder, builds a launch request,
 * stops any active process (one-active-process rule), starts the
 * controller, and sends the first prompt if provided.
 */
async function handleSessionStart(
  prompt: string,
  model?: string,
  thinking?: string,
): Promise<void> {
  const scope = resolveWorkspaceScope(vscode.workspace.workspaceFolders);
  const workspaceFolder = getEffectiveWorkspaceFolder(scope);
  const startupDefaults = await resolveStartupModelDefaults(model, thinking);
  const effectiveModel = startupDefaults.model;
  const effectiveThinking = startupDefaults.thinking;

  if (!workspaceFolder) {
    pushLaunchFailed(
      "new",
      undefined,
      "No workspace folder available. Open a workspace to start a session.",
      {
        type: "session.start",
        prompt,
        model: effectiveModel,
        thinking: effectiveThinking as
          | "off"
          | "minimal"
          | "low"
          | "medium"
          | "high"
          | "xhigh"
          | undefined,
      },
    );
    return;
  }

  const runId = `omp_run_${Date.now()}`;
  const request: OmpLaunchRequest = {
    kind: "new",
    workspaceFolder,
    prompt: prompt.trim() || undefined,
    model: effectiveModel,
    thinking: effectiveThinking,
  };

  await launchSession(request, "new", runId, prompt.trim());
}

/**
 * Resume an existing OMP session.
 *
 * Validates the selected resumable session path via host logic,
 * stops any active process, starts the controller with --resume,
 * and sends the follow-up prompt if provided.
 */
async function handleSessionResume(sessionPath: string, prompt?: string): Promise<void> {
  // Validate the resume path before attempting launch.
  // OMP treats missing files as empty sessions; the extension must
  // not let a stale row silently create a new session.
  const validation = await validateResumePath(sessionPath);
  if (validation !== "ok") {
    const msg =
      validation === "missing"
        ? `Session file no longer exists: ${sessionPath}`
        : `Session file is invalid or has no messages: ${sessionPath}`;
    pushLaunchFailed("resume", sessionPath, msg, {
      type: "session.resume",
      sessionPath,
      prompt,
    });
    return;
  }

  const scope = resolveWorkspaceScope(vscode.workspace.workspaceFolders);
  const workspaceFolder = getEffectiveWorkspaceFolder(scope);

  if (!workspaceFolder) {
    pushLaunchFailed("resume", sessionPath, "No workspace folder available.", {
      type: "session.resume",
      sessionPath,
      prompt,
    });
    return;
  }

  const runId = `omp_run_${Date.now()}`;
  const request: OmpLaunchRequest = {
    kind: "resume",
    workspaceFolder,
    sessionPath,
    prompt: prompt?.trim() || undefined,
  };

  await launchSession(request, "resume", runId, prompt?.trim());
}

/**
 * Common launch path for both start and resume.
 *
 * Manages the one-active-process rule: if a process is running,
 * stops it first. Transitions through launching → active/failed states.
 * If a first prompt is provided, sends it after the controller reports ready.
 */
async function launchSession(
  request: OmpLaunchRequest,
  mode: "new" | "resume",
  runId: string,
  firstPrompt: string | undefined,
): Promise<void> {
  // Refresh models.dev catalog on session start (force if expired).
  refreshModelCatalog(isExpired());

  // One-active-process rule: stop existing process before starting a new one.
  if (rpcController?.isRunning()) {
    outputChannel.appendLine("[omp] stopping existing session before switch");
    try {
      await rpcController.stop("switch");
    } catch (err) {
      outputChannel.appendLine(
        `[omp] error stopping existing session: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Continue with launch — best-effort stop.
    }
  }

  // Clear pending UI requests from the dead process — stale entries must not persist
  pendingUiRequests.clear();

  // Push launching state to the webview.
  currentLaunchState = {
    kind: "launching",
    mode,
    sessionPath: request.kind === "resume" ? request.sessionPath : undefined,
    runId,
  };
  currentRuntimeState = { kind: "starting", runId };
  postToWebview({ type: "session.launchState", state: currentLaunchState });
  postToWebview({ type: "runtime.state", state: currentRuntimeState });
  pushSelectionStateForLaunch(
    mode,
    request.kind === "resume" ? request.sessionPath : undefined,
    runId,
  );

  // Create or reset the controller for this launch.
  if (rpcController) {
    try {
      await rpcController.dispose();
    } catch {
      // Best-effort disposal
    }
  }

  const ompPath = findOmpBinary();
  const bridgeConfig = bridgeContext
    ? { url: bridgeContext.url, token: bridgeContext.token }
    : undefined;
  const env = createOmpEnvironment(bridgeConfig);

  // Resolve path to the bundled bridge extension
  const bridgeExtensionPath = vscode.Uri.joinPath(
    extensionUri,
    "bridge",
    "omp-vscode-bridge.js",
  ).fsPath;

  rpcController = new OmpRpcControllerImpl({
    process: {
      binaryPath: ompPath !== "omp" ? ompPath : undefined,
      cwd: request.workspaceFolder,
      env: env ?? undefined,
      extensions: [bridgeExtensionPath],
    },
  });

  // Create the transcript manager for this session.
  const sessionPath = request.kind === "resume" ? request.sessionPath : request.workspaceFolder;
  transcriptManager = new TranscriptManager(sessionPath, {
    postToWebview,
    log: (msg) => outputChannel.appendLine(msg),
  });

  // Reset cost/token accumulators for new session
  sessionCostAccumulator = 0;
  sessionTokensInput = 0;
  sessionTokensOutput = 0;
  sessionTokensCacheRead = 0;

  // Wire frame listener to push runtime state updates and transcript state.
  rpcController.onFrame((frame) => {
    handleRuntimeFrame(frame);
  });

  try {
    const runtimeState = await rpcController.start(request);

    if (runtimeState.kind === "error") {
      // Controller started but get_state failed — still report as launched
      // with an error state.
      outputChannel.appendLine(`[omp] session started with state error: ${runtimeState.message}`);
      currentRuntimeState = runtimeState;
      currentLaunchState = { kind: "launched", sessionPath: runtimeState.sessionPath ?? "" };
      currentActiveSessionPath = runtimeState.sessionPath;
    } else if (runtimeState.kind === "ready" || runtimeState.kind === "streaming") {
      outputChannel.appendLine(`[omp] session started: ${runtimeState.sessionPath}`);
      currentRuntimeState = runtimeState;
      currentActiveSessionPath = runtimeState.sessionPath;
      currentLaunchState = { kind: "launched", sessionPath: runtimeState.sessionPath };
    } else {
      // Unexpected state after start, but still report honestly.
      outputChannel.appendLine(`[omp] unexpected runtime state after start: ${runtimeState.kind}`);
      currentRuntimeState = runtimeState;
      currentLaunchState = undefined;
    }

    postToWebview({ type: "session.launchState", state: currentLaunchState ?? { kind: "idle" } });
    postToWebview({ type: "runtime.state", state: currentRuntimeState });
    pushSelectionStateForActive(currentActiveSessionPath);
    pushHeaderState();

    // Fetch full state immediately to populate context %, todos, and delivery modes
    if (rpcController?.isRunning()) {
      void rpcController
        .getState()
        .then((fullState) => {
          // Sync mode variables from runtime state
          if (fullState.steeringMode) currentSteeringMode = fullState.steeringMode;
          if (fullState.followUpMode) currentFollowUpMode = fullState.followUpMode;
          if (fullState.interruptMode) currentInterruptMode = fullState.interruptMode;
          // Detect active role from model
          const currentModel = fullState.model as { provider?: string; id?: string } | undefined;
          if (currentModel?.id) {
            const modelKey = `${currentModel.provider ?? ""}/${currentModel.id}`;
            const matchedRole = Object.entries(cachedModelRoles).find(([, pattern]) => {
              const spec = pattern.includes(":")
                ? pattern.slice(0, pattern.lastIndexOf(":"))
                : pattern;
              return (
                spec === modelKey || modelKey.includes(spec) || spec.includes(currentModel.id!)
              );
            });
            currentModelRole = matchedRole?.[0] ?? currentModelRole;
          }
          updateHeaderFromOmpState(fullState);
          pushFooterState();
        })
        .catch(() => {
          /* best effort */
        });

      // Pre-fetch available models for thinking support detection
      refreshAvailableModels("runtime");
    }

    // Load model roles config for /cycle-roles
    void refreshOmpConfig()
      .then((config) => {
        cachedModelRoles = config.modelRoles;
        cachedCycleOrder = config.cycleOrder;
      })
      .catch(() => {
        /* best effort */
      });

    // Update transcript manager's session path now that we know the real path.
    if (transcriptManager && currentActiveSessionPath) {
      transcriptManager.reset(currentActiveSessionPath);
    }

    // Hydrate transcript on resume: load existing messages from the runtime.
    if (
      request.kind === "resume" &&
      rpcController?.isRunning() &&
      transcriptManager &&
      (runtimeState.kind === "ready" || runtimeState.kind === "streaming")
    ) {
      try {
        const jsonlHydration = currentActiveSessionPath
          ? readHydrationFromJsonl(currentActiveSessionPath)
          : null;

        let messages: Record<string, unknown>[];
        if (jsonlHydration) {
          messages = jsonlHydration.messages as Record<string, unknown>[];
          transcriptManager.hydrateFromMessages(
            messages,
            jsonlHydration.turnMetadataEntries.length > 0
              ? jsonlHydration.turnMetadataEntries
              : undefined,
            "jsonl",
            jsonlHydration.userAttachmentsEntries.length > 0
              ? jsonlHydration.userAttachmentsEntries
              : undefined,
          );
          outputChannel.appendLine(
            `[omp] hydrated from JSONL: ${messages.length} messages, ${jsonlHydration.turnMetadataEntries.length} turn metadata entries`,
          );
        } else {
          messages = (await rpcController.getMessages()) as Record<string, unknown>[];
          transcriptManager.hydrateFromMessages(messages, undefined, "omp");
          transcriptManager.addSystemMessage("Could not access Session Path, restored from OMP");
          outputChannel.appendLine(
            "[omp] session path unreadable — restored from OMP get_messages",
          );
        }

        // Seed cost/token accumulators from historical messages
        for (const raw of messages) {
          const msg = raw as Record<string, unknown>;
          if (msg.role === "assistant") {
            const usage = msg.usage as Record<string, unknown> | undefined;
            if (usage) {
              if (typeof usage.input === "number") sessionTokensInput += usage.input;
              if (typeof usage.output === "number") sessionTokensOutput += usage.output;
              if (typeof usage.cacheRead === "number") sessionTokensCacheRead += usage.cacheRead;
              const cost = usage.cost as Record<string, unknown> | undefined;
              if (cost && typeof cost.total === "number") {
                sessionCostAccumulator += cost.total;
              }
            }
          }
        }

        // Push accumulated cost to header
        if (sessionCostAccumulator > 0 || sessionTokensInput > 0) {
          currentHeaderState = {
            ...currentHeaderState,
            costUsd: sessionCostAccumulator > 0 ? sessionCostAccumulator : undefined,
            tokens: {
              input: sessionTokensInput,
              output: sessionTokensOutput,
              cacheRead: sessionTokensCacheRead,
            },
          };
          postToWebview({ type: "header.state", state: currentHeaderState });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        outputChannel.appendLine(`[omp] transcript hydration failed: ${msg}`);
        // Non-fatal — session is active, transcript will accumulate from live frames.
      }
    }

    // Send first prompt if provided and runtime is ready.
    if (firstPrompt && (runtimeState.kind === "ready" || runtimeState.kind === "streaming")) {
      await sendFirstPrompt(firstPrompt, runtimeState);
    }

    // Refresh sessions to reflect the new/resumed session.
    refreshSessions();
  } catch (err) {
    const errorMessage = formatLaunchError(err);
    outputChannel.appendLine(`[omp] session launch failed: ${errorMessage}`);

    currentLaunchState = {
      kind: "failed",
      mode,
      sessionPath: request.kind === "resume" ? request.sessionPath : undefined,
      message: errorMessage,
    };
    currentRuntimeState = { kind: "disconnected" };
    currentActiveSessionPath = undefined;

    postToWebview({ type: "session.launchState", state: currentLaunchState });
    postToWebview({ type: "runtime.state", state: currentRuntimeState });
    postToWebview({
      type: "error",
      scope: "launch",
      message: errorMessage,
      retry:
        mode === "new"
          ? { type: "session.start", prompt: firstPrompt ?? "" }
          : {
              type: "session.resume",
              sessionPath: request.kind === "resume" ? request.sessionPath : "",
              prompt: firstPrompt,
            },
    });
    pushSelectionStateForFailed(
      mode,
      request.kind === "resume" ? request.sessionPath : undefined,
      errorMessage,
      firstPrompt ?? "",
    );
  }
}

/**
 * Send the first prompt after session startup.
 *
 * Chooses the correct streaming behavior based on current runtime state.
 */
async function sendFirstPrompt(prompt: string, state: OmpRuntimeState): Promise<void> {
  if (!rpcController?.isRunning()) return;

  try {
    if (state.kind === "streaming") {
      await rpcController.prompt({
        message: prompt,
        streamingBehavior: "followUp",
      });
    } else {
      await rpcController.prompt({ message: prompt });
    }

    // Prompt accepted — add user message to transcript.
    transcriptManager?.addUserMessage(prompt);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    outputChannel.appendLine(`[omp] first prompt failed: ${msg}`);
    // Don't fail the entire launch — the session started, prompt just failed.
    // The user can retry by typing in the composer.
    postToWebview({
      type: "error",
      scope: "runtime",
      message: `Prompt failed: ${msg}`,
    });
  }
}

/**
 * Handle a chat.send message for an active session.
 *
 * When streaming, routes as steer or follow_up based on:
 * 1. Explicit behavior from caller (if specified)
 * 2. interruptMode from runtime state: "immediate" → steer, "wait" → followUp
 *
 * "forceSend" behavior maps to abort_and_prompt (kill current turn + send).
 */
async function handleChatSend(
  sessionPath: string,
  content: string,
  behavior?: "steer" | "followUp" | "forceSend",
  fileContexts?: ChatFileContext[],
  attachments?: ChatAttachment[],
): Promise<void> {
  if (!rpcController?.isRunning()) {
    postToWebview({
      type: "error",
      scope: "runtime",
      message: "No active session. Start or resume a session first.",
    });
    return;
  }

  try {
    const state = await rpcController.getState();
    const runtimeMessage = await buildRuntimePrompt(content, fileContexts);
    const runtimeImages = attachments?.map((attachment) => ({
      type: "image" as const,
      data: attachment.data,
      mimeType: attachment.mediaType,
    }));

    // Stash file contexts for bridge callback (persisted as user_attachments in JSONL)
    if (fileContexts && fileContexts.length > 0) {
      pendingUserAttachments = { fileContexts };
    } else {
      pendingUserAttachments = null;
    }

    let effectiveBehavior: "steer" | "followUp" | "forceSend" | undefined;

    if (behavior === "forceSend") {
      // Abort current turn and send as fresh prompt
      await rpcController.send({
        type: "abort_and_prompt",
        message: runtimeMessage,
        images: runtimeImages,
      });
      effectiveBehavior = "forceSend";
    } else if (state.isStreaming) {
      // Auto-decide based on interruptMode if no explicit behavior
      effectiveBehavior = behavior ?? (state.interruptMode === "immediate" ? "steer" : "followUp");

      if (effectiveBehavior === "steer") {
        await rpcController.send({ type: "steer", message: runtimeMessage, images: runtimeImages });
      } else {
        await rpcController.send({
          type: "follow_up",
          message: runtimeMessage,
          images: runtimeImages,
        });
      }
    } else {
      // Not streaming — normal prompt
      await rpcController.prompt({ message: runtimeMessage, images: runtimeImages });
    }

    // Prompt accepted — add user message to transcript
    if (transcriptManager) {
      transcriptManager.addUserMessage(content, {
        images: attachments?.map((a) => ({ mimeType: a.mediaType, data: a.data })),
        fileContexts: fileContexts?.length ? fileContexts : undefined,
      });
    }

    // Notify webview of the queued behavior so it can style the message
    if (effectiveBehavior && effectiveBehavior !== "forceSend") {
      postToWebview({
        type: "chat.queued",
        behavior: effectiveBehavior,
        content,
      } as ExtensionToWebviewMessage);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    outputChannel.appendLine(`[omp] chat.send failed: ${msg}`);
    postToWebview({
      type: "error",
      scope: "runtime",
      message: `Send failed: ${msg}`,
    });
  }
}

async function buildRuntimePrompt(
  content: string,
  fileContexts?: ChatFileContext[],
): Promise<string> {
  if (!fileContexts || fileContexts.length === 0) return content;

  const sections: string[] = [];
  for (const context of fileContexts) {
    const section = await buildFileContextSection(context);
    if (section) sections.push(section);
  }

  if (sections.length === 0) return content;

  return `${sections.join("\n\n")}\n\nUser request:\n${content}`;
}

async function buildFileContextSection(context: ChatFileContext): Promise<string | undefined> {
  const MAX_EMBED_BYTES = 50_000; // ~1000 lines of source code

  try {
    const uri = vscode.Uri.file(context.path);
    const document = await vscode.workspace.openTextDocument(uri);
    const fullText = document.getText();
    const language = context.languageId || document.languageId || "text";
    const filename = pathBasename(context.path);
    const range = formatContextRange(context.line, context.endLine);

    // If a line range is specified, always embed the slice (user explicitly selected it)
    if (context.line != null) {
      const text = sliceContextText(fullText, context.line, context.endLine);
      return [
        `<attached-file filename="${filename}" language="${language}"${range ? ` range="${range}"` : ""}>`,
        "```",
        text,
        "```",
        `</attached-file>`,
      ].join("\n");
    }

    // Full file: check size threshold
    const byteSize = Buffer.byteLength(fullText, "utf-8");
    if (byteSize > MAX_EMBED_BYTES) {
      const lineCount = document.lineCount;
      const sizeLabel =
        byteSize > 1_000_000
          ? `${(byteSize / 1_000_000).toFixed(1)}MB`
          : `${Math.round(byteSize / 1_000)}KB`;
      return [
        `<attached-file filename="${filename}" language="${language}" size="${sizeLabel}" lines="${lineCount}" reference="true">`,
        `File too large to embed (${sizeLabel}, ${lineCount} lines).`,
        `Available at: ${context.path}`,
        `Use the read tool to inspect relevant sections.`,
        `</attached-file>`,
      ].join("\n");
    }

    return [
      `<attached-file filename="${filename}" language="${language}"${range ? ` range="${range}"` : ""}>`,
      "```",
      fullText,
      "```",
      `</attached-file>`,
    ].join("\n");
  } catch {
    const filename = pathBasename(context.path);
    const range = formatContextRange(context.line, context.endLine);
    return `<attached-file filename="${filename}"${range ? ` range="${range}"` : ""}>\n[Could not read file content]\n</attached-file>`;
  }
}

function formatContextRange(line?: number, endLine?: number): string {
  if (line != null && endLine != null && endLine !== line) return `lines ${line}-${endLine}`;
  if (line != null) return `line ${line}`;
  return "";
}

function sliceContextText(fullText: string, line?: number, endLine?: number): string {
  if (line == null && endLine == null) {
    return fullText;
  }
  const lines = fullText.split(/\r?\n/);
  const startLine = Math.max(1, line ?? 1);
  const finalLine = Math.max(startLine, endLine ?? line ?? Math.min(lines.length, startLine + 24));
  const slice = lines.slice(startLine - 1, finalLine);
  return slice.join("\n");
}

function pathBasename(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

/**
 * Handle a chat.abort message — abort the current turn.
 */
async function handleChatAbort(): Promise<void> {
  if (!rpcController?.isRunning()) return;

  try {
    await rpcController.send({ type: "abort" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    outputChannel.appendLine(`[omp] chat.abort failed: ${msg}`);
  }
}

/**
 * Handle an outbound frame from the OMP runtime.
 *
 * Routes frames through the transcript manager for state accumulation
 * and webview message emission, then forwards relevant state changes
 * to update the runtime state.
 */
function handleRuntimeFrame(frame: unknown): void {
  if (!rpcController) return;

  // Route through transcript manager for transcript state accumulation.
  if (transcriptManager) {
    transcriptManager.handleFrame(frame as import("./protocol/ompRpcTypes.ts").OmpRpcFrame);
  }

  const frameObj = frame as Record<string, unknown>;
  const frameType = frameObj.type as string | undefined;

  switch (frameType) {
    case "agent_start":
      // Agent started — reset per-turn accumulators and update runtime state
      turnCostAccumulator = 0;
      turnTokensInput = 0;
      turnTokensOutput = 0;
      turnTokensCacheRead = 0;
      turnStartTimestamp = Date.now();
      updateRuntimeStateFromController();
      break;
    case "agent_end": {
      // Agent ended — emit per-turn metadata, then query full state and refresh header stats
      const turnDurationMs = Date.now() - turnStartTimestamp;
      void rpcController
        .getState()
        .then((state) => {
          // Emit per-turn metadata to the webview
          const modelId = state.model?.id;
          let thinkingLvl: string | undefined;
          if (typeof state.thinkingLevel === "string") {
            thinkingLvl = state.thinkingLevel;
          } else if (state.thinkingLevel && typeof state.thinkingLevel === "object") {
            thinkingLvl = (state.thinkingLevel as { level?: string }).level;
          }
          postToWebview({
            type: "runtime.turnMetadata",
            metadata: {
              model:
                state.model && modelId ? { provider: state.model.provider, modelId } : undefined,
              thinkingLevel: thinkingLvl,
              contextPercent:
                state.contextUsage?.percent != null
                  ? Math.round(state.contextUsage.percent)
                  : undefined,
              tokens:
                turnTokensInput > 0 || turnTokensOutput > 0 || turnTokensCacheRead > 0
                  ? {
                      input: turnTokensInput,
                      output: turnTokensOutput,
                      cacheRead: turnTokensCacheRead,
                    }
                  : undefined,
              costUsd: turnCostAccumulator > 0 ? turnCostAccumulator : undefined,
              durationMs: turnDurationMs > 0 ? turnDurationMs : undefined,
            },
          });

          currentRuntimeState = mapControllerState(state, currentActiveSessionPath);
          postToWebview({ type: "runtime.state", state: currentRuntimeState });
          pushHeaderState();
          updateHeaderFromOmpState(state);
          pushFooterState(); // Stable moment — safe to push footer
        })
        .catch(() => {
          // Best effort — state update on agent_end is non-critical
          // Still emit turn metadata with what we have (no model/context info)
          postToWebview({
            type: "runtime.turnMetadata",
            metadata: {
              tokens:
                turnTokensInput > 0 || turnTokensOutput > 0 || turnTokensCacheRead > 0
                  ? {
                      input: turnTokensInput,
                      output: turnTokensOutput,
                      cacheRead: turnTokensCacheRead,
                    }
                  : undefined,
              costUsd: turnCostAccumulator > 0 ? turnCostAccumulator : undefined,
              durationMs: turnDurationMs > 0 ? turnDurationMs : undefined,
            },
          });
        });
      // Refresh cost/token stats after each agent turn
      void refreshHeaderStats();
      break;
    }
    case "message_start":
    case "message_update":
    case "turn_start":
    case "turn_end":
      // These are transcript events — forward to webview for later rendering.
      updateRuntimeStateFromController();
      break;
    case "message_end": {
      // Extract usage/cost from the finalized message and accumulate
      const endFrame = frame as Record<string, unknown>;
      const endMessage = endFrame.message as Record<string, unknown> | undefined;
      if (endMessage) {
        const usage = endMessage.usage as Record<string, unknown> | undefined;
        if (usage) {
          // Accumulate tokens (session-level)
          if (typeof usage.input === "number") sessionTokensInput += usage.input;
          if (typeof usage.output === "number") sessionTokensOutput += usage.output;
          if (typeof usage.cacheRead === "number") sessionTokensCacheRead += usage.cacheRead;

          // Accumulate tokens (turn-level)
          if (typeof usage.input === "number") turnTokensInput += usage.input;
          if (typeof usage.output === "number") turnTokensOutput += usage.output;
          if (typeof usage.cacheRead === "number") turnTokensCacheRead += usage.cacheRead;

          // Accumulate cost
          const cost = usage.cost as Record<string, unknown> | undefined;
          if (cost && typeof cost.total === "number") {
            sessionCostAccumulator += cost.total;
            turnCostAccumulator += cost.total;
          } else if (typeof usage.totalCost === "number") {
            sessionCostAccumulator += usage.totalCost as number;
            turnCostAccumulator += usage.totalCost as number;
          }

          // Push updated header with accumulated values
          currentHeaderState = {
            ...currentHeaderState,
            costUsd: sessionCostAccumulator > 0 ? sessionCostAccumulator : undefined,
            tokens: {
              input: sessionTokensInput,
              output: sessionTokensOutput,
              cacheRead: sessionTokensCacheRead,
            },
          };
          postToWebview({ type: "header.state", state: currentHeaderState });
        }
      }
      updateRuntimeStateFromController();
      break;
    }
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
      updateRuntimeStateFromController();
      break;
    case "auto_compaction_start":
    case "auto_compaction_end":
    case "auto_retry_start":
    case "auto_retry_end":
      updateRuntimeStateFromController();
      break;
    case "todo_reminder":
    case "todo_auto_clear":
      // Todos changed — refresh state to get updated todoPhases
      updateRuntimeStateFromController();
      break;
    case "extension_ui_request":
      handleExtensionUiRequest(
        frameObj as import("./protocol/ompRpcTypes.ts").OmpExtensionUiRequest,
      );
      break;
    default:
      // Other frames (response, etc.) are handled by controller correlation.
      break;
  }
}

/**
 * Handle an extension UI request from the runtime.
 *
 * Passive methods (notify, setStatus, setTitle, setWidget) are handled locally.
 * Interactive methods (select, confirm, input, editor) are forwarded to the webview.
 * The cancel method dismisses a pending dialog in the webview.
 */
function handleExtensionUiRequest(
  request: import("./protocol/ompRpcTypes.ts").OmpExtensionUiRequest,
): void {
  const method = (request as Record<string, unknown>).method as string;
  const id = (request as Record<string, unknown>).id as string;

  switch (method) {
    case "notify": {
      const r = request as { message: string; notifyType?: "info" | "warning" | "error" };
      const notifyType = r.notifyType ?? "info";
      if (notifyType === "error") {
        vscode.window.showErrorMessage(r.message);
      } else if (notifyType === "warning") {
        vscode.window.showWarningMessage(r.message);
      } else {
        vscode.window.showInformationMessage(r.message);
      }
      break;
    }
    case "setStatus":
    case "setTitle":
    case "setWidget":
      // Deferred — log only
      outputChannel.appendLine(`[omp] extensionUi.${method}: ${JSON.stringify(request)}`);
      break;
    case "set_editor_text": {
      const r = request as { text: string };
      postToWebview({ type: "extensionUi.setEditorText", text: r.text });
      break;
    }
    case "cancel": {
      const r = request as { targetId: string };
      pendingUiRequests.delete(r.targetId);
      postToWebview({ type: "extensionUi.cancel", targetId: r.targetId });
      break;
    }
    case "select":
    case "confirm":
    case "input":
    case "editor": {
      // Interactive — forward to webview, track pending
      const webviewRequest = mapToWebviewRequest(request);
      pendingUiRequests.set(id, { request: webviewRequest, timestamp: Date.now() });
      postToWebview({ type: "extensionUi.request", request: webviewRequest });
      break;
    }
    default:
      outputChannel.appendLine(`[omp] extensionUi: unknown method '${method}'`);
      break;
  }
}

/** Map raw RPC extension_ui_request to the webview-friendly shape. */
function mapToWebviewRequest(
  raw: import("./protocol/ompRpcTypes.ts").OmpExtensionUiRequest,
): import("./protocol/webviewMessages.ts").ExtensionUiRequestForWebview {
  const r = raw as Record<string, unknown>;
  const method = r.method as string;
  const requestId = r.id as string;

  switch (method) {
    case "select":
      return {
        method: "select",
        requestId,
        title: r.title as string,
        options: r.options as string[],
        timeout: r.timeout as number | undefined,
      };
    case "confirm":
      return {
        method: "confirm",
        requestId,
        title: r.title as string,
        message: r.message as string,
        timeout: r.timeout as number | undefined,
      };
    case "input":
      return {
        method: "input",
        requestId,
        title: r.title as string,
        placeholder: r.placeholder as string | undefined,
        timeout: r.timeout as number | undefined,
      };
    case "editor":
      return {
        method: "editor",
        requestId,
        title: r.title as string,
        prefill: r.prefill as string | undefined,
      };
    default:
      // Should not reach here — caller filters to interactive methods
      return { method: "select", requestId, title: "Unknown", options: [] };
  }
}

/**
 * Poll the controller for current state and push to webview.
 */
function updateRuntimeStateFromController(): void {
  if (!rpcController?.isRunning()) return;

  void rpcController
    .getState()
    .then((state) => {
      currentRuntimeState = mapControllerState(state, currentActiveSessionPath);
      postToWebview({ type: "runtime.state", state: currentRuntimeState });
      updateHeaderFromOmpState(state);
      // Note: pushFooterState NOT called here — it's too hot a path.
      // Footer state is pushed on editor changes and after agent_end.
    })
    .catch(() => {
      // Non-critical — state will be reconciled on next event.
    });
}

/**
 * Map a controller get_state payload to a webview runtime state.
 */
function mapControllerState(
  state: OmpStatePayload,
  sessionPath: string | undefined,
): OmpRuntimeState {
  const path = state.sessionFile ?? sessionPath ?? "";

  if (state.isStreaming) {
    return {
      kind: "streaming",
      sessionPath: path,
      sessionId: state.sessionId || undefined,
      model: state.model,
      thinking: state.thinkingLevel,
      queuedMessageCount: state.queuedMessageCount,
    };
  }

  return {
    kind: "ready",
    sessionPath: path,
    sessionId: state.sessionId || undefined,
    model: state.model,
    thinking: state.thinkingLevel,
    queuedMessageCount: state.queuedMessageCount,
  };
}

/**
 * Format a launch error for display.
 */
function formatLaunchError(err: unknown): string {
  if (err instanceof OmpResumePathError) {
    return err.reason === "missing"
      ? `Session file does not exist: ${err.sessionPath}`
      : `Session file is not readable: ${err.sessionPath}`;
  }
  if (err instanceof OmpSpawnError) {
    return `Failed to start OMP: ${err.message}`;
  }
  if (err instanceof OmpStartupError) {
    return `OMP process exited during startup (code ${err.exitCode ?? "unknown"})`;
  }
  if (err instanceof OmpStartupTimeoutError) {
    return `OMP process did not start within ${err.timeoutMs / 1000}s`;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

// ============================================================================
// State push helpers
// ============================================================================

/**
 * Push initial state to the webview after it reports ready.
 *
 * Sends the current known state for each domain. Unknown/unavailable
 * data is represented honestly, not as plausible defaults.
 * Triggers an async session refresh so the list loads after handshake.
 */
function pushInitialState(): void {
  // Push current known state immediately, then trigger async refresh.
  postToWebview({
    type: "sessions.state",
    state: currentSessionListState,
  });

  // Push selection based on current state.
  pushSelectionState();

  // Push current runtime state (may be disconnected or from previous session).
  postToWebview({
    type: "runtime.state",
    state: currentRuntimeState,
  });

  // Push current launch state if any.
  if (currentLaunchState) {
    postToWebview({ type: "session.launchState", state: currentLaunchState });
  }

  // Footer — real editor context + runtime state.
  pushFooterState();

  // Header state — push current (may be from a previous session or initial empty).
  pushHeaderState();

  // Kick off an async session refresh to populate real data.
  refreshSessions();

  // Push models.dev catalog (if loaded).
  pushModelCatalog();

  // Push slash command catalog.
  pushSlashCatalog();

  // Push display settings (async — reads config).
  void getOmpConfig().then((config) => {
    postToWebview({
      type: "display.settings",
      hideThinkingBlock: !!config.raw.hideThinkingBlock,
      showTokenUsage: !!config.raw["display.showTokenUsage"],
    } as any);
  });
}

/**
 * Refresh the session list from the filesystem.
 *
 * Reads the workspace scope, enumerates sessions, and pushes the
 * resulting state to the webview. Errors are caught and pushed as
 * honest error state rather than being silently swallowed.
 */
async function refreshSessions(): Promise<void> {
  const scope = resolveWorkspaceScope(vscode.workspace.workspaceFolders);
  const workspaceFolder = getEffectiveWorkspaceFolder(scope);

  // Push loading state immediately so the webview can show a spinner.
  const loadingState: OmpSessionListState = {
    kind: "loading",
    workspaceFolder,
  };
  currentSessionListState = loadingState;
  postToWebview({ type: "sessions.state", state: loadingState });

  try {
    if (!workspaceFolder) {
      const emptyState: OmpSessionListState = { kind: "empty", workspaceFolder: "" };
      currentSessionListState = emptyState;
      currentSessions = [];
      postToWebview({ type: "sessions.state", state: emptyState });
      return;
    }

    const sessions = await listWorkspaceSessions(workspaceFolder);

    if (sessions.length === 0) {
      const emptyState: OmpSessionListState = { kind: "empty", workspaceFolder };
      currentSessionListState = emptyState;
    } else {
      const readyState: OmpSessionListState = {
        kind: "ready",
        workspaceFolder,
        sessions,
        selectedSessionPath,
      };
      currentSessionListState = readyState;
    }

    currentSessions = sessions;
    postToWebview({ type: "sessions.state", state: currentSessionListState });

    // If a session was previously selected, push updated selection too.
    if (selectedSessionPath) {
      pushSelectionState();
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[omp] session discovery error: ${msg}`);
    const errorState: OmpSessionListState = {
      kind: "error",
      workspaceFolder,
      message: msg,
      retryable: true,
    };
    currentSessionListState = errorState;
    currentSessions = [];
    postToWebview({ type: "sessions.state", state: errorState });
  }
}

async function handleSessionDelete(sessionPath: string): Promise<void> {
  const fail = async (message: string) => {
    outputChannel.appendLine(`[omp] session.delete failed: ${message}`);
    postToWebview({ type: "session.deleteResult", sessionPath, success: false, message });
    await refreshSessions();
  };

  try {
    const scope = resolveWorkspaceScope(vscode.workspace.workspaceFolders);
    const workspaceFolder = getEffectiveWorkspaceFolder(scope);
    if (!workspaceFolder) {
      await fail("No workspace folder is available for session deletion.");
      return;
    }

    if (currentActiveSessionPath === sessionPath && rpcController?.isRunning()) {
      await fail("Cannot delete the active session. Stop or switch sessions first.");
      return;
    }

    const sessionDir = path.resolve(getOmpSessionDir(workspaceFolder));
    const targetPath = path.resolve(sessionPath);
    if (!path.isAbsolute(sessionPath) || path.extname(targetPath) !== ".jsonl") {
      await fail("Refusing to delete an invalid session path.");
      return;
    }

    const relative = path.relative(sessionDir, targetPath);
    if (
      relative === "" ||
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      relative.includes(path.sep)
    ) {
      await fail("Refusing to delete a session outside this workspace.");
      return;
    }

    const discovered = currentSessions.some((session) => path.resolve(session.path) === targetPath);
    if (!discovered) {
      await fail("Session is not in the current workspace session list.");
      return;
    }

    try {
      const stat = await fs.lstat(targetPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        await fail("Refusing to delete a non-file session path.");
        return;
      }
      await fs.unlink(targetPath);
    } catch (err) {
      if (!isNodeErrorCode(err, "ENOENT")) throw err;
    }

    if (selectedSessionPath === sessionPath) {
      selectedSessionPath = undefined;
      pushSelectionState();
    }

    await refreshSessions();
    postToWebview({ type: "session.deleteResult", sessionPath, success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await fail(message);
  }
}

function isNodeErrorCode(err: unknown, code: string): boolean {
  return (
    !!err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === code
  );
}

/**
 * Push the current selection state to the webview.
 *
 * If a session is selected and exists in the current session list,
 * show its preview. Otherwise, show the new-session pane.
 */
function pushSelectionState(): void {
  if (selectedSessionPath) {
    const session = currentSessions.find((s) => s.path === selectedSessionPath);
    if (session) {
      postToWebview({
        type: "selection.state",
        state: { kind: "preview", session, draft: "" },
      });
      return;
    }
    // Selected session no longer in list — fall through to new-session pane.
    outputChannel.appendLine(
      `[omp] selected session not found in current list: ${selectedSessionPath}`,
    );
    selectedSessionPath = undefined;
  }

  postToWebview({
    type: "selection.state",
    state: { kind: "new", draft: "" },
  });
}

/**
 * Push a launching state for the selection pane.
 */
function pushSelectionStateForLaunch(
  mode: "new" | "resume",
  sessionPath: string | undefined,
  runId: string,
): void {
  postToWebview({
    type: "selection.state",
    state: { kind: "launching", mode, sessionPath, draft: "", runId },
  });
}

/**
 * Push an active session state for the selection pane.
 */
function pushSelectionStateForActive(sessionPath: string | undefined): void {
  if (sessionPath) {
    postToWebview({
      type: "selection.state",
      state: { kind: "active", sessionPath, acceptsInput: true },
    });
  } else {
    // No session path — show new-session pane
    postToWebview({
      type: "selection.state",
      state: { kind: "new", draft: "" },
    });
  }
}

/**
 * Build and push header state to the webview.
 *
 * Derives connection from runtime state, session name from discovery or state,
 * and cost/tokens from the last known stats.
 */
function pushHeaderState(): void {
  // Derive connection from runtime state
  const connection: ChatHeaderState["connection"] =
    currentRuntimeState.kind === "ready" || currentRuntimeState.kind === "streaming"
      ? "connected"
      : currentRuntimeState.kind === "disconnected"
        ? "disconnected"
        : "connecting";

  // Find session title from discovery (fallback to current header name)
  const activeSession = currentSessions.find((s) => s.path === currentActiveSessionPath);
  const sessionName = activeSession?.title ?? currentHeaderState.sessionName ?? "New Session";

  currentHeaderState = {
    ...currentHeaderState,
    connection,
    sessionName,
    sessionPath: currentActiveSessionPath ?? "",
    canCompact: connection === "connected",
  };

  postToWebview({ type: "header.state", state: currentHeaderState });
}

/**
 * Update header state from a raw get_state payload.
 *
 * Extracts contextUsage, sessionName, and todoPhases directly from the
 * OMP runtime state response. Called after every successful get_state.
 */
function updateHeaderFromOmpState(state: OmpStatePayload): void {
  const ctx = state.contextUsage;
  const modelId = state.model?.id;
  let thinkingLevelStr: string | undefined;
  if (typeof state.thinkingLevel === "string") {
    thinkingLevelStr = state.thinkingLevel;
  } else if (state.thinkingLevel && typeof state.thinkingLevel === "object") {
    thinkingLevelStr = (state.thinkingLevel as { level?: string }).level;
  }
  currentHeaderState = {
    ...currentHeaderState,
    contextPercent:
      ctx?.percent != null ? Math.round(ctx.percent) : currentHeaderState.contextPercent,
    sessionName: state.sessionName ?? currentHeaderState.sessionName,
    tokens:
      ctx?.tokens != null
        ? { input: ctx.tokens, output: 0, cacheRead: 0 }
        : currentHeaderState.tokens,
    details: {
      model: state.model && modelId ? { provider: state.model.provider, modelId } : undefined,
      thinkingLevel: thinkingLevelStr,
      steeringMode: state.steeringMode,
      followUpMode: state.followUpMode,
      interruptMode: state.interruptMode,
      messageCount: state.messageCount,
      queuedMessageCount: state.queuedMessageCount,
      toolCount: state.dumpTools?.length,
      hasSystemPrompt: !!state.systemPrompt,
    },
  };

  postToWebview({ type: "header.state", state: currentHeaderState });

  // Push todos separately so the webview can render the todo row
  if (state.todoPhases) {
    postToWebview({
      type: "header.todos",
      todos: state.todoPhases,
    } as ExtensionToWebviewMessage);
  }

  // Update queue modes for footer
  currentSteeringMode = state.steeringMode;
  currentFollowUpMode = state.followUpMode;
  currentInterruptMode = state.interruptMode;
}

/**
 * Update header with usage stats from get_session_stats.
 */
async function refreshHeaderStats(): Promise<void> {
  if (!rpcController?.isRunning()) return;
  try {
    const stats = await rpcController.getSessionStats();
    if (!stats) return;

    const usage = stats as Record<string, unknown>;
    currentHeaderState = {
      ...currentHeaderState,
      costUsd:
        typeof usage.totalCostUsd === "number" ? usage.totalCostUsd : currentHeaderState.costUsd,
      contextPercent:
        typeof usage.contextPercent === "number"
          ? Math.round(usage.contextPercent)
          : typeof usage.usedPercent === "number"
            ? Math.round(usage.usedPercent)
            : currentHeaderState.contextPercent,
      tokens:
        typeof usage.inputTokens === "number"
          ? {
              input: usage.inputTokens as number,
              output: (usage.outputTokens as number) ?? 0,
              cacheRead: (usage.cacheReadTokens as number) ?? 0,
            }
          : currentHeaderState.tokens,
    };

    postToWebview({ type: "header.state", state: currentHeaderState });
  } catch {
    // Non-critical — stats are best-effort
  }
}

/**
 * Push a failed launch state for the selection pane.
 */
function pushSelectionStateForFailed(
  mode: "new" | "resume",
  sessionPath: string | undefined,
  message: string,
  draft: string,
): void {
  const retry: WebviewToExtensionMessage =
    mode === "new"
      ? { type: "session.start", prompt: draft }
      : { type: "session.resume", sessionPath: sessionPath ?? "", prompt: draft || undefined };

  postToWebview({
    type: "selection.state",
    state: { kind: "failed", attempted: mode, sessionPath, message, retry, draft },
  });
}

/**
 * Push a launch failed state and error message to the webview.
 */
function pushLaunchFailed(
  mode: "new" | "resume",
  sessionPath: string | undefined,
  message: string,
  retry: WebviewToExtensionMessage,
): void {
  currentLaunchState = { kind: "failed", mode, sessionPath, message };
  postToWebview({ type: "session.launchState", state: currentLaunchState });
  postToWebview({
    type: "error",
    scope: "launch",
    message,
    retry,
  });
}

/**
 * Push the current runtime state to the webview.
 */
function pushRuntimeState(): void {
  if (rpcController?.isRunning()) {
    void rpcController
      .getState()
      .then((state) => {
        currentRuntimeState = mapControllerState(state, currentActiveSessionPath);
        postToWebview({ type: "runtime.state", state: currentRuntimeState });
      })
      .catch(() => {
        postToWebview({ type: "runtime.state", state: currentRuntimeState });
      });
  } else {
    postToWebview({ type: "runtime.state", state: currentRuntimeState });
  }
}

async function refreshSlashCatalogFromRuntime(): Promise<void> {
  let runtimeCommands: RuntimeDiscoveredCommand[] = [];

  if (rpcController?.isRunning()) {
    try {
      const result = await rpcController.send({ type: "get_commands" as any });
      runtimeCommands =
        typeof result === "object" &&
        result !== null &&
        Array.isArray((result as { commands?: unknown }).commands)
          ? ((result as { commands: RuntimeDiscoveredCommand[] }).commands ?? [])
          : [];
    } catch (error) {
      outputChannel.appendLine(
        `[omp] slash catalog runtime refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // If RPC returned nothing, scan command directories directly (same paths bridge uses)
  if (runtimeCommands.length === 0) {
    runtimeCommands = await scanCommandDirectories();
  }

  slashCatalog = mergeSlashCatalog(runtimeCommands);
  slashCatalogVersion = `${Date.now()}`;
  pushSlashCatalog();
  outputChannel.appendLine(
    `[omp] slash catalog refreshed: ${slashCatalog.length} total commands (${runtimeCommands.length} from runtime/scan)`,
  );
}

/** Scan command directories directly when get_commands RPC is unavailable. */
async function scanCommandDirectories(): Promise<RuntimeDiscoveredCommand[]> {
  const agentDir = resolveAgentDir();
  const commands: RuntimeDiscoveredCommand[] = [];

  const scanDir = async (dir: string, location: string) => {
    try {
      const entries = await fs.readdir(dir);
      for (const entry of entries) {
        if (!entry.endsWith(".md")) continue;
        const filePath = path.join(dir, entry);
        const name = entry.replace(/\.md$/, "");
        let description: string | undefined;
        try {
          const content = await fs.readFile(filePath, "utf-8");
          if (content.startsWith("---")) {
            const endIdx = content.indexOf("\n---", 3);
            if (endIdx > 0) {
              const frontmatter = content.slice(4, endIdx);
              const descLine = frontmatter.split("\n").find((l) => l.startsWith("description:"));
              description = descLine?.slice(12).trim();
            }
          }
          if (!description) {
            description = content
              .split("\n")
              .find((l) => l.trim())
              ?.slice(0, 80);
          }
        } catch {}
        commands.push({ name, description, source: "prompt", location, path: filePath });
      }
    } catch {}
  };

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  await scanDir(path.join(agentDir, "commands"), "user");
  if (workspaceFolder) {
    await scanDir(path.join(workspaceFolder, ".omp", "commands"), "project");
  }

  return commands;
}
function pushSlashCatalog(): void {
  const visibleCommands = slashCatalog.filter(
    (cmd) => cmd.phase <= CURRENT_PHASE || cmd.source === "runtime",
  );
  postToWebview({
    type: "slash.catalog",
    version: slashCatalogVersion,
    commands: visibleCommands.map((cmd) => ({
      name: cmd.name,
      description: cmd.description,
      tier: cmd.tier,
      source: cmd.source,
      aliases: cmd.aliases,
      acceptsArgs: cmd.acceptsArgs,
      argsHint: cmd.argsHint,
      inlineHint: cmd.argsHint,
      runtimeMeta: cmd.runtimeMeta,
      route: {
        kind: cmd.route.kind,
        reason: cmd.route.kind === "blocked" ? cmd.route.reason : undefined,
      },
    })),
  });
}

/**
 * Ephemeral badge rule:
 * Show badge when command effect is INVISIBLE in the UI.
 * Skip when: UI trigger (picker opens), Tier 4 with path (command card), or
 * mode/model/thinking change (pill updates visually).
 */
const BADGE_SKIP_RPC_TYPES = new Set([
  "set_model",
  "set_thinking_level",
  "set_steering_mode",
  "set_follow_up_mode",
  "set_interrupt_mode",
  "set_auto_compaction",
  "set_auto_retry",
  "cycle_model",
  "cycle_thinking_level",
  "new_session",
]);

/** Host actions with visible side effects — no badge needed. */
const BADGE_SKIP_HOST_ACTIONS = new Set([
  "newSession", // session changes entirely
  "resumeSession", // session switches — visible
  "openChat", // panel opens — visible
  "openSessionFile", // editor tab opens — visible
  "openHelpUrl", // browser opens — visible
  "showDiagnostics", // output channel opens — visible
  "cycleRoles", // role pill updates — visible
]);

function shouldEmitBadge(command: SlashCommand): boolean {
  // UI triggers have visible effect (picker/screen opens)
  if (command.route.kind === "webview") return false;
  // Tier 4 with path already gets a command card
  if (command.runtimeMeta?.path) return false;
  // Config panels open visibly
  if (command.route.kind === "config") return false;
  // Blocked commands show error toast
  if (command.route.kind === "blocked") return false;
  // Mode/model/thinking RPC commands update pills visibly
  if (command.route.kind === "rpc" && BADGE_SKIP_RPC_TYPES.has(command.route.rpcType)) return false;
  // Host actions with visible side effects
  if (command.route.kind === "host" && BADGE_SKIP_HOST_ACTIONS.has(command.route.action))
    return false;
  // Everything else: badge it (clipboard ops, background tasks, invisible effects)
  return true;
}

async function handleSlashExecute(
  message: Extract<WebviewToExtensionMessage, { type: "slash.execute" }>,
): Promise<void> {
  if (!slashDispatcher) {
    postToWebview({
      type: "slash.result",
      command: message.command,
      ok: false,
      message: "Slash dispatcher unavailable.",
    });
    return;
  }

  const parsed = parseSlashInput(message.raw);
  const commandName = parsed.command || message.command;
  const args = parsed.isSlash ? parsed.args : message.args;
  const resolved = resolveSlashCommand(slashCatalog, commandName, args);
  if (resolved && resolved.phase > CURRENT_PHASE && resolved.source !== "runtime") {
    postToWebview({
      type: "slash.result",
      command: resolved.name,
      ok: false,
      message: "This command is not yet available in the current version",
    });
    return;
  }
  const command = resolved ?? {
    name: commandName,
    description: "Runtime pass-through",
    tier: 4,
    source: "runtime",
    route: { kind: "passThrough" as const },
    acceptsArgs: true,
    phase: 1,
  };

  const result = await slashDispatcher.execute(command, args, message.raw);

  // Emit command card frame for Tier 4 (skill/prompt) commands on success
  if (result.ok && command.runtimeMeta?.path) {
    postToWebview({
      type: "runtime.frame",
      frame: {
        type: "command_invocation",
        command: command.name,
        args: args,
        source: (command as any).runtimeMeta?.path,
      },
    });
  }

  if (result.ok && command.route.kind === "rpc" && rpcController?.isRunning()) {
    try {
      const state = await rpcController.getState();
      currentRuntimeState = mapControllerState(state, currentActiveSessionPath);
      postToWebview({ type: "runtime.state", state: currentRuntimeState });
      if (state.steeringMode) currentSteeringMode = state.steeringMode;
      if (state.followUpMode) currentFollowUpMode = state.followUpMode;
      if (state.interruptMode) currentInterruptMode = state.interruptMode;
      // Detect active role from model
      const currentModel = state.model as { provider?: string; id?: string } | undefined;
      if (currentModel?.id) {
        const modelKey = `${currentModel.provider ?? ""}/${currentModel.id}`;
        const matchedRole = Object.entries(cachedModelRoles).find(
          ([, pattern]) =>
            pattern === modelKey ||
            modelKey.includes(pattern) ||
            pattern.includes(currentModel.id!),
        );
        currentModelRole = matchedRole?.[0] ?? currentModelRole;
      }
      updateHeaderFromOmpState(state);
      pushFooterState();
    } catch {
      // State refresh failed — non-critical, UI will catch up
    }
  }

  postToWebview({
    type: "slash.result",
    command: result.command,
    ok: result.ok,
    message: result.message,
  });

  // Emit ephemeral badge for commands whose effect is invisible in the UI
  if (result.ok && shouldEmitBadge(command)) {
    postToWebview({
      type: "runtime.frame",
      frame: {
        type: "command_badge",
        command: command.name,
        message: result.message,
      },
    });
  }
}

/**
 * Post a typed message to the webview.
 *
 * Silently drops the message if the provider is not yet resolved.
 * This is acceptable for initial state pushes; the webview will
 * request a rehydration via `webview.ready` on reload.
 */
function postToWebview(message: ExtensionToWebviewMessage): void {
  void chatProvider?.postMessage(message);
}

/**
 * Push footer state to the webview.
 *
 * Reads the current active editor and selection from VS Code, plus
 * runtime model/thinking state, and sends a footer.state message.
 */
function pushFooterState(): void {
  const editor = vscode.window.activeTextEditor;
  const items: ChatFooterItem[] = [];

  // Editor context
  if (editor) {
    items.push({
      source: "vscodeBridge",
      kind: "editor",
      filePath: editor.document.uri.fsPath,
      languageId: editor.document.languageId,
      isDirty: editor.document.isDirty,
    });

    // Selection/cursor
    const sel = editor.selection;
    if (sel && !sel.isEmpty) {
      items.push({
        source: "vscodeBridge",
        kind: "selection",
        line: sel.start.line + 1, // VS Code is 0-indexed, display as 1-indexed
        endLine: sel.end.line + 1,
      });
    } else if (sel) {
      items.push({
        source: "vscodeBridge",
        kind: "selection",
        line: sel.active.line + 1,
      });
    }
  } else {
    items.push({
      source: "vscodeBridge",
      kind: "editor",
      filePath: undefined,
      languageId: undefined,
      isDirty: false,
    });
  }

  // Runtime model/thinking
  if (currentRuntimeState.kind === "ready" || currentRuntimeState.kind === "streaming") {
    const rs = currentRuntimeState as Record<string, unknown>;
    const model = rs.model
      ? typeof rs.model === "string"
        ? rs.model
        : (rs.model as any)?.id || (rs.model as any)?.name || undefined
      : undefined;
    items.push({
      source: "ompRuntime",
      kind: "runtime",
      state: currentRuntimeState.kind as "ready" | "streaming",
      model: model ?? undefined,
      thinking: (rs.thinking as import("./protocol/webviewMessages.ts").ThinkingLevel) ?? undefined,
    } as ChatFooterItem);
  } else {
    items.push({
      source: "ompRuntime",
      kind: "runtime",
      state: currentRuntimeState.kind === "disconnected" ? "ready" : "error",
      model: undefined,
      thinking: undefined,
    });
  }

  // Push queue modes as a separate conceptual item (webview extracts from footer.state)
  postToWebview({ type: "footer.state", items });

  // Push queue modes directly via runtime state
  postToWebview({
    type: "footer.modes",
    steeringMode: currentSteeringMode,
    followUpMode: currentFollowUpMode,
    interruptMode: currentInterruptMode,
    activeRole: currentModelRole,
    availableRoles: Object.keys(cachedModelRoles),
  } as ExtensionToWebviewMessage);

  // Determine thinking support from cached model list
  if (currentRuntimeState.kind === "ready" || currentRuntimeState.kind === "streaming") {
    const rs = currentRuntimeState as Record<string, unknown>;
    const modelRef = rs.model as { provider?: string; id?: string } | string | undefined;
    const modelId = typeof modelRef === "string" ? modelRef : modelRef?.id;

    let thinkingSupported = false;
    let thinkingMinLevel: string | undefined;
    let thinkingMaxLevel: string | undefined;

    if (modelId && cachedAvailableModels.length > 0) {
      const matchedModel = cachedAvailableModels.find((m) => m.id === modelId);
      if (matchedModel && matchedModel.thinking) {
        thinkingSupported = true;
        const t = matchedModel.thinking as Record<string, unknown>;
        thinkingMinLevel = t.minLevel as string | undefined;
        thinkingMaxLevel = t.maxLevel as string | undefined;
      }
    } else if (rs.thinking != null) {
      // Fallback: if runtime reports thinkingLevel, it's supported
      thinkingSupported = true;
    }

    postToWebview({
      type: "footer.thinkingSupport",
      supported: thinkingSupported,
      minLevel: thinkingMinLevel,
      maxLevel: thinkingMaxLevel,
    } as ExtensionToWebviewMessage);
  }
}

export async function activate(context: vscode.ExtensionContext) {
  extensionUri = context.extensionUri;
  outputChannel = vscode.window.createOutputChannel("Oh My Coder", { log: true });
  context.subscriptions.push(outputChannel);

  outputChannel.appendLine("[omp] activating oh-my-coder extension");

  // Load models.dev catalog from disk immediately, then background-refresh if stale.
  void loadFromDisk((msg) => outputChannel.appendLine(msg)).then(() => {
    if (isExpired()) {
      refreshModelCatalog(false);
    }
  });

  await startBridge(context);
  context.subscriptions.push({
    dispose: () => {
      const dispose = bridgeContext?.dispose;
      bridgeContext = undefined;
      void dispose?.();
    },
  });

  // Verify omp binary is resolvable
  const ompPath = findOmpBinary();
  outputChannel.appendLine(`[omp] resolved binary: ${ompPath}`);

  // Register commands
  const commands: [string, (...args: never[]) => void | Promise<void>][] = [
    ["omp.openChat", () => focusChatView()],
    ["omp.openSettings", () => SettingsEditorProvider.openPanel(extensionUri)],
    ["omp.showHistory", () => showHistoryScreen()],
    ["omp.newSession", () => focusChatView()],
    ["omp.resumeSession", () => focusChatView()],
    ["omp.addFileToChatContext", (uri?: vscode.Uri) => addFileToChatContext(uri)],
    ["omp.addSelectionToChatContext", () => addSelectionToChatContext()],
    ["omp.focusInput", () => sendRuntimeCommand("focusInput")],
    ["omp.switchModel", () => sendRuntimeCommand("switchModel")],
    ["omp.cycleThinkingLevel", () => sendRuntimeCommand("cycleThinkingLevel")],
    ["omp.compact", () => sendRuntimeCommand("compact")],
    [
      "omp.openCurrentSessionInEditor",
      () => {
        if (currentActiveSessionPath) {
          const uri = vscode.Uri.file(currentActiveSessionPath);
          void vscode.workspace.openTextDocument(uri).then((doc) => {
            vscode.window.showTextDocument(doc, { preview: false });
          });
        } else {
          outputChannel.appendLine("[omp] openCurrentSessionInEditor: no active session");
        }
      },
    ],
    [
      "omp.showDiagnosticsLog",
      () => {
        outputChannel.show(true);
      },
    ],
    [
      "omp.cycleRoles",
      async () => {
        if (!rpcController?.isRunning()) return;
        const roles = cachedCycleOrder.filter((role) => cachedModelRoles[role]);
        if (roles.length === 0) return;

        // Find current role index
        let currentIdx = currentModelRole ? roles.indexOf(currentModelRole) : -1;
        const nextIdx = (currentIdx + 1) % roles.length;
        const nextRole = roles[nextIdx]!;
        const nextModelPattern = cachedModelRoles[nextRole];
        if (!nextModelPattern) return;

        // Parse "provider/modelId:thinkingLevel" pattern
        // The colon-suffix is a thinking level (e.g., ":medium", ":low", ":off")
        let thinkingLevel: string | undefined;
        let modelSpec = nextModelPattern;
        const lastColon = modelSpec.lastIndexOf(":");
        if (lastColon > 0 && modelSpec.indexOf("/") < lastColon) {
          // Colon exists after the provider/model slash — it's a thinking level
          thinkingLevel = modelSpec.slice(lastColon + 1);
          modelSpec = modelSpec.slice(0, lastColon);
        }

        const slash = modelSpec.indexOf("/");
        let provider: string;
        let modelId: string;
        if (slash > 0) {
          provider = modelSpec.slice(0, slash);
          modelId = modelSpec.slice(slash + 1);
        } else {
          const match = cachedAvailableModels.find((m) => m.id.includes(modelSpec));
          if (!match) return;
          provider = match.provider;
          modelId = match.id;
        }

        await rpcController.send({ type: "set_model", provider, modelId });
        if (thinkingLevel) {
          await rpcController.send({ type: "set_thinking_level", level: thinkingLevel } as any);
        }
        currentModelRole = nextRole;

        // Refresh UI state
        try {
          const state = await rpcController.getState();
          currentRuntimeState = mapControllerState(state, currentActiveSessionPath);
          postToWebview({ type: "runtime.state", state: currentRuntimeState });
          updateHeaderFromOmpState(state);
          pushFooterState();
        } catch {
          // Best effort — push footer anyway to reflect role change
          pushFooterState();
        }
      },
    ],
    [
      "omp.refreshCommands",
      async () => {
        outputChannel.appendLine("[omp] Manual slash catalog refresh triggered");
        await refreshSlashCatalogFromRuntime();
      },
    ],
  ];

  for (const [id, handler] of commands) {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  }

  // Status bar item — compact, opens/focuses OMP
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = "$(comment-discussion) OMC";
  statusBarItem.tooltip = "Open Oh My Coder";
  statusBarItem.command = "omp.openChat";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Webview view provider — typed IPC, CSP/nonce, real message routing
  chatProvider = new OmpChatProvider(extensionUri, handleWebviewMessage, outputChannel);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("omp.chatView", chatProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
  context.subscriptions.push({
    dispose: () => {
      chatProvider = undefined;
    },
  });

  // Settings panel provider — wire message handler and file watcher
  SettingsEditorProvider.setMessageHandler(handleWebviewMessage);
  const configWatcher = watchConfigFile(() => {
    if (saveInFlight) return;
    outputChannel.appendLine("[omp] config.yml changed externally — refreshing");
    void (async () => {
      const config = await refreshOmpConfig();
      const settingsConfig = await getSettingsPanelConfig(config.raw);
      const agents = await fetchAgentsFromReverseBridge();
      const providerStatus = await fetchProviderStatusFromReverseBridge();
      const skills = await fetchSkillsFromReverseBridge();
      const mcpServers = await fetchMcpServersFromReverseBridge();
      const payload = {
        type: "settings.loaded" as const,
        config: settingsConfig,
        agents,
        bridgeAvailable: !!bridgeContext?.reverseBridgePort,
        providerStatus,
        skills,
        mcpServers,
      };
      postToWebview(payload);
      SettingsEditorProvider.postMessage(payload);
    })();
  });
  context.subscriptions.push({ dispose: () => configWatcher.dispose() });
  context.subscriptions.push({ dispose: () => SettingsEditorProvider.dispose() });

  slashDispatcher = new SlashDispatcher({
    rpc: {
      send: async (command: Record<string, unknown>) => {
        if (!rpcController?.isRunning()) return undefined;
        return rpcController.send(command as any);
      },
      prompt: async (text: string) => {
        if (!rpcController?.isRunning()) return;
        await rpcController.prompt({ message: text });
      },
    },
    isConnected: () => !!rpcController?.isRunning(),
    executeVscodeCommand: vscode.commands.executeCommand,
    postToWebview: (message: unknown) => postToWebview(message as ExtensionToWebviewMessage),
    openSettingsPanel: (tab) => {
      SettingsEditorProvider.openPanel(extensionUri, tab);
    },
    openHelpUrl: "https://github.com/anthropics/oh-my-coder",
    expandAndSend: async (command, args) => {
      const filePath = command.runtimeMeta?.path;
      if (!filePath) {
        return { ok: false, command: command.name, message: "No file path for command" };
      }
      const kind = command.runtimeMeta?.source === "skill" ? "skill" : "prompt";
      const result = await expandCommand(filePath, args, command.name, kind);
      if (!result.ok) {
        return { ok: false, command: command.name, message: result.message };
      }
      await rpcController!.prompt({ message: result.envelope });
      outputChannel.appendLine(`[omp] Expanded /${command.name} from ${filePath}`);
      return { ok: true, command: command.name, message: `Expanded from ${filePath}` };
    },
    exportMd: async (outputPath?: string) => {
      if (!rpcController?.isRunning()) return undefined;
      const res = await rpcController.send({ type: "get_messages" } as any);
      const messages =
        (res as { messages?: Array<{ role: string; content: unknown }> })?.messages ??
        (Array.isArray(res) ? (res as Array<{ role: string; content: unknown }>) : []);

      const lines: string[] = ["# Session Transcript\n"];
      for (const msg of messages) {
        const role =
          msg.role === "user" ? "User" : msg.role === "assistant" ? "Assistant" : msg.role;
        const content =
          typeof msg.content === "string"
            ? msg.content
            : Array.isArray(msg.content)
              ? (msg.content as Array<{ type?: string; text?: string }>)
                  .filter((b) => b.type === "text")
                  .map((b) => b.text)
                  .join("\n")
              : "";
        if (!content.trim()) continue;
        lines.push(`## ${role}\n`);
        lines.push(content);
        lines.push("");
      }

      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      let resolvedPath: string;
      if (outputPath) {
        resolvedPath = path.isAbsolute(outputPath)
          ? outputPath
          : path.join(workspaceRoot ?? process.cwd(), outputPath);
      } else {
        resolvedPath = path.join(workspaceRoot ?? process.cwd(), "session-export.md");
      }

      await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
      await fs.writeFile(resolvedPath, lines.join("\n"), "utf-8");
      return resolvedPath;
    },
  });
  void refreshSlashCatalogFromRuntime();

  // ── Editor context listeners for footer ────────────────────────────────
  // Track active editor and selection to push file context to the webview footer.
  // Text document changes are debounced to avoid per-keystroke message churn.
  let textChangeTimer: ReturnType<typeof setTimeout> | undefined;
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => pushFooterState()),
    vscode.window.onDidChangeTextEditorSelection(() => pushFooterState()),
    vscode.workspace.onDidChangeTextDocument((e) => {
      // Only push if the changed doc is the active editor's document
      const active = vscode.window.activeTextEditor;
      if (active && e.document === active.document) {
        if (textChangeTimer) clearTimeout(textChangeTimer);
        textChangeTimer = setTimeout(() => pushFooterState(), 300);
      }
    }),
  );
  context.subscriptions.push({
    dispose: () => {
      if (textChangeTimer) clearTimeout(textChangeTimer);
    },
  });

  outputChannel.appendLine("[omp] activation complete");
}

export async function deactivate() {
  // Stop the RPC controller if active.
  if (rpcController) {
    try {
      await rpcController.stop("deactivate");
    } catch {
      // Best-effort stop on deactivation.
    }
    try {
      await rpcController.dispose();
    } catch {
      // Best-effort disposal.
    }
    rpcController = undefined;
  }

  const dispose = bridgeContext?.dispose;
  bridgeContext = undefined;
  await dispose?.();
}

/**
 * Focus the OMP chat view in the Activity Bar.
 */
function focusChatView(): void {
  vscode.commands.executeCommand("omp.chatView.focus");
}

function showHistoryScreen(): void {
  focusChatView();
  postToWebview({ type: "ui.trigger", action: "openHistory" });
}

async function addFileToChatContext(uri?: vscode.Uri): Promise<void> {
  const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!targetUri || targetUri.scheme !== "file") return;

  const activeEditor = vscode.window.activeTextEditor;
  const selection =
    activeEditor?.document.uri.toString() === targetUri.toString()
      ? activeEditor.selection
      : undefined;

  focusChatView();
  postToWebview({
    type: "composer.addFileContext",
    context: {
      path: targetUri.fsPath,
      languageId:
        activeEditor?.document.uri.toString() === targetUri.toString()
          ? activeEditor.document.languageId
          : undefined,
      line: selection ? selection.start.line + 1 : undefined,
      endLine: selection && !selection.isEmpty ? selection.end.line + 1 : undefined,
    },
  });
}

async function addSelectionToChatContext(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== "file") return;
  const selection = editor.selection;
  if (!selection || selection.isEmpty) return;

  focusChatView();
  postToWebview({
    type: "composer.addFileContext",
    context: {
      path: editor.document.uri.fsPath,
      languageId: editor.document.languageId,
      line: selection.start.line + 1,
      endLine: selection.end.line + 1,
    },
  });
}

/**
 * Open a file in the VS Code editor, optionally at a specific line.
 */
async function handleOpenFile(filePath: string, line?: number, endLine?: number): Promise<void> {
  try {
    // Resolve relative paths against workspace folder
    let uri: vscode.Uri;
    if (filePath.startsWith("/") || filePath.match(/^[A-Za-z]:\\/)) {
      // Absolute path
      uri = vscode.Uri.file(filePath);
    } else {
      // Relative path — resolve against workspace root
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (workspaceFolder) {
        uri = vscode.Uri.joinPath(workspaceFolder, filePath);
      } else {
        uri = vscode.Uri.file(filePath);
      }
    }

    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: true });

    if (line) {
      const startLine = Math.max(0, line - 1);
      const endLn = endLine ? Math.max(0, endLine - 1) : startLine;
      const range = new vscode.Range(startLine, 0, endLn, 0);
      editor.selection = new vscode.Selection(range.start, range.end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    outputChannel.appendLine(`[omp] openFile failed: ${msg}`);
  }
}

/**
 * Dispatch a runtime command placeholder.
 * Full runtime command wiring depends on the RPC controller.
 */
function sendRuntimeCommand(command: string): void {
  if (command === "focusInput") {
    // Focus is a webview intent, not an RPC command.
    postToWebview({ type: "runtime.state", state: currentRuntimeState });
    outputChannel.appendLine("[omp] focusInput — posting current state");
    return;
  }

  if (!rpcController?.isRunning()) {
    outputChannel.appendLine(`[omp] runtime command '${command}' — no active session`);
    return;
  }

  // Delegate to controller for wired commands.
  outputChannel.appendLine(`[omp] runtime command '${command}' deferred to later slice`);
}
