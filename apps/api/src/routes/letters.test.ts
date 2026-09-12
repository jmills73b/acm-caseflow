import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionToken } from "@acm-caseflow/core";
import app from "../index";
import type { Env } from "../index";

const SECRET = "test-secret";
const API_KEY = "test-anthropic-key";

async function sessionCookie(userId = 1): Promise<string> {
  return `session=${await createSessionToken({ userId, exp: Math.floor(Date.now() / 1000) + 60 }, SECRET)}`;
}

function claudeResponse(text: string, usage = { input_tokens: 42, output_tokens: 84 }) {
  return new Response(JSON.stringify({ content: [{ type: "text", text }], usage }), { status: 200 });
}

interface LetterRow {
  id: number;
  client_id: number;
  letter_type: string | null;
  personal_fields: string;
  draft_body: string;
  review_flags: string | null;
  pii_scan_clean: number | null;
  created_by: number;
  created_at: string;
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
    letters?: LetterRow[];
    complianceGuidelines?: string;
    aiModel?: string;
    aiUsage?: AiUsageRow[];
  } = {},
): Env {
  const clients = options.clients ?? [{ id: 1, name: "Sarah Whitfield" }];
  const users = options.users ?? [{ id: 1, email: "anita@example.com" }];
  const letterStore = new Map<number, LetterRow>((options.letters ?? []).map((l) => [l.id, l]));
  let nextId = Math.max(0, ...[...letterStore.keys()]) + 1;
  const complianceGuidelines = options.complianceGuidelines ?? "";
  const aiModel = options.aiModel ?? null;
  // Not a copy -- tests pass their own array in to observe what gets logged.
  const aiUsageRows: AiUsageRow[] = options.aiUsage ?? [];

  function enrich(row: LetterRow) {
    return {
      id: row.id,
      client_id: row.client_id,
      client_name: clients.find((c) => c.id === row.client_id)?.name ?? "",
      letter_type: row.letter_type,
      personal_fields: row.personal_fields,
      draft_body: row.draft_body,
      review_flags: row.review_flags,
      pii_scan_clean: row.pii_scan_clean,
      created_by_email: users.find((u) => u.id === row.created_by)?.email ?? "",
      created_at: row.created_at,
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
              const [clientId, letterType, personalFields, draftBody, reviewFlags, piiScanClean, createdBy] =
                boundArgs as [
                  number,
                  string | null,
                  string,
                  string,
                  string | null,
                  number | null,
                  number,
                ];
              const id = nextId++;
              letterStore.set(id, {
                id,
                client_id: clientId,
                letter_type: letterType,
                personal_fields: personalFields,
                draft_body: draftBody,
                review_flags: reviewFlags,
                pii_scan_clean: piiScanClean,
                created_by: createdBy,
                created_at: "2026-09-12T12:00:00.000Z",
                deleted_at: null,
                deleted_by: null,
              });
              return { id } as T;
            }
            if (sql.includes("WHERE letters.id = ?")) {
              const [id] = boundArgs as [number];
              const row = letterStore.get(id);
              return (row ? enrich(row) : null) as T;
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
              row.deleted_at = "2026-09-12T13:00:00.000Z";
              row.deleted_by = deletedBy;
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /api/letters", () => {
  it("rejects a request with no session", async () => {
    const res = await app.request("/api/letters", {}, fakeEnv());
    expect(res.status).toBe(401);
  });

  it("lists non-deleted letters for a client", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/letters?clientId=1",
      { headers: { Cookie: cookie } },
      fakeEnv({
        letters: [
          {
            id: 1,
            client_id: 1,
            letter_type: "Fee estimate cover letter",
            personal_fields: JSON.stringify(["CLIENT_NAME"]),
            draft_body: "Dear {{CLIENT_NAME}},",
            review_flags: null,
            pii_scan_clean: 1,
            created_by: 1,
            created_at: "2026-09-12T12:00:00.000Z",
            deleted_at: null,
            deleted_by: null,
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ clientName: "Sarah Whitfield", letterType: "Fee estimate cover letter" });
  });
});

describe("POST /api/letters/chat", () => {
  const validBody = {
    letterType: "Fee estimate cover letter for the ancillary relief matter",
    personalFields: ["CLIENT_NAME"],
    messages: [{ role: "user", content: "Please draft this letter." }],
  };

  it("reports not configured when ANTHROPIC_API_KEY is missing", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/letters/chat",
      { method: "POST", headers: { Cookie: cookie }, body: JSON.stringify(validBody) },
      fakeEnv(),
    );
    expect(res.status).toBe(500);
  });

  it("rejects a missing letterType", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/letters/chat",
      {
        method: "POST",
        headers: { Cookie: cookie },
        body: JSON.stringify({ ...validBody, letterType: undefined }),
      },
      fakeEnv({ apiKey: API_KEY }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects an empty messages array", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/letters/chat",
      { method: "POST", headers: { Cookie: cookie }, body: JSON.stringify({ ...validBody, messages: [] }) },
      fakeEnv({ apiKey: API_KEY }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects messages that don't end with a user turn", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/letters/chat",
      {
        method: "POST",
        headers: { Cookie: cookie },
        body: JSON.stringify({
          ...validBody,
          messages: [
            { role: "user", content: "Please draft this letter." },
            { role: "assistant", content: "What amount should I include?" },
          ],
        }),
      },
      fakeEnv({ apiKey: API_KEY }),
    );
    expect(res.status).toBe(400);
  });

  it("returns the drafting agent's reply", async () => {
    const cookie = await sessionCookie();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => claudeResponse("Dear {{CLIENT_NAME}},\n\nThank you.")),
    );
    const res = await app.request(
      "/api/letters/chat",
      { method: "POST", headers: { Cookie: cookie }, body: JSON.stringify(validBody) },
      fakeEnv({ apiKey: API_KEY }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).reply).toContain("{{CLIENT_NAME}}");
  });

  it("carries the full conversation through to the Anthropic call", async () => {
    const cookie = await sessionCookie();
    const fetchMock = vi.fn(async () => claudeResponse("Dear {{CLIENT_NAME}}, following up as discussed."));
    vi.stubGlobal("fetch", fetchMock);
    const conversation = {
      ...validBody,
      messages: [
        { role: "user", content: "Please draft this letter." },
        { role: "assistant", content: "What tone would you like?" },
        { role: "user", content: "Warm but professional." },
      ],
    };
    const res = await app.request(
      "/api/letters/chat",
      { method: "POST", headers: { Cookie: cookie }, body: JSON.stringify(conversation) },
      fakeEnv({ apiKey: API_KEY }),
    );
    expect(res.status).toBe(200);
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sentBody.messages).toEqual(conversation.messages);
  });

  it("surfaces an error when the Anthropic API call fails", async () => {
    const cookie = await sessionCookie();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    const res = await app.request(
      "/api/letters/chat",
      { method: "POST", headers: { Cookie: cookie }, body: JSON.stringify(validBody) },
      fakeEnv({ apiKey: API_KEY }),
    );
    expect(res.status).toBe(502);
  });

  it("sends the account's configured AI model to Anthropic, defaulting to Haiku 4.5", async () => {
    const cookie = await sessionCookie();
    const fetchMock = vi.fn(async () => claudeResponse("Dear {{CLIENT_NAME}},"));
    vi.stubGlobal("fetch", fetchMock);
    await app.request(
      "/api/letters/chat",
      { method: "POST", headers: { Cookie: cookie }, body: JSON.stringify(validBody) },
      fakeEnv({ apiKey: API_KEY, aiModel: "claude-sonnet-5" }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe("claude-sonnet-5");

    const fetchMockDefault = vi.fn(async () => claudeResponse("Dear {{CLIENT_NAME}},"));
    vi.stubGlobal("fetch", fetchMockDefault);
    await app.request(
      "/api/letters/chat",
      { method: "POST", headers: { Cookie: cookie }, body: JSON.stringify(validBody) },
      fakeEnv({ apiKey: API_KEY }),
    );
    expect(JSON.parse(fetchMockDefault.mock.calls[0][1].body).model).toBe("claude-haiku-4-5");
  });

  it("logs the call's token usage against the model used", async () => {
    const cookie = await sessionCookie();
    const aiUsage: AiUsageRow[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => claudeResponse("Dear {{CLIENT_NAME}},", { input_tokens: 120, output_tokens: 60 })),
    );
    const res = await app.request(
      "/api/letters/chat",
      { method: "POST", headers: { Cookie: cookie }, body: JSON.stringify(validBody) },
      fakeEnv({ apiKey: API_KEY, aiModel: "claude-sonnet-5", aiUsage }),
    );
    expect(res.status).toBe(200);
    expect(aiUsage).toEqual([
      { endpoint: "chat", model: "claude-sonnet-5", input_tokens: 120, output_tokens: 60 },
    ]);
  });
});

describe("POST /api/letters/review", () => {
  it("rejects a missing draftBody", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/letters/review",
      { method: "POST", headers: { Cookie: cookie }, body: JSON.stringify({}) },
      fakeEnv(),
    );
    expect(res.status).toBe(400);
  });

  it("always runs the deterministic PII scan, even without an API key", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/letters/review",
      {
        method: "POST",
        headers: { Cookie: cookie },
        body: JSON.stringify({ draftBody: "Contact sarah@example.com for details." }),
      },
      fakeEnv(),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.piiScanClean).toBe(false);
    expect(body.reviewConfigured).toBe(false);
    expect(body.flags).toEqual([]);
  });

  it("reports the scan clean for a letter using only placeholder tokens", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/letters/review",
      {
        method: "POST",
        headers: { Cookie: cookie },
        body: JSON.stringify({ draftBody: "Dear {{CLIENT_NAME}}, thank you." }),
      },
      fakeEnv(),
    );
    const body = await res.json();
    expect(body.piiScanClean).toBe(true);
  });

  it("parses OK/CONCERN lines from the review agent into flags", async () => {
    const cookie = await sessionCookie();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => claudeResponse("OK: Tone is appropriate.\nCONCERN: Doesn't mention the estimate expiry.")),
    );
    const res = await app.request(
      "/api/letters/review",
      {
        method: "POST",
        headers: { Cookie: cookie },
        body: JSON.stringify({ draftBody: "Dear {{CLIENT_NAME}}, this is an estimate." }),
      },
      fakeEnv({ apiKey: API_KEY, complianceGuidelines: "State estimate validity." }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reviewConfigured).toBe(true);
    expect(body.flags).toEqual([
      { severity: "ok", text: "Tone is appropriate." },
      { severity: "concern", text: "Doesn't mention the estimate expiry." },
    ]);
  });

  it("logs the review call's token usage", async () => {
    const cookie = await sessionCookie();
    const aiUsage: AiUsageRow[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => claudeResponse("OK: Fine.", { input_tokens: 30, output_tokens: 10 })),
    );
    const res = await app.request(
      "/api/letters/review",
      {
        method: "POST",
        headers: { Cookie: cookie },
        body: JSON.stringify({ draftBody: "Dear {{CLIENT_NAME}}," }),
      },
      fakeEnv({ apiKey: API_KEY, aiModel: "claude-haiku-4-5", aiUsage }),
    );
    expect(res.status).toBe(200);
    expect(aiUsage).toEqual([
      { endpoint: "review", model: "claude-haiku-4-5", input_tokens: 30, output_tokens: 10 },
    ]);
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
          { endpoint: "chat", model: "claude-haiku-4-5", input_tokens: 1_000_000, output_tokens: 1_000_000 },
          { endpoint: "review", model: "claude-haiku-4-5", input_tokens: 1_000_000, output_tokens: 0 },
          { endpoint: "chat", model: "claude-sonnet-5", input_tokens: 1_000_000, output_tokens: 1_000_000 },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalInputTokens).toBe(3_000_000);
    expect(body.totalOutputTokens).toBe(2_000_000);
    // Haiku 4.5: 2M in * $1/MTok + 1M out * $5/MTok = $7. Sonnet 5: 1M in * $2/MTok + 1M out * $10/MTok = $12.
    expect(body.estimatedCostUsd).toBeCloseTo(19, 5);
    expect(body.byModel).toEqual(
      expect.arrayContaining([
        { model: "claude-haiku-4-5", inputTokens: 2_000_000, outputTokens: 1_000_000, estimatedCostUsd: 7 },
        { model: "claude-sonnet-5", inputTokens: 1_000_000, outputTokens: 1_000_000, estimatedCostUsd: 12 },
      ]),
    );
  });
});

describe("POST /api/letters", () => {
  it("rejects a missing clientId", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/letters",
      { method: "POST", headers: { Cookie: cookie }, body: JSON.stringify({ draftBody: "Dear {{CLIENT_NAME}}," }) },
      fakeEnv(),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a missing draftBody", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/letters",
      { method: "POST", headers: { Cookie: cookie }, body: JSON.stringify({ clientId: 1 }) },
      fakeEnv(),
    );
    expect(res.status).toBe(400);
  });

  it("404s for an unknown client", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/letters",
      {
        method: "POST",
        headers: { Cookie: cookie },
        body: JSON.stringify({ clientId: 99, draftBody: "Dear {{CLIENT_NAME}}," }),
      },
      fakeEnv(),
    );
    expect(res.status).toBe(404);
  });

  it("saves a letter and returns it with the client name and letter type", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/letters",
      {
        method: "POST",
        headers: { Cookie: cookie },
        body: JSON.stringify({
          clientId: 1,
          letterType: "Fee estimate cover letter",
          personalFields: ["CLIENT_NAME"],
          draftBody: "Dear {{CLIENT_NAME}},",
          reviewFlags: [{ severity: "ok", text: "Fine." }],
          piiScanClean: true,
        }),
      },
      fakeEnv(),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({
      clientName: "Sarah Whitfield",
      letterType: "Fee estimate cover letter",
      draftBody: "Dear {{CLIENT_NAME}},",
      piiScanClean: true,
    });
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
      fakeEnv({
        letters: [
          {
            id: 1,
            client_id: 1,
            letter_type: null,
            personal_fields: "[]",
            draft_body: "Dear {{CLIENT_NAME}},",
            review_flags: null,
            pii_scan_clean: null,
            created_by: 1,
            created_at: "2026-09-12T12:00:00.000Z",
            deleted_at: null,
            deleted_by: null,
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
