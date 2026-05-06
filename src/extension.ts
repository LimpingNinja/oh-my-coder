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
import { EMPTY_FOOTER_ITEMS } from "./protocol/footerTypes.ts";
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
      outputChannel.appendLine(`[omp] session.switch: ${message.sessionPath} — deferred`);
      break;

    case "session.rename":
      outputChannel.appendLine(`[omp] session.rename: ${message.sessionPath} — deferred`);
      break;

    case "session.openTranscript":
      outputChannel.appendLine(`[omp] session.openTranscript: ${message.sessionPath} — deferred`);
      break;

    case "chat.send":
      outputChannel.appendLine(`[omp] chat.send: ${message.sessionPath}`);
      handleChatSend(message.sessionPath, message.content);
      break;

    case "chat.abort":
      outputChannel.appendLine(`[omp] chat.abort: ${message.sessionPath}`);
      handleChatAbort();
      break;

    case "runtime.setModel":
      outputChannel.appendLine(
        `[omp] runtime.setModel: ${message.provider}/${message.modelId} — deferred`,
      );
      break;

    case "runtime.cycleModel":
      outputChannel.appendLine("[omp] runtime.cycleModel — deferred");
      break;

    case "runtime.setThinkingLevel":
      outputChannel.appendLine(`[omp] runtime.setThinkingLevel: ${message.level} — deferred`);
      break;

    case "runtime.cycleThinkingLevel":
      outputChannel.appendLine("[omp] runtime.cycleThinkingLevel — deferred");
      break;

    case "runtime.compact":
      outputChannel.appendLine("[omp] runtime.compact — deferred");
      break;

    case "runtime.getState":
      outputChannel.appendLine("[omp] runtime.getState");
      pushRuntimeState();
      break;

    case "extensionUi.respond":
      outputChannel.appendLine(`[omp] extensionUi.respond: ${message.requestId} — deferred`);
      break;

    case "input.focusRequested":
      outputChannel.appendLine("[omp] input.focusRequested — deferred");
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

  rpcController = new OmpRpcControllerImpl({
    process: {
      binaryPath: ompPath !== "omp" ? ompPath : undefined,
      cwd: request.workspaceFolder,
      env: env ?? undefined,
    },
  });

  // Create the transcript manager for this session.
  const sessionPath = request.kind === "resume" ? request.sessionPath : request.workspaceFolder;
  transcriptManager = new TranscriptManager(sessionPath, {
    postToWebview,
    log: (msg) => outputChannel.appendLine(msg),
  });

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
 */
async function handleChatSend(sessionPath: string, content: string): Promise<void> {
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
    if (state.isStreaming) {
      // Queue as follow-up when streaming
      await rpcController.prompt({
        message: content,
        streamingBehavior: "followUp",
      });
    } else {
      await rpcController.prompt({ message: content });
    }

    // Prompt accepted — add user message to transcript.
    transcriptManager?.addUserMessage(content);
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
      // Agent ended — query full state
      void rpcController
        .getState()
        .then((state) => {
          currentRuntimeState = mapControllerState(state, currentActiveSessionPath);
          postToWebview({ type: "runtime.state", state: currentRuntimeState });
        })
        .catch(() => {
          // Best effort — state update on agent_end is non-critical
        });
      break;
    }
    case "message_start":
    case "message_update":
    case "message_end":
    case "turn_start":
    case "turn_end":
      // These are transcript events — forward to webview for later rendering.
      // This slice does not implement transcript rendering, but we forward
      // frame data so the UI can at least know streaming is happening.
      updateRuntimeStateFromController();
      break;
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
    default:
      // Other frames (response, extension_ui_request, etc.) are handled
      // by controller correlation or deferred to later slices.
      break;
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

  // Footer — unavailable items only.
  postToWebview({
    type: "footer.state",
    items: EMPTY_FOOTER_ITEMS,
  });

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
        outputChannel.appendLine("[omp] openCurrentSessionInEditor: no active session (deferred)");
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
