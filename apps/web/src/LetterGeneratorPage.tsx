import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { scanForPii } from "@acm-caseflow/core";
import { Icon } from "./icons";
import { extractDocumentText, isSupportedDocument } from "./documentExtract";
import { downloadBlob, generateLetterDocx, generateLetterPdf } from "./letterExport";
import {
  createLetterSession,
  deleteLetter,
  finalizeLetter,
  getClients,
  getDocumentCategories,
  getLetter,
  getLetters,
  goBackToStage,
  requestLetterReview,
  sendAnalysisMessage,
  sendCompositionMessage,
  sendReviewFeedback,
  summarizeAnalysis,
  uploadDocument,
  type Client,
  type DocumentCategory,
  type LetterFormat,
  type LetterSession,
  type LetterStage,
  type LetterSummary,
  type StageResult,
} from "./api";

// A fixed small set rather than a per-letter-type field schema -- keeps
// the app from ever needing a form-builder for this. Every one of these
// only ever reaches the agents as a token name (e.g. "CLIENT_NAME"),
// never the real value -- see api.ts's doc comments and ARCHITECTURE.md's
// Correspondence section. This is the one piece of setup that stays
// structured even though everything else (letter type, facts, tone) now
// flows through the staged conversations -- it's the safety mechanism,
// not a fact to discuss.
const PERSONAL_FIELD_OPTIONS: Array<{ token: string; label: string }> = [
  { token: "CLIENT_NAME", label: "Client name" },
  { token: "CLIENT_ADDRESS", label: "Postal address" },
  { token: "YOUR_NAME", label: "Your sign-off name" },
];

const FORMAT_LABELS: Record<LetterFormat, string> = { letter: "Letter", email: "Email" };

const STAGE_ORDER: LetterStage[] = ["analysis", "composition", "review", "finalized"];
const STAGE_LABELS: Record<LetterStage, string> = {
  analysis: "1. Analysis",
  composition: "2. Composition",
  review: "3. Review",
  finalized: "4. Finalised",
};

// Complete = solid ink (finalized). Not yet really underway = dashed,
// faint (analysis, still establishing the basis). Everything between =
// plain outline, moving but not finished -- same fill/outline/dashed
// convention used for invoice and client-case status elsewhere in the app.
function stageStatusClass(stage: LetterStage): string {
  if (stage === "finalized") return "status-complete";
  if (stage === "analysis") return "status-in-progress";
  return "";
}

// The stage stepper -- a segmented control (like .mode-toggle elsewhere)
// rather than independent chips, since a letter is in exactly one stage at
// a time. An earlier stage is clickable to go back to it (append-only --
// nothing already written is lost, see api.ts's goBackToStage); the
// current and any later stage aren't, since forward movement only ever
// happens through an explicit stage action (Move to drafting, Send to
// review, etc.), never by jumping ahead in the stepper.
function StageStepper({ session, onBack }: { session: LetterSession; onBack: (stage: "analysis" | "composition") => void }) {
  const currentIndex = STAGE_ORDER.indexOf(session.stage);
  return (
    <div className="mode-toggle" style={{ marginBottom: 20 }}>
      {STAGE_ORDER.map((stage, i) => {
        const isCurrent = stage === session.stage;
        const canGoBack = session.stage !== "finalized" && i < currentIndex && (stage === "analysis" || stage === "composition");
        return (
          <button
            key={stage}
            type="button"
            className={isCurrent ? "active" : ""}
            disabled={!canGoBack}
            onClick={canGoBack ? () => onBack(stage as "analysis" | "composition") : undefined}
          >
            {STAGE_LABELS[stage]}
          </button>
        );
      })}
    </div>
  );
}

// Grows with typed content instead of staying a cramped fixed height, up
// to maxHeight -- past that it scrolls within itself rather than pushing
// the rest of the page down indefinitely.
function AutoGrowTextarea({
  value,
  onChange,
  placeholder,
  disabled,
  maxHeight = 240,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  maxHeight?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [value, maxHeight]);

  return (
    <textarea
      ref={ref}
      rows={2}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      style={{ maxHeight, overflowY: "auto", resize: "none" }}
    />
  );
}

// Renders {{TOKEN}} placeholders as visually distinct badges wherever
// they appear in a message, so a token reads as "not a real value yet"
// the same way it does in the setup checklist above.
function renderTokens(text: string, keyPrefix: string) {
  const parts = text.split(/(\{\{[A-Z0-9_]+\}\})/g);
  return parts.map((part, i) =>
    /^\{\{[A-Z0-9_]+\}\}$/.test(part) ? (
      <span className="token" key={`${keyPrefix}-${i}`}>
        {part}
      </span>
    ) : (
      <span key={`${keyPrefix}-${i}`}>{part}</span>
    ),
  );
}

// A `**Subheading**` line (see letters.ts's drafter prompt -- the only
// markdown it's allowed to produce) renders bold here the same way it
// renders bold in the exported docx/PDF (letterExport.ts) -- one shared
// convention, not markdown support in general.
function renderWithTokens(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    const bold = /^\*\*([^*]+)\*\*$/.exec(part);
    return bold ? <strong key={i}>{renderTokens(bold[1] ?? "", `b${i}`)}</strong> : <span key={i}>{renderTokens(part, `p${i}`)}</span>;
  });
}

function exportFilename(letterType: string | null, clientName: string, extension: string): string {
  const base = `${letterType?.trim() || "Letter"} - ${clientName}`.replace(/[/\\:*?"<>|]/g, "-").slice(0, 120);
  return `${base}.${extension}`;
}

// Shared by the finalized draft's export row and any other saveable view
// -- same two questions either way: which file format, and whether a copy
// also belongs in Documents (case file) or is just a download.
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

  // The active staged session, at whatever stage it's currently in --
  // null means the setup panel below is showing, about to create one.
  // Every stage transition persists server-side as it happens (see
  // api.ts), so there's no separate "unsaved" state to lose.
  const [session, setSession] = useState<LetterSession | null>(null);
  const [analysisInput, setAnalysisInput] = useState("");
  const [compositionInput, setCompositionInput] = useState("");
  const [sending, setSending] = useState(false);
  // True when the last reply was cut off by hitting the model's token
  // limit rather than finishing naturally -- see anthropic.ts's `truncated`.
  const [lastReplyTruncated, setLastReplyTruncated] = useState(false);

  const [selectedFlags, setSelectedFlags] = useState<Set<number>>(new Set());
  const [feedbackText, setFeedbackText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [justFinalized, setJustFinalized] = useState(false);

  // Analysis-stage document attach: the file itself never leaves the
  // browser (see documentExtract.ts) -- only the extracted text, reviewed
  // and possibly edited here, is ever sent to the analyst. documentText
  // resets documentConfirmed on every edit so a stale confirmation can't
  // cover content the user hasn't actually reviewed.
  const [documentFilename, setDocumentFilename] = useState<string | null>(null);
  const [documentText, setDocumentText] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [documentConfirmed, setDocumentConfirmed] = useState(false);
  const documentFileInputRef = useRef<HTMLInputElement>(null);
  const documentPiiScan = documentText.trim() ? scanForPii(documentText) : null;

  const [history, setHistory] = useState<LetterSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  useEffect(() => {
    Promise.all([getClients(), getDocumentCategories()])
      .then(([clientList, categoryList]) => {
        setClients(clientList);
        setDocumentCategories(categoryList);
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Couldn't load Correspondence"))
      .finally(() => setLoading(false));
  }, []);

  async function refreshHistory(forClientId: number | "") {
    if (forClientId === "") {
      setHistory([]);
      return;
    }
    try {
      setHistory(await getLetters(forClientId));
    } catch {
      // Keep whatever's already showing on a transient failure.
    }
  }

  useEffect(() => {
    setHistoryLoading(true);
    refreshHistory(clientId).finally(() => setHistoryLoading(false));
  }, [clientId]);

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

  function clearDocument() {
    setDocumentFilename(null);
    setDocumentText("");
    setDocumentConfirmed(false);
    setExtractError(null);
    if (documentFileInputRef.current) documentFileInputRef.current.value = "";
  }

  function updateDocumentText(value: string) {
    setDocumentText(value);
    setDocumentConfirmed(false);
  }

  function resetSessionState() {
    setSession(null);
    setAnalysisInput("");
    setCompositionInput("");
    setSelectedFlags(new Set());
    setFeedbackText("");
    setLastReplyTruncated(false);
    setError(null);
    clearDocument();
  }

  function handleNewLetter() {
    resetSessionState();
    setLetterType("");
    setFormat("letter");
    setJustFinalized(false);
  }

  // Shared by every stage action below: run it, adopt whatever session
  // state it returns, and surface an error without losing the session.
  async function runStageAction(action: () => Promise<StageResult>): Promise<boolean> {
    setSending(true);
    setError(null);
    setLastReplyTruncated(false);
    try {
      const result = await action();
      setSession(result.letter);
      setLastReplyTruncated(result.truncated);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
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
    setJustFinalized(false);
    setSending(true);
    setError(null);
    try {
      const created = await createLetterSession({ clientId, letterType: letterType.trim(), format, personalFields });
      setSession(created);
      await refreshHistory(clientId);
      const result = await sendAnalysisMessage(created.id, `I need to write: ${letterType.trim()}`);
      setSession(result.letter);
      setLastReplyTruncated(result.truncated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start this letter");
    } finally {
      setSending(false);
    }
  }

  async function handleSendAnalysis(event: FormEvent) {
    event.preventDefault();
    if (!session) return;
    const text = analysisInput.trim();
    if (!text) return;
    setAnalysisInput("");
    const ok = await runStageAction(() => sendAnalysisMessage(session.id, text));
    if (!ok) setAnalysisInput(text);
  }

  async function handleContinueAnalysis() {
    if (!session) return;
    await runStageAction(() =>
      sendAnalysisMessage(session.id, "Please continue exactly where you left off -- don't repeat or restate anything already written."),
    );
  }

  async function handleDocumentFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!isSupportedDocument(file)) {
      setExtractError("Only PDF and Word (.docx) documents can be attached");
      if (documentFileInputRef.current) documentFileInputRef.current.value = "";
      return;
    }
    setExtractError(null);
    setDocumentText("");
    setDocumentConfirmed(false);
    setExtracting(true);
    try {
      const text = await extractDocumentText(file);
      if (!text.trim()) {
        setExtractError("Couldn't find any text in that document");
        setDocumentFilename(null);
      } else {
        setDocumentFilename(file.name);
        setDocumentText(text);
      }
    } catch (err) {
      setExtractError(err instanceof Error ? err.message : "Couldn't extract text from that document");
      setDocumentFilename(null);
    } finally {
      setExtracting(false);
      if (documentFileInputRef.current) documentFileInputRef.current.value = "";
    }
  }

  // Sent as a normal analysis turn -- there's no separate "attachment"
  // concept server-side (see api.ts's sendAnalysisMessage), just the
  // reviewed extracted text framed with its source document's name.
  async function handleSendDocument() {
    if (!session || !documentText.trim()) return;
    const content = `Extracted from an uploaded document ("${documentFilename ?? "attached document"}") -- review for ` +
      `accuracy, it may contain layout artefacts from extraction:\n\n${documentText.trim()}`;
    const ok = await runStageAction(() => sendAnalysisMessage(session.id, content));
    if (ok) clearDocument();
  }

  // The explicit Analysis -> Composition handoff, followed immediately by
  // an auto-kickoff drafting turn -- same "start talking straight away"
  // feel as handleStart above, just for the drafting agent this time.
  async function handleSummarize() {
    if (!session) return;
    const id = session.id;
    setSending(true);
    setError(null);
    setLastReplyTruncated(false);
    try {
      const summarized = await summarizeAnalysis(id);
      setSession(summarized.letter);
      const drafted = await sendCompositionMessage(id, "Please draft the letter based on the Analysis Summary above.");
      setSession(drafted.letter);
      setLastReplyTruncated(drafted.truncated);
      await refreshHistory(clientId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't move to drafting");
    } finally {
      setSending(false);
    }
  }

  async function handleSendComposition(event: FormEvent) {
    event.preventDefault();
    if (!session) return;
    const text = compositionInput.trim();
    if (!text) return;
    setCompositionInput("");
    const ok = await runStageAction(() => sendCompositionMessage(session.id, text));
    if (!ok) setCompositionInput(text);
  }

  async function handleContinueComposition() {
    if (!session) return;
    await runStageAction(() =>
      sendCompositionMessage(session.id, "Please continue exactly where you left off -- don't repeat or restate anything already written."),
    );
  }

  async function handleRequestReview() {
    if (!session) return;
    setSelectedFlags(new Set());
    setFeedbackText("");
    const ok = await runStageAction(() => requestLetterReview(session.id));
    if (ok) await refreshHistory(clientId);
  }

  // Turns the flags picked plus anything typed into one response, sent to
  // the drafting agent -- the review round itself is never applied
  // automatically, only ever routed back for the user to see revised.
  async function handleSendReviewFeedback() {
    if (!session) return;
    const previousFlags = selectedFlags;
    const previousText = feedbackText;
    setSelectedFlags(new Set());
    setFeedbackText("");
    const ok = await runStageAction(() =>
      sendReviewFeedback(session.id, { selectedFlagIndexes: [...previousFlags], feedbackText: previousText }),
    );
    if (!ok) {
      setSelectedFlags(previousFlags);
      setFeedbackText(previousText);
    } else {
      await refreshHistory(clientId);
    }
  }

  async function handleBack(stage: "analysis" | "composition") {
    if (!session) return;
    setSelectedFlags(new Set());
    setFeedbackText("");
    const ok = await runStageAction(() => goBackToStage(session.id, stage));
    if (ok) await refreshHistory(clientId);
  }

  async function handleFinalize() {
    if (!session) return;
    const ok = await runStageAction(() => finalizeLetter(session.id));
    if (ok) {
      setJustFinalized(true);
      await refreshHistory(clientId);
    }
  }

  async function handleOpenHistory(id: number) {
    setError(null);
    try {
      const full = await getLetter(id);
      setLetterType(full.letterType ?? "");
      setFormat(full.format);
      setPersonalFields(full.personalFields);
      setSession(full);
      setAnalysisInput("");
      setCompositionInput("");
      setSelectedFlags(new Set());
      setFeedbackText("");
      setLastReplyTruncated(false);
      setJustFinalized(false);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't open that letter");
    }
  }

  async function handleDeleteHistory(id: number) {
    const confirmed = window.confirm("Delete this letter? It moves to Deleted letters, not removed outright.");
    if (!confirmed) return;
    try {
      await deleteLetter(id);
      setHistory((prev) => prev.filter((l) => l.id !== id));
      if (session?.id === id) resetSessionState();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't delete that letter");
    }
  }

  if (loading) return <p className="loading">Loading…</p>;

  const selectedClientName = clients.find((c) => c.id === clientId)?.name ?? "";
  const currentRound = session && session.reviewRounds.length > 0 ? session.reviewRounds[session.reviewRounds.length - 1] : null;

  return (
    <>
      <button type="button" className="back-link" onClick={onBack}>
        <Icon name="back" /> Dashboard
      </button>
      <h1>Correspondence</h1>
      <p className="hint">
        Produce a letter through three stages: analysis with a legal-analyst agent to establish the facts and UK
        family-law basis, drafting with a legal-composition agent guided by that analysis, and a legal-reviewer
        agent's check before you finalise it. Personal details are never sent to the AI — every stage uses
        placeholders, filled in afterward outside the system. Progress saves automatically as you move between
        stages, so you can leave and come back.
      </p>

      {loadError && (
        <p className="error" role="alert">
          {loadError}
        </p>
      )}

      {!session && (
        <>
          <p className="settings-section-title">1. Who this is for, and what kind of letter</p>
          <div className="edit-panel">
            <div className="edit-row" style={{ marginBottom: 16 }}>
              <label className="edit-field">
                <span>Client</span>
                <select
                  className="input-compact"
                  value={clientId}
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
                <select className="input-compact" value={format} onChange={(event) => setFormat(event.target.value as LetterFormat)}>
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
            The real name and address never leave your database and never reach the AI — only the token does, for
            every stage below.
          </p>
        </>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {!session ? (
        <div className="row-actions" style={{ marginBottom: 36 }}>
          <button type="button" onClick={handleStart} disabled={sending}>
            <Icon name="add" /> {sending ? "Starting…" : "Start"}
          </button>
        </div>
      ) : (
        <>
          <StageStepper session={session} onBack={handleBack} />
          <p className="hint" style={{ marginTop: -8, marginBottom: 20 }}>
            {FORMAT_LABELS[session.format]} — {session.letterType ?? "Letter"}
          </p>

          {session.stage === "analysis" && (
            <>
              <p className="settings-section-title">Analysis — establish the facts and legal basis</p>
              <p className="hint">
                Talk through the facts, the client's objective, and the relevant UK family-law basis with the legal
                analyst. Move to drafting once you're both satisfied there's enough to work from.
              </p>

              <div className="edit-panel" style={{ marginBottom: 16 }}>
                <p className="edit-panel-title">Attach a document (optional)</p>
                <p className="hint" style={{ marginBottom: 12 }}>
                  Extract text from a PDF or Word document to add to the conversation — the file itself never
                  leaves your browser, only the text you review and send below.
                </p>
                <input
                  ref={documentFileInputRef}
                  type="file"
                  className="input-compact"
                  accept=".pdf,.docx"
                  onChange={handleDocumentFileChange}
                  disabled={extracting || sending}
                />
                {extracting && <p className="loading">Extracting text…</p>}
                {extractError && (
                  <p className="error" role="alert">
                    {extractError}
                  </p>
                )}
                {documentText && (
                  <>
                    <label className="edit-field" style={{ marginTop: 12, marginBottom: 12 }}>
                      <span>Extracted text from "{documentFilename}" — review and edit before sending</span>
                      <AutoGrowTextarea value={documentText} onChange={updateDocumentText} disabled={sending} maxHeight={320} />
                    </label>
                    {documentPiiScan && !documentPiiScan.clean && (
                      <>
                        <p className="error" role="alert">
                          Possible personal data found in this text
                          {documentPiiScan.matches.length > 0 ? `: ${documentPiiScan.matches.map((m) => m.kind).join(", ")}` : ""}.
                          Edit it out above, or confirm below that it's safe to send.
                        </p>
                        <label className="token-row" style={{ marginBottom: 12 }}>
                          <input
                            type="checkbox"
                            checked={documentConfirmed}
                            onChange={(event) => setDocumentConfirmed(event.target.checked)}
                          />
                          <span className="field-name">I've reviewed this text and it's safe to send</span>
                        </label>
                      </>
                    )}
                    <div className="row-actions">
                      <button
                        type="button"
                        onClick={handleSendDocument}
                        disabled={sending || !documentText.trim() || (documentPiiScan !== null && !documentPiiScan.clean && !documentConfirmed)}
                      >
                        <Icon name="add" /> {sending ? "Sending…" : "Add to conversation"}
                      </button>
                      <button type="button" className="secondary" onClick={clearDocument} disabled={sending}>
                        Discard
                      </button>
                    </div>
                  </>
                )}
              </div>

              <div className="edit-panel chat-transcript">
                {session.analysisMessages.map((message, i) => (
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

              {lastReplyTruncated && !sending && (
                <>
                  <p className="error" role="alert">
                    That reply looks like it was cut off mid-sentence (hit the model's length limit).
                  </p>
                  <div className="row-actions" style={{ marginBottom: 12 }}>
                    <button type="button" className="secondary" onClick={handleContinueAnalysis}>
                      <Icon name="add" /> Continue
                    </button>
                  </div>
                </>
              )}

              <form onSubmit={handleSendAnalysis} className="chat-input-row">
                <AutoGrowTextarea value={analysisInput} onChange={setAnalysisInput} placeholder="Reply to the legal analyst…" disabled={sending} />
                <button type="submit" disabled={sending || !analysisInput.trim()}>
                  <Icon name="add" /> Send
                </button>
              </form>

              <div className="row-actions" style={{ margin: "16px 0 36px" }}>
                <button type="button" onClick={handleSummarize} disabled={sending || session.analysisMessages.length === 0}>
                  <Icon name="tag" /> {sending ? "Working…" : "Move to drafting"}
                </button>
              </div>
            </>
          )}

          {(session.stage === "composition" || session.stage === "review") && (
            <>
              <p className="settings-section-title">{session.stage === "review" ? "Composition" : "Composition — draft it together"}</p>
              {session.analysisSummary && session.stage === "composition" && (
                <div className="edit-panel" style={{ marginBottom: 16 }}>
                  <p className="edit-panel-title">Analysis summary</p>
                  <p style={{ whiteSpace: "pre-wrap" }}>{renderWithTokens(session.analysisSummary)}</p>
                </div>
              )}
              {session.stage === "composition" && (
                <>
                  <div className="edit-panel chat-transcript">
                    {session.compositionMessages.map((message, i) => (
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

                  {lastReplyTruncated && !sending && (
                    <>
                      <p className="error" role="alert">
                        That reply looks like it was cut off mid-sentence (hit the model's length limit).
                      </p>
                      <div className="row-actions" style={{ marginBottom: 12 }}>
                        <button type="button" className="secondary" onClick={handleContinueComposition}>
                          <Icon name="add" /> Continue
                        </button>
                      </div>
                    </>
                  )}

                  <form onSubmit={handleSendComposition} className="chat-input-row">
                    <AutoGrowTextarea
                      value={compositionInput}
                      onChange={setCompositionInput}
                      placeholder="Reply to the drafting agent…"
                      disabled={sending}
                    />
                    <button type="submit" disabled={sending || !compositionInput.trim()}>
                      <Icon name="add" /> Send
                    </button>
                  </form>

                  <div className="row-actions" style={{ margin: "16px 0 36px" }}>
                    <button type="button" onClick={handleRequestReview} disabled={sending || !session.draftBody.trim()}>
                      <Icon name="tag" /> {sending ? "Working…" : "Send to review"}
                    </button>
                  </div>
                </>
              )}
            </>
          )}

          {session.stage === "review" && currentRound && (
            <>
              <p className="settings-section-title">Review — legal &amp; compliance check</p>
              <div className="edit-panel chat-transcript">
                <div className="chat-message chat-message-assistant">
                  <div className="chat-bubble">{renderWithTokens(session.draftBody)}</div>
                </div>
              </div>
              <div className="edit-panel">
                <div style={{ marginBottom: currentRound.flags.length > 0 ? 14 : 0 }}>
                  <span className={`status ${currentRound.piiScanClean ? "status-complete" : ""}`}>
                    Personal-data scan: {currentRound.piiScanClean ? "clear" : "check needed"}
                  </span>
                </div>
                {!currentRound.piiScanClean && (
                  <p className="error" role="alert">
                    Possible personal data found outside the placeholder tokens
                    {currentRound.piiMatches.length > 0 ? `: ${currentRound.piiMatches.map((m) => m.kind).join(", ")}` : ""}. Go
                    back to drafting and ask the agent to fix it before finalising.
                  </p>
                )}
                {!currentRound.reviewConfigured && (
                  <p className="hint">
                    Advisory legal review isn't configured yet (needs an Anthropic API key) — the personal-data
                    scan above still ran.
                  </p>
                )}
                {currentRound.truncated && (
                  <p className="error" role="alert">
                    This review looks like it was cut off mid-sentence (hit the model's length limit) — try Send to
                    review again.
                  </p>
                )}
                {currentRound.flags.length > 0 && (
                  <ul className="review-list">
                    {currentRound.flags.map((flag, i) => (
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
                <label className="edit-field" style={{ marginTop: currentRound.flags.length > 0 ? 16 : 4, marginBottom: 12 }}>
                  <span>Feedback for the drafting agent (optional)</span>
                  <AutoGrowTextarea
                    value={feedbackText}
                    onChange={setFeedbackText}
                    placeholder="Check any points above the agent should address, or add anything else here — e.g. why a flag doesn't apply, or another change to make"
                    disabled={sending}
                  />
                </label>
                <div className="row-actions">
                  <button
                    type="button"
                    onClick={handleSendReviewFeedback}
                    disabled={sending || (selectedFlags.size === 0 && !feedbackText.trim())}
                  >
                    <Icon name="add" /> {sending ? "Sending…" : "Send feedback to agent"}
                  </button>
                </div>
              </div>
              <p className="panel-note">Advisory, not a gate — you decide what to act on.</p>

              <div className="row-actions" style={{ margin: "16px 0 36px" }}>
                <button type="button" onClick={handleFinalize} disabled={sending}>
                  <Icon name="save" /> {sending ? "Finalising…" : "Finalise letter"}
                </button>
              </div>
            </>
          )}

          {session.stage === "finalized" && (
            <>
              <p className="settings-section-title">Finalised</p>
              <div className="edit-panel chat-transcript">
                <div className="chat-message chat-message-assistant">
                  <div className="chat-bubble">{renderWithTokens(session.draftBody)}</div>
                </div>
              </div>
              {session.reviewFlags && session.reviewFlags.length > 0 && (
                <ul className="review-list" style={{ marginBottom: 16 }}>
                  {session.reviewFlags.map((flag, i) => (
                    <li className="review-item" key={i}>
                      <span className={`review-dot ${flag.severity === "concern" ? "warn" : ""}`} />
                      <span>{flag.text}</span>
                    </li>
                  ))}
                </ul>
              )}
              {session.processSummary && (
                <>
                  <p className="settings-section-title">AI process summary</p>
                  <div className="edit-panel" style={{ marginBottom: 20 }}>
                    <p style={{ whiteSpace: "pre-wrap" }}>{session.processSummary}</p>
                  </div>
                </>
              )}
              <ExportControls
                clientId={session.clientId}
                clientName={session.clientName}
                letterType={session.letterType}
                body={session.draftBody}
                categories={documentCategories}
              />
            </>
          )}

          <div className="row-actions" style={{ marginBottom: 24 }}>
            <button type="button" className="secondary" onClick={handleNewLetter}>
              New letter
            </button>
          </div>
        </>
      )}
      {justFinalized && <p className="hint">Finalised.</p>}

      {clientId !== "" && (
        <>
          <p className="settings-section-title">Correspondence history — {selectedClientName}</p>
          {historyLoading ? (
            <p className="loading">Loading…</p>
          ) : history.length === 0 ? (
            <p className="empty">No letters started for this client yet.</p>
          ) : (
            <div className="table-scroll">
              <table className="ledger">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Type</th>
                    <th>Format</th>
                    <th>Stage</th>
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
                        <span className={`status ${stageStatusClass(letter.stage)}`}>{STAGE_LABELS[letter.stage]}</span>
                      </td>
                      <td>
                        <div className="row-actions">
                          <button type="button" className="secondary" onClick={() => handleOpenHistory(letter.id)}>
                            <Icon name="mail" /> Open
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
        </>
      )}
    </>
  );
}
