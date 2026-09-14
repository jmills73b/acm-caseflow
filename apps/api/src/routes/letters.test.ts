import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionToken } from "@acm-caseflow/core";
import app from "../index";
import type { Env } from "../index";

const SECRET = "test-secret";
const API_KEY = "test-anthropic-key";

async function sessionCookie(userId = 1): Promise<string> {
  return `session=${await createSessionToken({ userId, exp: Math.floor(Date.now() / 1000) + 60 }, SECRET)}`;
}

function claudeResponse(text: string, usage = { input_tokens: 42, output_tokens: 84 }, stopReason = "end_turn") {
  return new Response(
    JSON.stringify({ content: [{ type: "text", text }], usage, stop_reason: stopReason }),
    { status: 200 },
  );
}

interface StoredLetter {
  id: number;
  client_id: number;
  letter_type: string | null;
  format: string;
  personal_fields: string;
  draft_body: string;
  review_flags: string | null;
  pii_scan_clean: number | null;
  stage: string;
  analysis_messages: string;
  analysis_summary: string | null;
  composition_messages: string;
  review_rounds: string;
  process_summary: string | null;
  created_by: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_by: number | null;
}

interface AiUsageRow {
  endpoint: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
}

function fakeEnv(
  options: {
    apiKey?: string;
    clients?: Array<{ id: number; name: string }>;
    users?: Array<{ id: number; email: string }>;
    letters?: StoredLetter[];
    complianceGuidelines?: string;
    aiModel?: string;
    aiUsage?: AiUsageRow[];
  } = {},
): Env {
  const clients = options.clients ?? [{ id: 1, name: "Sarah Whitfield" }];
  const users = options.users ?? [{ id: 1, email: "anita@example.com" }];
  const letterStore = new Map<number, StoredLetter>((options.letters ?? []).map((l) => [l.id, l]));
  let nextId = Math.max(0, ...[...letterStore.keys()]) + 1;
  const complianceGuidelines = options.complianceGuidelines ?? "";
  const aiModel = options.aiModel ?? null;
  // Not a copy -- tests pass their own array in to observe what gets logged.
  const aiUsageRows: AiUsageRow[] = options.aiUsage ?? [];

  function enrich(row: StoredLetter) {
    return {
      id: row.id,
      client_id: row.client_id,
      client_name: clients.find((c) => c.id === row.client_id)?.name ?? "",
      letter_type: row.letter_type,
      format: row.format,
      personal_fields: row.personal_fields,
      draft_body: row.draft_body,
      review_flags: row.review_flags,
      pii_scan_clean: row.pii_scan_clean,
      stage: row.stage,
      analysis_messages: row.analysis_messages,
      analysis_summary: row.analysis_summary,
      composition_messages: row.composition_messages,
      review_rounds: row.review_rounds,
      process_summary: row.process_summary,
      created_by_email: users.find((u) => u.id === row.created_by)?.email ?? "",
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  return {
    SESSION_SECRET: SECRET,
    ANTHROPIC_API_KEY: options.apiKey,
    DB: {
      prepare: (sql: string) => {
        let boundArgs: unknown[] = [];
        const statement = {
          bind: (...args: unknown[]) => {
            boundArgs = args;
            return statement;
          },
          first: async <T,>() => {
            if (sql.includes("SELECT ai_model, compliance_guidelines FROM account_settings")) {
              return { ai_model: aiModel, compliance_guidelines: complianceGuidelines } as T;
            }
            if (sql.includes("SELECT id FROM clients WHERE id = ?")) {
              const [id] = boundArgs as [number];
              return (clients.some((c) => c.id === id) ? { id } : null) as T;
            }
            if (sql.includes("INSERT INTO letters")) {
              const [clientId, letterType, format, personalFields, createdBy, updatedAt] = boundArgs as [
                number,
                string,
                string,
                string,
                number,
                string,
              ];
              const id = nextId++;
              letterStore.set(id, {
                id,
                client_id: clientId,
                letter_type: letterType,
                format,
                personal_fields: personalFields,
                draft_body: "",
                review_flags: null,
                pii_scan_clean: null,
                stage: "analysis",
                analysis_messages: "[]",
                analysis_summary: null,
                composition_messages: "[]",
                review_rounds: "[]",
                process_summary: null,
                created_by: createdBy,
                created_at: updatedAt,
                updated_at: updatedAt,
                deleted_at: null,
                deleted_by: null,
              });
              return { id } as T;
            }
            if (sql.includes("WHERE letters.id = ? AND letters.deleted_at IS NULL")) {
              const [id] = boundArgs as [number];
              const row = letterStore.get(id);
              return (row && row.deleted_at === null ? enrich(row) : null) as T;
            }
            return null;
          },
          all: async <T,>() => {
            if (sql.includes("FROM ai_usage GROUP BY model")) {
              const byModel = new Map<string, { input_tokens: number; output_tokens: number }>();
              for (const row of aiUsageRows) {
                const existing = byModel.get(row.model) ?? { input_tokens: 0, output_tokens: 0 };
                byModel.set(row.model, {
                  input_tokens: existing.input_tokens + row.input_tokens,
                  output_tokens: existing.output_tokens + row.output_tokens,
                });
              }
              const results = [...byModel.entries()].map(([model, sums]) => ({ model, ...sums }));
              return { results: results as T[], success: true, meta: {} };
            }
            if (sql.includes("letters.deleted_at IS NOT NULL")) {
              const rows = [...letterStore.values()]
                .filter((l) => l.deleted_at !== null)
                .map((row) => ({
                  ...enrich(row),
                  deleted_by_email: users.find((u) => u.id === row.deleted_by)?.email ?? null,
                  deleted_at: row.deleted_at,
                }));
              return { results: rows as T[], success: true, meta: {} };
            }
            if (sql.includes("letters.client_id = ?")) {
              const [clientId] = boundArgs as [number];
              const rows = [...letterStore.values()]
                .filter((l) => l.client_id === clientId && l.deleted_at === null)
                .map(enrich);
              return { results: rows as T[], success: true, meta: {} };
            }
            if (sql.includes("letters.deleted_at IS NULL")) {
              const rows = [...letterStore.values()].filter((l) => l.deleted_at === null).map(enrich);
              return { results: rows as T[], success: true, meta: {} };
            }
            return { results: [] as T[], success: true, meta: {} };
          },
          run: async () => {
            if (sql.includes("INSERT INTO ai_usage")) {
              const [endpoint, model, inputTokens, outputTokens] = boundArgs as [string, string, number, number];
              aiUsageRows.push({ endpoint, model, input_tokens: inputTokens, output_tokens: outputTokens });
              return { success: true, meta: {} };
            }
            if (sql.includes("UPDATE letters SET deleted_at")) {
              const [deletedBy, id] = boundArgs as [number, number];
              const row = letterStore.get(id);
              if (!row || row.deleted_at !== null) return { success: true, meta: { changes: 0 } };
              row.deleted_at = "2026-09-14T13:00:00.000Z";
              row.deleted_by = deletedBy;
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("UPDATE letters SET stage = ?")) {
              const [
                stage,
                analysisMessages,
                analysisSummary,
                compositionMessages,
                reviewRounds,
                processSummary,
                draftBody,
                reviewFlags,
                piiScanClean,
                updatedAt,
                id,
              ] = boundArgs as [string, string, string | null, string, string, string | null, string, string | null, number | null, string, number];
              const row = letterStore.get(id);
              if (!row || row.deleted_at !== null) return { success: true, meta: { changes: 0 } };
              row.stage = stage;
              row.analysis_messages = analysisMessages;
              row.analysis_summary = analysisSummary;
              row.composition_messages = compositionMessages;
              row.review_rounds = reviewRounds;
              row.process_summary = processSummary;
              row.draft_body = draftBody;
              row.review_flags = reviewFlags;
              row.pii_scan_clean = piiScanClean;
              row.updated_at = updatedAt;
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: {} };
          },
        };
        return statement;
      },
    } as unknown as D1Database,
  };
}

function baseLetter(overrides: Partial<StoredLetter> = {}): StoredLetter {
  return {
    id: 1,
    client_id: 1,
    letter_type: "Fee estimate cover letter",
    format: "letter",
    personal_fields: JSON.stringify(["CLIENT_NAME"]),
    draft_body: "",
    review_flags: null,
    pii_scan_clean: null,
    stage: "analysis",
    analysis_messages: "[]",
    analysis_summary: null,
    composition_messages: "[]",
    review_rounds: "[]",
    process_summary: null,
    created_by: 1,
    created_at: "2026-09-14T12:00:00.000Z",
    updated_at: "2026-09-14T12:00:00.000Z",
    deleted_at: null,
    deleted_by: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/letters", () => {
  it("rejects a missing clientId", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/letters",
      { method: "POST", headers: { Cookie: cookie }, body: JSON.stringify({ letterType: "Fee estimate" }) },
      fakeEnv(),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a missing letterType", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/letters",
      { method: "POST", headers: { Cookie: cookie }, body: JSON.stringify({ clientId: 1 }) },
      fakeEnv(),
    );
    expect(res.status).toBe(400);
  });

  it("rejects an invalid format", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/letters",
      {
        method: "POST",
        headers: { Cookie: cookie },
        body: JSON.stringify({ clientId: 1, letterType: "Fee estimate", format: "fax" }),
      },
      fakeEnv(),
    );
    expect(res.status).toBe(400);
  });

  it("404s for an unknown client", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/letters",
      { method: "POST", headers: { Cookie: cookie }, body: JSON.stringify({ clientId: 99, letterType: "Fee estimate" }) },
      fakeEnv(),
    );
    expect(res.status).toBe(404);
  });

  it("creates a session at the analysis stage with an empty draft", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/letters",
      {
        method: "POST",
        headers: { Cookie: cookie },
        body: JSON.stringify({
          clientId: 1,
          letterType: "Fee estimate cover letter",
          format: "email",
          personalFields: ["CLIENT_NAME"],
        }),
      },
      fakeEnv(),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({
      clientName: "Sarah Whitfield",
      letterType: "Fee estimate cover letter",
      format: "email",
      stage: "analysis",
      draftBody: "",
      analysisMessages: [],
      compositionMessages: [],
      reviewRounds: [],
      analysisSummary: null,
      processSummary: null,
    });
  });

  it("defaults format to letter when omitted", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/letters",
      { method: "POST", headers: { Cookie: cookie }, body: JSON.stringify({ clientId: 1, letterType: "Fee estimate" }) },
      fakeEnv(),
    );
    expect((await res.json()).format).toBe("letter");
  });
});

describe("GET /api/letters", () => {
  it("rejects a request with no session", async () => {
    const res = await app.request("/api/letters", {}, fakeEnv());
    expect(res.status).toBe(401);
  });

  it("lists non-deleted letters for a client without their message histories", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/letters?clientId=1",
      { headers: { Cookie: cookie } },
      fakeEnv({ letters: [baseLetter({ stage: "composition", analysis_messages: JSON.stringify([{ role: "user", content: "hi" }]) })] }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ clientName: "Sarah Whitfield", stage: "composition" });
    expect(body[0].analysisMessages).toBeUndefined();
  });
});

describe("GET /api/letters/:id", () => {
  it("returns full detail including message histories", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/letters/1",
      { headers: { Cookie: cookie } },
      fakeEnv({
        letters: [
          baseLetter({
            stage: "composition",
            analysis_messages: JSON.stringify([{ role: "user", content: "The facts are..." }]),
            analysis_summary: "Key facts: ...",
          }),
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.analysisMessages).toEqual([{ role: "user", content: "The facts are..." }]);
    expect(body.analysisSummary).toBe("Key facts: ...");
  });

  it("404s for an unknown letter", async () => {
    const cookie = await sessionCookie();
    const res = await app.request("/api/letters/99", { headers: { Cookie: cookie } }, fakeEnv());
    expect(res.status).toBe(404);
  });
});

describe("POST /api/letters/:id/analysis", () => {
  it("reports not configured when ANTHROPIC_API_KEY is missing", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/letters/1/analysis",
      { method: "POST", headers: { Cookie: cookie }, body: JSON.stringify({ message: "Here are the facts." }) },
      fakeEnv({ letters: [baseLetter()] }),
    );
    expect(res.status).toBe(500);
  });

  it("rejects an empty message", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/letters/1/analysis",
      { method: "POST", headers: { Cookie: cookie }, body: JSON.stringify({ message: "  " }) },
      fakeEnv({ apiKey: API_KEY, letters: [baseLetter()] }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a letter that isn't in the analysis stage", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/letters/1/analysis",
      { method: "POST", headers: { Cookie: cookie }, body: JSON.stringify({ message: "More facts." }) },
      fakeEnv({ apiKey: API_KEY, letters: [baseLetter({ stage: "composition" })] }),
    );
    expect(res.status).toBe(400);
  });

  it("appends the exchange to analysis_messages and stays in the analysis stage", async () => {
    const cookie = await sessionCookie();
    vi.stubGlobal("fetch", vi.fn(async () => claudeResponse("What is the client's objective?")));
    const res = await app.request(
      "/api/letters/1/analysis",
      { method: "POST", headers: { Cookie: cookie }, body: JSON.stringify({ message: "The other party has filed a Form E." }) },
      fakeEnv({ apiKey: API_KEY, letters: [baseLetter()] }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.letter.stage).toBe("analysis");
    expect(body.letter.analysisMessages).toEqual([
      { role: "user", content: "The other party has filed a Form E." },
      { role: "assistant", content: "What is the client's objective?" },
    ]);
    expect(body.truncated).toBe(false);
  });

  it("frames the analyst as UK family law and forbids drafting in this stage", async () => {
    const cookie = await sessionCookie();
    const fetchMock = vi.fn(async () => claudeResponse("Understood."));
    vi.stubGlobal("fetch", fetchMock);
    await app.request(
      "/api/letters/1/analysis",
      { method: "POST", headers: { Cookie: cookie }, body: JSON.stringify({ message: "Facts." }) },
      fakeEnv({ apiKey: API_KEY, letters: [baseLetter()] }),
    );
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sentBody.system).toContain("UK family law");
    expect(sentBody.system).toContain("Never draft the actual letter or email text in this stage");
    expect(sentBody.system).toContain("Converge quickly");
  });

  it("flags a truncated reply and logs usage against the analysis endpoint", async () => {
    const cookie = await sessionCookie();
    const aiUsage: AiUsageRow[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => claudeResponse("What is the...", { input_tokens: 10, output_tokens: 5 }, "max_tokens")),
    );
    const res = await app.request(
      "/api/letters/1/analysis",
      { method: "POST", headers: { Cookie: cookie }, body: JSON.stringify({ message: "Facts." }) },
      fakeEnv({ apiKey: API_KEY, letters: [baseLetter()], aiUsage }),
    );
    expect((await res.json()).truncated).toBe(true);
    expect(aiUsage).toEqual([{ endpoint: "analysis", model: "claude-haiku-4-5", input_tokens: 10, output_tokens: 5 }]);
  });
});

describe("POST /api/letters/:id/analysis/summarize", () => {
  it("rejects when there's nothing to summarise yet", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/letters/1/analysis/summarize",
      { method: "POST", headers: { Cookie: cookie } },
      fakeEnv({ apiKey: API_KEY, letters: [baseLetter()] }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a letter not in the analysis stage", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/letters/1/analysis/summarize",
      { method: "POST", headers: { Cookie: cookie } },
      fakeEnv({
        apiKey: API_KEY,
        letters: [baseLetter({ stage: "composition", analysis_messages: JSON.stringify([{ role: "user", content: "hi" }]) })],
      }),
    );
    expect(res.status).toBe(400);
  });

  it("generates the Analysis Summary and transitions to composition", async () => {
    const cookie = await sessionCookie();
    vi.stubGlobal("fetch", vi.fn(async () => claudeResponse("Key facts: ...\nClient objective: ...")));
    const res = await app.request(
      "/api/letters/1/analysis/summarize",
      { method: "POST", headers: { Cookie: cookie } },
      fakeEnv({
        apiKey: API_KEY,
        letters: [baseLetter({ analysis_messages: JSON.stringify([{ role: "user", content: "The other party has filed a Form E." }]) })],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.letter.stage).toBe("composition");
    expect(body.letter.analysisSummary).toContain("Key facts");
  });
});

describe("POST /api/letters/:id/composition", () => {
  it("rejects a letter not in the composition stage", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/letters/1/composition",
      { method: "POST", headers: { Cookie: cookie }, body: JSON.stringify({ message: "Please draft it." }) },
      fakeEnv({ apiKey: API_KEY, letters: [baseLetter()] }),
    );
    expect(res.status).toBe(400);
  });

  it("drafts using the Analysis Summary and sets draftBody from the reply", async () => {
    const cookie = await sessionCookie();
    vi.stubGlobal("fetch", vi.fn(async () => claudeResponse("Dear {{CLIENT_NAME}}, thank you.")));
    const res = await app.request(
      "/api/letters/1/composition",
      { method: "POST", headers: { Cookie: cookie }, body: JSON.stringify({ message: "Please draft it." }) },
      fakeEnv({
        apiKey: API_KEY,
        letters: [baseLetter({ stage: "composition", analysis_summary: "Key facts: the client wants a fee estimate." })],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.letter.draftBody).toBe("Dear {{CLIENT_NAME}}, thank you.");
    expect(body.letter.stage).toBe("composition");
  });

  it("passes the Analysis Summary into the drafting agent's system prompt", async () => {
    const cookie = await sessionCookie();
    const fetchMock = vi.fn(async () => claudeResponse("Dear {{CLIENT_NAME}},"));
    vi.stubGlobal("fetch", fetchMock);
    await app.request(
      "/api/letters/1/composition",
      { method: "POST", headers: { Cookie: cookie }, body: JSON.stringify({ message: "Draft it." }) },
      fakeEnv({ apiKey: API_KEY, letters: [baseLetter({ stage: "composition", analysis_summary: "Key facts: XYZ." })] }),
    );
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sentBody.system).toContain("Key facts: XYZ.");
    expect(sentBody.system).toContain("Draft using your best professional judgement");
    expect(sentBody.system).toContain("`**Subheading**`");
  });

  it("asks for a subject line when format is email", async () => {
    const cookie = await sessionCookie();
    const fetchMock = vi.fn(async () => claudeResponse("Subject: Fee estimate\n\nDear {{CLIENT_NAME}},"));
    vi.stubGlobal("fetch", fetchMock);
    await app.request(
      "/api/letters/1/composition",
      { method: "POST", headers: { Cookie: cookie }, body: JSON.stringify({ message: "Draft it." }) },
      fakeEnv({ apiKey: API_KEY, letters: [baseLetter({ stage: "composition", format: "email" })] }),
    );
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sentBody.system).toContain("drafting an email");
    expect(sentBody.system).toContain("Subject:");
  });
});

describe("POST /api/letters/:id/review", () => {
  it("rejects a letter with nothing drafted yet", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/letters/1/review",
      { method: "POST", headers: { Cookie: cookie } },
      fakeEnv({ letters: [baseLetter({ stage: "composition", draft_body: "" })] }),
    );
    expect(res.status).toBe(400);
  });

  it("always runs the deterministic PII scan and appends a round, even without an API key", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/letters/1/review",
      { method: "POST", headers: { Cookie: cookie } },
      fakeEnv({ letters: [baseLetter({ stage: "composition", draft_body: "Contact sarah@example.com for details." })] }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.letter.stage).toBe("review");
    expect(body.letter.reviewRounds).toHaveLength(1);
    expect(body.letter.reviewRounds[0].piiScanClean).toBe(false);
    expect(body.letter.reviewRounds[0].reviewConfigured).toBe(false);
  });

  it("parses OK/CONCERN lines into flags for the round and mirrors them onto the legacy columns", async () => {
    const cookie = await sessionCookie();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => claudeResponse("OK: Tone is appropriate.\nCONCERN: Doesn't mention the estimate expiry.")),
    );
    const res = await app.request(
      "/api/letters/1/review",
      { method: "POST", headers: { Cookie: cookie } },
      fakeEnv({
        apiKey: API_KEY,
        letters: [baseLetter({ stage: "composition", draft_body: "Dear {{CLIENT_NAME}}, this is an estimate." })],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.letter.reviewRounds[0].flags).toEqual([
      { severity: "ok", text: "Tone is appropriate." },
      { severity: "concern", text: "Doesn't mention the estimate expiry." },
    ]);
    expect(body.letter.reviewFlags).toEqual(body.letter.reviewRounds[0].flags);
  });

  it("appends a second round rather than replacing the first when reviewed again", async () => {
    const cookie = await sessionCookie();
    vi.stubGlobal("fetch", vi.fn(async () => claudeResponse("OK: Fine.")));
    const existingRound = {
      createdAt: "2026-09-14T12:30:00.000Z",
      draftSnapshot: "Old draft",
      piiScanClean: true,
      piiMatches: [],
      reviewConfigured: true,
      truncated: false,
      flags: [{ severity: "concern", text: "Old concern." }],
      selectedFlagTexts: ["Old concern."],
      feedbackText: null,
      respondedAt: "2026-09-14T12:35:00.000Z",
    };
    const res = await app.request(
      "/api/letters/1/review",
      { method: "POST", headers: { Cookie: cookie } },
      fakeEnv({
        apiKey: API_KEY,
        letters: [
          baseLetter({
            stage: "composition",
            draft_body: "Dear {{CLIENT_NAME}}, revised.",
            review_rounds: JSON.stringify([existingRound]),
          }),
        ],
      }),
    );
    const body = await res.json();
    expect(body.letter.reviewRounds).toHaveLength(2);
    expect(body.letter.reviewRounds[0]).toMatchObject({ draftSnapshot: "Old draft" });
  });

  it("includes the Analysis Summary and drafting conversation in the reviewer's system prompt", async () => {
    const cookie = await sessionCookie();
    const fetchMock = vi.fn(async () => claudeResponse("OK: Fine."));
    vi.stubGlobal("fetch", fetchMock);
    await app.request(
      "/api/letters/1/review",
      { method: "POST", headers: { Cookie: cookie } },
      fakeEnv({
        apiKey: API_KEY,
        letters: [
          baseLetter({
            stage: "composition",
            draft_body: "Dear {{CLIENT_NAME}}, the estimate is £500.",
            analysis_summary: "Key facts: the estimate is £450.",
            composition_messages: JSON.stringify([
              { role: "user", content: "Please draft it." },
              { role: "assistant", content: "Dear {{CLIENT_NAME}}, the estimate is £500." },
            ]),
          }),
        ],
      }),
    );
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sentBody.system).toContain("supervising solicitor");
    expect(sentBody.system).toContain("Key facts: the estimate is £450.");
    expect(sentBody.system).toContain("Drafting conversation:");
    expect(sentBody.system).toContain("Only raise a CONCERN for something materially wrong");
  });
});

describe("POST /api/letters/:id/review/feedback", () => {
  const round = {
    createdAt: "2026-09-14T12:30:00.000Z",
    draftSnapshot: "Dear {{CLIENT_NAME}}, draft one.",
    piiScanClean: true,
    piiMatches: [],
    reviewConfigured: true,
    truncated: false,
    flags: [
      { severity: "ok", text: "Tone is fine." },
      { severity: "concern", text: "Doesn't mention the estimate expiry." },
    ],
    selectedFlagTexts: null,
    feedbackText: null,
    respondedAt: null,
  };

  it("rejects when no flags are selected and no feedback text is given", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/letters/1/review/feedback",
      { method: "POST", headers: { Cookie: cookie }, body: JSON.stringify({ selectedFlagIndexes: [] }) },
      fakeEnv({
        apiKey: API_KEY,
        letters: [baseLetter({ stage: "review", draft_body: "Dear {{CLIENT_NAME}}, draft one.", review_rounds: JSON.stringify([round]) })],
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a letter not in the review stage", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/letters/1/review/feedback",
      { method: "POST", headers: { Cookie: cookie }, body: JSON.stringify({ feedbackText: "Fix it." }) },
      fakeEnv({ apiKey: API_KEY, letters: [baseLetter({ stage: "composition" })] }),
    );
    expect(res.status).toBe(400);
  });

  it("records the selection and feedback on the round, forwards it as a drafting turn, and routes back to composition", async () => {
    const cookie = await sessionCookie();
    const fetchMock = vi.fn(async () => claudeResponse("Dear {{CLIENT_NAME}}, draft two, now mentioning expiry."));
    vi.stubGlobal("fetch", fetchMock);
    const res = await app.request(
      "/api/letters/1/review/feedback",
      {
        method: "POST",
        headers: { Cookie: cookie },
        body: JSON.stringify({ selectedFlagIndexes: [1], feedbackText: "Also mention the 30-day validity." }),
      },
      fakeEnv({
        apiKey: API_KEY,
        letters: [baseLetter({ stage: "review", draft_body: "Dear {{CLIENT_NAME}}, draft one.", review_rounds: JSON.stringify([round]) })],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.letter.stage).toBe("composition");
    expect(body.letter.draftBody).toBe("Dear {{CLIENT_NAME}}, draft two, now mentioning expiry.");
    expect(body.letter.reviewRounds[0].selectedFlagTexts).toEqual(["Doesn't mention the estimate expiry."]);
    expect(body.letter.reviewRounds[0].feedbackText).toBe("Also mention the 30-day validity.");
    expect(body.letter.reviewRounds[0].respondedAt).not.toBeNull();

    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    const lastMessage = sentBody.messages[sentBody.messages.length - 1];
    expect(lastMessage.content).toContain("Doesn't mention the estimate expiry.");
    expect(lastMessage.content).toContain("Also mention the 30-day validity.");
  });
});

describe("POST /api/letters/:id/back", () => {
  it("rejects an invalid target stage", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/letters/1/back",
      { method: "POST", headers: { Cookie: cookie }, body: JSON.stringify({ stage: "review" }) },
      fakeEnv({ letters: [baseLetter({ stage: "composition" })] }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects going back on an already-finalized letter", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/letters/1/back",
      { method: "POST", headers: { Cookie: cookie }, body: JSON.stringify({ stage: "composition" }) },
      fakeEnv({ letters: [baseLetter({ stage: "finalized", draft_body: "Final." })] }),
    );
    expect(res.status).toBe(400);
  });

  it("moves the stage pointer without touching any message history", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/letters/1/back",
      { method: "POST", headers: { Cookie: cookie }, body: JSON.stringify({ stage: "analysis" }) },
      fakeEnv({
        letters: [
          baseLetter({
            stage: "review",
            draft_body: "Dear {{CLIENT_NAME}},",
            analysis_messages: JSON.stringify([{ role: "user", content: "Facts." }]),
          }),
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.letter.stage).toBe("analysis");
    expect(body.letter.analysisMessages).toEqual([{ role: "user", content: "Facts." }]);
    expect(body.letter.draftBody).toBe("Dear {{CLIENT_NAME}},");
  });
});

describe("POST /api/letters/:id/finalize", () => {
  it("rejects a letter with nothing drafted", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/letters/1/finalize",
      { method: "POST", headers: { Cookie: cookie } },
      fakeEnv({ letters: [baseLetter({ draft_body: "" })] }),
    );
    expect(res.status).toBe(400);
  });

  it("finalizes without a process summary when the AI isn't configured", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/letters/1/finalize",
      { method: "POST", headers: { Cookie: cookie } },
      fakeEnv({ letters: [baseLetter({ stage: "review", draft_body: "Dear {{CLIENT_NAME}}," })] }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.letter.stage).toBe("finalized");
    expect(body.letter.processSummary).toBeNull();
  });

  it("generates an AI-written narrative process summary and mirrors the last round onto the legacy columns", async () => {
    const cookie = await sessionCookie();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => claudeResponse("The analyst established the key facts, then the draft went through one revision.")),
    );
    const round = {
      createdAt: "2026-09-14T12:30:00.000Z",
      draftSnapshot: "Dear {{CLIENT_NAME}},",
      piiScanClean: true,
      piiMatches: [],
      reviewConfigured: true,
      truncated: false,
      flags: [{ severity: "ok", text: "Fine." }],
      selectedFlagTexts: null,
      feedbackText: null,
      respondedAt: null,
    };
    const res = await app.request(
      "/api/letters/1/finalize",
      { method: "POST", headers: { Cookie: cookie } },
      fakeEnv({
        apiKey: API_KEY,
        letters: [baseLetter({ stage: "review", draft_body: "Dear {{CLIENT_NAME}},", review_rounds: JSON.stringify([round]) })],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.letter.stage).toBe("finalized");
    expect(body.letter.processSummary).toContain("key facts");
    expect(body.letter.reviewFlags).toEqual([{ severity: "ok", text: "Fine." }]);
    expect(body.letter.piiScanClean).toBe(true);
  });

  it("logs the finalize call's usage against the finalize-summary endpoint", async () => {
    const cookie = await sessionCookie();
    const aiUsage: AiUsageRow[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => claudeResponse("Narrative.", { input_tokens: 20, output_tokens: 8 })));
    await app.request(
      "/api/letters/1/finalize",
      { method: "POST", headers: { Cookie: cookie } },
      fakeEnv({ apiKey: API_KEY, letters: [baseLetter({ stage: "review", draft_body: "Dear {{CLIENT_NAME}}," })], aiUsage }),
    );
    expect(aiUsage).toEqual([{ endpoint: "finalize-summary", model: "claude-haiku-4-5", input_tokens: 20, output_tokens: 8 }]);
  });
});

describe("DELETE /api/letters/:id", () => {
  it("404s when the letter doesn't exist or is already deleted", async () => {
    const cookie = await sessionCookie();
    const res = await app.request("/api/letters/99", { method: "DELETE", headers: { Cookie: cookie } }, fakeEnv());
    expect(res.status).toBe(404);
  });

  it("soft-deletes an existing letter", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/letters/1",
      { method: "DELETE", headers: { Cookie: cookie } },
      fakeEnv({ letters: [baseLetter()] }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("GET /api/letters/deleted", () => {
  it("lists soft-deleted letters with who deleted them", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/letters/deleted",
      { headers: { Cookie: cookie } },
      fakeEnv({ letters: [baseLetter({ deleted_at: "2026-09-14T13:00:00.000Z", deleted_by: 1 })] }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0]).toMatchObject({ deletedByEmail: "anita@example.com" });
  });
});

describe("GET /api/letters/usage", () => {
  it("rejects a request with no session", async () => {
    const res = await app.request("/api/letters/usage", {}, fakeEnv());
    expect(res.status).toBe(401);
  });

  it("returns zeroed totals with no recorded usage", async () => {
    const cookie = await sessionCookie();
    const res = await app.request("/api/letters/usage", { headers: { Cookie: cookie } }, fakeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      totalInputTokens: 0,
      totalOutputTokens: 0,
      estimatedCostUsd: 0,
      byModel: [],
    });
  });

  it("sums usage per model and estimates cost from each model's published pricing", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/letters/usage",
      { headers: { Cookie: cookie } },
      fakeEnv({
        aiUsage: [
          { endpoint: "analysis", model: "claude-haiku-4-5", input_tokens: 1_000_000, output_tokens: 1_000_000 },
          { endpoint: "review", model: "claude-haiku-4-5", input_tokens: 1_000_000, output_tokens: 0 },
          { endpoint: "composition", model: "claude-sonnet-5", input_tokens: 1_000_000, output_tokens: 1_000_000 },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalInputTokens).toBe(3_000_000);
    expect(body.totalOutputTokens).toBe(2_000_000);
    expect(body.estimatedCostUsd).toBeCloseTo(19, 5);
  });
});
