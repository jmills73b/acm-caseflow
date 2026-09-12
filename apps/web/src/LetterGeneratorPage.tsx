import { useEffect, useState, type FormEvent } from "react";
import { Icon } from "./icons";
import { downloadBlob, generateLetterDocx, generateLetterPdf } from "./letterExport";
import {
  addLetter,
  chatDraftLetter,
  deleteLetter,
  getClients,
  getDocumentCategories,
  getLetters,
  reviewLetter,
  updateLetter,
  uploadDocument,
  type ChatMessage,
  type Client,
  type DocumentCategory,
  type Letter,
  type LetterFormat,
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

const FORMAT_LABELS: Record<LetterFormat, string> = { letter: "Letter", email: "Email" };

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

function exportFilename(letterType: string | null, clientName: string, extension: string): string {
  const base = `${letterType?.trim() || "Letter"} - ${clientName}`.replace(/[/\\:*?"<>|]/g, "-").slice(0, 120);
  return `${base}.${extension}`;
}

// Shared by the live draft's export row and the "view a saved letter"
// panel below -- same two questions either way: which file format, and
// whether a copy also belongs in Documents (case file) or is just a
// download.
function ExportControls({
  clientId,
  clientName,
  letterType,
  body,
  categories,
}: {
  clientId: number;
  clientName: string;
  letterType: string | null;
  body: string;
  categories: DocumentCategory[];
}) {
  const [fileFormat, setFileFormat] = useState<"docx" | "pdf">("docx");
  const [saveToDocuments, setSaveToDocuments] = useState(false);
  const [categoryId, setCategoryId] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exported, setExported] = useState(false);
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setExportError("Couldn't copy to clipboard");
    }
  }

  async function handleExport() {
    setExportError(null);
    setExported(false);
    setExporting(true);
    try {
      const filename = exportFilename(letterType, clientName, fileFormat);
      let file: File;
      if (fileFormat === "docx") {
        const blob = await generateLetterDocx(body);
        file = new File([blob], filename, { type: blob.type });
      } else {
        const bytes = await generateLetterPdf(body);
        file = new File([bytes as Uint8Array<ArrayBuffer>], filename, { type: "application/pdf" });
      }
      downloadBlob(file, filename);
      if (saveToDocuments) {
        await uploadDocument({
          clientId,
          categoryId: categoryId ? Number(categoryId) : null,
          direction: "outbound",
          file,
        });
      }
      setExported(true);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "Couldn't export the letter");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="edit-panel">
      <p className="edit-panel-title">Export</p>
      <div className="edit-row" style={{ marginBottom: 16 }}>
        <label className="edit-field">
          <span>File format</span>
          <select className="input-compact" value={fileFormat} onChange={(event) => setFileFormat(event.target.value as "docx" | "pdf")}>
            <option value="docx">Word (.docx)</option>
            <option value="pdf">PDF</option>
          </select>
        </label>
      </div>
      <label className="token-row" style={{ marginBottom: saveToDocuments ? 12 : 0 }}>
        <input type="checkbox" checked={saveToDocuments} onChange={(event) => setSaveToDocuments(event.target.checked)} />
        <span className="field-name">Also save this file to Documents</span>
      </label>
      {saveToDocuments && (
        <label className="edit-field" style={{ marginBottom: 16, maxWidth: 260 }}>
          <span>Category</span>
          <select className="input-compact" value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
            <option value="">Uncategorised</option>
            {categories.map((cat) => (
              <option key={cat.id} value={cat.id}>
                {cat.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {exportError && (
        <p className="error" role="alert">
          {exportError}
        </p>
      )}
      <div className="row-actions">
        <button type="button" onClick={handleExport} disabled={exporting}>
          <Icon name="save" /> {exporting ? "Exporting…" : "Download"}
        </button>
        <button type="button" className="secondary" onClick={handleCopy}>
          <Icon name="mail" /> {copied ? "Copied!" : "Copy text"}
        </button>
      </div>
      {exported && <p className="hint">{saveToDocuments ? "Downloaded and saved to Documents." : "Downloaded."}</p>}
    </div>
  );
}

export function LetterGeneratorPage({ onBack }: { onBack: () => void }) {
  const [clients, setClients] = useState<Client[]>([]);
  const [documentCategories, setDocumentCategories] = useState<DocumentCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [clientId, setClientId] = useState<number | "">("");
  const [letterType, setLetterType] = useState("");
  const [format, setFormat] = useState<LetterFormat>("letter");
  const [personalFields, setPersonalFields] = useState<string[]>(PERSONAL_FIELD_OPTIONS.map((f) => f.token));

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [sending, setSending] = useState(false);
  // Set once "Continue editing" resumes a saved letter as a live
  // conversation -- Save then updates that same history row (PATCH)
  // instead of creating a new one (POST). Cleared by startOver/handleSave.
  const [editingLetterId, setEditingLetterId] = useState<number | null>(null);

  const [review, setReview] = useState<ReviewLetterResult | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [selectedFlags, setSelectedFlags] = useState<Set<number>>(new Set());
  const [feedbackText, setFeedbackText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [history, setHistory] = useState<Letter[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [viewingLetter, setViewingLetter] = useState<Letter | null>(null);

  useEffect(() => {
    Promise.all([getClients(), getDocumentCategories()])
      .then(([clientList, categoryList]) => {
        setClients(clientList);
        setDocumentCategories(categoryList);
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Couldn't load Correspondence"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    setViewingLetter(null);
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

  function toggleSelectedFlag(index: number) {
    setSelectedFlags((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  // Deliberately doesn't reset `saved` -- handleSave calls this right after
  // a successful save, and the "Saved." confirmation (rendered outside the
  // in-conversation view below) needs to survive the reset back to the
  // pre-drafting screen. handleStart clears it instead, once a genuinely
  // new draft begins.
  function startOver() {
    setMessages([]);
    setChatInput("");
    setReview(null);
    setSelectedFlags(new Set());
    setFeedbackText("");
    setEditingLetterId(null);
    setError(null);
  }

  // Shared by the kickoff message, a normal chat reply, and review
  // feedback -- all three are "append this as the next user turn and get
  // the agent's reply", differing only in how the content is composed.
  async function sendToAgent(content: string): Promise<boolean> {
    const userMessage: ChatMessage = { role: "user", content };
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setError(null);
    setSending(true);
    try {
      const result = await chatDraftLetter({ letterType: letterType.trim(), format, personalFields, messages: nextMessages });
      setMessages([...nextMessages, { role: "assistant", content: result.reply }]);
      setReview(null);
      setSelectedFlags(new Set());
      setSaved(false);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't reach the drafting agent");
      setMessages(messages);
      return false;
    } finally {
      setSending(false);
    }
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
    setSaved(false);
    await sendToAgent(`I need to write: ${letterType.trim()}`);
  }

  async function handleSend(event: FormEvent) {
    event.preventDefault();
    const text = chatInput.trim();
    if (!text) return;
    setChatInput("");
    const ok = await sendToAgent(text);
    if (!ok) setChatInput(text);
  }

  async function handleReview() {
    if (!lastAssistantMessage) return;
    setError(null);
    setReviewing(true);
    try {
      setReview(await reviewLetter(lastAssistantMessage.content));
      setSelectedFlags(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't review the letter");
    } finally {
      setReviewing(false);
    }
  }

  // The feedback loop: turn the flags you've picked plus anything you've
  // typed into one message, send it as the next chat turn, and let the
  // agent revise -- rather than you having to retype the review's
  // findings into the chat box yourself.
  async function handleSendFeedback() {
    if (!review) return;
    const flagTexts = review.flags.filter((_, i) => selectedFlags.has(i)).map((f) => f.text);
    const parts: string[] = [];
    if (flagTexts.length > 0) {
      parts.push(`Please address this review feedback:\n${flagTexts.map((t) => `- ${t}`).join("\n")}`);
    }
    if (feedbackText.trim()) {
      parts.push(feedbackText.trim());
    }
    if (parts.length === 0) return;

    const previousFlags = selectedFlags;
    const previousText = feedbackText;
    setSelectedFlags(new Set());
    setFeedbackText("");
    const ok = await sendToAgent(parts.join("\n\n"));
    if (!ok) {
      setSelectedFlags(previousFlags);
      setFeedbackText(previousText);
    }
  }

  async function handleSave() {
    if (clientId === "" || !lastAssistantMessage) return;
    setError(null);
    setSaving(true);
    try {
      const payload = {
        letterType: letterType.trim(),
        format,
        personalFields,
        draftBody: lastAssistantMessage.content,
        reviewFlags: review?.flags ?? null,
        piiScanClean: review?.piiScanClean ?? null,
      };
      if (editingLetterId !== null) {
        await updateLetter(editingLetterId, payload);
      } else {
        await addLetter({ clientId, ...payload });
      }
      setSaved(true);
      startOver();
      setLetterType("");
      setFormat("letter");
      setHistory(await getLetters(clientId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the letter");
    } finally {
      setSaving(false);
    }
  }

  // Resumes a saved letter as a live conversation -- there's no stored
  // chat history (the chat endpoint is stateless, see api.ts), so this
  // seeds a fresh two-turn conversation ending in the saved draft, which
  // is enough for the agent to revise from. Saving from here updates the
  // same row (see handleSave) rather than creating a duplicate.
  function handleContinueEditing(letter: Letter) {
    setLetterType(letter.letterType ?? "");
    setFormat(letter.format);
    setPersonalFields(letter.personalFields);
    setMessages([
      { role: "user", content: `Resuming this previously saved ${FORMAT_LABELS[letter.format].toLowerCase()} for further edits.` },
      { role: "assistant", content: letter.draftBody },
    ]);
    setReview(
      letter.reviewFlags || letter.piiScanClean !== null
        ? {
            piiScanClean: letter.piiScanClean ?? true,
            piiMatches: [],
            reviewConfigured: (letter.reviewFlags?.length ?? 0) > 0,
            flags: letter.reviewFlags ?? [],
          }
        : null,
    );
    setSelectedFlags(new Set());
    setFeedbackText("");
    setEditingLetterId(letter.id);
    setSaved(false);
    setError(null);
    setViewingLetter(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function handleDeleteHistory(id: number) {
    const confirmed = window.confirm("Delete this saved letter? It moves to Deleted letters, not removed outright.");
    if (!confirmed) return;
    try {
      await deleteLetter(id);
      setHistory((prev) => prev.filter((l) => l.id !== id));
      if (viewingLetter?.id === id) setViewingLetter(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't delete that letter");
    }
  }

  if (loading) return <p className="loading">Loading…</p>;

  const inConversation = messages.length > 0;
  const selectedClientName = clients.find((c) => c.id === clientId)?.name ?? "";

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
          <label className="edit-field">
            <span>Output</span>
            <select
              className="input-compact"
              value={format}
              disabled={inConversation}
              onChange={(event) => setFormat(event.target.value as LetterFormat)}
            >
              <option value="letter">Letter</option>
              <option value="email">Email</option>
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
          {editingLetterId !== null && (
            <p className="hint" style={{ marginBottom: 12 }}>
              Continuing a previously saved letter — saving will update that history entry rather than add a new one.
            </p>
          )}
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
                        <label className="token-row" style={{ gap: 8 }}>
                          <input type="checkbox" checked={selectedFlags.has(i)} onChange={() => toggleSelectedFlag(i)} />
                          <span className={`review-dot ${flag.severity === "concern" ? "warn" : ""}`} />
                          <span>{flag.text}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
                <label className="edit-field" style={{ marginTop: review.flags.length > 0 ? 16 : 4, marginBottom: 12 }}>
                  <span>Feedback for the drafting agent (optional)</span>
                  <textarea
                    rows={2}
                    value={feedbackText}
                    onChange={(event) => setFeedbackText(event.target.value)}
                    placeholder="Check any points above the agent should address, or add anything else here — e.g. why a flag doesn't apply, or another change to make"
                    disabled={sending}
                  />
                </label>
                <div className="row-actions">
                  <button
                    type="button"
                    onClick={handleSendFeedback}
                    disabled={sending || (selectedFlags.size === 0 && !feedbackText.trim())}
                  >
                    <Icon name="add" /> {sending ? "Sending…" : "Send feedback to agent"}
                  </button>
                </div>
              </div>
              <p className="panel-note">Advisory, not a gate — you decide what to act on.</p>
            </>
          )}

          <div className="row-actions" style={{ marginBottom: 24 }}>
            <button type="button" onClick={handleSave} disabled={!lastAssistantMessage || saving}>
              <Icon name="save" /> {saving ? "Saving…" : editingLetterId !== null ? "Save changes" : "Save to history"}
            </button>
          </div>

          {lastAssistantMessage && clientId !== "" && (
            <ExportControls
              clientId={clientId}
              clientName={selectedClientName}
              letterType={letterType.trim() || null}
              body={lastAssistantMessage.content}
              categories={documentCategories}
            />
          )}
        </>
      )}
      {saved && <p className="hint">Saved.</p>}

      {clientId !== "" && (
        <>
          <p className="settings-section-title">Correspondence history — {selectedClientName}</p>
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
                    <th>Format</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((letter) => (
                    <tr key={letter.id}>
                      <td>{new Date(letter.createdAt).toLocaleDateString("en-GB")}</td>
                      <td>{letter.letterType ?? "—"}</td>
                      <td>{FORMAT_LABELS[letter.format] ?? letter.format}</td>
                      <td>
                        <div className="row-actions">
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => setViewingLetter(viewingLetter?.id === letter.id ? null : letter)}
                          >
                            <Icon name="mail" /> {viewingLetter?.id === letter.id ? "Hide" : "View"}
                          </button>
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

          {viewingLetter && (
            <>
              <p className="settings-section-title">
                {viewingLetter.letterType ?? "Letter"} — {new Date(viewingLetter.createdAt).toLocaleDateString("en-GB")}
              </p>
              <div className="edit-panel chat-transcript">
                <div className="chat-message chat-message-assistant">
                  <div className="chat-bubble">{renderWithTokens(viewingLetter.draftBody)}</div>
                </div>
              </div>
              {viewingLetter.reviewFlags && viewingLetter.reviewFlags.length > 0 && (
                <ul className="review-list" style={{ marginBottom: 16 }}>
                  {viewingLetter.reviewFlags.map((flag, i) => (
                    <li className="review-item" key={i}>
                      <span className={`review-dot ${flag.severity === "concern" ? "warn" : ""}`} />
                      <span>{flag.text}</span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="row-actions" style={{ marginBottom: 16 }}>
                <button type="button" onClick={() => handleContinueEditing(viewingLetter)}>
                  <Icon name="tag" /> Continue editing
                </button>
              </div>
              <ExportControls
                clientId={viewingLetter.clientId}
                clientName={viewingLetter.clientName}
                letterType={viewingLetter.letterType}
                body={viewingLetter.draftBody}
                categories={documentCategories}
              />
            </>
          )}
        </>
      )}
    </>
  );
}
