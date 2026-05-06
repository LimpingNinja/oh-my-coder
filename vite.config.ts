import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Vite plugin to inline .wasm files as WebAssembly.Module.
 * Mirrors KiloCode's approach — avoids CSP issues in VS Code webviews
 * where fetching external .wasm files at runtime is blocked.
 */
const wasmPlugin = (): Plugin => ({
  name: "wasm",
  async load(id) {
    if (id.endsWith(".wasm")) {
      const wasmBinary = await import(id);
      return `
        const wasmModule = new WebAssembly.Module(${wasmBinary.default});
        export default wasmModule;
      `;
    }
  },
});

export default defineConfig({
  plugins: [react(), wasmPlugin()],
  build: {
    outDir: resolve(__dirname, "dist-webview"),
    emptyOutDir: true,
    reportCompressedSize: false,
    sourcemap: false,
    minify: true,
    cssCodeSplit: false,
    rollupOptions: {
      input: resolve(__dirname, "webview-ui/src/index.tsx"),
      output: {
        entryFileNames: "assets/main.js",
        chunkFileNames: "assets/chunk-[hash].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
  optimizeDeps: {
    exclude: ["vscode-oniguruma", "shiki"],
  },
  assetsInclude: ["**/*.wasm"],
});
