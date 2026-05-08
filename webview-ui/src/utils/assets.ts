/**
 * Access image asset URIs injected by the extension host as data attributes
 * on the #omp-app root element. These are resolved via `webview.asWebviewUri()`
 * at HTML render time — no inline script needed, avoiding CSP issues.
 */

const ASSET_KEYS = {
  logoFull: "data-asset-logo-full",
  logoIcon: "data-asset-logo-icon",
} as const;

export type AssetKey = keyof typeof ASSET_KEYS;

let cachedRoot: HTMLElement | null = null;

function getRoot(): HTMLElement | null {
  if (!cachedRoot) {
    cachedRoot = document.getElementById("omp-app");
  }
  return cachedRoot;
}

export function getAssetUri(key: AssetKey): string {
  const root = getRoot();
  return root?.getAttribute(ASSET_KEYS[key]) ?? "";
}
