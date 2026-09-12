import { useEffect, useState } from "react";
import { Icon } from "./icons";
import { AI_MODEL_OPTIONS, getAccountSettings, updateAiModel, updateComplianceGuidelines } from "./api";

const DEFAULT_GUIDELINES =
  "Flag anything beyond what's necessary for the letter's purpose (GDPR data minimisation). " +
  "Flag anything that reads as a firm legal or factual assertion rather than a considered position. " +
  "Keep tone professional and clear.";

// Both settings here feed Correspondence's drafting/review agents
// (routes/letters.ts) -- the model choice applies to both agents at once
// (see getAccountAiSettings there), and the guidelines are deliberately
// free text the account holder maintains themselves, rather than rules
// this app hard-codes. Nobody but the account holder actually knows which
// regulatory framework applies to their own practice, so this app can't
// assert that for them (see ARCHITECTURE.md's Correspondence section for
// the full reasoning).
export function AiSettingsPanel() {
  const [aiModel, setAiModel] = useState("");
  const [savingModel, setSavingModel] = useState(false);
  const [modelSaved, setModelSaved] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);

  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getAccountSettings()
      .then((settings) => {
        setText(settings.complianceGuidelines || DEFAULT_GUIDELINES);
        setAiModel(settings.aiModel);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load the AI settings"))
      .finally(() => setLoading(false));
  }, []);

  async function handleModelChange(nextModel: string) {
    setAiModel(nextModel);
    setModelError(null);
    setModelSaved(false);
    setSavingModel(true);
    try {
      await updateAiModel(nextModel);
      setModelSaved(true);
    } catch (err) {
      setModelError(err instanceof Error ? err.message : "Couldn't save the model choice");
    } finally {
      setSavingModel(false);
    }
  }

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

  if (loading) return <p className="loading">Loading…</p>;

  return (
    <>
      <div className="edit-panel" style={{ marginBottom: 24 }}>
        <p className="edit-panel-title">Model</p>
        <p className="hint">
          Used by both of Correspondence's agents — drafting and the supervising-solicitor-style review. A more
          capable model costs more per letter; see Usage below for what this has spent so far.
        </p>
        <label className="edit-field" style={{ marginBottom: 16 }}>
          <span>Model</span>
          <select
            className="input-compact"
            value={aiModel}
            disabled={savingModel}
            onChange={(event) => handleModelChange(event.target.value)}
          >
            {AI_MODEL_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {modelError && (
          <p className="error" role="alert">
            {modelError}
          </p>
        )}
        {modelSaved && !modelError && <p className="hint">Saved.</p>}
      </div>

      <div className="edit-panel">
        <p className="edit-panel-title">Compliance guidelines</p>
        <p className="hint">
          Used by Correspondence's review step. This is a starting point, not legal advice — correct it to match
          whichever regulatory framework actually applies to your practice before relying on it.
        </p>
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
      </div>
    </>
  );
}
