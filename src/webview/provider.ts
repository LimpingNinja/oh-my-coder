/**
 * WebviewViewProvider for the OMP chat panel.
 *
 * Loads the React webview bundle from dist-webview/ (built by Vite).
 */

import * as vscode from "vscode";
import type {
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
} from "../protocol/webviewMessages.ts";
import { isWebviewToExtensionMessage } from "../protocol/webviewMessages.ts";

/**
 * WebviewViewProvider for the OMP chat view.
 */
export class OmpChatProvider implements vscode.WebviewViewProvider {
  private _view: vscode.WebviewView | undefined;
  private readonly _extensionUri: vscode.Uri;
  private readonly _messageHandler: (message: WebviewToExtensionMessage) => void;
  private readonly _outputChannel: vscode.OutputChannel;
  private _disposables: vscode.Disposable[] = [];

  constructor(
    extensionUri: vscode.Uri,
    messageHandler: (message: WebviewToExtensionMessage) => void,
    outputChannel: vscode.OutputChannel,
  ) {
    this._extensionUri = extensionUri;
    this._messageHandler = messageHandler;
    this._outputChannel = outputChannel;
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    // Register message listener BEFORE setting html to avoid missing early messages
    this._disposables.push(
      webviewView.webview.onDidReceiveMessage((data: unknown) => {
        if (isWebviewToExtensionMessage(data)) {
          this._messageHandler(data);
        } else {
          this._outputChannel.appendLine(`[omp] webview: unknown message: ${JSON.stringify(data)}`);
        }
      }),
    );

    webviewView.webview.html = this._getHtml(webviewView.webview);

    webviewView.onDidDispose(() => {
      this._view = undefined;
      for (const d of this._disposables) {
        d.dispose();
      }
      this._disposables = [];
    });

    this._outputChannel.appendLine("[omp] webview view resolved");
  }

  postMessage(message: ExtensionToWebviewMessage): Thenable<boolean> {
    if (!this._view) {
      return Promise.resolve(false);
    }
    return this._view.webview.postMessage(message);
  }

  get isResolved(): boolean {
    return this._view !== undefined;
  }

  dispose(): void {
    for (const d of this._disposables) {
      d.dispose();
    }
    this._disposables = [];
    this._view = undefined;
  }

  private _getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "dist-webview", "assets", "main.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "dist-webview", "assets", "style.css"),
    );

    const nonce = getNonce();

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource} 'wasm-unsafe-eval' 'strict-dynamic'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">
  <title>OMP Chat</title>
  <link rel="stylesheet" href="${styleUri}">
</head>
<body>
  <div id="omp-app"></div>
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
