import { useState, useRef, useEffect, type ReactNode } from "react";

interface PillPopoverProps {
  trigger: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * A pill button that shows a popover above it on hover.
 * Popover appears above the pill, centered horizontally.
 */
export function PillPopover({ trigger, children, className }: PillPopoverProps) {
  const [visible, setVisible] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const show = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setVisible(true);
  };

  const hide = () => {
    timeoutRef.current = setTimeout(() => setVisible(false), 150);
  };

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className={`omp-pill-popover-wrap ${className ?? ""}`}
      onMouseEnter={show}
      onMouseLeave={hide}
    >
      {trigger}
      {visible && (
        <div className="omp-pill-popover" onMouseEnter={show} onMouseLeave={hide}>
          {children}
        </div>
      )}
    </div>
  );
}
