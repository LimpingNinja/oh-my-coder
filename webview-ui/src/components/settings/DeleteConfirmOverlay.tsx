interface DeleteConfirmOverlayProps {
  type: string;
  name: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export function DeleteConfirmOverlay({ type, name, onCancel, onConfirm }: DeleteConfirmOverlayProps) {
  return (
    <div className="omp-session-delete-overlay" style={{ position: "fixed" }} role="dialog" aria-modal="true" aria-label={`Delete ${type} confirmation`}>
      <div className="omp-session-delete-card">
        <div className="omp-session-delete-icon">
          <i className="codicon codicon-trash" />
        </div>
        <div className="omp-session-delete-title">Delete this {type}?</div>
        <div className="omp-session-delete-message">
          This will permanently remove <span>{name}</span>.
        </div>
        <div className="omp-session-delete-actions">
          <button className="omp-session-delete-cancel" onClick={onCancel}>Cancel</button>
          <button className="omp-session-delete-confirm" onClick={onConfirm}>Yes, delete</button>
        </div>
      </div>
    </div>
  );
}
