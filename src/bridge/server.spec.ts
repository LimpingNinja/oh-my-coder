import { beforeAll, describe, expect, it, vi } from "vitest";

// Mock vscode module before any imports that depend on it
vi.mock("vscode", () => ({
  window: {
    onDidChangeTextEditorSelection: vi.fn(() => ({ dispose: vi.fn() })),
    onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
    onDidChangeVisibleTextEditors: vi.fn(() => ({ dispose: vi.fn() })),
    activeTextEditor: undefined,
  },
  languages: {
    onDidChangeDiagnostics: vi.fn(() => ({ dispose: vi.fn() })),
    getDiagnostics: vi.fn(() => []),
  },
  workspace: {
    onDidChangeTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
    onDidSaveTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
    onDidCloseTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
    workspaceFolders: [],
    textDocuments: [],
  },
  ExtensionContext: vi.fn(),
  Uri: { file: (p: string) => ({ fsPath: p, toString: () => `file://${p}` }) },
  ViewColumn: { One: 1 },
}));

import { createBridge } from "./server.ts";

describe("bridge server", () => {
  let mockContext: { subscriptions: { dispose: () => void }[] };

  beforeAll(() => {
    mockContext = { subscriptions: [] };
  });

  it("starts and returns url, token, and dispose", async () => {
    const bridge = await createBridge(mockContext as never);

    expect(bridge).toBeDefined();
    expect(bridge.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(typeof bridge.token).toBe("string");
    expect(bridge.token.length).toBeGreaterThan(0);
    expect(typeof bridge.dispose).toBe("function");

    // Clean up
    await bridge.dispose();
  });

  it("registers vscode event subscriptions on creation and disposes them", async () => {
    const bridge = await createBridge(mockContext as never);

    // createBridge pushes subscriptions to context.subscriptions
    // We verify it doesn't throw and that dispose completes
    expect(mockContext.subscriptions.length).toBeGreaterThan(0);

    await bridge.dispose();
  });

  it("accepts authenticated RPC requests on /rpc", async () => {
    const bridge = await createBridge(mockContext as never);
    const url = new URL("/rpc", bridge.url);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-omp-authorization": bridge.token,
      },
      body: JSON.stringify({ method: "getStatus", params: {} }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: unknown };
    expect(body).toHaveProperty("result");

    await bridge.dispose();
  });

  it("accepts legacy x-pi-vscode-authorization header", async () => {
    const bridge = await createBridge(mockContext as never);
    const url = new URL("/rpc", bridge.url);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-pi-vscode-authorization": bridge.token,
      },
      body: JSON.stringify({ method: "getStatus", params: {} }),
    });

    expect(response.status).toBe(200);

    await bridge.dispose();
  });

  it("rejects unauthenticated requests with 401", async () => {
    const bridge = await createBridge(mockContext as never);
    const url = new URL("/rpc", bridge.url);

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: "getStatus", params: {} }),
    });

    expect(response.status).toBe(401);

    await bridge.dispose();
  });

  it("rejects wrong token with 401", async () => {
    const bridge = await createBridge(mockContext as never);
    const url = new URL("/rpc", bridge.url);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-omp-authorization": "wrong-token",
      },
      body: JSON.stringify({ method: "getStatus", params: {} }),
    });

    expect(response.status).toBe(401);

    await bridge.dispose();
  });

  it("returns 404 for non-rpc paths", async () => {
    const bridge = await createBridge(mockContext as never);
    const url = new URL("/other", bridge.url);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-omp-authorization": bridge.token,
      },
      body: JSON.stringify({ method: "getStatus", params: {} }),
    });

    expect(response.status).toBe(404);

    await bridge.dispose();
  });

  it("returns 400 for requests without a method", async () => {
    const bridge = await createBridge(mockContext as never);
    const url = new URL("/rpc", bridge.url);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-omp-authorization": bridge.token,
      },
      body: JSON.stringify({ params: {} }),
    });

    expect(response.status).toBe(400);

    await bridge.dispose();
  });

  it("disposes the server cleanly and is idempotent", async () => {
    const bridge = await createBridge(mockContext as never);
    await bridge.dispose();

    // Second dispose should not throw (idempotent)
    await bridge.dispose();
  });
});
