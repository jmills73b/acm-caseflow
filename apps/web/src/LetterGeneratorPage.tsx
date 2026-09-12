import { useEffect, useState } from "react";
import { Icon } from "./icons";
import {
  addLetter,
  deleteLetter,
  draftLetter,
  getClients,
  getLetterCategories,
  getLetters,
  reviewLetter,
  type Client,
  type Letter,
  type LetterCategory,
  type ReviewLetterResult,
} from "./api";

const TONE_OPTIONS = ["Firm", "Reassuring", "Neutral", "Friendly"];

// A fixed small set rather than a per-letter-type field schema -- keeps
// the app from ever needing a form-builder for this. Every one of these
// only ever reaches the drafting agent as a token name (e.g.
// "CLIENT_NAME"), never the real value -- see draftLetter's doc comment
// in api.ts and ARCHITECTURE.md's Correspondence section.
const PERSONAL_FIELD_OPTIONS: Array<{ token: string; label: string }> = [
  { token: "CLIENT_NAME", label: "Client name" },
  { token: "CLIENT_ADDRESS", label: "Postal address" },
  { token: "YOUR_NAME", label: "Your sign-off name" },
];

export function LetterGeneratorPage({ onBack }: { onBack: () => void }) {
  const [clients, setClients] = useState<Client[]>([]);
  const [categories, setCategories] = useState<LetterCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [clientId, setClientId] = useState<number | "">("");
  const [categoryId, setCategoryId] = useState<number | "">("");
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [keyDate, setKeyDate] = useState("");
  const [tone, setTone] = useState<string>(TONE_OPTIONS[0] ?? "Firm");
  const [personalFields, setPersonalFields] = useState<string[]>(PERSONAL_FIELD_OPTIONS.map((f) => f.token));
  const [bespokeRequest, setBespokeRequest] = useState("");

  const [draftBody, setDraftBody] = useState<string | null>(null);
  const [review, setReview] = useState<ReviewLetterResult | null>(null);
  const [generating, setGenerating] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [history, setHistory] = useState<Letter[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  useEffect(() => {
    Promise.all([getClients(), getLetterCategories()])
      .then(([clientRows, categoryRows]) => {
        setClients(clientRows);
        setCategories(categoryRows);
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Couldn't load Correspondence"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (clientId === "") {
      setHistory([]);
      return;
    }
    setHistoryLoading(true);
    getLetters(clientId)
      .then(setHistory)
      .catch(() => setHistory([]))
      .finally(() => setHistoryLoading(false));
  }, [clientId]);

  function togglePersonalField(token: string) {
    setPersonalFields((prev) => (prev.includes(token) ? prev.filter((f) => f !== token) : [...prev, token]));
  }

  function resetDraft() {
    setDraftBody(null);
    setReview(null);
    setSaved(false);
  }

  async function handleGenerate() {
    if (clientId === "") {
      setError("Choose a client first");
      return;
    }

    setError(null);
    setSaved(false);
    setGenerating(true);
    try {
      const result = await draftLetter({
        clientId,
        letterCategoryId: categoryId === "" ? null : categoryId,
        amount: amount ? Number(amount) : null,
        reference: reference || null,
        keyDate: keyDate || null,
        tone,
        personalFields,
        bespokeRequest: bespokeRequest || null,
      });
      setDraftBody(result.draftBody);
      setReview(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't draft the letter");
    } finally {
      setGenerating(false);
    }
  }

  async function handleReview() {
    if (!draftBody) return;
    setError(null);
    setReviewing(true);
    try {
      setReview(await reviewLetter(draftBody));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't review the letter");
    } finally {
      setReviewing(false);
    }
  }

  async function handleSave() {
    if (clientId === "" || !draftBody) return;
    setError(null);
    setSaving(true);
    try {
      await addLetter({
        clientId,
        letterCategoryId: categoryId === "" ? null : categoryId,
        amount: amount ? Number(amount) : null,
        reference: reference || null,
        keyDate: keyDate || null,
        tone,
        personalFields,
        bespokeRequest: bespokeRequest || null,
        draftBody,
        reviewFlags: review?.flags ?? null,
        piiScanClean: review?.piiScanClean ?? null,
      });
      setSaved(true);
      resetDraft();
      setHistory(await getLetters(clientId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the letter");
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteHistory(id: number) {
    const confirmed = window.confirm("Delete this saved letter? It moves to Deleted letters, not removed outright.");
    if (!confirmed) return;
    try {
      await deleteLetter(id);
      setHistory((prev) => prev.filter((l) => l.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't delete that letter");
    }
  }

  if (loading) return <p className="loading">Loading…</p>;

  return (
    <>
      <button type="button" className="back-link" onClick={onBack}>
        <Icon name="back" /> Dashboard
      </button>
      <h1>Correspondence</h1>
      <p className="hint">
        Drafts a letter, then reviews it for compliance and personal data before you send anything. Personal details
        are never sent to the AI — the letter always uses placeholders, filled in afterward outside the system.
      </p>

      {loadError && (
        <p className="error" role="alert">
          {loadError}
        </p>
      )}

      <p className="settings-section-title">1. Who this is for, and what kind of letter</p>
      <div className="edit-panel">
        <div className="edit-row" style={{ marginBottom: 18 }}>
          <label className="edit-field">
            <span>Client</span>
            <select
              className="input-compact"
              value={clientId}
              onChange={(event) => {
                setClientId(event.target.value ? Number(event.target.value) : "");
                resetDraft();
              }}
            >
              <option value="">Choose a client…</option>
              <optgroup label="Active / prospective">
                {clients
                  .filter((c) => c.caseStatus !== "Closed")
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </optgroup>
              <optgroup label="Closed">
                {clients
                  .filter((c) => c.caseStatus === "Closed")
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </optgroup>
            </select>
          </label>
        </div>
        <span className="field-label">Letter type</span>
        <div className="chip-group">
          {categories.map((cat) => (
            <span
              key={cat.id}
              role="button"
              tabIndex={0}
              className={`chip ${categoryId === cat.id ? "active" : ""}`}
              onClick={() => setCategoryId(cat.id)}
            >
              {cat.name}
            </span>
          ))}
        </div>
        {categories.length === 0 && (
          <p className="hint" style={{ margin: "10px 0 0" }}>
            No letter types yet — add one under Admin &amp; Settings → Categories → Letters.
          </p>
        )}
      </div>

      <p className="settings-section-title">2. The facts</p>
      <div className="edit-panel">
        <div className="edit-row">
          <label className="edit-field">
            <span>Amount (£)</span>
            <input
              className="input-compact"
              type="number"
              inputMode="decimal"
              step="0.01"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          </label>
          <label className="edit-field">
            <span>Reference</span>
            <input className="input-compact" value={reference} onChange={(event) => setReference(event.target.value)} />
          </label>
          <label className="edit-field">
            <span>Key date</span>
            <input
              className="input-compact"
              type="date"
              value={keyDate}
              onChange={(event) => setKeyDate(event.target.value)}
            />
          </label>
        </div>
        <span className="field-label" style={{ marginTop: 12, display: "block" }}>
          Tone
        </span>
        <div className="chip-group">
          {TONE_OPTIONS.map((option) => (
            <span
              key={option}
              role="button"
              tabIndex={0}
              className={`chip ${tone === option ? "active" : ""}`}
              onClick={() => setTone(option)}
            >
              {option}
            </span>
          ))}
        </div>
      </div>

      <p className="settings-section-title">3. Personal details — always placeholders</p>
      <div className="edit-panel">
        <div className="token-checklist">
          {PERSONAL_FIELD_OPTIONS.map((field) => (
            <label className="token-row" key={field.token}>
              <input
                type="checkbox"
                checked={personalFields.includes(field.token)}
                onChange={() => togglePersonalField(field.token)}
              />
              <span className="field-name">{field.label}</span>
              <span className="arrow">→</span>
              <span className="token">{`{{${field.token}}}`}</span>
            </label>
          ))}
        </div>
      </div>
      <p className="panel-note">
        The real name and address never leave your database and never reach the AI — only the token does.
      </p>

      <p className="settings-section-title">4. Anything specific to add?</p>
      <div className="edit-panel">
        <textarea
          rows={3}
          value={bespokeRequest}
          onChange={(event) => setBespokeRequest(event.target.value)}
          placeholder="Anything this letter needs that the guided fields above don't cover."
        />
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="row-actions" style={{ marginBottom: 36 }}>
        <button type="button" onClick={handleGenerate} disabled={generating || clientId === ""}>
          <Icon name="add" /> {generating ? "Drafting…" : draftBody ? "Regenerate" : "Generate draft"}
        </button>
      </div>

      {draftBody && (
        <>
          <p className="settings-section-title">Draft</p>
          <div className="edit-panel">
            <textarea rows={12} value={draftBody} onChange={(event) => setDraftBody(event.target.value)} />
          </div>

          <div className="row-actions" style={{ marginBottom: 20 }}>
            <button type="button" className="secondary" onClick={handleReview} disabled={reviewing}>
              <Icon name="tag" /> {reviewing ? "Reviewing…" : "Run compliance review"}
            </button>
          </div>

          {review && (
            <>
              <p className="settings-section-title">Compliance &amp; privacy review</p>
              <div className="edit-panel">
                <div style={{ marginBottom: review.flags.length > 0 ? 14 : 0 }}>
                  <span className={`status ${review.piiScanClean ? "status-complete" : ""}`}>
                    Personal-data scan: {review.piiScanClean ? "clear" : "check needed"}
                  </span>
                </div>
                {!review.piiScanClean && (
                  <p className="error" role="alert">
                    Possible personal data found outside the placeholder tokens
                    {review.piiMatches.length > 0 ? `: ${review.piiMatches.map((m) => m.kind).join(", ")}` : ""}.
                    Edit the draft above before saving.
                  </p>
                )}
                {!review.reviewConfigured && (
                  <p className="hint">
                    Advisory compliance review isn't configured yet (needs an Anthropic API key) — the personal-data
                    scan above still ran.
                  </p>
                )}
                {review.flags.length > 0 && (
                  <ul className="review-list">
                    {review.flags.map((flag, i) => (
                      <li className="review-item" key={i}>
                        <span className={`review-dot ${flag.severity === "concern" ? "warn" : ""}`} />
                        <span>{flag.text}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <p className="panel-note">Advisory, not a gate — you decide what to act on.</p>
            </>
          )}

          <div className="row-actions" style={{ marginBottom: 40 }}>
            <button type="button" onClick={handleSave} disabled={saving}>
              <Icon name="save" /> {saving ? "Saving…" : "Save to history"}
            </button>
          </div>
          {saved && <p className="hint">Saved.</p>}
        </>
      )}

      {clientId !== "" && (
        <>
          <p className="settings-section-title">
            Correspondence history — {clients.find((c) => c.id === clientId)?.name ?? ""}
          </p>
          {historyLoading ? (
            <p className="loading">Loading…</p>
          ) : history.length === 0 ? (
            <p className="empty">No letters saved for this client yet.</p>
          ) : (
            <div className="table-scroll">
              <table className="ledger">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Type</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((letter) => (
                    <tr key={letter.id}>
                      <td>{new Date(letter.createdAt).toLocaleDateString("en-GB")}</td>
                      <td>{letter.categoryName ?? "—"}</td>
                      <td>
                        <div className="row-actions">
                          <button type="button" className="danger" onClick={() => handleDeleteHistory(letter.id)}>
                            <Icon name="delete" /> Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}
