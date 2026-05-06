/**
 * Workspace scope and session-directory derivation for OMP session discovery.
 *
 * Mirrors OMP SessionManager default session directory naming:
 *   - paths under the user's home directory are stored as `-<home-relative>`
 *   - paths under the OS temp directory are stored as `-tmp-<tmp-relative>`
 *   - other paths use the legacy absolute form `--<absolute-encoded>--`
 *
 * This matters because current OMP migrates older home-scoped `--Users-...--`
 * directories to the newer `-CascadeProjects-...` shape.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { WorkspaceFolder } from "vscode";

// ============================================================================
// CWD encoding
// ============================================================================

/**
 * Encode a path segment for use in an OMP session directory name.
 *
 * Only path separators and Windows drive colons are replaced; spaces and
 * existing dashes are preserved. This is the shared primitive used by both
 * relative and legacy absolute encodings.
 */
export function encodeOmpCwd(cwd: string): string {
  return cwd.replace(/[\\/:]/g, "-");
}

/**
 * Encode a cwd using OMP's legacy absolute directory name.
 *
 * This is retained for non-home/non-temp workspaces and for tests that need
 * to verify compatibility with pre-relative OMP session roots.
 */
export function encodeLegacyOmpCwd(cwd: string): string {
  return path
    .resolve(cwd)
    .replace(/^[/\\]/, "")
    .replace(/[\\/:]/g, "-");
}

function resolveEquivalentPath(value: string): string {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

function pathIsWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function encodeRelativeSessionDirName(prefix: string, root: string, cwd: string): string {
  const relative = path.relative(root, cwd).replace(/[\\/:]/g, "-");
  if (!relative) return prefix;
  return prefix.endsWith("-") ? `${prefix}${relative}` : `${prefix}-${relative}`;
}

function encodeLegacyAbsoluteSessionDirName(cwd: string): string {
  return `--${encodeLegacyOmpCwd(cwd)}--`;
}

/**
 * Return the OMP default session directory basename for a cwd.
 */
export function getOmpSessionDirName(cwd: string): string {
  const resolvedCwd = path.resolve(cwd);
  const canonicalCwd = resolveEquivalentPath(resolvedCwd);
  const home = resolveEquivalentPath(os.homedir());
  const tempRoot = resolveEquivalentPath(os.tmpdir());

  if (pathIsWithin(home, canonicalCwd)) {
    return encodeRelativeSessionDirName("-", home, canonicalCwd);
  }

  if (pathIsWithin(tempRoot, canonicalCwd)) {
    return encodeRelativeSessionDirName("-tmp", tempRoot, canonicalCwd);
  }

  return encodeLegacyAbsoluteSessionDirName(canonicalCwd);
}

// ============================================================================
// Session directory derivation
// ============================================================================

/**
 * Derive the OMP session directory for a given cwd.
 *
 * Returns an absolute path below `<homedir>/.omp/agent/sessions` using the
 * same cwd-to-directory mapping as OMP SessionManager.
 */
export function getOmpSessionDir(cwd: string): string {
  return path.join(os.homedir(), ".omp", "agent", "sessions", getOmpSessionDirName(cwd));
}

// ============================================================================
// Workspace scope resolution
// ============================================================================

/** Discriminated workspace scope result. */
export type WorkspaceScope =
  | { kind: "noWorkspace" }
  | { kind: "single"; folder: string }
  | { kind: "multiRoot"; folders: string[] };

/**
 * Resolve the workspace scope from VS Code workspace folders.
 *
 * This is a pure function; it does not access VS Code APIs directly so it
 * can be tested without mocking the extension host.
 *
 * @param workspaceFolders - The `vscode.workspace.workspaceFolders` array,
 *   which may be `undefined` when no workspace is open.
 * @returns A discriminated union describing the workspace scope.
 */
export function resolveWorkspaceScope(
  workspaceFolders: readonly WorkspaceFolder[] | undefined,
): WorkspaceScope {
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return { kind: "noWorkspace" };
  }

  if (workspaceFolders.length === 1) {
    return { kind: "single", folder: workspaceFolders[0]!.uri.fsPath };
  }

  return {
    kind: "multiRoot",
    folders: workspaceFolders.map((f) => f.uri.fsPath),
  };
}

/**
 * Get the effective workspace folder for OMP session discovery.
 *
 * For a single-root workspace, returns that folder.
 * For multi-root, returns the first folder (VS Code's convention).
 * For no workspace, returns `undefined` — the caller must decide how to
 * handle session discovery when there is no workspace (e.g., show an
 * explicit no-workspace state).
 */
export function getEffectiveWorkspaceFolder(scope: WorkspaceScope): string | undefined {
  if (scope.kind === "single") {
    return scope.folder;
  }

  if (scope.kind === "multiRoot") {
    return scope.folders[0];
  }

  return undefined;
}

/**
 * Derive the OMP session directory for a workspace scope.
 *
 * Returns `undefined` when there is no workspace. Otherwise returns the
 * session directory path for the effective workspace folder.
 */
export function getOmpSessionDirForScope(scope: WorkspaceScope): string | undefined {
  const folder = getEffectiveWorkspaceFolder(scope);
  if (!folder) {
    return undefined;
  }
  return getOmpSessionDir(folder);
}
