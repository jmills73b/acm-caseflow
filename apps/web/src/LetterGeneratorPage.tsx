import { useEffect, useState, type FormEvent } from "react";
import { Icon } from "./icons";
import {
  addLetter,
  chatDraftLetter,
  deleteLetter,
  getClients,
  getLetters,
  reviewLetter,
  type ChatMessage,
  type Client,
  type Letter,
  type ReviewLetterResult,
} from "./api";

// A fixed small set rather than a per-letter-type field schema -- keeps
// the app from ever needing a form-builder for this. Every one of these
// only ever reaches the drafting agent as a token name (e.g.
// "CLIENT_NAME"), never the real value -- see chatDraftLetter's doc
// comment in api.ts and ARCHITECTURE.md's Correspondence section. This is
// the one piece of setup that stays structured even though everything
// else (letter type, facts, tone) now flows through the conversation --
// it's the safety mechanism, not a fact to discuss.
const PERSONAL_FIELD_OPTIONS: Array<{ token: string; label: string }> = [
  { token: "CLIENT_NAME", label: "Client name" },
  { token: "CLIENT_ADDRESS", label: "Postal address" },
  { token: "YOUR_NAME", label: "Your sign-off name" },
];

// Renders {{TOKEN}} placeholders as visually distinct badges wherever
// they appear in a message, so a token reads as "not a real value yet"
// the same way it does in the setup checklist above.
function renderWithTokens(text: string) {
  const parts = text.split(/(\{\{[A-Z0-9_]+\}\})/g);
  return parts.map((part, i) =>
    /^\{\{[A-Z0-9_]+\}\}$/.test(part) ? (
      <span className="token" key={i}>
        {part}
      </span>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

export function LetterGeneratorPage({ onBack }: { onBack: () => void }) {
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [clientId, setClientId] = useState<number | "">("");
  const [letterType, setLetterType] = useState("");
  const [personalFields, setPersonalFields] = useState<string[]>(PERSONAL_FIELD_OPTIONS.map((f) => f.token));

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [sending, setSending] = useState(false);

  const [review, setReview] = useState<ReviewLetterResult | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [history, setHistory] = useState<Letter[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  useEffect(() => {
    getClients()
      .then(setClients)
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

  const lastAssistantMessage = [...messages].reverse().find((m) => m.role === "assistant") ?? null;

  function togglePersonalField(token: string) {
    setPersonalFields((prev) => (prev.includes(token) ? prev.filter((f) => f !== token) : [...prev, token]));
  }

  function startOver() {
    setMessages([]);
    setChatInput("");
    setReview(null);
    setSaved(false);
    setError(null);
  }

  async function handleStart() {
    if (clientId === "") {
      setError("Choose a client first");
      return;
    }
    if (!letterType.trim()) {
      setError("Describe the kind of letter you need");
      return;
    }

    setError(null);
    const kickoff: ChatMessage = { role: "user", content: `I need to write: ${letterType.trim()}` };
    setSending(true);
    try {
      const result = await chatDraftLetter({ letterType: letterType.trim(), personalFields, messages: [kickoff] });
      setMessages([kickoff, { role: "assistant", content: result.reply }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't reach the drafting agent");
    } finally {
      setSending(false);
    }
  }

  async function handleSend(event: FormEvent) {
    event.preventDefault();
    const text = chatInput.trim();
    if (!text) return;

    const userMessage: ChatMessage = { role: "user", content: text };
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setChatInput("");
    setError(null);
    setSending(true);
    try {
      const result = await chatDraftLetter({ letterType: letterType.trim(), personalFields, messages: nextMessages });
      setMessages([...nextMessages, { role: "assistant", content: result.reply }]);
      setReview(null);
      setSaved(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't reach the drafting agent");
      setMessages(messages);
      setChatInput(text);
    } finally {
      setSending(false);
    }
  }

  async function handleReview() {
    if (!lastAssistantMessage) return;
    setError(null);
    setReviewing(true);
    try {
      setReview(await reviewLetter(lastAssistantMessage.content));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't review the letter");
    } finally {
      setReviewing(false);
    }
  }

  async function handleSave() {
    if (clientId === "" || !lastAssistantMessage) return;
    setError(null);
    setSaving(true);
    try {
      await addLetter({
        clientId,
        letterType: letterType.trim(),
        personalFields,
        draftBody: lastAssistantMessage.content,
        reviewFlags: review?.flags ?? null,
        piiScanClean: review?.piiScanClean ?? null,
      });
      setSaved(true);
      startOver();
      setLetterType("");
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

  const inConversation = messages.length > 0;

  return (
    <>
      <button type="button" className="back-link" onClick={onBack}>
        <Icon name="back" /> Dashboard
      </button>
      <h1>Correspondence</h1>
      <p className="hint">
        Draft a letter through a conversation with the drafting agent, then send it for a compliance and
        personal-data review before you use it. Personal details are never sent to the AI — the letter always uses
        placeholders, filled in afterward outside the system.
      </p>

      {loadError && (
        <p className="error" role="alert">
          {loadError}
        </p>
      )}

      <p className="settings-section-title">1. Who this is for, and what kind of letter</p>
      <div className="edit-panel">
        <div className="edit-row" style={{ marginBottom: 16 }}>
          <label className="edit-field">
            <span>Client</span>
            <select
              className="input-compact"
              value={clientId}
              disabled={inConversation}
              onChange={(event) => setClientId(event.target.value ? Number(event.target.value) : "")}
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
        <label className="edit-field">
          <span>Letter type</span>
          <input
            className="input-compact"
            value={letterType}
            disabled={inConversation}
            onChange={(event) => setLetterType(event.target.value)}
            placeholder="e.g. Fee estimate cover letter for the ancillary relief matter"
          />
        </label>
      </div>

      <p className="settings-section-title">2. Personal details — always placeholders</p>
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
        The real name and address never leave your database and never reach the AI — only the token does, for the
        whole conversation below.
      </p>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {!inConversation ? (
        <div className="row-actions" style={{ marginBottom: 36 }}>
          <button type="button" onClick={handleStart} disabled={sending}>
            <Icon name="add" /> {sending ? "Starting…" : "Start drafting"}
          </button>
        </div>
      ) : (
        <>
          <p className="settings-section-title">3. Draft it together</p>
          <div className="edit-panel chat-transcript">
            {messages.map((message, i) => (
              <div className={`chat-message chat-message-${message.role}`} key={i}>
                <div className="chat-bubble">{renderWithTokens(message.content)}</div>
              </div>
            ))}
            {sending && (
              <div className="chat-message chat-message-assistant">
                <div className="chat-bubble chat-bubble-pending">Thinking…</div>
              </div>
            )}
          </div>

          <form onSubmit={handleSend} className="chat-input-row">
            <textarea
              rows={2}
              value={chatInput}
              onChange={(event) => setChatInput(event.target.value)}
              placeholder="Reply to the drafting agent…"
              disabled={sending}
            />
            <button type="submit" disabled={sending || !chatInput.trim()}>
              <Icon name="add" /> Send
            </button>
          </form>

          <div className="row-actions" style={{ margin: "16px 0 36px" }}>
            <button
              type="button"
              className="secondary"
              onClick={handleReview}
              disabled={!lastAssistantMessage || reviewing}
            >
              <Icon name="tag" /> {reviewing ? "Reviewing…" : "Send to review"}
            </button>
            <button type="button" className="secondary" onClick={startOver}>
              Start over
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
                    Ask the agent to fix it before saving.
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
            <button type="button" onClick={handleSave} disabled={!lastAssistantMessage || saving}>
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
                      <td>{letter.letterType ?? "—"}</td>
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
