import { useSettings } from "./SettingsContext";

export function SaveBar() {
  const { isDirty, save, discard, error, conflict, resolveConflict } = useSettings();

  if (!isDirty && !error && !conflict) return null;

  return (
    <div className="omp-settings-savebar">
      {error && <span className="omp-settings-savebar-error">{error}</span>}
      {conflict && (
        <span className="omp-settings-savebar-conflict">Config changed externally</span>
      )}
      <div className="omp-settings-savebar-actions">
        {conflict ? (
          <>
            <button className="omp-settings-savebar-discard" onClick={() => resolveConflict("reload")}>Reload</button>
            <button className="omp-settings-savebar-save" onClick={() => resolveConflict("keep")}>Keep Mine</button>
          </>
        ) : (
          <>
            <button className="omp-settings-savebar-discard" onClick={discard}>Discard</button>
            <button className="omp-settings-savebar-save" onClick={save}>Save</button>
          </>
        )}
      </div>
    </div>
  );
}
