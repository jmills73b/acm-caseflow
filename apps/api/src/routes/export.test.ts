import { describe, expect, it } from "vitest";
import { createSessionToken } from "@acm-caseflow/core";
import app from "../index";
import type { Env } from "../index";

const SECRET = "test-secret";

async function sessionCookie(): Promise<string> {
  return `session=${await createSessionToken({ userId: 1, exp: Math.floor(Date.now() / 1000) + 60 }, SECRET)}`;
}

function fakeEnv(options: { rowsByTable?: Record<string, unknown[]> } = {}): Env {
  const rowsByTable = options.rowsByTable ?? {};

  return {
    SESSION_SECRET: SECRET,
    DB: {
      prepare: (sql: string) => ({
        all: async () => {
          const match = sql.match(/SELECT \* FROM (\w+)/);
          const table = match?.[1] ?? "";
          return { results: rowsByTable[table] ?? [], success: true, meta: {} };
        },
      }),
    } as unknown as D1Database,
  };
}

describe("GET /api/export", () => {
  it("rejects a request with no session", async () => {
    const res = await app.request("/api/export", {}, fakeEnv());
    expect(res.status).toBe(401);
  });

  it("returns every business table keyed by name, with a timestamp", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/export",
      { headers: { Cookie: cookie } },
      fakeEnv({
        rowsByTable: {
          clients: [{ id: 1, name: "Smith" }],
          invoices: [{ id: 1, total_amount: 500 }],
        },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.exportedAt).toBe("string");
    expect(body.tables.clients).toEqual([{ id: 1, name: "Smith" }]);
    expect(body.tables.invoices).toEqual([{ id: 1, total_amount: 500 }]);
    // Every other business table is present too, even if empty in this test.
    expect(Object.keys(body.tables)).toEqual([
      "clients",
      "client_categories",
      "client_category_links",
      "client_notes",
      "client_note_versions",
      "note_categories",
      "document_categories",
      "documents",
      "letter_categories",
      "letters",
      "tasks",
      "task_occurrences",
      "intermediary_firms",
      "invoices",
      "invoice_batches",
      "invoice_settings",
      "expenses",
      "expense_categories",
      "time_entries",
      "time_categories",
      "time_settings",
      "hourly_rates",
      "tax_year_settings",
    ]);
  });

  it("never includes users or account_settings", async () => {
    const cookie = await sessionCookie();
    const res = await app.request("/api/export", { headers: { Cookie: cookie } }, fakeEnv());
    const body = await res.json();
    expect(body.tables.users).toBeUndefined();
    expect(body.tables.account_settings).toBeUndefined();
  });
});
