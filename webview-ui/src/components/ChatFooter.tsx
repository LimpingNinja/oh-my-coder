import { useState, useRef } from "react";
import { useAppState, getState } from "../state/store";
import { getVSCodeAPI } from "../vscode";
import { Composer } from "./Composer";
import { PillPopover } from "./PillPopover";
import { SendButton } from "./SendButton";
import { ModelSelector } from "./ModelSelector";
import { ThinkingSelector } from "./ThinkingSelector";

interface ChatFooterProps {
  onSubmit: (content: string, behavior?: "steer" | "followUp" | "forceSend") => void;
  isStreaming?: boolean;
}

/**
 * Footer for the active session view.
 *
 * Zone 1: file context (active editor from bridge) | New Session button
 * Zone 2: Composer (chat textarea)
 * Zone 3: Model pill · Thinking pill · Context pill · Delivery mode pill | Send/Stop
 */
export function ChatFooter({ onSubmit, isStreaming }: ChatFooterProps) {
  const { footerEditor, footerRuntime, header } = useAppState();

  const handleNewSession = () => {
    const vscode = getVSCodeAPI();
    vscode.postMessage({ type: "session.start", prompt: "" });
  };

  // Format file context display
  const fileDisplay = formatFileContext(footerEditor);

  return (
    <footer className="omp-footer" aria-label="Session controls">
      {/* Zone 1: File context bar */}
      <div className="omp-footer-zone omp-footer-context">
        <div className="omp-footer-context-left">
          {fileDisplay ? (
            <span className="omp-footer-file" title={footerEditor.filePath}>
              {footerEditor.isDirty && <span className="omp-footer-dirty">●</span>}
              {fileDisplay}
            </span>
          ) : (
            <span className="omp-footer-file omp-footer-file--empty">No active file</span>
          )}
        </div>
        <div className="omp-footer-context-right">
          <button className="omp-footer-btn" onClick={handleNewSession} title="New Session">
            <i className="codicon codicon-add" /> New
          </button>
        </div>
      </div>

      {/* Zone 2: Composer — never disabled, messages queue as steer/follow-up during streaming */}
      <Composer
        onSubmit={onSubmit}
        placeholder={isStreaming ? "Send steering or follow-up message..." : "Type a message..."}
      />

      {/* Zone 3: Controls bar — pill badges with hover popovers */}
      <div className="omp-footer-zone omp-footer-controls">
        <div className="omp-footer-controls-left">
          {/* Model pill — click to open model selector */}
          <ModelPill model={footerRuntime.model} state={footerRuntime.state} />

          {/* Thinking pill — click to open level selector, dimmed when not supported */}
          <ThinkingPill level={footerRuntime.thinking} supported={footerRuntime.thinkingSupported} />

          {/* Context pill */}
          <PillPopover
            trigger={
              <button className="omp-pill">
                <i className="codicon codicon-database" />
                <span>{header.contextPercent != null ? `${header.contextPercent}%` : "—"}</span>
              </button>
            }
          >
            <div className="omp-popover-content">
              <div className="omp-popover-title">Context Window</div>
              <div className="omp-popover-row">
                <span className="omp-popover-label">Used</span>
                <span className="omp-popover-value">
                  {header.contextPercent != null ? `${header.contextPercent}%` : "unavailable"}
                </span>
              </div>
              {header.tokens && (
                <>
                  <div className="omp-popover-row">
                    <span className="omp-popover-label">Input</span>
                    <span className="omp-popover-value">{formatTokens(header.tokens.input)}</span>
                  </div>
                  <div className="omp-popover-row">
                    <span className="omp-popover-label">Output</span>
                    <span className="omp-popover-value">{formatTokens(header.tokens.output)}</span>
                  </div>
                  <div className="omp-popover-row">
                    <span className="omp-popover-label">Cache</span>
                    <span className="omp-popover-value">{formatTokens(header.tokens.cacheRead)}</span>
                  </div>
                </>
              )}
              {header.costUsd != null && (
                <div className="omp-popover-row">
                  <span className="omp-popover-label">Cost</span>
                  <span className="omp-popover-value">${header.costUsd.toFixed(4)}</span>
                </div>
              )}
            </div>
          </PillPopover>

          {/* Delivery mode pill — click to open settings */}
          <DeliveryModePill
            steeringMode={footerRuntime.steeringMode}
            followUpMode={footerRuntime.followUpMode}
            interruptMode={footerRuntime.interruptMode}
          />
        </div>
        <div className="omp-footer-controls-right">
          <SendButton
            isStreaming={!!isStreaming}
            interruptMode={footerRuntime.interruptMode}
            onSend={(behavior) => {
              // Trigger send from composer content
              const textarea = document.querySelector<HTMLTextAreaElement>(".omp-composer textarea");
              if (textarea) {
                const content = textarea.value.trim();
                if (content) {
                  onSubmit(content, behavior);
                  textarea.value = "";
                  textarea.style.height = "auto";
                }
              }
            }}
          />
        </div>
      </div>
    </footer>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatFileContext(editor: { filePath?: string; line?: number; endLine?: number }): string {
  if (!editor.filePath) return "";
  const basename = editor.filePath.split(/[/\\]/).pop() ?? editor.filePath;
  if (editor.line != null && editor.endLine != null && editor.endLine !== editor.line) {
    return `${basename}:${editor.line}-${editor.endLine}`;
  }
  if (editor.line != null) {
    return `${basename}:${editor.line}`;
  }
  return basename;
}

function shortenModel(model: string): string {
  // Strip provider prefix if present (e.g. "anthropic/claude-sonnet-4-20250514" → "claude-sonnet-4")
  const parts = model.split("/");
  const name = parts[parts.length - 1] ?? model;
  // Remove date suffixes
  return name.replace(/-\d{8}$/, "");
}

function formatThinking(thinking?: string): string {
  if (!thinking || thinking === "off") return "off";
  const map: Record<string, string> = {
    minimal: "min",
    low: "L",
    medium: "M",
    high: "H",
    xhigh: "XH",
  };
  return map[thinking] ?? thinking;
}

// ── Delivery Mode Pill with click-to-open settings ───────────────────

interface DeliveryModePillProps {
  steeringMode?: "all" | "one-at-a-time";
  followUpMode?: "all" | "one-at-a-time";
  interruptMode?: "immediate" | "wait";
}

function DeliveryModePill({ steeringMode, followUpMode, interruptMode }: DeliveryModePillProps) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const hoverTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const vscode = getVSCodeAPI();

  const showHover = () => {
    if (open) return; // Don't show hover when settings panel is open
    if (hoverTimeout.current) clearTimeout(hoverTimeout.current);
    setHovered(true);
  };
  const hideHover = () => {
    hoverTimeout.current = setTimeout(() => setHovered(false), 150);
  };

  const setSteeringMode = (mode: "all" | "one-at-a-time") => {
    vscode.postMessage({ type: "runtime.setSteeringMode", mode });
  };
  const setFollowUpMode = (mode: "all" | "one-at-a-time") => {
    vscode.postMessage({ type: "runtime.setFollowUpMode", mode });
  };
  const setInterruptMode = (mode: "immediate" | "wait") => {
    vscode.postMessage({ type: "runtime.setInterruptMode", mode });
  };

  // Label for the pill: show current default behavior
  const defaultLabel = interruptMode === "immediate" ? "Steer" : "Queue";

  return (
    <div
      className="omp-pill-popover-wrap"
      onMouseEnter={showHover}
      onMouseLeave={hideHover}
    >
      <button className="omp-pill" onClick={() => { setHovered(false); setOpen(!open); }}>
        <i className="codicon codicon-git-compare" />
        <span>{defaultLabel}</span>
      </button>

      {/* Hover popover — read-only current state */}
      {hovered && !open && (
        <div className="omp-pill-popover" onMouseEnter={showHover} onMouseLeave={hideHover}>
          <div className="omp-popover-content">
            <div className="omp-popover-title">Queue Delivery Modes</div>
            <div className="omp-popover-row">
              <span className="omp-popover-label">Default</span>
              <span className="omp-popover-value">{interruptMode === "immediate" ? "Steer" : "Follow-up"}</span>
            </div>
            <div className="omp-popover-row">
              <span className="omp-popover-label">Interrupt</span>
              <span className="omp-popover-value">{interruptMode ?? "immediate"}</span>
            </div>
            <div className="omp-popover-row">
              <span className="omp-popover-label">Steering</span>
              <span className="omp-popover-value">{steeringMode === "all" ? "All" : "One at a time"}</span>
            </div>
            <div className="omp-popover-row">
              <span className="omp-popover-label">Follow-up</span>
              <span className="omp-popover-value">{followUpMode === "all" ? "All" : "One at a time"}</span>
            </div>
          </div>
        </div>
      )}

      {/* Click panel — editable settings */}
      {open && (
        <div className="omp-pill-popover omp-delivery-panel">
          <div className="omp-popover-content">
            <div className="omp-popover-title">Queue Delivery Settings</div>

            {/* Interrupt mode */}
            <div className="omp-delivery-setting">
              <span className="omp-delivery-label">Default send during streaming</span>
              <div className="omp-delivery-toggle">
                <button
                  className={`omp-toggle-btn ${interruptMode === "immediate" ? "omp-toggle-btn--active" : ""}`}
                  onClick={() => setInterruptMode("immediate")}
                >
                  Steer
                </button>
                <button
                  className={`omp-toggle-btn ${interruptMode === "wait" ? "omp-toggle-btn--active" : ""}`}
                  onClick={() => setInterruptMode("wait")}
                >
                  Follow-up
                </button>
              </div>
            </div>

            {/* Steering queue mode */}
            <div className="omp-delivery-setting">
              <span className="omp-delivery-label">Steering delivery</span>
              <div className="omp-delivery-toggle">
                <button
                  className={`omp-toggle-btn ${steeringMode === "one-at-a-time" ? "omp-toggle-btn--active" : ""}`}
                  onClick={() => setSteeringMode("one-at-a-time")}
                >
                  One
                </button>
                <button
                  className={`omp-toggle-btn ${steeringMode === "all" ? "omp-toggle-btn--active" : ""}`}
                  onClick={() => setSteeringMode("all")}
                >
                  All
                </button>
              </div>
            </div>

            {/* Follow-up queue mode */}
            <div className="omp-delivery-setting">
              <span className="omp-delivery-label">Follow-up delivery</span>
              <div className="omp-delivery-toggle">
                <button
                  className={`omp-toggle-btn ${followUpMode === "one-at-a-time" ? "omp-toggle-btn--active" : ""}`}
                  onClick={() => setFollowUpMode("one-at-a-time")}
                >
                  One
                </button>
                <button
                  className={`omp-toggle-btn ${followUpMode === "all" ? "omp-toggle-btn--active" : ""}`}
                  onClick={() => setFollowUpMode("all")}
                >
                  All
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {open && <div className="omp-send-popup-backdrop" onClick={() => setOpen(false)} />}
    </div>
  );
}

// ── Model Pill ───────────────────────────────────────────────────────

function ModelPill({ model, state }: { model?: string; state: string }) {
  const [selectorOpen, setSelectorOpen] = useState(false);

  return (
    <div className="omp-pill-popover-wrap">
      <button className="omp-pill omp-pill--clickable" onClick={() => setSelectorOpen(!selectorOpen)}>
        <i className="codicon codicon-hubot" />
        <span>{model ? shortenModel(model) : "—"}</span>
        <i className="codicon codicon-chevron-down omp-pill-chevron" />
      </button>
      <ModelSelector
        open={selectorOpen}
        onClose={() => setSelectorOpen(false)}
        currentModel={model}
      />
    </div>
  );
}

// ── Thinking Pill ────────────────────────────────────────────────────

function ThinkingPill({ level, supported }: { level?: string; supported: boolean }) {
  const [selectorOpen, setSelectorOpen] = useState(false);

  if (!supported) {
    return (
      <div className="omp-pill-popover-wrap">
        <button className="omp-pill omp-pill--disabled" disabled title="Current model does not support thinking levels">
          <span className="omp-pill-letter">—</span>
        </button>
      </div>
    );
  }

  return (
    <div className="omp-pill-popover-wrap">
      <button className="omp-pill omp-pill--clickable" onClick={() => setSelectorOpen(!selectorOpen)}>
        <span className="omp-pill-letter">{formatThinking(level)}</span>
        <i className="codicon codicon-chevron-down omp-pill-chevron" />
      </button>
      <ThinkingSelector
        open={selectorOpen}
        onClose={() => setSelectorOpen(false)}
        currentLevel={level ?? "off"}
      />
    </div>
  );
}
