import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionToken } from "@acm-caseflow/core";
import app from "../index";
import type { Env } from "../index";

const SECRET = "test-secret";
const API_KEY = "test-anthropic-key";

async function sessionCookie(userId = 1): Promise<string> {
  return `session=${await createSessionToken({ userId, exp: Math.floor(Date.now() / 1000) + 60 }, SECRET)}`;
}

function claudeResponse(text: string) {
  return new Response(JSON.stringify({ content: [{ type: "text", text }] }), { status: 200 });
}

interface LetterRow {
  id: number;
  client_id: number;
  letter_category_id: number | null;
  amount: number | null;
  reference: string | null;
  key_date: string | null;
  tone: string | null;
  personal_fields: string;
  bespoke_request: string | null;
  draft_body: string;
  review_flags: string | null;
  pii_scan_clean: number | null;
  created_by: number;
  created_at: string;
  deleted_at: string | null;
  deleted_by: number | null;
}

function fakeEnv(
  options: {
    apiKey?: string;
    clients?: Array<{ id: number; name: string }>;
    categories?: Array<{ id: number; name: string; drafting_instruction: string }>;
    users?: Array<{ id: number; email: string }>;
    letters?: LetterRow[];
    complianceGuidelines?: string;
  } = {},
): Env {
  const clients = options.clients ?? [{ id: 1, name: "Sarah Whitfield" }];
  const categories = options.categories ?? [{ id: 1, name: "Fee estimate cover letter", drafting_instruction: "" }];
  const users = options.users ?? [{ id: 1, email: "anita@example.com" }];
  const letterStore = new Map<number, LetterRow>((options.letters ?? []).map((l) => [l.id, l]));
  let nextId = Math.max(0, ...[...letterStore.keys()]) + 1;
  const complianceGuidelines = options.complianceGuidelines ?? "";

  function enrich(row: LetterRow) {
    return {
      id: row.id,
      client_id: row.client_id,
      client_name: clients.find((c) => c.id === row.client_id)?.name ?? "",
      letter_category_id: row.letter_category_id,
      category_name: categories.find((c) => c.id === row.letter_category_id)?.name ?? null,
      amount: row.amount,
      reference: row.reference,
      key_date: row.key_date,
      tone: row.tone,
      personal_fields: row.personal_fields,
      bespoke_request: row.bespoke_request,
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
            if (sql.includes("SELECT drafting_instruction FROM letter_categories")) {
              const [id] = boundArgs as [number];
              const cat = categories.find((c) => c.id === id);
              return (cat ? { drafting_instruction: cat.drafting_instruction } : null) as T;
            }
            if (sql.includes("SELECT compliance_guidelines FROM account_settings")) {
              return { compliance_guidelines: complianceGuidelines } as T;
            }
            if (sql.includes("SELECT id FROM clients WHERE id = ?")) {
              const [id] = boundArgs as [number];
              return (clients.some((c) => c.id === id) ? { id } : null) as T;
            }
            if (sql.includes("INSERT INTO letters")) {
              const [
                clientId,
                letterCategoryId,
                amount,
                reference,
                keyDate,
                tone,
                personalFields,
                bespokeRequest,
                draftBody,
                reviewFlags,
                piiScanClean,
                createdBy,
              ] = boundArgs as [
                number,
                number | null,
                number | null,
                string | null,
                string | null,
                string | null,
                string,
                string | null,
                string,
                string | null,
                number | null,
                number,
              ];
              const id = nextId++;
              letterStore.set(id, {
                id,
                client_id: clientId,
                letter_category_id: letterCategoryId,
                amount,
                reference,
                key_date: keyDate,
                tone,
                personal_fields: personalFields,
                bespoke_request: bespokeRequest,
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
            letter_category_id: 1,
            amount: 1450,
            reference: "WHIT-2026-04",
            key_date: "2026-11-26",
            tone: "Reassuring",
            personal_fields: JSON.stringify(["CLIENT_NAME"]),
            bespoke_request: null,
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
    expect(body[0]).toMatchObject({ clientName: "Sarah Whitfield", categoryName: "Fee estimate cover letter" });
  });
});

describe("POST /api/letters/draft", () => {
  it("reports not configured when ANTHROPIC_API_KEY is missing", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/letters/draft",
      { method: "POST", headers: { Cookie: cookie }, body: JSON.stringify({ clientId: 1 }) },
      fakeEnv(),
    );
    expect(res.status).toBe(500);
  });

  it("returns the drafted letter body from Claude", async () => {
    const cookie = await sessionCookie();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => claudeResponse("Dear {{CLIENT_NAME}},\n\nThank you.")),
    );
    const res = await app.request(
      "/api/letters/draft",
      {
        method: "POST",
        headers: { Cookie: cookie },
        body: JSON.stringify({
          clientId: 1,
          letterCategoryId: 1,
          amount: 1450,
          personalFields: ["CLIENT_NAME"],
        }),
      },
      fakeEnv({ apiKey: API_KEY }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).draftBody).toContain("{{CLIENT_NAME}}");
  });

  it("surfaces an error when the Anthropic API call fails", async () => {
    const cookie = await sessionCookie();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    const res = await app.request(
      "/api/letters/draft",
      { method: "POST", headers: { Cookie: cookie }, body: JSON.stringify({ clientId: 1 }) },
      fakeEnv({ apiKey: API_KEY }),
    );
    expect(res.status).toBe(502);
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

  it("saves a letter and returns it with the client and category names", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/letters",
      {
        method: "POST",
        headers: { Cookie: cookie },
        body: JSON.stringify({
          clientId: 1,
          letterCategoryId: 1,
          amount: 1450,
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
      categoryName: "Fee estimate cover letter",
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
            letter_category_id: null,
            amount: null,
            reference: null,
            key_date: null,
            tone: null,
            personal_fields: "[]",
            bespoke_request: null,
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
