import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const { mockState, vscodeMock } = vi.hoisted(() => ({
  mockState: {
    homedir: "",
  },
  vscodeMock: {
    workspace: {
      workspaceFolders: undefined as Array<{ uri: { fsPath: string } }> | undefined,
      getConfiguration: () => ({
        get: () => undefined,
        update: () => Promise.resolve(),
      }),
      onDidChangeConfiguration: () => ({ dispose: () => {} }),
    },
    window: {
      createOutputChannel: () => ({
        appendLine: () => {},
        dispose: () => {},
      }),
      showErrorMessage: () => {},
      showWarningMessage: () => {},
    },
    commands: { registerCommand: () => ({ dispose: () => {} }) },
    Uri: { file: (p: string) => ({ fsPath: p }) },
    ExtensionMode: { Production: 1, Development: 2, Test: 3 },
  },
}));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => mockState.homedir,
  };
});

vi.mock("vscode", () => vscodeMock);

let readRulesList: typeof import("./extension.ts").readRulesList;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rules-test-"));
  mockState.homedir = tmpDir;
  vscodeMock.workspace.workspaceFolders = undefined;
  vi.resetModules();
  const ext = await import("./extension.ts");
  readRulesList = ext.readRulesList;
});

afterEach(async () => {
  vi.restoreAllMocks();
  mockState.homedir = path.join(os.tmpdir(), "default");
  vscodeMock.workspace.workspaceFolders = undefined;
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

async function writeRule(dir: string, filename: string, content: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), content, "utf-8");
}

describe("readRulesList", () => {
  it("returns empty array when global dir does not exist and no workspace", async () => {
    const result = await readRulesList();
    expect(result).toEqual([]);
  });

  it("returns one rule with frontmatter from global dir", async () => {
    const globalDir = path.join(tmpDir, ".omp", "agent", "rules");
    await writeRule(
      globalDir,
      "my-rule.md",
      '---\ndescription: Test rule\nglobs:\n  - "*.ts"\nalwaysApply: true\n---\nRule body here\n',
    );
    const result = await readRulesList();
    expect(result).toHaveLength(1);
    const rule = result[0]!;
    expect(rule.name).toBe("my-rule");
    expect(rule.description).toBe("Test rule");
    expect(rule.globs).toEqual(["*.ts"]);
    expect(rule.alwaysApply).toBe(true);
    expect(rule.content).toBe("Rule body here");
    expect(rule.source).toBe("global");
  });

  it("returns one rule without frontmatter — body only", async () => {
    const globalDir = path.join(tmpDir, ".omp", "agent", "rules");
    await writeRule(globalDir, "plain.md", "Just plain content\n");
    const result = await readRulesList();
    expect(result).toHaveLength(1);
    const rule = result[0]!;
    expect(rule.name).toBe("plain");
    expect(rule.content).toBe("Just plain content");
    expect(rule.source).toBe("global");
    expect(rule.description).toBeUndefined();
    expect(rule.globs).toBeUndefined();
  });

  it("handles open fence with no closing fence — returns body after open fence", async () => {
    const globalDir = path.join(tmpDir, ".omp", "agent", "rules");
    await writeRule(globalDir, "broken.md", "---\nsome: yaml\nNo closing fence\n");
    const result = await readRulesList();
    expect(result).toHaveLength(1);
    const rule = result[0]!;
    expect(rule.name).toBe("broken");
    // Without a closing fence, content is everything after the open fence
    expect(rule.content).toContain("No closing fence");
  });

  it("drops wrong-typed fields instead of coercing", async () => {
    const globalDir = path.join(tmpDir, ".omp", "agent", "rules");
    await writeRule(
      globalDir,
      "badtypes.md",
      '---\ndescription: 123\nglobs: not-an-array\nalwaysApply: "yes"\ncondition: wrong\nscope: also-wrong\ninterruptMode: invalid-mode\n---\nBody\n',
    );
    const result = await readRulesList();
    expect(result).toHaveLength(1);
    const rule = result[0]!;

    expect(rule.name).toBe("badtypes");
    expect(rule.content).toBe("Body");
    // description is number, not string → dropped
    expect(rule.description).toBeUndefined();
    // globs is string, not string[] → dropped
    expect(rule.globs).toBeUndefined();
    // alwaysApply is string, not boolean → dropped
    expect(rule.alwaysApply).toBeUndefined();
    // condition is string, not string[] → dropped
    expect(rule.condition).toBeUndefined();
    // scope is string, not string[] → dropped
    expect(rule.scope).toBeUndefined();
    // interruptMode is not one of the four literals → dropped
    expect(rule.interruptMode).toBeUndefined();
  });

  it("returns global and project rules with correct sources when workspace is open", async () => {
    const globalDir = path.join(tmpDir, ".omp", "agent", "rules");
    await writeRule(globalDir, "global-rule.md", "---\ndescription: Global\n---\nGlobal body\n");

    // Set up a project dir
    const projectDir = path.join(tmpDir, "my-project");
    const projectRulesDir = path.join(projectDir, ".omp", "rules");
    await fs.mkdir(projectRulesDir, { recursive: true });
    await writeRule(
      projectRulesDir,
      "project-rule.md",
      "---\ndescription: Project\n---\nProject body\n",
    );

    // Mock vscode.workspace.workspaceFolders to point at project dir
    vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: projectDir } }];
    // Re-import extension to pick up workspace mock
    vi.resetModules();
    const ext = await import("./extension.ts");
    readRulesList = ext.readRulesList;

    const result = await readRulesList();
    expect(result).toHaveLength(2);
    const globalRule = result.find((r) => r.source === "global");
    const projectRule = result.find((r) => r.source === "project");
    expect(globalRule).toBeDefined();
    expect(globalRule!.name).toBe("global-rule");
    expect(projectRule).toBeDefined();
    expect(projectRule!.name).toBe("project-rule");
  });
});
