import { useSettings } from "./SettingsContext";

export function SaveBar() {
  const { isDirty, save, discard, error } = useSettings();
  if (!isDirty && !error) return null;
  return (
    <div className="omp-settings-savebar">
      {error && <span className="omp-settings-savebar-error">{error}</span>}
      <div className="omp-settings-savebar-actions">
        <button className="omp-settings-savebar-discard" onClick={discard}>Discard</button>
        <button className="omp-settings-savebar-save" onClick={save}>Save</button>
      </div>
    </div>
  );
}
