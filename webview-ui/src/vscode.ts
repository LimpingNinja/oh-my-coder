/**
 * VS Code API accessor for the webview.
 *
 * acquireVsCodeApi() can only be called once. This module caches it.
 */

interface VSCodeAPI {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

let vscodeApi: VSCodeAPI | undefined;

export function getVSCodeAPI(): VSCodeAPI {
  if (!vscodeApi) {
    // @ts-expect-error — acquireVsCodeApi is injected by VS Code webview runtime
    vscodeApi = acquireVsCodeApi();
  }
  return vscodeApi!;
}
