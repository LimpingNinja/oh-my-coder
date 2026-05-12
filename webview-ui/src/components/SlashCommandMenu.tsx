import React, { useEffect, useRef } from "react";
import type { SlashCommandForWebview } from "../../../src/protocol/webviewMessages";

interface SlashCommandMenuProps {
  visible: boolean;
  commands: SlashCommandForWebview[];
  selectedIndex: number;
  onSelect: (command: SlashCommandForWebview) => void;
}

type DisplayDensity = "compact" | "expanded" | "full";

function getDensity(count: number): DisplayDensity {
  if (count >= 5) return "compact";
  if (count >= 2) return "expanded";
  return "full";
}

function badgeForCommand(command: SlashCommandForWebview): string {
  if (command.source === "runtime") {
    if (command.runtimeMeta?.source === "skill") return "skill";
    if (command.runtimeMeta?.source === "extension") return "ext";
    return "prompt";
  }

  switch (command.tier) {
    case 1:
      return "rpc";
    case 2:
      return "host";
    case 3:
      return "ui";
    case 5:
      return "config";
    case 6:
      return "blocked";
    default:
      return "cmd";
  }
}

interface ItemProps {
  command: SlashCommandForWebview;
  selected: boolean;
  onSelect: () => void;
  activeRef?: React.RefObject<HTMLButtonElement | null>;
}

function CompactItem({ command, selected, onSelect, activeRef }: ItemProps) {
  const blocked = command.route.kind === "blocked";
  const badge = badgeForCommand(command);

  return (
    <button
      ref={selected ? activeRef : undefined}
      type="button"
      className={`slash-menu-item slash-menu-item--compact ${selected ? "selected" : ""} ${blocked ? "blocked" : ""}`}
      onMouseDown={(e) => {
        e.preventDefault();
        onSelect();
      }}
      role="option"
      aria-selected={selected}
      disabled={blocked}
    >
      <span className="slash-menu-name">/{command.name}</span>
      <span className={`slash-menu-badge badge-${badge}`}>{badge}</span>
      <span className="slash-menu-desc slash-menu-desc--truncate">{command.description}</span>
    </button>
  );
}

function ExpandedItem({ command, selected, onSelect, activeRef }: ItemProps) {
  const blocked = command.route.kind === "blocked";
  const badge = badgeForCommand(command);

  return (
    <button
      ref={selected ? activeRef : undefined}
      type="button"
      className={`slash-menu-item slash-menu-item--expanded ${selected ? "selected" : ""} ${blocked ? "blocked" : ""}`}
      onMouseDown={(e) => {
        e.preventDefault();
        onSelect();
      }}
      role="option"
      aria-selected={selected}
      disabled={blocked}
    >
      <div className="slash-menu-item-header">
        <span className="slash-menu-name">/{command.name}</span>
        <span className={`slash-menu-badge badge-${badge}`}>{badge}</span>
      </div>
      <span className="slash-menu-desc slash-menu-desc--full">{command.description}</span>
      {command.inlineHint && <span className="slash-menu-hint">Args: {command.inlineHint}</span>}
    </button>
  );
}

function FullDetailItem({ command, selected, onSelect, activeRef }: ItemProps) {
  const blocked = command.route.kind === "blocked";
  const badge = badgeForCommand(command);

  return (
    <button
      ref={selected ? activeRef : undefined}
      type="button"
      className={`slash-menu-item slash-menu-item--full ${selected ? "selected" : ""} ${blocked ? "blocked" : ""}`}
      onMouseDown={(e) => {
        e.preventDefault();
        onSelect();
      }}
      role="option"
      aria-selected={selected}
      disabled={blocked}
    >
      <div className="slash-menu-item-header">
        <span className="slash-menu-name">/{command.name}</span>
        <span className={`slash-menu-badge badge-${badge}`}>{badge}</span>
      </div>
      <p className="slash-menu-desc slash-menu-desc--detail">{command.description}</p>
      {command.inlineHint && (
        <div className="slash-menu-args">
          <span className="slash-menu-args-label">Args:</span>
          <code className="slash-menu-args-value">{command.inlineHint}</code>
        </div>
      )}
      {command.subcommands && command.subcommands.length > 0 && (
        <div className="slash-menu-subcommands">
          {command.subcommands.map((sub) => (
            <span key={sub.name} className="slash-menu-sub">
              {sub.name}
              {sub.usage ? ` ${sub.usage}` : ""}
            </span>
          ))}
        </div>
      )}
      {command.runtimeMeta?.path && <span className="slash-menu-source">{command.runtimeMeta.path}</span>}
    </button>
  );
}

export function SlashCommandMenu({
  visible,
  commands,
  selectedIndex,
  onSelect,
}: SlashCommandMenuProps): React.JSX.Element | null {
  const containerRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, commands]);

  if (!visible || commands.length === 0) {
    return null;
  }

  const density = getDensity(commands.length);

  return (
    <div
      ref={containerRef}
      className={`slash-menu slash-menu--${density}`}
      role="listbox"
      aria-label="Slash commands"
    >
      {commands.map((command, index) => {
        const selected = index === selectedIndex;
        const itemProps: ItemProps = {
          command,
          selected,
          onSelect: () => onSelect(command),
          activeRef,
        };

        switch (density) {
          case "compact":
            return <CompactItem key={command.name} {...itemProps} />;
          case "expanded":
            return <ExpandedItem key={command.name} {...itemProps} />;
          case "full":
            return <FullDetailItem key={command.name} {...itemProps} />;
        }
      })}
    </div>
  );
}

export default SlashCommandMenu;
