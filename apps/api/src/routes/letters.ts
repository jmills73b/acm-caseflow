import { Hono } from "hono";
import { scanForPii, type PiiScanMatch } from "@acm-caseflow/core";
import type { AppEnv } from "../index";
import { requireAuth } from "./auth";
import { AI_MODELS, DEFAULT_MODEL, callClaude, type ChatMessage } from "../anthropic";

const letters = new Hono<AppEnv>();

letters.use("*", requireAuth);

// Correspondence is a staged, persisted workflow, not a single stateless
// chat: Analysis (facts + UK family-law basis with a legal-analyst agent) ->
// Composition (drafting with a legal-drafting agent, guided by the
// Analysis Summary) -> Review (a legal-reviewer agent checks the draft,
// looping back to Composition as many times as needed) -> Finalized. A
// `letters` row represents the whole session from the moment it's created,
// not just the finished result -- see migrations/0030_letter_stages.sql.
// Nothing is ever overwritten when the user goes back to an earlier stage
// (see /:id/back below): every message array and the review_rounds log
// only ever grow, which is both what makes back-navigation safe and what
// gives the finalize-time process summary its raw material.
type LetterStage = "analysis" | "composition" | "review" | "finalized";

interface LetterRow {
  id: number;
  client_id: number;
  client_name: string;
  letter_type: string | null;
  format: string;
  personal_fields: string;
  draft_body: string;
  review_flags: string | null;
  pii_scan_clean: number | null;
  stage: string;
  analysis_summary: string | null;
  process_summary: string | null;
  created_by_email: string;
  created_at: string;
  updated_at: string;
  // Only present when fetched via DETAIL_COLUMNS (see loadSession) -- the
  // list/deleted endpoints deliberately leave these out, since a growing
  // conversation history in every row of a list would be a lot of JSON to
  // ship for a screen that only shows a summary.
  analysis_messages?: string;
  composition_messages?: string;
  review_rounds?: string;
}

interface ReviewFlag {
  severity: "ok" | "concern";
  text: string;
}

// One entry per "Send to review": appended to review_rounds, never
// replaced, so the full history survives a back-navigation to Composition
// and is what the finalize-time narrative draws on. `respondedAt` and the
// two fields below it stay null until the user acts on this round via
// /:id/review/feedback.
interface ReviewRound {
  createdAt: string;
  draftSnapshot: string;
  piiScanClean: boolean;
  piiMatches: PiiScanMatch[];
  reviewConfigured: boolean;
  truncated: boolean;
  flags: ReviewFlag[];
  selectedFlagTexts: string[] | null;
  feedbackText: string | null;
  respondedAt: string | null;
}

// The shape every staged endpoint below loads, mutates, persists, and
// returns -- camelCase throughout so it doubles as the API response body,
// with no separate DB-row-to-response mapping step for the staged routes.
interface LetterSession {
  id: number;
  clientId: number;
  clientName: string;
  letterType: string | null;
  format: LetterFormat;
  personalFields: string[];
  stage: LetterStage;
  draftBody: string;
  analysisMessages: ChatMessage[];
  analysisSummary: string | null;
  compositionMessages: ChatMessage[];
  reviewRounds: ReviewRound[];
  processSummary: string | null;
  reviewFlags: ReviewFlag[] | null;
  piiScanClean: boolean | null;
  createdByEmail: string;
  createdAt: string;
  updatedAt: string;
}

const LETTER_FORMATS = ["letter", "email"] as const;
type LetterFormat = (typeof LETTER_FORMATS)[number];

function isValidFormat(value: unknown): value is LetterFormat {
  return typeof value === "string" && (LETTER_FORMATS as readonly string[]).includes(value);
}

function nowIso(): string {
  return new Date().toISOString();
}

function toLetterSummary(row: LetterRow) {
  return {
    id: row.id,
    clientId: row.client_id,
    clientName: row.client_name,
    letterType: row.letter_type,
    format: row.format,
    personalFields: JSON.parse(row.personal_fields) as string[],
    stage: row.stage as LetterStage,
    draftBody: row.draft_body,
    analysisSummary: row.analysis_summary,
    processSummary: row.process_summary,
    reviewFlags: row.review_flags ? (JSON.parse(row.review_flags) as ReviewFlag[]) : null,
    piiScanClean: row.pii_scan_clean === null ? null : row.pii_scan_clean === 1,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToSession(row: LetterRow): LetterSession {
  return {
    id: row.id,
    clientId: row.client_id,
    clientName: row.client_name,
    letterType: row.letter_type,
    format: row.format as LetterFormat,
    personalFields: JSON.parse(row.personal_fields) as string[],
    stage: row.stage as LetterStage,
    draftBody: row.draft_body,
    analysisMessages: JSON.parse(row.analysis_messages ?? "[]") as ChatMessage[],
    analysisSummary: row.analysis_summary,
    compositionMessages: JSON.parse(row.composition_messages ?? "[]") as ChatMessage[],
    reviewRounds: JSON.parse(row.review_rounds ?? "[]") as ReviewRound[],
    processSummary: row.process_summary,
    reviewFlags: row.review_flags ? (JSON.parse(row.review_flags) as ReviewFlag[]) : null,
    piiScanClean: row.pii_scan_clean === null ? null : row.pii_scan_clean === 1,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SUMMARY_COLUMNS =
  "letters.id, letters.client_id, clients.name AS client_name, letters.letter_type, letters.format, " +
  "letters.personal_fields, letters.draft_body, letters.review_flags, letters.pii_scan_clean, " +
  "letters.stage, letters.analysis_summary, letters.process_summary, " +
  "users.email AS created_by_email, letters.created_at, letters.updated_at";

const DETAIL_COLUMNS = `${SUMMARY_COLUMNS}, letters.analysis_messages, letters.composition_messages, letters.review_rounds`;

const LETTERS_JOIN = "FROM letters JOIN clients ON clients.id = letters.client_id JOIN users ON users.id = letters.created_by";

async function loadSession(db: D1Database, id: number): Promise<LetterSession | null> {
  const row = await db
    .prepare(`SELECT ${DETAIL_COLUMNS} ${LETTERS_JOIN} WHERE letters.id = ? AND letters.deleted_at IS NULL`)
    .bind(id)
    .first<LetterRow>();
  return row ? rowToSession(row) : null;
}

// The one write path for every staged endpoint below -- each loads a
// session, mutates the in-memory object, and calls this to persist the
// whole row back in one statement, rather than each route hand-rolling its
// own partial UPDATE. Stamps updatedAt itself so callers can't forget.
async function persistLetter(db: D1Database, session: LetterSession): Promise<void> {
  session.updatedAt = nowIso();
  await db
    .prepare(
      `UPDATE letters SET stage = ?, analysis_messages = ?, analysis_summary = ?, composition_messages = ?,
       review_rounds = ?, process_summary = ?, draft_body = ?, review_flags = ?, pii_scan_clean = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL`,
    )
    .bind(
      session.stage,
      JSON.stringify(session.analysisMessages),
      session.analysisSummary,
      JSON.stringify(session.compositionMessages),
      JSON.stringify(session.reviewRounds),
      session.processSummary,
      session.draftBody,
      session.reviewFlags ? JSON.stringify(session.reviewFlags) : null,
      session.piiScanClean === null ? null : session.piiScanClean ? 1 : 0,
      session.updatedAt,
      session.id,
    )
    .run();
}

// clientId is optional, same convention as documents.ts: a client's own
// Correspondence history passes it, while a future all-clients view could
// omit it -- clientName is always in the response either way via the join.
letters.get("/", async (c) => {
  const clientIdParam = c.req.query("clientId");
  let clientId: number | undefined;
  if (clientIdParam !== undefined) {
    clientId = Number(clientIdParam);
    if (!Number.isInteger(clientId)) {
      return c.json({ error: "Invalid clientId" }, 400);
    }
  }

  const where =
    clientId !== undefined ? "WHERE letters.client_id = ? AND letters.deleted_at IS NULL" : "WHERE letters.deleted_at IS NULL";
  const stmt = c.env.DB.prepare(`SELECT ${SUMMARY_COLUMNS} ${LETTERS_JOIN} ${where} ORDER BY letters.updated_at DESC`);
  const { results } = await (clientId !== undefined ? stmt.bind(clientId) : stmt).all<LetterRow>();

  return c.json(results.map(toLetterSummary));
});

// Shared by every agent call below -- the model choice is one account-wide
// setting (Admin's AI settings panel), applied to every stage's agent
// alike, rather than a separate picker per agent. Simpler to reason about,
// and easy to split later if one agent turns out to need a different model
// than the others.
async function getAccountAiSettings(db: D1Database): Promise<{ model: string; complianceGuidelines: string }> {
  const row = await db
    .prepare("SELECT ai_model, compliance_guidelines FROM account_settings WHERE id = 1")
    .first<{ ai_model: string | null; compliance_guidelines: string | null }>();
  return {
    model: row?.ai_model || DEFAULT_MODEL,
    complianceGuidelines: row?.compliance_guidelines?.trim() ?? "",
  };
}

type AiEndpoint = "analysis" | "analysis-summarize" | "composition" | "review" | "finalize-summary";

async function logAiUsage(
  db: D1Database,
  endpoint: AiEndpoint,
  model: string,
  usage: { inputTokens: number; outputTokens: number },
): Promise<void> {
  await db
    .prepare("INSERT INTO ai_usage (endpoint, model, input_tokens, output_tokens) VALUES (?, ?, ?, ?)")
    .bind(endpoint, model, usage.inputTokens, usage.outputTokens)
    .run();
}

letters.get("/deleted", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT ${SUMMARY_COLUMNS}, deleters.email AS deleted_by_email, letters.deleted_at
     ${LETTERS_JOIN}
     LEFT JOIN users deleters ON deleters.id = letters.deleted_by
     WHERE letters.deleted_at IS NOT NULL
     ORDER BY letters.deleted_at DESC`,
  ).all<LetterRow & { deleted_by_email: string | null; deleted_at: string }>();

  return c.json(
    results.map((row) => ({
      ...toLetterSummary(row),
      deletedAt: row.deleted_at,
      deletedByEmail: row.deleted_by_email,
    })),
  );
});

// Admin's "AI usage" panel -- grouped by model since Haiku and Sonnet are
// priced differently (see AI_MODELS in anthropic.ts), so a flat token sum
// alone couldn't produce an accurate cost estimate.
letters.get("/usage", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT model, COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens " +
      "FROM ai_usage GROUP BY model",
  ).all<{ model: string; input_tokens: number; output_tokens: number }>();

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let estimatedCostUsd = 0;
  const byModel = results.map((row) => {
    const pricing = AI_MODELS.find((m) => m.id === row.model);
    const cost = pricing
      ? (row.input_tokens / 1_000_000) * pricing.inputPricePerMTok +
        (row.output_tokens / 1_000_000) * pricing.outputPricePerMTok
      : 0;
    totalInputTokens += row.input_tokens;
    totalOutputTokens += row.output_tokens;
    estimatedCostUsd += cost;
    return { model: row.model, inputTokens: row.input_tokens, outputTokens: row.output_tokens, estimatedCostUsd: cost };
  });

  return c.json({ totalInputTokens, totalOutputTokens, estimatedCostUsd, byModel });
});

function renderConversation(messages: ChatMessage[], agentLabel: string): string {
  return messages.map((m) => `${m.role === "user" ? "User" : agentLabel}: ${m.content}`).join("\n\n");
}

function renderReviewRounds(rounds: ReviewRound[]): string {
  if (rounds.length === 0) return "(No review rounds yet.)";
  return rounds
    .map((round, i) => {
      const flagsText =
        round.flags.length > 0 ? round.flags.map((f) => `- [${f.severity.toUpperCase()}] ${f.text}`).join("\n") : "(no flags raised)";
      const responseText = round.respondedAt
        ? `User response -- addressed: ${
            round.selectedFlagTexts && round.selectedFlagTexts.length > 0 ? round.selectedFlagTexts.join("; ") : "(none selected)"
          }${round.feedbackText ? `; free-text feedback: ${round.feedbackText}` : ""}`
        : "(no user response recorded yet)";
      return `Round ${i + 1} (personal-data scan: ${round.piiScanClean ? "clean" : "flagged"}):\n${flagsText}\n${responseText}`;
    })
    .join("\n\n");
}

function tokensList(personalFields: string[]): string {
  return personalFields.length > 0
    ? personalFields.map((field) => `{{${field}}}`).join(", ")
    : "(no personal-data tokens were made available for this letter)";
}

// Stage 1 persona: gathers facts and legal basis only, never drafts.
function analystSystemPrompt(letterType: string, personalFields: string[]): string {
  return [
    "You are a legal analyst at a UK family-law costs consultancy, working through a back-and-forth conversation " +
      "with a colleague to establish the facts, the client's objective, and the legal basis for a piece of client " +
      "correspondence -- before anyone starts drafting it.",
    `The correspondence's purpose, as described by the colleague: ${letterType}`,
    "Your job in this stage is analysis only -- ask clarifying questions, surface the relevant facts, identify the " +
      "legal issues under UK family law (and UK costs law, since this is a costs consultancy) that bear on it, note " +
      "any applicable professional-conduct principles, and flag anything uncertain, missing, or risky. Never draft " +
      "the actual letter or email text in this stage -- that happens in a separate drafting stage once the facts " +
      "and basis are settled here.",
    "You must use ONLY the following literal placeholder tokens for any personal or identifying information (a " +
      "name, address, or similar) -- never invent, guess, or ask the colleague for a real value:",
    tokensList(personalFields),
  ].join("\n\n");
}

// One-shot call that turns the analyst conversation into the Analysis
// Summary handed to the drafting agent as its sole brief -- the drafting
// agent never sees the raw conversation, only this.
function summarizeAnalysisPrompt(): string {
  return [
    "You are condensing a legal analyst's conversation into a structured Analysis Summary that will be handed to a " +
      "separate legal drafting agent as its sole brief for a piece of UK family-law client correspondence -- the " +
      "drafting agent will not see the conversation itself, only this summary, so it must stand alone.",
    "Write it under these headings, each on its own line: 'Key facts', 'Client objective', 'Legal basis' (the " +
      "relevant UK family law and costs law points), 'Recommended approach', and 'Open questions or gaps' (write " +
      "'None' if there aren't any).",
    "Use plain text with the headings above, no markdown formatting. Keep any personal or identifying information " +
      "as the literal placeholder tokens already used in the conversation -- never resolve one to a real value.",
  ].join("\n\n");
}

// Stage 2 persona: drafts strictly within the Analysis Summary handed down
// from Stage 1, revised over as many turns as the user needs.
function drafterSystemPrompt(letterType: string, format: LetterFormat, personalFields: string[], analysisSummary: string | null): string {
  return [
    format === "email"
      ? "You are drafting an email for a UK family-law costs consultancy, through a back-and-forth conversation " +
        "with the person you're drafting it for."
      : "You are drafting a piece of business correspondence for a UK family-law costs consultancy, through a " +
        "back-and-forth conversation with the person you're drafting it for.",
    `The letter's purpose, as described by the user: ${letterType}`,
    analysisSummary
      ? "A legal analyst has already established the facts and legal basis for this letter. Draft strictly within " +
        `this Analysis Summary -- do not introduce facts or legal positions beyond it:\n\n${analysisSummary}`
      : "(No analysis summary is available for this letter.)",
    "You must use ONLY the following literal placeholder tokens for any personal or identifying information " +
      "(a name, address, or similar) -- never invent, guess, or fill in a real value of your own, even if it " +
      "would make the letter read more naturally:",
    tokensList(personalFields),
    "If you need something to draft responsibly that isn't covered by the Analysis Summary or this conversation, " +
      "ask a single concise clarifying question instead of drafting -- do not include a draft in that reply.",
    format === "email"
      ? "Otherwise, respond with ONLY the full email, incorporating everything discussed so far -- start with a " +
        "single line 'Subject: ...' summarising it, then a blank line, then the email body with a concise " +
        "greeting and sign-off (no postal address block, no markdown formatting, no preamble like 'Here's a draft')."
      : "Otherwise, respond with ONLY the full letter body, incorporating everything discussed so far -- no " +
        "preamble like 'Here's a draft', no commentary, no markdown formatting.",
  ].join("\n\n");
}

// Stage 3 persona: the same supervising-solicitor checks as before, now
// also given the Analysis Summary so it can check the draft stayed within
// the basis it was supposed to follow, not just against the drafting chat.
function reviewerSystemPrompt(compositionMessages: ChatMessage[], analysisSummary: string | null, guidelines: string): string {
  return [
    "You are a supervising solicitor at a UK family-law costs consultancy, reviewing a colleague's draft client " +
      "correspondence before it goes out. You do not rewrite the letter yourself -- you flag things worth a " +
      "human's attention, and propose a specific correction for each -- and you never declare it definitively " +
      "compliant with any law.",
    "Check the draft against the material below -- the Analysis Summary it was supposed to follow, and the " +
      "drafting conversation, the only record of what was actually discussed and agreed -- for: factual accuracy " +
      "(does the letter match what was actually established, and has anything been invented or embellished beyond " +
      "it?), legal accuracy under UK family law and costs law, whether any argument is pitched too strongly or too " +
      "weakly for what the facts support, tone and professionalism, anything materially omitted that the recipient " +
      "would expect to see, and anything the recipient could exploit against the firm or client if the letter were " +
      "sent as written.",
    analysisSummary ? `Analysis Summary:\n${analysisSummary}` : "(No analysis summary is available for this letter.)",
    compositionMessages.length > 0
      ? `Drafting conversation:\n${renderConversation(compositionMessages, "Drafting agent")}`
      : "(No drafting conversation was provided -- review the letter on its own terms, and treat every factual " +
        "claim in it as unverifiable rather than assuming it's accurate.)",
    "Do not comment on whether the letter contains personal data -- that is checked separately.",
    "Respond with exactly one item per line. Each line must start with either 'OK:' (something you checked and " +
      "found no issue with) or 'CONCERN:' (something worth a second look, with your proposed correction). Prefix " +
      "each line's message with a short bracketed category, e.g. '[Factual accuracy]', '[Tone]', '[Omission]', " +
      "'[Compliance]'. No other text before or after.",
    guidelines
      ? `Also check against the firm's own compliance guidelines:\n${guidelines}`
      : "No specific compliance guidelines have been set yet.",
  ].join("\n\n");
}

// One-shot call at finalize time, per the user's explicit choice of an
// AI-written narrative over a structured log: turns the whole session's
// journey into a short readable paragraph saved alongside the letter.
function finalizeSummaryPrompt(): string {
  return [
    "You are writing a short internal narrative summary of how a piece of UK family-law client correspondence was " +
      "produced, for the firm's own audit trail -- not for the client. It will be saved alongside the finished " +
      "letter.",
    "In 2-4 short paragraphs, describe: what was established during analysis, how the draft evolved through any " +
      "drafting exchanges, what the legal/compliance review raised (if anything), and how that feedback was " +
      "addressed. Write in plain prose, no headings, no markdown, no bullet points.",
    "Keep any personal or identifying information as the literal placeholder tokens already used throughout -- " +
      "never resolve one to a real value.",
  ].join("\n\n");
}

function parseReviewFlags(raw: string): ReviewFlag[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      if (line.toUpperCase().startsWith("CONCERN:")) {
        return { severity: "concern" as const, text: line.slice(line.indexOf(":") + 1).trim() };
      }
      if (line.toUpperCase().startsWith("OK:")) {
        return { severity: "ok" as const, text: line.slice(line.indexOf(":") + 1).trim() };
      }
      return { severity: "ok" as const, text: line };
    });
}

interface CreateSessionRequest {
  clientId?: number;
  letterType?: string;
  format?: string;
  personalFields?: string[];
}

// Creates a session at stage 'analysis' -- no draft, no messages yet. This
// replaces the old POST / that required a finished draftBody: a letter row
// now represents the whole lifecycle from the moment drafting starts, not
// just the accepted result.
letters.post("/", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<CreateSessionRequest>();

  if (!body.clientId || !Number.isInteger(body.clientId)) {
    return c.json({ error: "clientId is required" }, 400);
  }
  const letterType = body.letterType?.trim();
  if (!letterType) {
    return c.json({ error: "letterType is required" }, 400);
  }
  if (body.format !== undefined && !isValidFormat(body.format)) {
    return c.json({ error: `format must be one of: ${LETTER_FORMATS.join(", ")}` }, 400);
  }

  const client = await c.env.DB.prepare("SELECT id FROM clients WHERE id = ?").bind(body.clientId).first();
  if (!client) {
    return c.json({ error: "Client not found" }, 404);
  }

  const now = nowIso();
  const created = await c.env.DB.prepare(
    `INSERT INTO letters (client_id, letter_type, format, personal_fields, draft_body, stage,
       analysis_messages, composition_messages, review_rounds, created_by, updated_at)
     VALUES (?, ?, ?, ?, '', 'analysis', '[]', '[]', '[]', ?, ?)
     RETURNING id`,
  )
    .bind(
      body.clientId,
      letterType,
      isValidFormat(body.format) ? body.format : "letter",
      JSON.stringify(Array.isArray(body.personalFields) ? body.personalFields : []),
      userId,
      now,
    )
    .first<{ id: number }>();

  if (!created) {
    return c.json({ error: "Could not create the letter session" }, 500);
  }

  const session = await loadSession(c.env.DB, created.id);
  if (!session) {
    return c.json({ error: "Could not load the created letter session" }, 500);
  }

  return c.json(session, 201);
});

// Full-detail fetch for resuming a session -- unlike GET /, this includes
// the message histories and review rounds, which the list view deliberately
// leaves out.
letters.get("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) {
    return c.json({ error: "Invalid letter id" }, 400);
  }

  const session = await loadSession(c.env.DB, id);
  if (!session) {
    return c.json({ error: "Letter not found" }, 404);
  }

  return c.json(session);
});

interface MessageRequest {
  message?: string;
}

// A stateful chat turn with the analyst persona -- unlike the old
// stateless /chat, the server owns the conversation: the client sends only
// the new message, and this appends both it and the reply to
// analysis_messages before persisting, which is what makes auto-save at
// stage transitions and resuming a session possible.
letters.post("/:id/analysis", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) {
    return c.json({ error: "AI legal analysis is not configured" }, 500);
  }
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) {
    return c.json({ error: "Invalid letter id" }, 400);
  }
  const body = await c.req.json<MessageRequest>();
  const message = body.message?.trim();
  if (!message) {
    return c.json({ error: "message is required" }, 400);
  }

  const session = await loadSession(c.env.DB, id);
  if (!session) {
    return c.json({ error: "Letter not found" }, 404);
  }
  if (session.stage !== "analysis") {
    return c.json({ error: "This letter isn't in the analysis stage" }, 400);
  }

  const { model } = await getAccountAiSettings(c.env.DB);
  const nextMessages: ChatMessage[] = [...session.analysisMessages, { role: "user", content: message }];

  try {
    const { text, usage, truncated } = await callClaude(
      c.env.ANTHROPIC_API_KEY,
      model,
      analystSystemPrompt(session.letterType ?? "", session.personalFields),
      nextMessages,
    );
    await logAiUsage(c.env.DB, "analysis", model, usage);
    session.analysisMessages = [...nextMessages, { role: "assistant", content: text }];
    await persistLetter(c.env.DB, session);
    return c.json({ letter: session, truncated });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Could not reach the analysis agent" }, 502);
  }
});

// The explicit Stage 1 -> 2 handoff: turns the analyst conversation into a
// structured Analysis Summary and transitions to composition. The drafting
// agent below never sees the raw analyst conversation, only this summary.
letters.post("/:id/analysis/summarize", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) {
    return c.json({ error: "AI legal analysis is not configured" }, 500);
  }
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) {
    return c.json({ error: "Invalid letter id" }, 400);
  }

  const session = await loadSession(c.env.DB, id);
  if (!session) {
    return c.json({ error: "Letter not found" }, 404);
  }
  if (session.stage !== "analysis") {
    return c.json({ error: "This letter isn't in the analysis stage" }, 400);
  }
  if (session.analysisMessages.length === 0) {
    return c.json({ error: "Nothing to summarise yet -- talk to the analyst first" }, 400);
  }

  const { model } = await getAccountAiSettings(c.env.DB);

  try {
    const { text, usage, truncated } = await callClaude(c.env.ANTHROPIC_API_KEY, model, summarizeAnalysisPrompt(), [
      { role: "user", content: `Analyst conversation:\n\n${renderConversation(session.analysisMessages, "Analyst")}` },
    ]);
    await logAiUsage(c.env.DB, "analysis-summarize", model, usage);
    session.analysisSummary = text;
    session.stage = "composition";
    await persistLetter(c.env.DB, session);
    return c.json({ letter: session, truncated });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Could not summarise the analysis" }, 502);
  }
});

// A stateful chat turn with the drafting persona -- same append-and-persist
// pattern as /analysis. The latest reply always becomes the current
// draftBody, whether it's an actual draft or a clarifying question (same
// behaviour the old stateless /chat had, just persisted now).
letters.post("/:id/composition", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) {
    return c.json({ error: "AI letter drafting is not configured" }, 500);
  }
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) {
    return c.json({ error: "Invalid letter id" }, 400);
  }
  const body = await c.req.json<MessageRequest>();
  const message = body.message?.trim();
  if (!message) {
    return c.json({ error: "message is required" }, 400);
  }

  const session = await loadSession(c.env.DB, id);
  if (!session) {
    return c.json({ error: "Letter not found" }, 404);
  }
  if (session.stage !== "composition") {
    return c.json({ error: "This letter isn't in the composition stage" }, 400);
  }

  const { model } = await getAccountAiSettings(c.env.DB);
  const nextMessages: ChatMessage[] = [...session.compositionMessages, { role: "user", content: message }];

  try {
    const { text, usage, truncated } = await callClaude(
      c.env.ANTHROPIC_API_KEY,
      model,
      drafterSystemPrompt(session.letterType ?? "", session.format, session.personalFields, session.analysisSummary),
      nextMessages,
    );
    await logAiUsage(c.env.DB, "composition", model, usage);
    session.compositionMessages = [...nextMessages, { role: "assistant", content: text }];
    session.draftBody = text;
    await persistLetter(c.env.DB, session);
    return c.json({ letter: session, truncated });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Could not reach the drafting agent" }, 502);
  }
});

// The PII pattern scan always runs, with or without an API key -- it's
// plain regex (packages/core's scanForPii), not an AI call, and is the one
// hard gate in this feature (see docs/ARCHITECTURE.md). The advisory
// review layered on top plays supervising solicitor; its output is never
// treated as pass/fail -- only the human reading it decides what to do
// with a flag. Every call appends a new round rather than replacing the
// last one, so re-reviewing after more drafting keeps the full history.
letters.post("/:id/review", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) {
    return c.json({ error: "Invalid letter id" }, 400);
  }

  const session = await loadSession(c.env.DB, id);
  if (!session) {
    return c.json({ error: "Letter not found" }, 404);
  }
  if (session.stage !== "composition" && session.stage !== "review") {
    return c.json({ error: "This letter isn't ready for review yet" }, 400);
  }
  if (!session.draftBody.trim()) {
    return c.json({ error: "This letter has nothing drafted to review yet" }, 400);
  }

  const piiScan = scanForPii(session.draftBody);

  async function appendRound(round: ReviewRound) {
    session!.reviewRounds = [...session!.reviewRounds, round];
    session!.reviewFlags = round.flags;
    session!.piiScanClean = round.piiScanClean;
    session!.stage = "review";
    await persistLetter(c.env.DB, session!);
  }

  if (!c.env.ANTHROPIC_API_KEY) {
    await appendRound({
      createdAt: nowIso(),
      draftSnapshot: session.draftBody,
      piiScanClean: piiScan.clean,
      piiMatches: piiScan.matches,
      reviewConfigured: false,
      truncated: false,
      flags: [],
      selectedFlagTexts: null,
      feedbackText: null,
      respondedAt: null,
    });
    return c.json({ letter: session, truncated: false });
  }

  const { model, complianceGuidelines: guidelines } = await getAccountAiSettings(c.env.DB);

  try {
    const { text: raw, usage, truncated } = await callClaude(
      c.env.ANTHROPIC_API_KEY,
      model,
      reviewerSystemPrompt(session.compositionMessages, session.analysisSummary, guidelines),
      [{ role: "user", content: `Review this draft:\n\n${session.draftBody}` }],
    );
    await logAiUsage(c.env.DB, "review", model, usage);
    await appendRound({
      createdAt: nowIso(),
      draftSnapshot: session.draftBody,
      piiScanClean: piiScan.clean,
      piiMatches: piiScan.matches,
      reviewConfigured: true,
      truncated,
      flags: parseReviewFlags(raw),
      selectedFlagTexts: null,
      feedbackText: null,
      respondedAt: null,
    });
    return c.json({ letter: session, truncated });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Could not review the letter" }, 502);
  }
});

interface ReviewFeedbackRequest {
  selectedFlagIndexes?: number[];
  feedbackText?: string;
}

// The feedback loop: records which flags the user picked (and any free
// text) against the latest review round, then forwards it as the next
// composition turn and routes back to the composition stage -- the
// reviewer's findings are never applied automatically, only ever routed to
// the drafting agent for the user to see revised.
letters.post("/:id/review/feedback", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) {
    return c.json({ error: "AI letter drafting is not configured" }, 500);
  }
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) {
    return c.json({ error: "Invalid letter id" }, 400);
  }

  const session = await loadSession(c.env.DB, id);
  if (!session) {
    return c.json({ error: "Letter not found" }, 404);
  }
  if (session.stage !== "review") {
    return c.json({ error: "This letter isn't in the review stage" }, 400);
  }
  if (session.reviewRounds.length === 0) {
    return c.json({ error: "No review round to respond to" }, 400);
  }

  const body = await c.req.json<ReviewFeedbackRequest>();
  const round = session.reviewRounds[session.reviewRounds.length - 1];
  if (!round) {
    return c.json({ error: "No review round to respond to" }, 400);
  }
  const indexes = Array.isArray(body.selectedFlagIndexes)
    ? body.selectedFlagIndexes.filter((i) => Number.isInteger(i) && i >= 0 && i < round.flags.length)
    : [];
  const feedbackText = body.feedbackText?.trim() ?? "";
  const selectedFlagTexts = indexes.map((i) => round.flags[i]?.text).filter((text): text is string => text !== undefined);

  if (selectedFlagTexts.length === 0 && !feedbackText) {
    return c.json({ error: "Select a flag or add feedback for the drafting agent" }, 400);
  }

  const parts: string[] = [];
  if (selectedFlagTexts.length > 0) {
    parts.push(`Please address this review feedback:\n${selectedFlagTexts.map((t) => `- ${t}`).join("\n")}`);
  }
  if (feedbackText) {
    parts.push(feedbackText);
  }

  round.selectedFlagTexts = selectedFlagTexts.length > 0 ? selectedFlagTexts : null;
  round.feedbackText = feedbackText || null;
  round.respondedAt = nowIso();

  const { model } = await getAccountAiSettings(c.env.DB);
  const nextMessages: ChatMessage[] = [...session.compositionMessages, { role: "user", content: parts.join("\n\n") }];

  try {
    const { text, usage, truncated } = await callClaude(
      c.env.ANTHROPIC_API_KEY,
      model,
      drafterSystemPrompt(session.letterType ?? "", session.format, session.personalFields, session.analysisSummary),
      nextMessages,
    );
    await logAiUsage(c.env.DB, "composition", model, usage);
    session.compositionMessages = [...nextMessages, { role: "assistant", content: text }];
    session.draftBody = text;
    session.stage = "composition";
    await persistLetter(c.env.DB, session);
    return c.json({ letter: session, truncated });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Could not reach the drafting agent" }, 502);
  }
});

interface BackRequest {
  stage?: string;
}

// Manual back-navigation -- just moves the stage pointer. Nothing is
// deleted: analysis_messages, composition_messages and review_rounds are
// append-only (see the top of this file), so going back to Analysis and
// having another exchange, or back to Composition for a fresh revision,
// only ever adds to the record.
letters.post("/:id/back", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) {
    return c.json({ error: "Invalid letter id" }, 400);
  }
  const body = await c.req.json<BackRequest>();
  if (body.stage !== "analysis" && body.stage !== "composition") {
    return c.json({ error: "stage must be one of: analysis, composition" }, 400);
  }

  const session = await loadSession(c.env.DB, id);
  if (!session) {
    return c.json({ error: "Letter not found" }, 404);
  }
  if (session.stage === "finalized") {
    return c.json({ error: "This letter has already been finalised" }, 400);
  }

  session.stage = body.stage;
  await persistLetter(c.env.DB, session);
  return c.json({ letter: session, truncated: false });
});

// Generates the AI-written narrative process summary (the user's explicit
// choice over a structured log) and locks the session as finalized. The
// narrative is best-effort: if the AI isn't configured, finalizing still
// succeeds with no process summary, same as the review step degrading
// gracefully without an API key.
letters.post("/:id/finalize", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) {
    return c.json({ error: "Invalid letter id" }, 400);
  }

  const session = await loadSession(c.env.DB, id);
  if (!session) {
    return c.json({ error: "Letter not found" }, 404);
  }
  if (!session.draftBody.trim()) {
    return c.json({ error: "This letter has nothing drafted to finalise yet" }, 400);
  }

  let truncated = false;
  if (c.env.ANTHROPIC_API_KEY) {
    const { model } = await getAccountAiSettings(c.env.DB);
    const journey = [
      `Analyst conversation:\n${session.analysisMessages.length > 0 ? renderConversation(session.analysisMessages, "Analyst") : "(none)"}`,
      `Analysis summary:\n${session.analysisSummary ?? "(none)"}`,
      `Drafting conversation:\n${
        session.compositionMessages.length > 0 ? renderConversation(session.compositionMessages, "Drafting agent") : "(none)"
      }`,
      `Review rounds:\n${renderReviewRounds(session.reviewRounds)}`,
    ].join("\n\n");

    try {
      const {
        text,
        usage,
        truncated: callTruncated,
      } = await callClaude(c.env.ANTHROPIC_API_KEY, model, finalizeSummaryPrompt(), [{ role: "user", content: journey }]);
      await logAiUsage(c.env.DB, "finalize-summary", model, usage);
      session.processSummary = text;
      truncated = callTruncated;
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Could not generate the process summary" }, 502);
    }
  }

  const lastRound = session.reviewRounds[session.reviewRounds.length - 1];
  if (lastRound) {
    session.reviewFlags = lastRound.flags;
    session.piiScanClean = lastRound.piiScanClean;
  }
  session.stage = "finalized";
  await persistLetter(c.env.DB, session);
  return c.json({ letter: session, truncated });
});

letters.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) {
    return c.json({ error: "Invalid letter id" }, 400);
  }

  const result = await c.env.DB.prepare(
    "UPDATE letters SET deleted_at = datetime('now'), deleted_by = ? WHERE id = ? AND deleted_at IS NULL",
  )
    .bind(userId, id)
    .run();

  if (result.meta.changes === 0) {
    return c.json({ error: "Letter not found" }, 404);
  }

  return c.json({ ok: true });
});

export default letters;
