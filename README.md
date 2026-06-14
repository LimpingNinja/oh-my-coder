# Oh My Coder

A VS Code extension that provides an Activity Bar chat interface for [OMP](https://github.com/LimpingNinja/oh-my-pi) (Oh My Pi) sessions.

## Features

- Start and resume OMP sessions from VS Code
- Session discovery with workspace-scoped history
- Streaming chat transcript with markdown rendering
- Syntax-highlighted code blocks (Shiki + Oniguruma)
- Collapsible tool execution and thinking blocks
- VS Code bridge for editor/workspace integration

## Requirements

- VS Code 1.110+
- `omp` installed and on `PATH`

## Quick Start

### 1. Install Bun

Official docs: <https://bun.com/docs/installation>

| OS | Command |
|---|---|
| macOS | `brew install oven-sh/bun/bun` |
| Linux | `curl -fsSL https://bun.com/install \| bash` |
| Windows (PowerShell) | `powershell -c "irm bun.sh/install.ps1\|iex"` |

### 2. Install OMP

```bash
bun install -g @oh-my-pi/pi-coding-agent
```

### 3. Verify the CLI

```bash
omp --version
```

### 4. Install the extension

Install **Oh My Coder** from the VS Code Marketplace, or install a packaged VSIX manually.

For fuller macOS, Linux, and Windows setup notes, PATH troubleshooting, and VSIX install steps, see [INSTALL.md](./INSTALL.md).
## Development

```bash
pnpm install
pnpm build          # Build webview + extension
pnpm typecheck      # Type check extension
pnpm typecheck:webview  # Type check webview
pnpm lint           # Lint + format check
```

Run the extension in VS Code using the **Run Extension** launch configuration in `.vscode/launch.json`.

## Architecture

- **Extension host** (`src/`) — RPC controller, session management, transcript state, bridge server
- **Webview** (`webview-ui/src/`) — React frontend with Vite build, renders chat UI
- **Protocol** (`src/protocol/`) — Typed message contracts between extension and webview

## License

AGPL-3.0-or-later
