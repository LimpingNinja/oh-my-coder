/**
 * OMP VS Code Bridge Extension
 *
 * Preserved from pi-vscode bridge architecture. This runtime-side bridge
 * extension is passed to the OMP process via `--extension` so the agent
 * can call back into VS Code editor/workspace capabilities through the
 * local authenticated HTTP bridge.
 *
 * Product identity uses OMP-prefixed env variables and auth headers.
 * Legacy PI_VSCODE_* env variables and x-pi-vscode-authorization header
 * are read as fallbacks for upstream runtime compatibility.
 */
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
export default function (pi) {
  // OMP product identity env vars are primary; PI_ prefixed vars are
  // upstream runtime compatibility — the extension host injects both.
  const bridgeUrl = process.env.OMP_VSCODE_BRIDGE_URL || process.env.PI_VSCODE_BRIDGE_URL;
  const bridgeToken = process.env.OMP_VSCODE_BRIDGE_TOKEN || process.env.PI_VSCODE_BRIDGE_TOKEN;

  if (!bridgeUrl || !bridgeToken) return;

  const MAX_RESULT_BYTES = 50 * 1024;
  const MAX_RESULT_LINES = 2000;
  const STATUS_ID = "omp-vscode";
  const STATUS_REFRESH_MS = 1500;
  const MAX_STATUS_PATH_LENGTH = 48;
  let statusTimer;
  let statusRefreshInFlight = false;
  let statusGeneration = 0;
  let lastStatusKey;
  let latestContext;

  const callBridge = async (method, params = {}) => {
    const response = await fetch(`${bridgeUrl}/rpc`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // OMP product identity header with legacy pi-vscode fallback
        // for upstream/runtime compatibility.
        "x-omp-authorization": bridgeToken,
        "x-pi-vscode-authorization": bridgeToken,
      },
      body: JSON.stringify({ method, params }),
    });
    const payload = await response.json().catch(() => undefined);
    if (!response.ok) {
      const message = payload?.error || `Bridge request failed with status ${response.status}`;
      throw new Error(message);
    }
    return payload?.result;
  };

  const importRuntimeTaskModule = async () => {
    const errors = [];

    const tryImport = async (label, loader) => {
      try {
        const mod = await loader();
        if (typeof mod?.discoverAgents === "function") return mod;
        errors.push(`${label}: discoverAgents export missing`);
      } catch (err) {
        errors.push(`${label}: ${err?.message || err}`);
      }
      return undefined;
    };

    const direct = await tryImport(
      "direct subpath import",
      () => import("@oh-my-pi/pi-coding-agent/task"),
    );
    if (direct) return direct;

    const runtimeParents = [
      typeof Bun !== "undefined" ? Bun.main : undefined,
      process.argv?.[1],
      process.execPath,
    ].filter(Boolean);

    for (const parent of runtimeParents) {
      const resolved = await tryImport(`createRequire(${parent})`, async () => {
        const requireFromRuntime = createRequire(parent);
        const resolvedPath = requireFromRuntime.resolve("@oh-my-pi/pi-coding-agent/task");
        return import(pathToFileURL(resolvedPath).href);
      });
      if (resolved) return resolved;
    }

    throw new Error(errors.join("; "));
  };

  const serializeAgent = (agent) => ({
    name: agent.name,
    description: agent.description ?? "",
    systemPrompt: agent.systemPrompt ?? "",
    tools: agent.tools,
    spawns: agent.spawns,
    model: agent.model,
    thinkingLevel: agent.thinkingLevel,
    source: agent.source ?? "bundled",
    filePath: agent.filePath,
  });

  const truncateText = (text) => {
    const lines = text.split("\n");
    let output =
      lines.length > MAX_RESULT_LINES ? lines.slice(0, MAX_RESULT_LINES).join("\n") : text;
    if (Buffer.byteLength(output, "utf8") > MAX_RESULT_BYTES) {
      const buffer = Buffer.from(output, "utf8");
      output = buffer.subarray(0, MAX_RESULT_BYTES).toString("utf8");
    }
    return output;
  };

  const boundedJson = (value) => {
    const text = JSON.stringify(value) ?? "null";
    const lineCount = text.split("\n").length;
    const byteCount = Buffer.byteLength(text, "utf8");
    if (lineCount <= MAX_RESULT_LINES && byteCount <= MAX_RESULT_BYTES) return text;
    return JSON.stringify({
      truncated: true,
      message:
        "VS Code bridge result exceeded output limits. Re-run the tool with a narrower file/range/query if you need complete structured data.",
      originalBytes: byteCount,
      originalLines: lineCount,
      resultJsonPrefix: truncateText(text),
    });
  };

  const jsonResult = async (method, params) => ({
    content: [{ type: "text", text: boundedJson(await callBridge(method, params)) }],
    details: {},
  });

  const workspaceRelativePath = (filePath, workspaceFolders = []) => {
    if (!filePath) return "";
    const roots = [
      ...workspaceFolders.map((folder) => folder?.filePath).filter(Boolean),
      process.cwd(),
    ];

    let best = filePath;
    for (const root of roots) {
      const relative = path.relative(root, filePath);
      if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
        if (!relative) return path.basename(filePath);
        if (relative.length < best.length) best = relative;
      }
    }
    return best;
  };

  const shortenPath = (filePath) => {
    if (filePath.length <= MAX_STATUS_PATH_LENGTH) return filePath;
    const parts = filePath.split(/[\\/]+/).filter(Boolean);
    if (parts.length <= 2) return `…${filePath.slice(-(MAX_STATUS_PATH_LENGTH - 1))}`;
    const shortened = `…/${parts.slice(-2).join("/")}`;
    if (shortened.length <= MAX_STATUS_PATH_LENGTH) return shortened;
    return `…${shortened.slice(-(MAX_STATUS_PATH_LENGTH - 1))}`;
  };

  const formatSelectionStatus = (selection) => {
    if (!selection) return "no selection";
    const startLine = selection.start.line + 1;
    const startCharacter = selection.start.character + 1;
    const endLine = selection.end.line + 1;
    const endCharacter = selection.end.character + 1;
    if (selection.isEmpty) return `Ln ${startLine}, Col ${startCharacter}`;

    const selectedCharacters = selection.selectedCharacterCount ?? selection.text?.length;
    if (startLine === endLine) {
      const size = selectedCharacters === undefined ? "" : ` ${selectedCharacters} chars`;
      return `sel${size} @ ${startLine}:${startCharacter}-${endCharacter}`;
    }
    return `sel ${selection.selectedLineCount ?? endLine - startLine + 1} lines @ ${startLine}-${endLine}`;
  };

  const diagnosticsStatus = (counts) => {
    const parts = [];
    if (counts.errors) parts.push(`E${counts.errors}`);
    if (counts.warnings) parts.push(`W${counts.warnings}`);
    if (counts.infos) parts.push(`I${counts.infos}`);
    if (counts.hints) parts.push(`H${counts.hints}`);
    return parts.length > 0 ? parts.join(" ") : "✓";
  };

  const formatStatus = (status, ctx) => {
    const theme = ctx.ui.theme;
    const prefix = theme.fg("accent", "VS Code");
    const activeEditor = status?.activeEditor;
    if (!activeEditor?.filePath) return `${prefix}: ${theme.fg("dim", "no active editor")}`;

    const relativePath = shortenPath(
      workspaceRelativePath(activeEditor.filePath, status.workspaceFolders),
    );
    const dirty = activeEditor.isDirty ? theme.fg("warning", "● ") : "";
    const language = activeEditor.languageId ? ` • ${activeEditor.languageId}` : "";
    const selectionText = formatSelectionStatus(status.selection);
    const diagnosticCounts = status.diagnostics ?? { errors: 0, warnings: 0, infos: 0, hints: 0 };
    const issueText = diagnosticsStatus(diagnosticCounts);
    const coloredIssues =
      diagnosticCounts.errors > 0
        ? theme.fg("error", issueText)
        : diagnosticCounts.warnings > 0
          ? theme.fg("warning", issueText)
          : theme.fg("success", issueText);

    return `${prefix}: ${dirty}${relativePath} • ${selectionText}${language} • ${coloredIssues}`;
  };

  const setStatus = (ctx, statusKey, statusText) => {
    if (!ctx?.hasUI) return;
    if (statusKey === lastStatusKey) return;
    lastStatusKey = statusKey;
    ctx.ui.setStatus(STATUS_ID, statusText);
  };

  const refreshStatus = async (ctx, generation = statusGeneration) => {
    if (!ctx?.hasUI || generation !== statusGeneration || statusRefreshInFlight) return;
    statusRefreshInFlight = true;
    try {
      const status = await callBridge("getStatus");
      if (generation !== statusGeneration) return;
      const statusText = formatStatus(status, ctx);
      setStatus(ctx, statusText, statusText);
    } catch (error) {
      if (generation !== statusGeneration) return;
      const message = error instanceof Error ? error.message : String(error);
      const statusText = `${ctx.ui.theme.fg("accent", "VS Code")}: ${ctx.ui.theme.fg(
        "warning",
        `bridge unavailable (${message})`,
      )}`;
      setStatus(ctx, `error:${message}`, statusText);
    } finally {
      statusRefreshInFlight = false;
    }
  };

  const stopStatusUpdates = (ctx) => {
    if (statusTimer) {
      clearInterval(statusTimer);
      statusTimer = undefined;
    }
    statusGeneration++;
    lastStatusKey = undefined;
    if (ctx?.hasUI) ctx.ui.setStatus(STATUS_ID, undefined);
  };

  const startStatusUpdates = (ctx) => {
    if (!ctx?.hasUI) return;
    stopStatusUpdates(ctx);
    const generation = statusGeneration;
    void refreshStatus(ctx, generation);
    statusTimer = setInterval(() => {
      void refreshStatus(ctx, generation);
    }, STATUS_REFRESH_MS);
  };

  const reportTerminalSession = async (ctx) => {
    // OMP product identity; PI_ fallback for upstream runtime compatibility.
    const terminalId = process.env.OMP_VSCODE_TERMINAL_ID || process.env.PI_VSCODE_TERMINAL_ID;
    if (!terminalId) return;
    const sessionFile = ctx?.sessionManager?.getSessionFile?.();
    if (!sessionFile) return;
    try {
      await callBridge("reportTerminalSession", { terminalId, sessionFile });
    } catch {}
  };


  const parseSkillDescription = (content) => {
    if (!content.startsWith("---"))
      return (
        content
          .split("\n")
          .find((l) => l.trim())
          ?.slice(0, 80) || ""
      );
    const endIdx = content.indexOf("\n---", 3);
    if (endIdx === -1) return "";
    const frontmatter = content.slice(4, endIdx);
    const descLine = frontmatter.split("\n").find((l) => l.startsWith("description:"));
    return descLine ? descLine.slice(12).trim() : "";
  };
  const pushSlashCommands = async () => {
    const commands = [];

    const parseDescription = (content) => {
      if (!content.startsWith("---"))
        return (
          content
            .split("\n")
            .find((l) => l.trim())
            ?.slice(0, 80) || ""
        );
      const endIdx = content.indexOf("\n---", 3);
      if (endIdx === -1) return "";
      const frontmatter = content.slice(4, endIdx);
      const descLine = frontmatter.split("\n").find((l) => l.startsWith("description:"));
      return descLine ? descLine.slice(12).trim() : "";
    };

    const scanCommandsDir = (dir, location) => {
      try {
        const entries = fs.readdirSync(dir);
        for (const entry of entries) {
          if (!entry.endsWith(".md")) continue;
          const filePath = path.join(dir, entry);
          try {
            const content = fs.readFileSync(filePath, "utf-8");
            commands.push({
              name: entry.replace(/\.md$/, ""),
              description: parseDescription(content),
              source: "prompt",
              location,
              path: filePath,
            });
          } catch {}
        }
      } catch {}
    };

    const scanSkillsDir = (dir, location) => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const skillFile = path.join(dir, entry.name, "SKILL.md");
          try {
            const content = fs.readFileSync(skillFile, "utf-8");
            commands.push({
              name: `skill:${entry.name}`,
              description: parseDescription(content),
              source: "skill",
              location,
              path: skillFile,
            });
          } catch {}
        }
      } catch {}
    };

    const configDir = process.env.PI_CONFIG_DIR || ".omp";
    const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), configDir, "agent");
    scanCommandsDir(path.join(agentDir, "commands"), "user");
    scanSkillsDir(path.join(agentDir, "skills"), "user");

    const cwd = process.cwd();
    scanCommandsDir(path.join(cwd, ".omp", "commands"), "project");
    scanSkillsDir(path.join(cwd, ".omp", "skills"), "project");

    process.stderr.write(`[omp-bridge] Discovered ${commands.length} commands/skills\n`);
    if (commands.length > 0) {
      try {
        await callBridge("pushCommands", { commands });
        process.stderr.write(`[omp-bridge] Pushed ${commands.length} commands to VS Code\n`);
      } catch (err) {
        process.stderr.write(`[omp-bridge] Failed to push commands: ${err?.message || err}\n`);
      }
    }
  };

  const pushAgents = async () => {
    try {
      const { discoverAgents } = await importRuntimeTaskModule();
      const { agents } = await discoverAgents(process.cwd());
      process.stderr.write(
        `[omp-bridge] Discovered ${agents.length} agents via runtime discovery\n`,
      );

      await callBridge("pushAgents", {
        agents: agents.map(serializeAgent),
      });
      process.stderr.write(`[omp-bridge] Pushed ${agents.length} agents to VS Code\n`);
    } catch (err) {
      process.stderr.write(`[omp-bridge] Agent discovery failed: ${err?.message || err}\n`);
      // Fallback: push empty to clear stale state
      try {
        await callBridge("pushAgents", { agents: [] });
      } catch {}
    }
  };


  // ─── Provider Status ──────────────────────────────────────────────────────────
  const PROVIDER_META = [
    { id: "anthropic", name: "Anthropic", authMethod: "apiKey", badgeLabel: "API Key", envVars: ["ANTHROPIC_API_KEY"] },
    { id: "openai", name: "OpenAI", authMethod: "apiKey", badgeLabel: "API Key", envVars: ["OPENAI_API_KEY"] },
    { id: "google", name: "Google AI", authMethod: "apiKey", badgeLabel: "API Key", envVars: ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"] },
    { id: "openai-codex", name: "OpenAI Codex", authMethod: "oauth", badgeLabel: "OAuth", envVars: [] },
    { id: "groq", name: "Groq", authMethod: "apiKey", badgeLabel: "API Key", envVars: ["GROQ_API_KEY"] },
    { id: "deepseek", name: "DeepSeek", authMethod: "apiKey", badgeLabel: "API Key", envVars: ["DEEPSEEK_API_KEY"] },
    { id: "mistral", name: "Mistral", authMethod: "apiKey", badgeLabel: "API Key", envVars: ["MISTRAL_API_KEY"] },
    { id: "openrouter", name: "OpenRouter", authMethod: "apiKey", badgeLabel: "API Key", envVars: ["OPENROUTER_API_KEY"] },
    { id: "ollama", name: "Ollama", authMethod: "none", badgeLabel: "Local", envVars: [] },
    { id: "ollama-cloud", name: "Ollama Cloud", authMethod: "oauth", badgeLabel: "OAuth", envVars: ["OLLAMA_CLOUD_API_KEY"] },
    { id: "lm-studio", name: "LM Studio", authMethod: "none", badgeLabel: "Local", envVars: [] },
    { id: "fireworks", name: "Fireworks", authMethod: "apiKey", badgeLabel: "API Key", envVars: ["FIREWORKS_API_KEY"] },
    { id: "xai", name: "xAI", authMethod: "apiKey", badgeLabel: "API Key", envVars: ["XAI_API_KEY"] },
    { id: "together", name: "Together", authMethod: "apiKey", badgeLabel: "API Key", envVars: ["TOGETHER_API_KEY"] },
    { id: "kimi-code", name: "Kimi", authMethod: "apiKey", badgeLabel: "API Key", envVars: ["KIMI_API_KEY"] },
    { id: "cursor", name: "Cursor", authMethod: "oauth", badgeLabel: "OAuth", envVars: ["CURSOR_API_KEY"] },
    { id: "amazon-bedrock", name: "Amazon Bedrock", authMethod: "apiKey", badgeLabel: "AWS Credentials", envVars: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_REGION"] },
    { id: "huggingface", name: "Hugging Face", authMethod: "apiKey", badgeLabel: "API Key", envVars: ["HUGGINGFACE_HUB_TOKEN", "HF_TOKEN"] },
    { id: "cerebras", name: "Cerebras", authMethod: "apiKey", badgeLabel: "API Key", envVars: ["CEREBRAS_API_KEY"] },
    { id: "nvidia", name: "NVIDIA", authMethod: "apiKey", badgeLabel: "API Key", envVars: ["NVIDIA_API_KEY"] },
  ];

  /** Read models.yml provider overrides using YAML parser. */
  function readModelsYml() {
    try {
      const configDir = process.env.PI_CONFIG_DIR || ".omp";
      const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), configDir, "agent");
      const ymlPath = path.join(agentDir, "models.yml");
      if (!fs.existsSync(ymlPath)) return null;
      const raw = fs.readFileSync(ymlPath, "utf-8");
      const { parse } = require("yaml");
      const parsed = parse(raw);
      if (!parsed || typeof parsed !== "object" || !parsed.providers) return null;
      return parsed.providers;
    } catch {
      return null;
    }
  }

  function getProviderStatus() {
    const modelsYml = readModelsYml();
    const availableModels = latestContext?.modelRegistry?.getAvailable?.() ?? [];

    return PROVIDER_META.map((meta) => {
      const envVarsSet = {};
      let anyEnvSet = false;
      for (const v of meta.envVars) {
        const isSet = !!process.env[v];
        envVarsSet[v] = isSet;
        if (isSet) anyEnvSet = true;
      }

      const providerConf = modelsYml?.[meta.id];
      const hasConfigKey = !!providerConf?.apiKey;
      const hasConfigBaseUrl = !!providerConf?.baseUrl;

      let modelsAvailable = 0;
      for (const m of availableModels) {
        if (m.provider === meta.id) modelsAvailable++;
      }

      const configured = meta.authMethod === "none"
        ? (modelsAvailable > 0 || hasConfigBaseUrl)
        : (anyEnvSet || hasConfigKey);

      return {
        id: meta.id,
        name: meta.name,
        authMethod: meta.authMethod,
        badgeLabel: meta.badgeLabel,
        envVars: meta.envVars,
        envVarsSet,
        hasConfigKey,
        hasConfigBaseUrl,
        configured,
        modelsAvailable,
      };
    });
  }

  // ─── Reverse Bridge Server ────────────────────────────────────────────────────
  let reverseBridgeServer;

  const startReverseBridge = async () => {
    if (reverseBridgeServer) return;
    reverseBridgeServer = Bun.serve({
      port: 0, // OS assigns available port
      fetch: async (req) => {
        // Verify auth
        const auth =
          req.headers.get("x-omp-authorization") || req.headers.get("x-pi-vscode-authorization");
        if (auth !== bridgeToken) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }

        const url = new URL(req.url);

        try {
          switch (url.pathname) {
            case "/health":
              return Response.json({ ok: true, pid: process.pid });

            case "/settings": {
              if (req.method !== "POST")
                return Response.json({ error: "Method not allowed" }, { status: 405 });
              const patch = await req.json();
              if (!patch || typeof patch !== "object")
                return Response.json({ error: "Invalid body" }, { status: 400 });

              const { settings } = pi.pi;
              let applied = 0;
              for (const [key, value] of Object.entries(patch)) {
                settings.set(key, value);
                applied++;
              }
              process.stderr.write(`[omp-bridge] Reverse bridge: applied ${applied} settings\n`);
              return Response.json({ ok: true, applied });
            }

            case "/reload-commands": {
              await pushSlashCommands();
              return Response.json({ ok: true });
            }

            case "/get-settings": {
              if (req.method !== "POST")
                return Response.json({ error: "Method not allowed" }, { status: 405 });
              const { keys } = await req.json();
              if (!Array.isArray(keys))
                return Response.json({ error: "keys must be array" }, { status: 400 });
              const { settings } = pi.pi;
              const result = {};
              for (const key of keys) {
                result[key] = settings.get(key);
              }
              return Response.json(result);
            }

            case "/agents": {
              try {
                const { discoverAgents } = await importRuntimeTaskModule();
                const { agents } = await discoverAgents(process.cwd());
                return Response.json({
                  ok: true,
                  count: agents.length,
                  agents: agents.map(serializeAgent),
                });
              } catch (err) {
                const message = err?.message || String(err);
                process.stderr.write(`[omp-bridge] /agents endpoint error: ${message}\n`);
                return Response.json({ ok: false, error: message, agents: [] }, { status: 500 });
              }
            }

            case "/models": {
              const models = latestContext?.modelRegistry?.getAvailable?.() ?? [];
              return Response.json({ ok: true, count: models.length, models });
            }

            case "/provider-status": {
              const providers = getProviderStatus();
              return Response.json({ providers });
            }

            case "/skills": {
              try {
                // Try runtime API first
                let skills;
                try {
                  const mod = await import("@oh-my-pi/pi-coding-agent/extensibility/slash-commands");
                  if (typeof mod.loadSlashCommands === "function") {
                    const fileCommands = await mod.loadSlashCommands({ cwd: process.cwd() });
                    skills = fileCommands.map((cmd) => ({
                      name: cmd.name,
                      description: cmd.description || "",
                      source: cmd._source?.level === "user" || cmd._source?.level === "project"
                        ? (cmd.source || "prompt")
                        : (cmd.source || "prompt"),
                      location: cmd._source?.level || "user",
                      path: cmd.path || "",
                    }));
                  }
                } catch {}

                // If runtime API unavailable, return empty — don't show files
                // that may not actually be loadable as runtime commands
                if (!skills) {
                  skills = [];
                }

                return Response.json({ ok: true, count: skills.length, skills });
              } catch (err) {
                const message = err?.message || String(err);
                process.stderr.write(`[omp-bridge] /skills endpoint error: ${message}\n`);
                return Response.json({ ok: false, error: message, skills: [] }, { status: 500 });
              }
            }

            case "/mcp-servers": {
              try {
                let servers;

                // Try runtime API first
                try {
                  const mcpMod = await import("@oh-my-pi/pi-coding-agent/mcp");
                  if (typeof mcpMod.loadAllMCPConfigs === "function") {
                    const { configs, sources } = await mcpMod.loadAllMCPConfigs(process.cwd());
                    servers = Object.entries(configs).map(([name, cfg]) => {
                      const sanitized = { ...cfg };
                      delete sanitized.env;
                      delete sanitized.headers;
                      const src = sources?.[name];
                      return {
                        name,
                        type: cfg.type || (cfg.command ? "stdio" : cfg.url ? "http" : "stdio"),
                        status: "configured",
                        enabled: cfg.enabled !== false,
                        source: src?.level || "user",
                        sourcePath: src?.path || "",
                        config: sanitized,
                      };
                    });
                  }
                } catch {}

                // If runtime API unavailable, return empty — don't show config
                // files that the runtime may not have actually loaded
                if (!servers) {
                  servers = [];
                }

                return Response.json({ ok: true, count: servers.length, servers });
              } catch (err) {
                const message = err?.message || String(err);
                process.stderr.write(`[omp-bridge] /mcp-servers endpoint error: ${message}\n`);
                return Response.json({ ok: false, error: message, servers: [] }, { status: 500 });
              }
            }


            default:
              return Response.json({ error: "Not found" }, { status: 404 });
          }
        } catch (err) {
          process.stderr.write(`[omp-bridge] Reverse bridge error: ${err?.message || err}\n`);
          return Response.json({ error: err?.message || "Internal error" }, { status: 500 });
        }
      },
    });

    const port = reverseBridgeServer.port;
    process.stderr.write(`[omp-bridge] Reverse bridge listening on port ${port}\n`);

    // Tell extension host our port
    try {
      await callBridge("registerReverseBridge", { port });
      process.stderr.write(`[omp-bridge] Reverse bridge registered with extension host\n`);
    } catch (err) {
      process.stderr.write(
        `[omp-bridge] Failed to register reverse bridge: ${err?.message || err}\n`,
      );
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    latestContext = ctx;
    startStatusUpdates(ctx);
    await reportTerminalSession(ctx);
    await startReverseBridge();
    await pushSlashCommands();
    await pushAgents();
  });

  const persistUserAttachments = async () => {
    try {
      const attachments = await callBridge("getUserAttachments");
      if (attachments && typeof attachments === "object") {
        const hasData = attachments.fileContexts?.length > 0;
        if (hasData) {
          pi.appendEntry("user_attachments", { userAttachments: attachments });
        }
      }
    } catch {
      // Best effort — attachment persistence is non-critical
    }
  };

  pi.on("input", async (_event, ctx) => {
    void refreshStatus(ctx);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    void refreshStatus(ctx);
    await persistUserAttachments();
  });

  pi.on("agent_end", async (_event, ctx) => {
    void refreshStatus(ctx);
    // Persist per-turn metadata into the session JSONL for hydration.
    try {
      const metadata = await callBridge("getTurnMetadata");
      if (metadata && typeof metadata === "object") {
        const hasData =
          metadata.model || metadata.tokens || metadata.costUsd || metadata.durationMs;
        if (hasData) {
          pi.appendEntry("turn_metadata", metadata);
        }
      }
    } catch {
      // Best effort — metadata persistence is non-critical
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopStatusUpdates(ctx);
  });

  const tool = ({ rpcMethod, parameters, ...definition }) => ({
    ...definition,
    parameters,
    execute: async (_toolCallId, params) => jsonResult(rpcMethod, params),
  });

  const noParamsTool = ({ rpcMethod, ...definition }) => ({
    ...definition,
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: async () => jsonResult(rpcMethod),
  });

  const tools = [
    noParamsTool({
      name: "vscode_get_editor_state",
      label: "VS Code Editor State",
      description:
        "Get the active editor, current selection, cached latest selection, workspace folders, and open editors from VS Code.",
      promptSnippet: "Read current VS Code editor state, selection, and open editors.",
      promptGuidelines: [
        "Use VS Code bridge tools when the user asks about their current editor state, selection, diagnostics, symbols, definitions, hovers, references, or editor actions.",
        "If vscode_get_code_actions returns an action id, use vscode_execute_code_action to apply that exact quick fix.",
        "Use vscode_apply_workspace_edit when you need VS Code to update open buffers with explicit range-based edits.",
        "Use vscode_format_document or vscode_format_range to apply formatter-generated edits through VS Code instead of shelling out to formatters for open or dirty files.",
      ],
      rpcMethod: "getEditorState",
    }),
    noParamsTool({
      name: "vscode_get_selection",
      label: "VS Code Current Selection",
      description:
        "Get the current VS Code editor selection, including text, file path, and coordinates. Falls back to the latest cached VS Code selection when focus is in the OMP terminal.",
      promptSnippet: "Read the exact active or latest cached VS Code selection and selected text.",
      rpcMethod: "getCurrentSelection",
    }),
    noParamsTool({
      name: "vscode_get_latest_selection",
      label: "VS Code Latest Selection",
      description:
        "Get the latest cached selection observed by the VS Code extension, even if focus moved away.",
      rpcMethod: "getLatestSelection",
    }),
    tool({
      name: "vscode_get_diagnostics",
      label: "VS Code Diagnostics",
      description:
        "Get VS Code diagnostics (LSP, lint, or type errors) for a file or the full workspace.",
      promptSnippet: "Read current VS Code diagnostics for a file or the workspace.",
      parameters: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description: "Optional absolute or workspace-relative file path",
          },
        },
        additionalProperties: false,
      },
      rpcMethod: "getDiagnostics",
    }),
    noParamsTool({
      name: "vscode_get_open_editors",
      label: "VS Code Open Editors",
      description:
        "List open editors and tabs in VS Code, including which one is active and whether files are dirty.",
      rpcMethod: "getOpenEditors",
    }),
    noParamsTool({
      name: "vscode_get_workspace_folders",
      label: "VS Code Workspace Folders",
      description: "List VS Code workspace folders and metadata for the current window.",
      rpcMethod: "getWorkspaceFolders",
    }),
    tool({
      name: "vscode_open_file",
      label: "VS Code Open File",
      description: "Open a file in VS Code and optionally reveal a selection range.",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Absolute or workspace-relative file path" },
          preview: { type: "boolean", description: "Open in preview mode" },
          preserveFocus: {
            type: "boolean",
            description: "Keep focus in the current editor if possible",
          },
          selection: {
            type: "object",
            properties: {
              start: {
                type: "object",
                properties: {
                  line: { type: "number", description: "Zero-based line number" },
                  character: { type: "number", description: "Zero-based character offset" },
                },
                required: ["line", "character"],
                additionalProperties: false,
              },
              end: {
                type: "object",
                properties: {
                  line: { type: "number", description: "Zero-based line number" },
                  character: { type: "number", description: "Zero-based character offset" },
                },
                required: ["line", "character"],
                additionalProperties: false,
              },
            },
            required: ["start", "end"],
            additionalProperties: false,
          },
        },
        required: ["filePath"],
        additionalProperties: false,
      },
      rpcMethod: "openFile",
    }),
    tool({
      name: "vscode_check_document_dirty",
      label: "VS Code Dirty State",
      description: "Check whether a file is open in VS Code and whether it has unsaved changes.",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Absolute or workspace-relative file path" },
        },
        required: ["filePath"],
        additionalProperties: false,
      },
      rpcMethod: "checkDocumentDirty",
    }),
    tool({
      name: "vscode_save_document",
      label: "VS Code Save Document",
      executionMode: "sequential",
      description: "Save a document through VS Code so editor buffers and disk stay synchronized.",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Absolute or workspace-relative file path" },
        },
        required: ["filePath"],
        additionalProperties: false,
      },
      rpcMethod: "saveDocument",
    }),
    tool({
      name: "vscode_get_document_symbols",
      label: "VS Code Document Symbols",
      description: "Get outline symbols for a file from the active language server.",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Absolute or workspace-relative file path" },
        },
        required: ["filePath"],
        additionalProperties: false,
      },
      rpcMethod: "getDocumentSymbols",
    }),
    tool({
      name: "vscode_get_definitions",
      label: "VS Code Definitions",
      description: "Get symbol definitions from VS Code at a given file position.",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Absolute or workspace-relative file path" },
          position: {
            type: "object",
            properties: {
              line: { type: "number", description: "Zero-based line number" },
              character: { type: "number", description: "Zero-based character offset" },
            },
            required: ["line", "character"],
            additionalProperties: false,
          },
        },
        required: ["filePath", "position"],
        additionalProperties: false,
      },
      rpcMethod: "getDefinitions",
    }),
    tool({
      name: "vscode_get_type_definitions",
      label: "VS Code Type Definitions",
      description: "Get symbol type definitions from VS Code at a given file position.",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Absolute or workspace-relative file path" },
          position: {
            type: "object",
            properties: {
              line: { type: "number", description: "Zero-based line number" },
              character: { type: "number", description: "Zero-based character offset" },
            },
            required: ["line", "character"],
            additionalProperties: false,
          },
        },
        required: ["filePath", "position"],
        additionalProperties: false,
      },
      rpcMethod: "getTypeDefinitions",
    }),
    tool({
      name: "vscode_get_implementations",
      label: "VS Code Implementations",
      description: "Get concrete implementations from VS Code at a given file position.",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Absolute or workspace-relative file path" },
          position: {
            type: "object",
            properties: {
              line: { type: "number", description: "Zero-based line number" },
              character: { type: "number", description: "Zero-based character offset" },
            },
            required: ["line", "character"],
            additionalProperties: false,
          },
        },
        required: ["filePath", "position"],
        additionalProperties: false,
      },
      rpcMethod: "getImplementations",
    }),
    tool({
      name: "vscode_get_declarations",
      label: "VS Code Declarations",
      description: "Get symbol declarations from VS Code at a given file position.",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Absolute or workspace-relative file path" },
          position: {
            type: "object",
            properties: {
              line: { type: "number", description: "Zero-based line number" },
              character: { type: "number", description: "Zero-based character offset" },
            },
            required: ["line", "character"],
            additionalProperties: false,
          },
        },
        required: ["filePath", "position"],
        additionalProperties: false,
      },
      rpcMethod: "getDeclarations",
    }),
    tool({
      name: "vscode_get_hover",
      label: "VS Code Hover",
      description:
        "Get hover information like inferred types, signatures, and docs from VS Code at a given file position.",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Absolute or workspace-relative file path" },
          position: {
            type: "object",
            properties: {
              line: { type: "number", description: "Zero-based line number" },
              character: { type: "number", description: "Zero-based character offset" },
            },
            required: ["line", "character"],
            additionalProperties: false,
          },
        },
        required: ["filePath", "position"],
        additionalProperties: false,
      },
      rpcMethod: "getHover",
    }),
    tool({
      name: "vscode_get_workspace_symbols",
      label: "VS Code Workspace Symbols",
      description: "Search workspace symbols globally through VS Code language providers.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Workspace symbol search query" },
        },
        required: ["query"],
        additionalProperties: false,
      },
      rpcMethod: "getWorkspaceSymbols",
    }),
    tool({
      name: "vscode_get_references",
      label: "VS Code References",
      description: "Get symbol references from VS Code at a given file position.",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Absolute or workspace-relative file path" },
          position: {
            type: "object",
            properties: {
              line: { type: "number", description: "Zero-based line number" },
              character: { type: "number", description: "Zero-based character offset" },
            },
            required: ["line", "character"],
            additionalProperties: false,
          },
        },
        required: ["filePath", "position"],
        additionalProperties: false,
      },
      rpcMethod: "getReferences",
    }),
    tool({
      name: "vscode_get_code_actions",
      label: "VS Code Code Actions",
      description:
        "Get code actions or quick fixes available for a file range or selection from VS Code providers.",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Absolute or workspace-relative file path" },
          selection: {
            type: "object",
            properties: {
              start: {
                type: "object",
                properties: {
                  line: { type: "number", description: "Zero-based line number" },
                  character: { type: "number", description: "Zero-based character offset" },
                },
                required: ["line", "character"],
                additionalProperties: false,
              },
              end: {
                type: "object",
                properties: {
                  line: { type: "number", description: "Zero-based line number" },
                  character: { type: "number", description: "Zero-based character offset" },
                },
                required: ["line", "character"],
                additionalProperties: false,
              },
            },
            required: ["start", "end"],
            additionalProperties: false,
          },
          start: {
            type: "object",
            properties: {
              line: { type: "number", description: "Zero-based line number" },
              character: { type: "number", description: "Zero-based character offset" },
            },
            required: ["line", "character"],
            additionalProperties: false,
          },
          end: {
            type: "object",
            properties: {
              line: { type: "number", description: "Zero-based line number" },
              character: { type: "number", description: "Zero-based character offset" },
            },
            required: ["line", "character"],
            additionalProperties: false,
          },
        },
        required: ["filePath"],
        additionalProperties: false,
      },
      rpcMethod: "getCodeActions",
    }),
    tool({
      name: "vscode_execute_code_action",
      label: "VS Code Execute Code Action",
      executionMode: "sequential",
      description: "Execute a previously listed code action by id.",
      parameters: {
        type: "object",
        properties: {
          actionId: {
            type: "string",
            description: "Action id returned by vscode_get_code_actions",
          },
        },
        required: ["actionId"],
        additionalProperties: false,
      },
      rpcMethod: "executeCodeAction",
    }),
    tool({
      name: "vscode_apply_workspace_edit",
      label: "VS Code Apply Workspace Edit",
      executionMode: "sequential",
      description:
        "Apply explicit range-based text replacements through VS Code so open editor buffers stay in sync.",
      parameters: {
        type: "object",
        properties: {
          edits: {
            type: "array",
            description: "List of text replacements to apply through VS Code",
            items: {
              type: "object",
              properties: {
                filePath: {
                  type: "string",
                  description: "Absolute or workspace-relative file path",
                },
                range: {
                  type: "object",
                  properties: {
                    start: {
                      type: "object",
                      properties: {
                        line: { type: "number", description: "Zero-based line number" },
                        character: {
                          type: "number",
                          description: "Zero-based character offset",
                        },
                      },
                      required: ["line", "character"],
                      additionalProperties: false,
                    },
                    end: {
                      type: "object",
                      properties: {
                        line: { type: "number", description: "Zero-based line number" },
                        character: {
                          type: "number",
                          description: "Zero-based character offset",
                        },
                      },
                      required: ["line", "character"],
                      additionalProperties: false,
                    },
                  },
                  required: ["start", "end"],
                  additionalProperties: false,
                },
                newText: { type: "string", description: "Replacement text" },
              },
              required: ["filePath", "range", "newText"],
              additionalProperties: false,
            },
          },
        },
        required: ["edits"],
        additionalProperties: false,
      },
      rpcMethod: "applyWorkspaceEdit",
    }),
    tool({
      name: "vscode_format_document",
      label: "VS Code Format Document",
      executionMode: "sequential",
      description:
        "Run the active VS Code document formatter for a file and apply the resulting edits through VS Code.",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Absolute or workspace-relative file path" },
        },
        required: ["filePath"],
        additionalProperties: false,
      },
      rpcMethod: "formatDocument",
    }),
    tool({
      name: "vscode_format_range",
      label: "VS Code Format Range",
      executionMode: "sequential",
      description:
        "Run the active VS Code range formatter for a selection or explicit range and apply the resulting edits through VS Code.",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Absolute or workspace-relative file path" },
          selection: {
            type: "object",
            properties: {
              start: {
                type: "object",
                properties: {
                  line: { type: "number", description: "Zero-based line number" },
                  character: { type: "number", description: "Zero-based character offset" },
                },
                required: ["line", "character"],
                additionalProperties: false,
              },
              end: {
                type: "object",
                properties: {
                  line: { type: "number", description: "Zero-based line number" },
                  character: { type: "number", description: "Zero-based character offset" },
                },
                required: ["line", "character"],
                additionalProperties: false,
              },
            },
            required: ["start", "end"],
            additionalProperties: false,
          },
          start: {
            type: "object",
            properties: {
              line: { type: "number", description: "Zero-based line number" },
              character: { type: "number", description: "Zero-based character offset" },
            },
            required: ["line", "character"],
            additionalProperties: false,
          },
          end: {
            type: "object",
            properties: {
              line: { type: "number", description: "Zero-based line number" },
              character: { type: "number", description: "Zero-based character offset" },
            },
            required: ["line", "character"],
            additionalProperties: false,
          },
        },
        required: ["filePath"],
        additionalProperties: false,
      },
      rpcMethod: "formatRange",
    }),
    tool({
      name: "vscode_get_notifications",
      label: "VS Code Notifications",
      description:
        "Get recent bridge notifications like selection changes, diagnostics changes, active editor changes, and save/dirty events.",
      parameters: {
        type: "object",
        properties: {
          since: { type: "number", description: "Only return notifications after this timestamp" },
          limit: { type: "number", description: "Maximum number of notifications to return" },
        },
        additionalProperties: false,
      },
      rpcMethod: "getNotifications",
    }),
    noParamsTool({
      name: "vscode_clear_notifications",
      label: "VS Code Clear Notifications",
      description: "Clear the buffered VS Code bridge notification queue.",
      rpcMethod: "clearNotifications",
    }),
    tool({
      name: "vscode_show_notification",
      label: "VS Code Show Notification",
      description: "Show an info, warning, or error notification inside VS Code.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", description: "Notification message to show in VS Code" },
          type: {
            type: "string",
            description: "Notification severity: info, warning, or error",
            enum: ["info", "warning", "error"],
          },
          modal: { type: "boolean", description: "Whether to show the notification as modal" },
        },
        required: ["message"],
        additionalProperties: false,
      },
      rpcMethod: "showNotification",
    }),
  ];

  for (const toolDefinition of tools) pi.registerTool(toolDefinition);

  // ── Question tool ─────────────────────────────────────────────────────
  // Provides the model with the ability to ask the user questions via the
  // extension UI (select dialogs). Uses ctx.ui.select() which triggers
  // extension_ui_request frames handled by the VS Code extension host.
  pi.registerTool({
    name: "question",
    label: "Ask User",
    executionMode: "sequential",
    description:
      "Use this tool when you need to ask the user questions during execution. " +
      "This allows you to: 1. Gather user preferences or requirements, " +
      "2. Clarify ambiguous instructions, 3. Get decisions on implementation choices as you work, " +
      "4. Offer choices to the user about what direction to take.\n\n" +
      "Usage notes:\n" +
      '- When `custom` is enabled (default), a "Type your own answer" option is added automatically; don\'t include "Other" or catch-all options\n' +
      "- Answers are returned as arrays of labels; set `multiple: true` to allow selecting more than one\n" +
      '- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label\n' +
      "- Header must be 30 characters or less (maxLength: 30)",
    parameters: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          description: "Questions to ask",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              header: { type: "string", description: "Very short label (max 30 chars)" },
              question: { type: "string", description: "Complete question" },
              multiple: { type: "boolean", description: "Allow selecting multiple choices" },
              options: {
                type: "array",
                description: "Available choices",
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string", description: "Display text (1-5 words, concise)" },
                    description: { type: "string", description: "Explanation of choice" },
                  },
                  required: ["label", "description"],
                },
              },
            },
            required: ["question", "header", "options"],
          },
        },
      },
      required: ["questions"],
      additionalProperties: false,
    },
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      if (!ctx?.hasUI || !ctx.ui) {
        return {
          content: [{ type: "text", text: "Question tool requires interactive UI context" }],
          details: {},
          isError: true,
        };
      }

      const results = [];
      for (const q of params.questions) {
        const options = q.options.map((o) => o.label);
        // Add "Type your own answer" option for custom input
        const allOptions = [...options, "Type your own answer"];

        let selected;
        try {
          selected = await ctx.ui.select(q.question, allOptions, { signal });
        } catch (err) {
          if (err?.name === "AbortError") {
            return {
              content: [{ type: "text", text: "Question was cancelled by the user" }],
              details: {},
              isError: true,
            };
          }
          throw err;
        }

        if (selected === undefined) {
          return {
            content: [{ type: "text", text: "Question was cancelled by the user" }],
            details: {},
            isError: true,
          };
        }

        if (selected === "Type your own answer") {
          // Request custom text input via editor
          const customText = await ctx.ui.editor(q.header || "Your answer", undefined, { signal });
          results.push({
            question: q.question,
            answer: customText || "(empty)",
            isCustom: true,
          });
        } else {
          results.push({
            question: q.question,
            answer: selected,
            isCustom: false,
          });
        }
      }

      const summary = results
        .map((r) => `${r.question}\n→ ${r.answer}${r.isCustom ? " (custom)" : ""}`)
        .join("\n\n");

      return {
        content: [{ type: "text", text: summary }],
        details: { results },
      };
    },
  });
}
