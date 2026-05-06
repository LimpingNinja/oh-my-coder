import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";

const WIN_EXECUTABLE_EXTENSIONS = [".cmd", ".exe", ".ps1"];

export type OmpThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface OmpResolveOptions {
  /** User-configured custom path (from omp.path setting) */
  customPath?: string;
  /** Current platform (defaults to process.platform) */
  platform?: string;
  /** Home directory */
  home?: string;
  /** PATH environment variable */
  pathEnv?: string;
  /** %APPDATA% on Windows */
  appData?: string;
  /** %LOCALAPPDATA% on Windows */
  localAppData?: string;
  /** Workspace root directories */
  workspaceDirs?: string[];
  /** File access check (defaults to fs.accessSync) */
  access?: (path: string, mode: number) => void;
}

/**
 * Resolve the `omp` binary path.
 *
 * Search order:
 * 1. User-configured `omp.path` setting
 * 2. Workspace-local `node_modules/.bin/omp`
 * 3. Well-known global install paths (`~/.bun/bin/omp`, `~/.local/bin/omp`, `~/.npm-global/bin/omp`)
 * 4. OS `PATH` directories
 * 5. Fallback: bare `"omp"` (relies on OS spawn PATH resolution)
 */
export function resolveOmpBinary(opts: OmpResolveOptions = {}): string {
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? process.env.HOME ?? process.env.USERPROFILE ?? "";
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? "";
  const workspaceDirs = opts.workspaceDirs ?? [];
  const access = opts.access ?? accessSync;

  const isWin = platform === "win32";
  const names = isWin ? WIN_EXECUTABLE_EXTENSIONS.map((ext) => `omp${ext}`) : ["omp"];
  const accessFlag = isWin ? constants.F_OK : constants.X_OK;

  if (opts.customPath) {
    if (isWin) {
      const resolved = resolveWindowsExecutable(opts.customPath, access);
      if (resolved) return resolved;
    }
    return opts.customPath;
  }

  const workspaceCandidates = workspaceDirs.flatMap((dir) =>
    names.map((n) => join(dir, "node_modules", ".bin", n)),
  );

  const globalCandidates = isWin
    ? windowsGlobalDirs(opts).flatMap((d) => names.map((n) => join(d, n)))
    : [`${home}/.bun/bin/omp`, `${home}/.local/bin/omp`, `${home}/.npm-global/bin/omp`];

  const candidates = [...workspaceCandidates, ...globalCandidates];
  for (const c of candidates) {
    try {
      access(c, accessFlag);
      return c;
    } catch {
      // not found, continue
    }
  }

  const pathDirs = pathEnv.split(isWin ? ";" : ":");
  for (const dir of pathDirs) {
    if (!dir) continue;
    for (const n of names) {
      const full = join(dir, n);
      try {
        access(full, accessFlag);
        return full;
      } catch {
        // not found, continue
      }
    }
  }

  return "omp";
}

/**
 * Find the omp binary using the current VS Code configuration and workspace.
 */
export function findOmpBinary(): string {
  const config = vscode.workspace.getConfiguration("omp");
  return resolveOmpBinary({
    customPath: config.get<string>("path") || undefined,
    workspaceDirs: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
  });
}

/**
 * Build launch arguments for `omp --mode rpc`.
 *
 * Resume launch requires an explicit session path; bare `--resume` without a path
 * is prohibited because it invokes the TUI picker and blocks JSONL protocol flow.
 */
export function buildOmpRpcArgs(request: {
  kind: "new" | "resume";
  sessionPath?: string;
  model?: string;
  thinking?: OmpThinkingLevel;
}): string[] {
  const args = ["--mode", "rpc"];

  if (request.kind === "resume") {
    if (!request.sessionPath) {
      throw new Error("resume launch requires an explicit session path");
    }
    args.push("--resume", request.sessionPath);
  }

  if (request.kind === "new" && request.model) {
    args.push("--model", request.model);
  }
  if (request.kind === "new" && request.thinking) {
    args.push("--thinking", request.thinking);
  }

  return args;
}

/**
 * Build environment variables for the OMP process.
 *
 * Bridge config is injected via OMP-native env vars.
 * The `PI_VSCODE_*` naming is upstream runtime compatibility;
 * the OMP bridge extension reads these same variables.
 * Product-facing naming uses `OMP_*`.
 */
export function createOmpEnvironment(
  bridgeConfig: { url: string; token: string } | undefined,
): Record<string, string> | undefined {
  if (!bridgeConfig) return undefined;
  return {
    OMP_VSCODE_BRIDGE_URL: bridgeConfig.url,
    OMP_VSCODE_BRIDGE_TOKEN: bridgeConfig.token,
    // Upstream runtime compatibility: the bridge extension reads PI_ prefixed vars
    PI_VSCODE_BRIDGE_URL: bridgeConfig.url,
    PI_VSCODE_BRIDGE_TOKEN: bridgeConfig.token,
  };
}

function windowsGlobalDirs(opts: OmpResolveOptions): string[] {
  const appData = opts.appData ?? process.env.APPDATA ?? "";
  const localAppData = opts.localAppData ?? process.env.LOCALAPPDATA ?? "";
  const dirs: string[] = [];
  if (appData) dirs.push(join(appData, "npm"));
  if (localAppData) dirs.push(join(localAppData, "pnpm"));
  return dirs;
}

function resolveWindowsExecutable(
  filePath: string,
  access: (path: string, mode: number) => void,
): string | null {
  const sep = Math.max(filePath.lastIndexOf("\\"), filePath.lastIndexOf("/"));
  if (filePath.lastIndexOf(".") > sep) return null;

  for (const ext of WIN_EXECUTABLE_EXTENSIONS) {
    try {
      access(filePath + ext, constants.F_OK);
      return filePath + ext;
    } catch {
      // not found, continue
    }
  }
  return null;
}
