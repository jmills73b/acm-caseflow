import { Hono } from "hono";
import { scanForPii } from "@acm-caseflow/core";
import type { AppEnv } from "../index";
import { requireAuth } from "./auth";
import { callClaude, type ChatMessage } from "../anthropic";

const letters = new Hono<AppEnv>();

letters.use("*", requireAuth);

interface LetterRow {
  id: number;
  client_id: number;
  client_name: string;
  letter_type: string | null;
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

function toLetter(row: LetterRow) {
  return {
    id: row.id,
    clientId: row.client_id,
    clientName: row.client_name,
    letterType: row.letter_type,
    personalFields: JSON.parse(row.personal_fields) as string[],
    draftBody: row.draft_body,
    reviewFlags: row.review_flags ? (JSON.parse(row.review_flags) as ReviewFlag[]) : null,
    piiScanClean: row.pii_scan_clean === null ? null : row.pii_scan_clean === 1,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
  };
}

const LIST_COLUMNS =
  "letters.id, letters.client_id, clients.name AS client_name, letters.letter_type, " +
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

interface ChatRequest {
  letterType?: string;
  personalFields?: string[];
  messages?: ChatMessage[];
}

function isValidMessages(messages: unknown): messages is ChatMessage[] {
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
    ) &&
    messages[messages.length - 1].role === "user"
  );
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
  if (!isValidMessages(body.messages)) {
    return c.json({ error: "messages must be a non-empty list ending with a user message" }, 400);
  }

  const personalFields = Array.isArray(body.personalFields) ? body.personalFields : [];
  const tokens = personalFields.map((field) => `{{${field}}}`);

  const system = [
    "You are drafting a piece of business correspondence for a UK family-law costs consultancy, through a " +
      "back-and-forth conversation with the person you're drafting it for.",
    `The letter's purpose, as described by the user: ${letterType}`,
    "You must use ONLY the following literal placeholder tokens for any personal or identifying information " +
      "(a name, address, or similar) -- never invent, guess, or fill in a real value of your own, even if it " +
      "would make the letter read more naturally:",
    tokens.length > 0 ? tokens.join(", ") : "(no personal-data tokens were made available for this letter)",
    "If you need more information before producing a useful draft, ask a single concise clarifying question and " +
      "do not include a draft in that reply.",
    "Otherwise, respond with ONLY the full letter body, incorporating everything discussed so far -- no preamble " +
      "like 'Here's a draft', no commentary, no markdown formatting.",
  ].join("\n\n");

  try {
    const reply = await callClaude(c.env.ANTHROPIC_API_KEY, system, body.messages);
    return c.json({ reply });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Could not reach the drafting agent" }, 502);
  }
});

interface ReviewRequest {
  draftBody?: string;
}

// The PII pattern scan always runs, with or without an API key -- it's
// plain regex (packages/core's scanForPii), not an AI call, and is the one
// hard gate in this feature (see docs/ARCHITECTURE.md). The advisory
// compliance/tone review is a second, separate concern layered on top: it
// needs the API key, and its output is never treated as a pass/fail --
// only the human reading it decides what to do with a flag.
letters.post("/review", async (c) => {
  const { draftBody } = await c.req.json<ReviewRequest>();
  if (!draftBody) {
    return c.json({ error: "draftBody is required" }, 400);
  }

  const piiScan = scanForPii(draftBody);

  if (!c.env.ANTHROPIC_API_KEY) {
    return c.json({ piiScanClean: piiScan.clean, piiMatches: piiScan.matches, reviewConfigured: false, flags: [] });
  }

  const settings = await c.env.DB.prepare("SELECT compliance_guidelines FROM account_settings WHERE id = 1").first<{
    compliance_guidelines: string;
  }>();
  const guidelines = settings?.compliance_guidelines?.trim();

  const system = [
    "You review draft client correspondence for a UK family-law costs consultancy against the firm's own " +
      "compliance guidelines below. You do not rewrite the letter, and you never declare it definitively " +
      "compliant with any law -- you flag things worth a human's attention and let them decide.",
    "Do not comment on whether the letter contains personal data -- that is checked separately.",
    "Respond with exactly one item per line. Each line must start with either 'OK:' (something you checked and " +
      "found no issue with) or 'CONCERN:' (something worth a second look). No other text before or after.",
    guidelines ? `Compliance guidelines:\n${guidelines}` : "No specific compliance guidelines have been set yet -- review only for professional tone and clarity.",
  ].join("\n\n");

  try {
    const raw = await callClaude(c.env.ANTHROPIC_API_KEY, system, [{ role: "user", content: draftBody }]);
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

    return c.json({ piiScanClean: piiScan.clean, piiMatches: piiScan.matches, reviewConfigured: true, flags });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Could not review the letter" }, 502);
  }
});

interface SaveRequest {
  clientId?: number;
  letterType?: string | null;
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

  const client = await c.env.DB.prepare("SELECT id FROM clients WHERE id = ?").bind(body.clientId).first();
  if (!client) {
    return c.json({ error: "Client not found" }, 404);
  }

  const created = await c.env.DB.prepare(
    `INSERT INTO letters (client_id, letter_type, personal_fields, draft_body, review_flags, pii_scan_clean, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     RETURNING id`,
  )
    .bind(
      body.clientId,
      body.letterType ?? null,
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
