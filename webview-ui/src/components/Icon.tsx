/**
 * Codicon icon component.
 * Uses the @vscode/codicons font loaded via CSS.
 * See: https://microsoft.github.io/vscode-codicons/dist/codicon.html
 */

interface IconProps {
  name: string;
  className?: string;
  title?: string;
}

export function Icon({ name, className = "", title }: IconProps) {
  return <i className={`codicon codicon-${name} ${className}`.trim()} title={title} />;
}
