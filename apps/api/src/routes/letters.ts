import { Hono } from "hono";
import { scanForPii } from "@acm-caseflow/core";
import type { AppEnv } from "../index";
import { requireAuth } from "./auth";
import { AI_MODELS, DEFAULT_MODEL, callClaude, type ChatMessage } from "../anthropic";

const letters = new Hono<AppEnv>();

letters.use("*", requireAuth);

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
  created_by_email: string;
  created_at: string;
}

interface ReviewFlag {
  severity: "ok" | "concern";
  text: string;
}

const LETTER_FORMATS = ["letter", "email"] as const;
type LetterFormat = (typeof LETTER_FORMATS)[number];

function isValidFormat(value: unknown): value is LetterFormat {
  return typeof value === "string" && (LETTER_FORMATS as readonly string[]).includes(value);
}

function toLetter(row: LetterRow) {
  return {
    id: row.id,
    clientId: row.client_id,
    clientName: row.client_name,
    letterType: row.letter_type,
    format: row.format,
    personalFields: JSON.parse(row.personal_fields) as string[],
    draftBody: row.draft_body,
    reviewFlags: row.review_flags ? (JSON.parse(row.review_flags) as ReviewFlag[]) : null,
    piiScanClean: row.pii_scan_clean === null ? null : row.pii_scan_clean === 1,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
  };
}

const LIST_COLUMNS =
  "letters.id, letters.client_id, clients.name AS client_name, letters.letter_type, letters.format, " +
  "letters.personal_fields, letters.draft_body, letters.review_flags, " +
  "letters.pii_scan_clean, users.email AS created_by_email, letters.created_at";

const LIST_JOIN = "FROM letters JOIN clients ON clients.id = letters.client_id JOIN users ON users.id = letters.created_by";

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
  const stmt = c.env.DB.prepare(`SELECT ${LIST_COLUMNS} ${LIST_JOIN} ${where} ORDER BY letters.created_at DESC`);
  const { results } = await (clientId !== undefined ? stmt.bind(clientId) : stmt).all<LetterRow>();

  return c.json(results.map(toLetter));
});

// Shared by both agent calls below -- the model choice is one account-wide
// setting (Admin's AI settings panel), applied to drafting and review
// alike, rather than a separate picker per agent. Simpler to reason about,
// and easy to split later if one agent turns out to need a different model
// than the other.
async function getAccountAiSettings(db: D1Database): Promise<{ model: string; complianceGuidelines: string }> {
  const row = await db
    .prepare("SELECT ai_model, compliance_guidelines FROM account_settings WHERE id = 1")
    .first<{ ai_model: string | null; compliance_guidelines: string | null }>();
  return {
    model: row?.ai_model || DEFAULT_MODEL,
    complianceGuidelines: row?.compliance_guidelines?.trim() ?? "",
  };
}

async function logAiUsage(
  db: D1Database,
  endpoint: "chat" | "review",
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
    `SELECT ${LIST_COLUMNS}, deleters.email AS deleted_by_email, letters.deleted_at
     ${LIST_JOIN}
     LEFT JOIN users deleters ON deleters.id = letters.deleted_by
     WHERE letters.deleted_at IS NOT NULL
     ORDER BY letters.deleted_at DESC`,
  ).all<LetterRow & { deleted_by_email: string | null; deleted_at: string }>();

  return c.json(
    results.map((row) => ({
      ...toLetter(row),
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

interface ChatRequest {
  letterType?: string;
  format?: string;
  personalFields?: string[];
  messages?: ChatMessage[];
}

// Shared shape check; /chat additionally requires the last turn to be the
// user's (it's about to get a reply), which doesn't hold for /review's use
// -- the conversation it's handed normally ends with the assistant's draft.
function isValidConversation(messages: unknown): messages is ChatMessage[] {
  return (
    Array.isArray(messages) &&
    messages.length > 0 &&
    messages.every(
      (m): m is ChatMessage =>
        typeof m === "object" &&
        m !== null &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim().length > 0,
    )
  );
}

function isValidMessages(messages: unknown): messages is ChatMessage[] {
  return isValidConversation(messages) && messages[messages.length - 1].role === "user";
}

// Stateless by design: the conversation lives in the browser (see
// LetterGeneratorPage.tsx), which resends the whole message history on
// every turn -- nothing about a letter's drafting conversation is
// persisted server-side, only the final accepted draft (POST / below).
//
// The only personal-data input this endpoint ever receives is the *names*
// of placeholder tokens (personalFields, e.g. "CLIENT_NAME") -- never a
// client's real name, address, or any other identifying value. The system
// prompt is rebuilt fresh on every call from letterType/personalFields, so
// that rule is enforced across the whole conversation, not just the first
// turn. The model is told to use those tokens verbatim and invent nothing
// else, which is what makes "no real PII ever reaches the AI" a structural
// guarantee rather than a prompt-level request it could ignore. What the
// user themselves types into the conversation is their own free text, no
// different a trust boundary than any other text box in this app.
letters.post("/chat", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) {
    return c.json({ error: "AI letter drafting is not configured" }, 500);
  }

  const body = await c.req.json<ChatRequest>();
  const letterType = body.letterType?.trim();
  if (!letterType) {
    return c.json({ error: "letterType is required" }, 400);
  }
  if (body.format !== undefined && !isValidFormat(body.format)) {
    return c.json({ error: `format must be one of: ${LETTER_FORMATS.join(", ")}` }, 400);
  }
  if (!isValidMessages(body.messages)) {
    return c.json({ error: "messages must be a non-empty list ending with a user message" }, 400);
  }

  const format: LetterFormat = isValidFormat(body.format) ? body.format : "letter";
  const { model } = await getAccountAiSettings(c.env.DB);
  const personalFields = Array.isArray(body.personalFields) ? body.personalFields : [];
  const tokens = personalFields.map((field) => `{{${field}}}`);

  const system = [
    format === "email"
      ? "You are drafting an email for a UK family-law costs consultancy, through a back-and-forth conversation " +
        "with the person you're drafting it for."
      : "You are drafting a piece of business correspondence for a UK family-law costs consultancy, through a " +
        "back-and-forth conversation with the person you're drafting it for.",
    `The letter's purpose, as described by the user: ${letterType}`,
    "Before drafting, work through this for yourself: the relevant facts established so far in the conversation, " +
      "what the client is trying to achieve, the legal issues raised, any applicable UK law or professional-" +
      "conduct principles worth bearing in mind, your recommended position, and anything uncertain or missing " +
      "that you'd need before drafting responsibly. Don't include this analysis in your reply -- it should only " +
      "inform how you draft.",
    "You must use ONLY the following literal placeholder tokens for any personal or identifying information " +
      "(a name, address, or similar) -- never invent, guess, or fill in a real value of your own, even if it " +
      "would make the letter read more naturally:",
    tokens.length > 0 ? tokens.join(", ") : "(no personal-data tokens were made available for this letter)",
    "If your analysis turned up anything uncertain or missing, ask a single concise clarifying question instead " +
      "of drafting -- do not include a draft in that reply.",
    format === "email"
      ? "Otherwise, respond with ONLY the full email, incorporating everything discussed so far -- start with a " +
        "single line 'Subject: ...' summarising it, then a blank line, then the email body with a concise " +
        "greeting and sign-off (no postal address block, no markdown formatting, no preamble like 'Here's a draft')."
      : "Otherwise, respond with ONLY the full letter body, incorporating everything discussed so far -- no " +
        "preamble like 'Here's a draft', no commentary, no markdown formatting.",
  ].join("\n\n");

  try {
    const { text, usage, truncated } = await callClaude(c.env.ANTHROPIC_API_KEY, model, system, body.messages);
    await logAiUsage(c.env.DB, "chat", model, usage);
    return c.json({ reply: text, truncated });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Could not reach the drafting agent" }, 502);
  }
});

interface ReviewRequest {
  draftBody?: string;
  // The drafting conversation the draft came from -- optional (a review of
  // an old saved letter with no conversation to hand still works, just
  // without the facts-comparison checks below), but the live UI always has
  // it and always sends it, since it's the reviewer's only source of what
  // was actually discussed.
  messages?: ChatMessage[];
}

function renderConversation(messages: ChatMessage[]): string {
  return messages.map((m) => `${m.role === "user" ? "User" : "Drafting agent"}: ${m.content}`).join("\n\n");
}

// The PII pattern scan always runs, with or without an API key -- it's
// plain regex (packages/core's scanForPii), not an AI call, and is the one
// hard gate in this feature (see docs/ARCHITECTURE.md). The advisory
// review layered on top plays supervising solicitor: checking the draft
// against what was actually discussed (factual/legal accuracy, invented
// content, argument strength, omissions, exploitability, tone) as well as
// the firm's own compliance guidelines. Its output is never treated as a
// pass/fail -- only the human reading it decides what to do with a flag.
letters.post("/review", async (c) => {
  const { draftBody, messages } = await c.req.json<ReviewRequest>();
  if (!draftBody) {
    return c.json({ error: "draftBody is required" }, 400);
  }

  const piiScan = scanForPii(draftBody);

  if (!c.env.ANTHROPIC_API_KEY) {
    return c.json({
      piiScanClean: piiScan.clean,
      piiMatches: piiScan.matches,
      reviewConfigured: false,
      flags: [],
      truncated: false,
    });
  }

  const { model, complianceGuidelines: guidelines } = await getAccountAiSettings(c.env.DB);

  const system = [
    "You are a supervising solicitor at a UK family-law costs consultancy, reviewing a colleague's draft client " +
      "correspondence before it goes out. You do not rewrite the letter yourself -- you flag things worth a " +
      "human's attention, and propose a specific correction for each -- and you never declare it definitively " +
      "compliant with any law.",
    "Check the draft against the drafting conversation below, which is the only record of what was actually " +
      "discussed and agreed, for: factual accuracy (does the letter match what was actually said, and has " +
      "anything been invented or embellished beyond it?), legal accuracy, whether any argument is pitched too " +
      "strongly or too weakly for what the facts support, tone and professionalism, anything materially omitted " +
      "that the recipient would expect to see, and anything the recipient could exploit against the firm or " +
      "client if the letter were sent as written.",
    isValidConversation(messages)
      ? `Drafting conversation:\n${renderConversation(messages)}`
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

  try {
    const { text: raw, usage, truncated } = await callClaude(c.env.ANTHROPIC_API_KEY, model, system, [
      { role: "user", content: `Review this draft:\n\n${draftBody}` },
    ]);
    await logAiUsage(c.env.DB, "review", model, usage);
    const flags: ReviewFlag[] = raw
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

    return c.json({ piiScanClean: piiScan.clean, piiMatches: piiScan.matches, reviewConfigured: true, flags, truncated });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Could not review the letter" }, 502);
  }
});

interface SaveRequest {
  clientId?: number;
  letterType?: string | null;
  format?: string;
  personalFields?: string[];
  draftBody?: string;
  reviewFlags?: ReviewFlag[] | null;
  piiScanClean?: boolean | null;
}

letters.post("/", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<SaveRequest>();

  if (!body.clientId || !Number.isInteger(body.clientId)) {
    return c.json({ error: "clientId is required" }, 400);
  }
  if (!body.draftBody?.trim()) {
    return c.json({ error: "draftBody is required" }, 400);
  }
  if (body.format !== undefined && !isValidFormat(body.format)) {
    return c.json({ error: `format must be one of: ${LETTER_FORMATS.join(", ")}` }, 400);
  }

  const client = await c.env.DB.prepare("SELECT id FROM clients WHERE id = ?").bind(body.clientId).first();
  if (!client) {
    return c.json({ error: "Client not found" }, 404);
  }

  const created = await c.env.DB.prepare(
    `INSERT INTO letters (client_id, letter_type, format, personal_fields, draft_body, review_flags, pii_scan_clean, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id`,
  )
    .bind(
      body.clientId,
      body.letterType ?? null,
      isValidFormat(body.format) ? body.format : "letter",
      JSON.stringify(body.personalFields ?? []),
      body.draftBody,
      body.reviewFlags ? JSON.stringify(body.reviewFlags) : null,
      body.piiScanClean === undefined || body.piiScanClean === null ? null : body.piiScanClean ? 1 : 0,
      userId,
    )
    .first<{ id: number }>();

  if (!created) {
    return c.json({ error: "Could not save the letter" }, 500);
  }

  const row = await c.env.DB.prepare(`SELECT ${LIST_COLUMNS} ${LIST_JOIN} WHERE letters.id = ?`)
    .bind(created.id)
    .first<LetterRow>();
  if (!row) {
    return c.json({ error: "Could not load the saved letter" }, 500);
  }

  return c.json(toLetter(row), 201);
});

// "Continue editing" (LetterGeneratorPage.tsx) resumes a saved letter as a
// live drafting conversation and, on save, updates this same row rather
// than creating a duplicate history entry -- clientId/createdBy/createdAt
// stay fixed since this is a revision of the same letter, not a new one.
letters.patch("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) {
    return c.json({ error: "Invalid letter id" }, 400);
  }

  const body = await c.req.json<SaveRequest>();
  if (!body.draftBody?.trim()) {
    return c.json({ error: "draftBody is required" }, 400);
  }
  if (body.format !== undefined && !isValidFormat(body.format)) {
    return c.json({ error: `format must be one of: ${LETTER_FORMATS.join(", ")}` }, 400);
  }

  const result = await c.env.DB.prepare(
    `UPDATE letters SET letter_type = ?, format = ?, personal_fields = ?, draft_body = ?, review_flags = ?, pii_scan_clean = ?
     WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(
      body.letterType ?? null,
      isValidFormat(body.format) ? body.format : "letter",
      JSON.stringify(body.personalFields ?? []),
      body.draftBody,
      body.reviewFlags ? JSON.stringify(body.reviewFlags) : null,
      body.piiScanClean === undefined || body.piiScanClean === null ? null : body.piiScanClean ? 1 : 0,
      id,
    )
    .run();

  if (result.meta.changes === 0) {
    return c.json({ error: "Letter not found" }, 404);
  }

  const row = await c.env.DB.prepare(`SELECT ${LIST_COLUMNS} ${LIST_JOIN} WHERE letters.id = ?`)
    .bind(id)
    .first<LetterRow>();
  if (!row) {
    return c.json({ error: "Could not load the saved letter" }, 500);
  }

  return c.json(toLetter(row));
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
