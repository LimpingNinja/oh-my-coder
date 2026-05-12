import { useEffect, useRef } from "react";
import { getVSCodeAPI } from "../vscode";

interface RoleSelectorProps {
  open: boolean;
  onClose: () => void;
  currentRole?: string;
  availableRoles: string[];
}

export function RoleSelector({ open, onClose, currentRole, availableRoles }: RoleSelectorProps) {
  const vscode = getVSCodeAPI();
  const firstOptionRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => firstOptionRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  if (!open) return null;

  const handleSelect = (role: string) => {
    vscode.postMessage({ type: "runtime.setRole", role });
    onClose();
  };

  return (
    <>
      <div className="omp-send-popup-backdrop" onClick={onClose} />
      <div className="omp-role-selector">
        {availableRoles.map((role, idx) => {
          const isActive = currentRole === role;
          return (
            <button
              ref={idx === 0 ? firstOptionRef : undefined}
              key={role}
              className={`omp-role-selector-item ${isActive ? "omp-role-selector-item--active" : ""}`}
              onClick={() => handleSelect(role)}
            >
              <span className="omp-role-selector-label">{role}</span>
              {isActive && <i className="codicon codicon-check" />}
            </button>
          );
        })}
      </div>
    </>
  );
}
