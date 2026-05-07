/**
 * Renders text with file paths made clickable.
 */

import { parseFilePaths, openFileInEditor } from "../utils/resultParser";

interface ClickableTextProps {
  text: string;
  className?: string;
}

export function ClickableText({ text, className }: ClickableTextProps) {
  const segments = parseFilePaths(text);

  // If no paths detected, render plain
  if (segments.length === 1 && segments[0]!.type === "text") {
    return <span className={className}>{text}</span>;
  }

  return (
    <span className={className}>
      {segments.map((seg, i) =>
        seg.type === "path" ? (
          <a
            key={i}
            className="omp-file-link"
            href="#"
            onClick={(e) => {
              e.preventDefault();
              openFileInEditor(seg.value);
            }}
            title={`Open ${seg.value}`}
          >
            {seg.display}
          </a>
        ) : (
          <span key={i}>{seg.value}</span>
        ),
      )}
    </span>
  );
}
