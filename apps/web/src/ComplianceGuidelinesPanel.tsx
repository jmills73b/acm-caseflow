import { useEffect, useState } from "react";
import { Icon } from "./icons";
import { getAccountSettings, updateComplianceGuidelines } from "./api";

const DEFAULT_GUIDELINES =
  "Flag anything beyond what's necessary for the letter's purpose (GDPR data minimisation). " +
  "Flag anything that reads as a firm legal or factual assertion rather than a considered position. " +
  "Keep tone professional and clear.";

// Fed into the Correspondence review agent's prompt (routes/letters.ts) --
// deliberately free text the account holder maintains themselves, rather
// than rules this app hard-codes. Nobody but the account holder actually
// knows which regulatory framework applies to their own practice, so this
// app can't assert that for them (see ARCHITECTURE.md's Auth model /
// Correspondence section for the full reasoning).
export function ComplianceGuidelinesPanel() {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getAccountSettings()
      .then((settings) => setText(settings.complianceGuidelines || DEFAULT_GUIDELINES))
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load the compliance guidelines"))
      .finally(() => setLoading(false));
  }, []);

  async function handleSave() {
    setError(null);
    setSaving(true);
    try {
      const updated = await updateComplianceGuidelines(text);
      setText(updated.complianceGuidelines);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the compliance guidelines");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="edit-panel">
      <p className="edit-panel-title">Compliance guidelines</p>
      <p className="hint">
        Used by Correspondence's review step (Admin &amp; Settings → Categories → Letters manages the letter types
        themselves). This is a starting point, not legal advice — correct it to match whichever regulatory framework
        actually applies to your practice before relying on it.
      </p>
      {loading ? (
        <p className="loading">Loading…</p>
      ) : (
        <>
          <label className="edit-field" style={{ marginBottom: 16 }}>
            <span>Guidelines</span>
            <textarea
              rows={5}
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                setSaved(false);
              }}
            />
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {saved && !error && <p className="hint">Saved.</p>}
          <div className="row-actions">
            <button type="button" onClick={handleSave} disabled={saving}>
              <Icon name="save" /> {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
