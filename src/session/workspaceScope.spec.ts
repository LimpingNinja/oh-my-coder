import { describe, expect, it } from "vitest";
import {
  encodeLegacyOmpCwd,
  encodeOmpCwd,
  getEffectiveWorkspaceFolder,
  getOmpSessionDir,
  getOmpSessionDirForScope,
  getOmpSessionDirName,
  resolveWorkspaceScope,
} from "./workspaceScope.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ============================================================================
// encodeOmpCwd
// ============================================================================

describe("encodeOmpCwd", () => {
  it("replaces path separators with dashes", () => {
    expect(encodeOmpCwd("Users/alice/projects/my-app")).toBe("Users-alice-projects-my-app");
  });

  it("replaces backslashes for Windows-style paths", () => {
    expect(encodeOmpCwd("C:\\Users\\alice\\projects")).toBe("C--Users-alice-projects");
  });

  it("preserves spaces and existing dashes", () => {
    expect(encodeOmpCwd("my projects/some-app")).toBe("my projects-some-app");
  });
});

describe("encodeLegacyOmpCwd", () => {
  it("strips the leading absolute separator and encodes the full path", () => {
    expect(encodeLegacyOmpCwd("/Users/alice/projects/my-app")).toBe("Users-alice-projects-my-app");
  });
});

// ============================================================================
// getOmpSessionDirName
// ============================================================================

describe("getOmpSessionDirName", () => {
  it("uses the current OMP home-relative format for paths under home", () => {
    const cwd = path.join(os.homedir(), "CascadeProjects", "oh-my-coder");
    expect(getOmpSessionDirName(cwd)).toBe("-CascadeProjects-oh-my-coder");
  });

  it("uses the current OMP temp-relative format for existing paths under tmp", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-test-discovery-"));
    try {
      const suffix = path.basename(cwd).replace(/[/\\:]/g, "-");
      expect(getOmpSessionDirName(cwd)).toBe(`-tmp-${suffix}`);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("uses legacy absolute format outside home and tmp", () => {
    const cwd = "/var/lib/project";
    expect(getOmpSessionDirName(cwd)).toBe("--var-lib-project--");
  });
});

// ============================================================================
// getOmpSessionDir
// ============================================================================

describe("getOmpSessionDir", () => {
  it("derives session directory from a home-scoped workspace", () => {
    const cwd = path.join(os.homedir(), "CascadeProjects", "oh-my-coder");
    const expected = path.join(
      os.homedir(),
      ".omp",
      "agent",
      "sessions",
      "-CascadeProjects-oh-my-coder",
    );
    expect(getOmpSessionDir(cwd)).toBe(expected);
  });

  it("derives session directory from an existing tmp-scoped workspace", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-test-discovery-"));
    try {
      const suffix = path.basename(cwd).replace(/[/\\:]/g, "-");
      const expected = path.join(os.homedir(), ".omp", "agent", "sessions", `-tmp-${suffix}`);
      expect(getOmpSessionDir(cwd)).toBe(expected);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("derives legacy absolute session directory outside home and tmp", () => {
    const expected = path.join(os.homedir(), ".omp", "agent", "sessions", "--var-lib-project--");
    expect(getOmpSessionDir("/var/lib/project")).toBe(expected);
  });
});

// ============================================================================
// resolveWorkspaceScope
// ============================================================================

describe("resolveWorkspaceScope", () => {
  it("returns noWorkspace when workspaceFolders is undefined", () => {
    expect(resolveWorkspaceScope(undefined)).toEqual({ kind: "noWorkspace" });
  });

  it("returns noWorkspace when workspaceFolders is empty", () => {
    expect(resolveWorkspaceScope([])).toEqual({ kind: "noWorkspace" });
  });

  it("returns single scope for one workspace folder", () => {
    const folders = [{ uri: { fsPath: "/home/user/project" } } as any];
    expect(resolveWorkspaceScope(folders)).toEqual({
      kind: "single",
      folder: "/home/user/project",
    });
  });

  it("returns multiRoot scope for multiple workspace folders", () => {
    const folders = [
      { uri: { fsPath: "/home/user/project-a" } } as any,
      { uri: { fsPath: "/home/user/project-b" } } as any,
    ];
    expect(resolveWorkspaceScope(folders)).toEqual({
      kind: "multiRoot",
      folders: ["/home/user/project-a", "/home/user/project-b"],
    });
  });
});

// ============================================================================
// getEffectiveWorkspaceFolder
// ============================================================================

describe("getEffectiveWorkspaceFolder", () => {
  it("returns undefined for noWorkspace", () => {
    expect(getEffectiveWorkspaceFolder({ kind: "noWorkspace" })).toBeUndefined();
  });

  it("returns the folder for single workspace", () => {
    expect(getEffectiveWorkspaceFolder({ kind: "single", folder: "/home/user/proj" })).toBe(
      "/home/user/proj",
    );
  });

  it("returns the first folder for multiRoot workspace", () => {
    expect(
      getEffectiveWorkspaceFolder({
        kind: "multiRoot",
        folders: ["/a", "/b", "/c"],
      }),
    ).toBe("/a");
  });
});

// ============================================================================
// getOmpSessionDirForScope
// ============================================================================

describe("getOmpSessionDirForScope", () => {
  it("returns undefined for noWorkspace", () => {
    expect(getOmpSessionDirForScope({ kind: "noWorkspace" })).toBeUndefined();
  });

  it("returns session dir for single workspace", () => {
    const folder = path.join(os.homedir(), "CascadeProjects", "oh-my-coder");
    const result = getOmpSessionDirForScope({ kind: "single", folder });
    const expected = path.join(
      os.homedir(),
      ".omp",
      "agent",
      "sessions",
      "-CascadeProjects-oh-my-coder",
    );
    expect(result).toBe(expected);
  });

  it("returns session dir for first folder in multiRoot workspace", () => {
    const first = path.join(os.homedir(), "proj-a");
    const result = getOmpSessionDirForScope({
      kind: "multiRoot",
      folders: [first, path.join(os.homedir(), "proj-b")],
    });
    const expected = path.join(os.homedir(), ".omp", "agent", "sessions", "-proj-a");
    expect(result).toBe(expected);
  });
});
