# UI Polish Backlog

Updated: 2026-05-07

## Completed This Session

- [x] Read tool: Shiki syntax highlighting, displayContent preference, hash detection fix
- [x] Search tool: file-grouped snippets, match highlighting, clickable paths
- [x] Find tool: file icons, clean spacing, collapsible
- [x] ast_grep/ast_edit: routed to search renderer
- [x] web_search: numbered link cards with URL/snippets
- [x] todo_write: circle icons, strikethrough, priority badges
- [x] vscode_* bridge tools: SmartJson renderer
- [x] Generic/MCP fallback: SmartJson auto-detection
- [x] User bubble: preserves newlines (white-space: pre-wrap)
- [x] TaskWaveform context graph (symmetric, ethereal colors, click-to-jump, drag-scroll)
- [x] Header tooltips: CSS-only data-tip with 800ms delay, positioned below
- [x] Details row defaults to open
- [x] Extension UI request/response system (Phase 7)
- [x] Bridge --extension wiring + question tool
- [x] Question tool: suppressed while running, Q&A summary on completion
- [x] Footer defects fixed (hover timeout, model selector, thinkingSupported, composer ref, debounce)
- [x] Delivery mode z-index fix

## Pending TODOs

### High Priority

- [ ] **Question session grouping** — Show one unified card during multi-question tool calls (KiloCode-style). Design complete (embed session in ToolCallEvent, single reducer pass per message, component-local state for interaction). Blocked on careful implementation to avoid React crash. See distinguished architect design in session notes.

- [ ] **Persist details open/closed state** — Currently defaults to open but resets on webview reload. Need light session metadata via VS Code webviewState or workspaceState.

- [ ] **Passive editor context on messages** — Prepend editor state (file, line, selection) to user messages before sending to runtime. Windsurf-style passive awareness without tool calls. Simple implementation: read footerEditor state and prepend a context line.

### Medium Priority — UI Polish

- [ ] Loading skeleton states instead of plain spinners
- [ ] Keyboard navigation in session lists
- [ ] Responsive layout for narrow panel widths
- [ ] Accessibility pass: ARIA labels, focus management
- [ ] Message timestamps (optional toggle)

### Medium Priority — Features

- [ ] **Editor lightbulb code actions** — When user selects code, offer "Ask OMP", "Explain", "Refactor" via VS Code CodeActionProvider
- [ ] **Context graph enhancements** — Color legend, possibly per-turn token cost display, checkpoint navigation concept
- [ ] **Suggest tool** — Register via bridge for model to offer follow-up actions to user

### Phase 8 (Not Started)

- [ ] Native VS Code commands (OMP: Open Chat, New Session, Resume, Focus Input, Switch Model, etc.)
- [ ] VS Code settings (binary path, default model, auto compact, context includes, etc.)
- [ ] Status bar item (compact, opens/focuses OMP)
- [ ] Terminal fallback (explicit debug path only)

### Phase 9 (Not Started)

- [ ] Session file watching + live sidebar refresh
- [ ] Debounced refresh, preserve selection, handle directory creation

### Phase 10 (Not Started)

- [ ] Hardening: all edge cases (no workspace, multiple workspaces, invalid JSONL, missing resume path, etc.)
- [ ] Unit tests: arg construction, session discovery, JSONL parser, message protocol, footer mapping
- [ ] Component tests: launch composer, session preview, chat composer, extension UI dialogs
- [ ] Integration tests: RPC ready, get_state, prompt streaming, resume, bridge
- [ ] Manual UX QA: keyboard-only, high contrast, narrow sidebar, long titles

## Entry Screen

- [ ] Validate session click-to-resume (no stale selection state)
- [ ] "Show History" count badge if > MAX_RECENT
- [ ] Empty state illustration/art

## History Screen

- [ ] Import JSONL session: wire file picker + discovery registration
- [ ] Export as Markdown: real markdown conversion
- [ ] Session context menu (rename, delete, open in editor)
- [ ] Selected/active session indicator in history list

## Open Questions

- **Tool/system message duplication** — Suppress system error messages that duplicate tool execution results? Current approach: turn-based rendering mostly eliminates this, but edge cases may remain.
- **Question session architecture** — The distinguished architect proposed embedding QuestionSession in ToolCallEvent within the turn transcript (single atomic reducer pass). The code skeptic confirmed this avoids the crash. Implementation deferred.
