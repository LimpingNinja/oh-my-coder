import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({ get: () => "" }),
    workspaceFolders: [],
  },
}));

let buildOmpRpcArgs: typeof import("./omp.ts").buildOmpRpcArgs;
let createOmpEnvironment: typeof import("./omp.ts").createOmpEnvironment;
let resolveOmpBinary: typeof import("./omp.ts").resolveOmpBinary;
type OmpResolveOptions = import("./omp.ts").OmpResolveOptions;

beforeAll(async () => {
  const omp = await import("./omp.ts");
  buildOmpRpcArgs = omp.buildOmpRpcArgs;
  createOmpEnvironment = omp.createOmpEnvironment;
  resolveOmpBinary = omp.resolveOmpBinary;
});

describe("buildOmpRpcArgs", () => {
  it("builds new-session rpc args with optional model/thinking", () => {
    expect(
      buildOmpRpcArgs({
        kind: "new",
        model: "openai-codex/gpt-5.4:medium",
        thinking: "medium",
      }),
    ).toEqual(["--mode", "rpc", "--model", "openai-codex/gpt-5.4:medium", "--thinking", "medium"]);
  });

  it("builds resume args with explicit session path and no model/thinking flags", () => {
    expect(
      buildOmpRpcArgs({
        kind: "resume",
        sessionPath: "/tmp/session file.jsonl",
        model: "should-not-be-used",
        thinking: "high",
      }),
    ).toEqual(["--mode", "rpc", "--resume", "/tmp/session file.jsonl"]);
  });

  it("throws when resume is requested without an explicit session path", () => {
    expect(() => buildOmpRpcArgs({ kind: "resume" })).toThrow(
      "resume launch requires an explicit session path",
    );
  });
});

describe("resolveOmpBinary", () => {
  function accessForExisting(paths: Set<string>) {
    return (path: string) => {
      if (!paths.has(path)) {
        throw new Error("ENOENT");
      }
    };
  }

  it("prefers configured custom path", () => {
    const options: OmpResolveOptions = {
      platform: "linux",
      customPath: "/custom/omp",
      access: accessForExisting(new Set()),
    };

    expect(resolveOmpBinary(options)).toBe("/custom/omp");
  });

  it("resolves workspace-local binary before global/PATH candidates", () => {
    const expected = "/workspace/node_modules/.bin/omp";
    const options: OmpResolveOptions = {
      platform: "linux",
      workspaceDirs: ["/workspace"],
      pathEnv: "/usr/local/bin:/usr/bin",
      home: "/home/tester",
      access: accessForExisting(new Set([expected])),
    };

    expect(resolveOmpBinary(options)).toBe(expected);
  });

  it("falls back to bare omp when no candidate exists", () => {
    const options: OmpResolveOptions = {
      platform: "linux",
      workspaceDirs: ["/workspace"],
      pathEnv: "/usr/local/bin:/usr/bin",
      home: "/home/tester",
      access: accessForExisting(new Set()),
    };

    expect(resolveOmpBinary(options)).toBe("omp");
  });
});

describe("createOmpEnvironment", () => {
  it("returns undefined when bridge config is absent", () => {
    expect(createOmpEnvironment(undefined)).toBeUndefined();
  });

  it("injects OMP and upstream-compatible PI bridge variables", () => {
    expect(createOmpEnvironment({ url: "http://127.0.0.1:4545", token: "secret" })).toEqual({
      OMP_VSCODE_BRIDGE_URL: "http://127.0.0.1:4545",
      OMP_VSCODE_BRIDGE_TOKEN: "secret",
      PI_VSCODE_BRIDGE_URL: "http://127.0.0.1:4545",
      PI_VSCODE_BRIDGE_TOKEN: "secret",
    });
  });
});
