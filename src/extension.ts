import { createBridge } from "./bridge/server.ts";
import type { BridgeContext } from "./bridge/types.ts";
import * as vscode from "vscode";
import { findOmpBinary, createOmpEnvironment } from "./omp.ts";
import { OmpChatProvider } from "./webview/provider.ts";
import type {
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
  OmpLaunchState,
} from "./protocol/webviewMessages.ts";
import { EMPTY_HEADER_STATE } from "./protocol/footerTypes.ts";
import type { ChatHeaderState, ChatFooterItem } from "./protocol/footerTypes.ts";
import { listWorkspaceSessions, validateResumePath } from "./session/discovery.ts";
import { resolveWorkspaceScope, getEffectiveWorkspaceFolder } from "./session/workspaceScope.ts";
import type { OmpSessionListState, OmpSessionSummary } from "./session/types.ts";
import { OmpRpcControllerImpl } from "./rpc/controller.ts";
import type { OmpLaunchRequest } from "./rpc/types.ts";
import type { OmpRuntimeState, OmpStatePayload } from "./protocol/ompRpcTypes.ts";
import {
  OmpResumePathError,
  OmpStartupError,
  OmpStartupTimeoutError,
  OmpSpawnError,
} from "./rpc/errors.ts";
import { TranscriptManager } from "./transcript/manager.ts";

let extensionUri: vscode.Uri;
let outputChannel: vscode.OutputChannel;

// Bridge state — populated during activation, disposed on deactivate.
let bridgeContext: BridgeContext | undefined;

// Webview provider — created during activation, disposed on deactivate.
let chatProvider: OmpChatProvider | undefined;

// RPC controller — owns the single active OMP process.
let rpcController: OmpRpcControllerImpl | undefined;

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

// Header state — tracks the header presentation state for the webview.
let currentHeaderState: ChatHeaderState = { ...EMPTY_HEADER_STATE };

// Accumulated session cost (from message_end usage data).
let sessionCostAccumulator = 0;
let sessionTokensInput = 0;
let sessionTokensOutput = 0;
let sessionTokensCacheRead = 0;

// Queue delivery modes from runtime state.
let currentSteeringMode: string = "one-at-a-time";
let currentFollowUpMode: string = "one-at-a-time";
let currentInterruptMode: string = "immediate";

// Cached available models from get_available_models.
let cachedAvailableModels: Array<Record<string, unknown>> = [];

// Pending extension UI requests — buffered for webview delivery and response routing.
const pendingUiRequests = new Map<string, { request: import("./protocol/webviewMessages.ts").ExtensionUiRequestForWebview; timestamp: number }>();

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
    const bridge = await createBridge(context);
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
        void rpcController.send({ type: "set_session_name", name: title }).then(() => {
          // Update header immediately
          currentHeaderState = { ...currentHeaderState, sessionName: title };
          postToWebview({ type: "header.state", state: currentHeaderState });
          // Refresh session list to reflect new name
          refreshSessions();
        }).catch((err) => {
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

    case "chat.send":
      outputChannel.appendLine(`[omp] chat.send: ${message.sessionPath} (behavior: ${message.behavior ?? "auto"})`);
      handleChatSend(message.sessionPath, message.content, message.behavior);
      break;

    case "chat.abort":
      outputChannel.appendLine(`[omp] chat.abort: ${message.sessionPath}`);
      handleChatAbort();
      break;

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
      outputChannel.appendLine("[omp] getAvailableModels");
      if (rpcController?.isRunning()) {
        void rpcController
          .send<{ models: Array<Record<string, unknown>> }>({ type: "get_available_models" })
          .then((result) => {
            cachedAvailableModels = result?.models ?? [];
            postToWebview({
              type: "runtime.availableModels",
              models: cachedAvailableModels as Array<{ provider: string; id: string }>,
            });
          })
          .catch((err) => {
            outputChannel.appendLine(`[omp] getAvailableModels failed: ${err}`);
            postToWebview({ type: "runtime.availableModels", models: [] });
          });
      }
      break;

    case "runtime.setThinkingLevel":
      outputChannel.appendLine(`[omp] setThinkingLevel: ${message.level}`);
      if (rpcController?.isRunning()) {
        void rpcController.send({ type: "set_thinking_level", level: message.level }).then(async () => {
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
      const { requestId, response } = message as { requestId: string; response: Record<string, unknown> };
      // Guard: ignore late responses for cancelled/expired requests
      if (!pendingUiRequests.has(requestId)) {
        outputChannel.appendLine(`[omp] extensionUi.respond: ignoring late response for ${requestId} (not pending)`);
        break;
      }
      pendingUiRequests.delete(requestId);
      const uiResponse = { ...response, type: "extension_ui_response", id: requestId } as import("./protocol/ompRpcTypes.ts").OmpExtensionUiResponse;
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

  if (!workspaceFolder) {
    pushLaunchFailed(
      "new",
      undefined,
      "No workspace folder available. Open a workspace to start a session.",
      {
        type: "session.start",
        prompt,
        model,
        thinking: thinking as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined,
      },
    );
    return;
  }

  const runId = `omp_run_${Date.now()}`;
  const request: OmpLaunchRequest = {
    kind: "new",
    workspaceFolder,
    prompt: prompt.trim() || undefined,
    model,
    thinking,
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
  const bridgeExtensionPath = vscode.Uri.joinPath(extensionUri, "bridge", "omp-vscode-bridge.js").fsPath;

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
      void rpcController.getState().then((fullState) => {
        updateHeaderFromOmpState(fullState);
        pushFooterState(); // Push after modes are set from fullState
      }).catch(() => { /* best effort */ });

      // Pre-fetch available models for thinking support detection
      void rpcController
        .send<{ models: Array<Record<string, unknown>> }>({ type: "get_available_models" })
        .then((result) => {
          cachedAvailableModels = result?.models ?? [];
          // Re-push footer now that we have model capabilities
          pushFooterState();
        })
        .catch(() => { /* best effort */ });
    }

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
        const messages = await rpcController.getMessages();
        transcriptManager.hydrateFromMessages(messages);

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

    let effectiveBehavior: "steer" | "followUp" | "forceSend" | undefined;

    if (behavior === "forceSend") {
      // Abort current turn and send as fresh prompt
      await rpcController.send({ type: "abort_and_prompt", message: content });
      effectiveBehavior = "forceSend";
    } else if (state.isStreaming) {
      // Auto-decide based on interruptMode if no explicit behavior
      effectiveBehavior = behavior ?? (state.interruptMode === "immediate" ? "steer" : "followUp");

      if (effectiveBehavior === "steer") {
        await rpcController.send({ type: "steer", message: content });
      } else {
        await rpcController.send({ type: "follow_up", message: content });
      }
    } else {
      // Not streaming — normal prompt
      await rpcController.prompt({ message: content });
    }

    // Prompt accepted — add user message to transcript
    if (transcriptManager) {
      transcriptManager.addUserMessage(content);
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
      // Agent started — update runtime state to streaming
      updateRuntimeStateFromController();
      break;
    case "agent_end": {
      // Agent ended — query full state and refresh header stats
      void rpcController
        .getState()
        .then((state) => {
          currentRuntimeState = mapControllerState(state, currentActiveSessionPath);
          postToWebview({ type: "runtime.state", state: currentRuntimeState });
          pushHeaderState();
          updateHeaderFromOmpState(state);
          pushFooterState(); // Stable moment — safe to push footer
        })
        .catch(() => {
          // Best effort — state update on agent_end is non-critical
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
          // Accumulate tokens
          if (typeof usage.input === "number") sessionTokensInput += usage.input;
          if (typeof usage.output === "number") sessionTokensOutput += usage.output;
          if (typeof usage.cacheRead === "number") sessionTokensCacheRead += usage.cacheRead;

          // Accumulate cost
          const cost = usage.cost as Record<string, unknown> | undefined;
          if (cost && typeof cost.total === "number") {
            sessionCostAccumulator += cost.total;
          } else if (typeof usage.totalCost === "number") {
            sessionCostAccumulator += usage.totalCost as number;
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
      handleExtensionUiRequest(frameObj as import("./protocol/ompRpcTypes.ts").OmpExtensionUiRequest);
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
function handleExtensionUiRequest(request: import("./protocol/ompRpcTypes.ts").OmpExtensionUiRequest): void {
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
      return { method: "select", requestId, title: r.title as string, options: r.options as string[], timeout: r.timeout as number | undefined };
    case "confirm":
      return { method: "confirm", requestId, title: r.title as string, message: r.message as string, timeout: r.timeout as number | undefined };
    case "input":
      return { method: "input", requestId, title: r.title as string, placeholder: r.placeholder as string | undefined, timeout: r.timeout as number | undefined };
    case "editor":
      return { method: "editor", requestId, title: r.title as string, prefill: r.prefill as string | undefined };
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
  currentHeaderState = {
    ...currentHeaderState,
    contextPercent: state.contextUsage?.percent != null
      ? Math.round(state.contextUsage.percent)
      : currentHeaderState.contextPercent,
    sessionName: state.sessionName ?? currentHeaderState.sessionName,
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
      costUsd: typeof usage.totalCostUsd === "number" ? usage.totalCostUsd : currentHeaderState.costUsd,
      contextPercent: typeof usage.contextPercent === "number"
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
    ["omp.newSession", () => focusChatView()],
    ["omp.resumeSession", () => focusChatView()],
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
  ];

  for (const [id, handler] of commands) {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  }

  // Status bar item — compact, opens/focuses OMP
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = "$(comment-discussion) OMP";
  statusBarItem.tooltip = "Open OMP Chat";
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
  context.subscriptions.push({ dispose: () => { if (textChangeTimer) clearTimeout(textChangeTimer); } });

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

/**
 * Open a file in the VS Code editor, optionally at a specific line.
 */
async function handleOpenFile(
  filePath: string,
  line?: number,
  endLine?: number,
): Promise<void> {
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
