import { Hono } from "hono";
import { scanForPii } from "@acm-caseflow/core";
import type { AppEnv } from "../index";
import { requireAuth } from "./auth";
import { callClaude } from "../anthropic";

const letters = new Hono<AppEnv>();

letters.use("*", requireAuth);

interface LetterRow {
  id: number;
  client_id: number;
  client_name: string;
  letter_category_id: number | null;
  category_name: string | null;
  amount: number | null;
  reference: string | null;
  key_date: string | null;
  tone: string | null;
  personal_fields: string;
  bespoke_request: string | null;
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
    letterCategoryId: row.letter_category_id,
    categoryName: row.category_name,
    amount: row.amount,
    reference: row.reference,
    keyDate: row.key_date,
    tone: row.tone,
    personalFields: JSON.parse(row.personal_fields) as string[],
    bespokeRequest: row.bespoke_request,
    draftBody: row.draft_body,
    reviewFlags: row.review_flags ? (JSON.parse(row.review_flags) as ReviewFlag[]) : null,
    piiScanClean: row.pii_scan_clean === null ? null : row.pii_scan_clean === 1,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
  };
}

const LIST_COLUMNS =
  "letters.id, letters.client_id, clients.name AS client_name, letters.letter_category_id, " +
  "letter_categories.name AS category_name, letters.amount, letters.reference, letters.key_date, letters.tone, " +
  "letters.personal_fields, letters.bespoke_request, letters.draft_body, letters.review_flags, " +
  "letters.pii_scan_clean, users.email AS created_by_email, letters.created_at";

const LIST_JOIN =
  "FROM letters " +
  "JOIN clients ON clients.id = letters.client_id " +
  "LEFT JOIN letter_categories ON letter_categories.id = letters.letter_category_id " +
  "JOIN users ON users.id = letters.created_by";

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

interface DraftRequest {
  clientId?: number;
  letterCategoryId?: number;
  amount?: number;
  reference?: string;
  keyDate?: string;
  tone?: string;
  personalFields?: string[];
  bespokeRequest?: string;
}

// Drafts are never persisted here -- this only ever returns text for the
// frontend to show and let the user regenerate or edit before choosing to
// save it (POST / below). Critically, the only personal-data inputs this
// endpoint ever receives are the *names* of placeholder tokens
// (personalFields, e.g. "CLIENT_NAME") -- never a client's real name,
// address, or any other identifying value. The model is told to use those
// tokens verbatim and invent nothing else, which is what makes "no real
// PII ever reaches the AI" a structural guarantee rather than a prompt-
// level request it could ignore.
letters.post("/draft", async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) {
    return c.json({ error: "AI letter drafting is not configured" }, 500);
  }

  const body = await c.req.json<DraftRequest>();
  const personalFields = Array.isArray(body.personalFields) ? body.personalFields : [];

  let draftingInstruction = "";
  if (body.letterCategoryId) {
    const category = await c.env.DB.prepare("SELECT drafting_instruction FROM letter_categories WHERE id = ?")
      .bind(body.letterCategoryId)
      .first<{ drafting_instruction: string }>();
    draftingInstruction = category?.drafting_instruction ?? "";
  }

  const tokens = personalFields.map((field) => `{{${field}}}`);
  const facts: string[] = [];
  if (body.amount !== undefined) facts.push(`Amount: £${body.amount.toFixed(2)}`);
  if (body.reference) facts.push(`Reference: ${body.reference}`);
  if (body.keyDate) facts.push(`Key date: ${body.keyDate}`);
  if (body.tone) facts.push(`Tone: ${body.tone}`);

  const system = [
    "You draft business correspondence for a UK family-law costs consultancy.",
    "You must use ONLY the following literal placeholder tokens for any personal or identifying information " +
      "(a name, address, or similar) -- never invent, guess, or fill in a real value of your own, even if it " +
      "would make the letter read more naturally:",
    tokens.length > 0 ? tokens.join(", ") : "(no personal-data tokens were requested for this letter)",
    "State every factual figure and date exactly as given below -- never calculate, round, or restate them " +
      "differently.",
    "Respond with only the letter body text. No subject-line prefix, no commentary, no markdown formatting.",
  ].join("\n\n");

  const user = [
    draftingInstruction && `House style for this letter type: ${draftingInstruction}`,
    facts.length > 0 && `Facts to include:\n${facts.join("\n")}`,
    `Personal-data placeholders available: ${tokens.join(", ") || "none"}`,
    body.bespokeRequest && `Additional instructions: ${body.bespokeRequest}`,
    "Draft the letter now.",
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    const draftBody = await callClaude(c.env.ANTHROPIC_API_KEY, system, user);
    return c.json({ draftBody });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Could not draft the letter" }, 502);
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
    const raw = await callClaude(c.env.ANTHROPIC_API_KEY, system, draftBody);
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
  letterCategoryId?: number | null;
  amount?: number | null;
  reference?: string | null;
  keyDate?: string | null;
  tone?: string | null;
  personalFields?: string[];
  bespokeRequest?: string | null;
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
    `INSERT INTO letters
       (client_id, letter_category_id, amount, reference, key_date, tone, personal_fields, bespoke_request,
        draft_body, review_flags, pii_scan_clean, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id`,
  )
    .bind(
      body.clientId,
      body.letterCategoryId ?? null,
      body.amount ?? null,
      body.reference ?? null,
      body.keyDate ?? null,
      body.tone ?? null,
      JSON.stringify(body.personalFields ?? []),
      body.bespokeRequest ?? null,
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
