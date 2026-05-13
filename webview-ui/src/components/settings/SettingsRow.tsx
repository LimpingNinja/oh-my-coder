import type { ReactNode } from "react";

interface SettingsRowProps {
  title: string;
  description?: string;
  children: ReactNode;
  last?: boolean;
}

export function SettingsRow({ title, description, children, last }: SettingsRowProps) {
  return (
    <div className={`omp-settings-row${last ? " omp-settings-row--last" : ""}`}>
      <div className="omp-settings-row-label">
        <span className="omp-settings-row-title">{title}</span>
        {description && <span className="omp-settings-row-desc">{description}</span>}
      </div>
      <div className="omp-settings-row-control">
        {children}
      </div>
    </div>
  );
}
