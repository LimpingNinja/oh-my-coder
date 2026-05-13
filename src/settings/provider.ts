/**
 * SettingsEditorProvider — singleton WebviewPanel for the OMC settings UI.
 *
 * Shares the same webview bundle as the chat panel (route-based rendering).
 * The extension host sends a "settings.navigate" message to tell the React
 * app to render the <Settings /> route instead of <Chat />.
 */

import * as vscode from "vscode";
import type {
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
} from "../protocol/webviewMessages.ts";
import { isWebviewToExtensionMessage } from "../protocol/webviewMessages.ts";

const VIEW_TYPE = "omp.settings";

export class SettingsEditorProvider {
  private static _panel: vscode.WebviewPanel | undefined;
  private static _disposables: vscode.Disposable[] = [];
  private static _messageHandler: ((message: WebviewToExtensionMessage) => void) | undefined;

  /**
   * Set the message handler that delegates webview messages to extension.ts logic.
   * Must be called before openPanel to wire up message routing.
   */
  static setMessageHandler(handler: (message: WebviewToExtensionMessage) => void): void {
    SettingsEditorProvider._messageHandler = handler;
  }

  /**
   * Open or reveal the settings panel. If already open, reveals and optionally
   * navigates to a specific tab.
   */
  static openPanel(extensionUri: vscode.Uri, tab?: string): void {
    if (SettingsEditorProvider._panel) {
      SettingsEditorProvider._panel.reveal(vscode.ViewColumn.Active);
      if (tab) {
        void SettingsEditorProvider._panel.webview.postMessage({
          type: "settings.navigate",
          tab,
        } satisfies ExtensionToWebviewMessage);
      }
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      "OMC Settings",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      },
    );

    SettingsEditorProvider._panel = panel;

    panel.webview.html = SettingsEditorProvider._getHtml(panel.webview, extensionUri);

    SettingsEditorProvider._disposables.push(
      panel.webview.onDidReceiveMessage((data: unknown) => {
        if (isWebviewToExtensionMessage(data)) {
          SettingsEditorProvider._messageHandler?.(data);
        }
      }),
    );

    panel.onDidDispose(() => {
      SettingsEditorProvider._cleanup();
    });

    // After the webview is ready, navigate to settings (with optional tab)
    // We post immediately — the webview React app handles queuing if not yet mounted
    void panel.webview.postMessage({
      type: "settings.navigate",
      tab,
    } satisfies ExtensionToWebviewMessage);
  }

  /**
   * Post a message to the settings panel webview (if open).
   */
  static postMessage(message: ExtensionToWebviewMessage): Thenable<boolean> {
    if (!SettingsEditorProvider._panel) {
      return Promise.resolve(false);
    }
    return SettingsEditorProvider._panel.webview.postMessage(message);
  }

  /**
   * Whether the settings panel is currently open.
   */
  static get isOpen(): boolean {
    return SettingsEditorProvider._panel !== undefined;
  }

  /**
   * Dispose the settings panel programmatically.
   */
  static dispose(): void {
    SettingsEditorProvider._panel?.dispose();
  }

  private static _cleanup(): void {
    for (const d of SettingsEditorProvider._disposables) {
      d.dispose();
    }
    SettingsEditorProvider._disposables = [];
    SettingsEditorProvider._panel = undefined;
  }

  private static _getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, "dist-webview", "assets", "main.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, "dist-webview", "assets", "style.css"),
    );
    const logoFullUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, "assets", "omc_full_lockup_transparent_16c.png"),
    );
    const logoIconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, "assets", "omc_large_icon_square_transparent_16c.png"),
    );

    const nonce = getNonce();

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource} 'wasm-unsafe-eval' 'strict-dynamic'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource} data:;">
  <title>OMC Settings</title>
  <link rel="stylesheet" href="${styleUri}">
</head>
<body>
  <div id="omp-app" data-route="settings" data-asset-logo-full="${logoFullUri}" data-asset-logo-icon="${logoIconUri}"></div>
  <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const bytes = new Uint8Array(32);
  if (
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.getRandomValues === "function"
  ) {
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  let nonce = "";
  for (let i = 0; i < 64; i++) {
    nonce += Math.floor(Math.random() * 16).toString(16);
  }
  return nonce;
}
