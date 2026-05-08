/**
 * TaskWaveform — symmetric waveform visualization of session activity.
 *
 * Each bar = one event from agent turns (text, tool call, thinking).
 * Direction: reads/inputs extend UP from center, writes/outputs extend DOWN.
 * Color  = event type (read=blue, write=dark blue, tool=indigo, error=red, text=gray).
 * Height = proportional to content length relative to largest event.
 * Width  = uniform 10px per bar.
 *
 * Interactions: drag scroll, mouse wheel, auto-scroll to latest, hover tooltip,
 * click to scroll transcript to that event's turn.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useAppState } from "../state/store";
import type { Turn, TurnEvent, ToolCallEvent } from "../state/turns";

// ── Constants ────────────────────────────────────────────────────────────

const BAR_W = 10;
const GAP = 1;
const MAX_H = 20; // max height per direction (total height = 2 * MAX_H)
const MIN_H = 4;
const TOTAL_H = MAX_H * 2 + 2; // +2 for center line breathing room

// ── Types ────────────────────────────────────────────────────────────────

interface WaveformBar {
  color: string;
  tip: string;
  height: number; // 0-1 normalized
  direction: "up" | "down";
  turnId: string;
  timestamp: number;
}

// ── Color palette ────────────────────────────────────────────────────────

const palette = {
  text: "color-mix(in srgb, var(--vscode-descriptionForeground) 60%, transparent)",
  reasoning: "color-mix(in srgb, var(--vscode-editorInfo-foreground, #7eb6ff) 50%, transparent)",
  read: "color-mix(in srgb, var(--vscode-textLink-foreground) 75%, transparent)",
  write: "color-mix(in srgb, var(--vscode-editorGutter-addedBackground, #4ec9b0) 70%, transparent)",
  tool: "color-mix(in srgb, var(--vscode-activityBarBadge-background) 65%, transparent)",
  error: "color-mix(in srgb, var(--vscode-errorForeground) 70%, transparent)",
  user: "color-mix(in srgb, var(--vscode-editor-findMatchHighlightBackground, #ea5c00) 60%, transparent)",
};

// ── Classification ───────────────────────────────────────────────────────

const READ_TOOLS = new Set(["read", "read_file", "search", "search_files", "find", "glob", "grep", "ast_grep", "lsp", "web_search",
  "vscode_get_editor_state", "vscode_get_selection", "vscode_get_diagnostics", "vscode_get_document_symbols",
  "vscode_get_definitions", "vscode_get_references", "vscode_get_hover", "vscode_get_open_editors",
  "vscode_get_workspace_folders", "vscode_get_code_actions", "vscode_get_workspace_symbols",
  "vscode_get_notifications", "vscode_get_latest_selection", "vscode_get_type_definitions",
  "vscode_get_implementations", "vscode_get_declarations", "vscode_check_document_dirty"]);

const WRITE_TOOLS = new Set(["edit", "edit_file", "write", "write_to_file", "create_file", "apply_diff",
  "replace_in_file", "bash", "execute_command", "vscode_apply_workspace_edit",
  "vscode_execute_code_action", "vscode_format_document", "vscode_format_range", "vscode_save_document"]);

function classifyEvent(event: TurnEvent): { color: string; tip: string; direction: "up" | "down"; size: number } {
  switch (event.kind) {
    case "text":
      return { color: palette.text, tip: "Text", direction: "down", size: event.content.length };
    case "thinking":
      return { color: palette.reasoning, tip: "Reasoning", direction: "up", size: event.content.length };
    case "tool_call": {
      const tc = event as ToolCallEvent;
      const name = tc.toolName;
      if (tc.status === "error" || tc.isError) {
        return { color: palette.error, tip: `${name} (error)`, direction: "down", size: 50 };
      }
      if (READ_TOOLS.has(name)) {
        return { color: palette.read, tip: name, direction: "up", size: contentSize(tc) };
      }
      if (WRITE_TOOLS.has(name)) {
        return { color: palette.write, tip: name, direction: "down", size: contentSize(tc) };
      }
      return { color: palette.tool, tip: name, direction: "up", size: contentSize(tc) };
    }
    case "error":
      return { color: palette.error, tip: "Error", direction: "down", size: event.message.length };
    case "compaction":
      return { color: palette.reasoning, tip: "Compaction", direction: "up", size: 30 };
    case "retry":
      return { color: palette.error, tip: "Retry", direction: "down", size: 20 };
    default:
      return { color: palette.text, tip: "Event", direction: "down", size: 10 };
  }
}

function contentSize(tc: ToolCallEvent): number {
  const argsLen = tc.args ? JSON.stringify(tc.args).length : 10;
  const resultLen = tc.result ? (typeof tc.result === "string" ? tc.result.length : JSON.stringify(tc.result).length) : 0;
  return Math.max(10, argsLen + resultLen);
}

// ── Build bars from turns ────────────────────────────────────────────────

function buildBars(turns: Turn[]): WaveformBar[] {
  const bars: WaveformBar[] = [];
  const raw: { bar: Omit<WaveformBar, "height">; size: number }[] = [];

  for (const turn of turns) {
    if (turn.kind === "user") {
      raw.push({
        bar: { color: palette.user, tip: "User", direction: "up", turnId: turn.id, timestamp: turn.timestamp },
        size: turn.text.length,
      });
      continue;
    }
    if (turn.kind === "agent") {
      for (const event of turn.events) {
        if (event.kind === "tool_result") continue; // skip, already shown via tool_call
        const classified = classifyEvent(event);
        raw.push({
          bar: { color: classified.color, tip: classified.tip, direction: classified.direction, turnId: turn.id, timestamp: turn.timestamp },
          size: classified.size,
        });
      }
    }
  }

  if (raw.length === 0) return bars;

  const maxSize = Math.max(...raw.map((r) => r.size));
  for (const { bar, size } of raw) {
    const normalized = Math.min(1, size / Math.max(1, maxSize));
    bars.push({ ...bar, height: normalized });
  }

  return bars;
}

// ── Component ────────────────────────────────────────────────────────────

export function TaskWaveform({ onScrollToTurn }: { onScrollToTurn?: (turnId: string) => void }) {
  const { turnTranscript, footerRuntime } = useAppState();
  const containerRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<{ text: string; left: number } | null>(null);
  const dragging = useRef(false);
  const didDrag = useRef(false);
  const startX = useRef(0);
  const startScroll = useRef(0);

  const bars = useMemo(() => buildBars(turnTranscript.turns), [turnTranscript.turns]);
  const isStreaming = footerRuntime.state === "streaming" || footerRuntime.state === "tool";

  // Auto-scroll to latest bar
  const prevLen = useRef(0);
  useEffect(() => {
    if (bars.length > prevLen.current && containerRef.current) {
      containerRef.current.scrollLeft = containerRef.current.scrollWidth;
    }
    prevLen.current = bars.length;
  }, [bars.length]);

  // Drag scroll handlers — no pointer capture (it steals clicks from child elements)
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (!containerRef.current) return;
    dragging.current = true;
    didDrag.current = false;
    startX.current = e.clientX;
    startScroll.current = containerRef.current.scrollLeft;
    containerRef.current.style.cursor = "grabbing";
    containerRef.current.style.userSelect = "none";
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current || !containerRef.current) return;
    const dx = Math.abs(e.clientX - startX.current);
    if (dx > 3) didDrag.current = true;
    containerRef.current.scrollLeft = startScroll.current - (e.clientX - startX.current);
  }, []);

  const onPointerUp = useCallback(() => {
    if (!containerRef.current) return;
    dragging.current = false;
    containerRef.current.style.cursor = "grab";
    containerRef.current.style.userSelect = "";
  }, []);

  // Wheel → horizontal scroll
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      el.scrollLeft += e.deltaY || e.deltaX;
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  if (bars.length === 0) return null;

  return (
    <div className="omp-waveform-outer">
      {tooltip && (
        <div className="omp-waveform-tooltip" style={{ left: `${tooltip.left}px` }}>
          {tooltip.text.split("\n").map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}
      <div
        ref={containerRef}
        className="omp-waveform"
        style={{ height: `${TOTAL_H}px` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        {bars.map((bar, i) => {
          const h = Math.round(MIN_H + bar.height * (MAX_H - MIN_H));
          const isLast = i === bars.length - 1;

          return (
            <div
              key={i}
              className="omp-waveform-bar"
              style={{ width: `${BAR_W}px`, height: `${TOTAL_H}px` }}
              onClick={() => { if (!didDrag.current) onScrollToTurn?.(bar.turnId); }}
              onMouseEnter={(e) => {
                const barEl = e.currentTarget;
                const containerEl = containerRef.current;
                if (!containerEl) return;
                const left = barEl.offsetLeft - containerEl.scrollLeft + BAR_W / 2;
                setTooltip({ text: `${bar.tip}\n${formatTime(bar.timestamp)}`, left });
              }}
              onMouseLeave={() => setTooltip(null)}
            >
              <div
                className={`omp-waveform-fill omp-waveform-fill--${bar.direction}${isLast && isStreaming ? " omp-waveform-fill--active" : ""}`}
                style={{
                  background: bar.color,
                  height: `${h}px`,
                }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function formatTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
