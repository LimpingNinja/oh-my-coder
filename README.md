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
- `omp` binary installed and on PATH (or configured via `omp.path` setting)

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

MIT
