import { describe, expect, it } from "vitest";
import { createSessionToken } from "@acm-caseflow/core";
import app from "../index";
import type { Env } from "../index";

const SECRET = "test-secret";

async function sessionCookie(): Promise<string> {
  return `session=${await createSessionToken({ userId: 1, exp: Math.floor(Date.now() / 1000) + 60 }, SECRET)}`;
}

interface StoredCategory {
  id: number;
  name: string;
  drafting_instruction: string;
  sort_order: number;
}

function fakeEnv(options: { categories?: StoredCategory[] } = {}): Env {
  const categoryStore = new Map<number, StoredCategory>((options.categories ?? []).map((c) => [c.id, c]));
  let nextId = Math.max(0, ...[...categoryStore.keys()]) + 1;

  return {
    SESSION_SECRET: SECRET,
    DB: {
      prepare: (sql: string) => {
        let boundArgs: unknown[] = [];
        const statement = {
          bind: (...args: unknown[]) => {
            boundArgs = args;
            return statement;
          },
          first: async <T,>() => {
            if (sql.includes("MAX(sort_order)")) {
              const max = Math.max(0, ...[...categoryStore.values()].map((c) => c.sort_order));
              return { maxOrder: categoryStore.size ? max : null } as T;
            }
            if (sql.includes("WHERE name = ? AND id != ?")) {
              const [name, id] = boundArgs as [string, number];
              const dup = [...categoryStore.values()].find((c) => c.name === name && c.id !== id);
              return (dup ? { id: dup.id } : null) as T;
            }
            if (sql.includes("WHERE name = ?")) {
              const [name] = boundArgs as [string];
              const dup = [...categoryStore.values()].find((c) => c.name === name);
              return (dup ? { id: dup.id } : null) as T;
            }
            if (sql.includes("INSERT INTO letter_categories")) {
              const [name, draftingInstruction, sortOrder] = boundArgs as [string, string, number];
              const id = nextId++;
              const row = { id, name, drafting_instruction: draftingInstruction, sort_order: sortOrder };
              categoryStore.set(id, row);
              return row as T;
            }
            if (sql.includes("UPDATE letter_categories SET name")) {
              const [name, draftingInstruction, id] = boundArgs as [string, string, number];
              const existing = categoryStore.get(id);
              if (!existing) return null as T;
              const updated = { ...existing, name, drafting_instruction: draftingInstruction };
              categoryStore.set(id, updated);
              return updated as T;
            }
            if (sql.includes("SELECT id FROM letter_categories WHERE id = ?")) {
              const [id] = boundArgs as [number];
              return (categoryStore.has(id) ? { id } : null) as T;
            }
            return null;
          },
          all: async <T,>() => {
            const rows = [...categoryStore.values()].sort(
              (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name),
            );
            return { results: rows as T[], success: true, meta: {} };
          },
          run: async () => {
            if (sql.includes("DELETE FROM letter_categories")) {
              const [id] = boundArgs as [number];
              categoryStore.delete(id);
            }
            return { success: true, meta: {} };
          },
        };
        return statement;
      },
    } as unknown as D1Database,
  };
}

describe("GET /api/letter-categories", () => {
  it("rejects a request with no session", async () => {
    const res = await app.request("/api/letter-categories", {}, fakeEnv());
    expect(res.status).toBe(401);
  });

  it("lists letter types in sort order", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/letter-categories",
      { headers: { Cookie: cookie } },
      fakeEnv({
        categories: [
          { id: 2, name: "General correspondence", drafting_instruction: "", sort_order: 2 },
          { id: 1, name: "Fee estimate cover letter", drafting_instruction: "State it's an estimate.", sort_order: 1 },
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { id: 1, name: "Fee estimate cover letter", draftingInstruction: "State it's an estimate." },
      { id: 2, name: "General correspondence", draftingInstruction: "" },
    ]);
  });
});

describe("POST /api/letter-categories", () => {
  it("rejects an empty name", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/letter-categories",
      { method: "POST", headers: { Cookie: cookie }, body: JSON.stringify({ name: "  " }) },
      fakeEnv(),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a duplicate name", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/letter-categories",
      { method: "POST", headers: { Cookie: cookie }, body: JSON.stringify({ name: "Payment chase" }) },
      fakeEnv({ categories: [{ id: 1, name: "Payment chase", drafting_instruction: "", sort_order: 1 }] }),
    );
    expect(res.status).toBe(400);
  });

  it("creates a new letter type with its drafting instruction", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/letter-categories",
      {
        method: "POST",
        headers: { Cookie: cookie },
        body: JSON.stringify({
          name: "Costs schedule submission",
          draftingInstruction: "Always reference CPR Part 44.",
        }),
      },
      fakeEnv(),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      id: 1,
      name: "Costs schedule submission",
      draftingInstruction: "Always reference CPR Part 44.",
    });
  });

  it("defaults the drafting instruction to an empty string when omitted", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/letter-categories",
      { method: "POST", headers: { Cookie: cookie }, body: JSON.stringify({ name: "General correspondence" }) },
      fakeEnv(),
    );
    expect(res.status).toBe(201);
    expect((await res.json()).draftingInstruction).toBe("");
  });
});

describe("PATCH /api/letter-categories/:id", () => {
  it("renames a letter type and updates its drafting instruction", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/letter-categories/1",
      {
        method: "PATCH",
        headers: { Cookie: cookie },
        body: JSON.stringify({ name: "Fee estimate letter", draftingInstruction: "Never call it an invoice." }),
      },
      fakeEnv({ categories: [{ id: 1, name: "Fee estimate cover letter", drafting_instruction: "", sort_order: 1 }] }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: 1,
      name: "Fee estimate letter",
      draftingInstruction: "Never call it an invoice.",
    });
  });
});

describe("DELETE /api/letter-categories/:id", () => {
  it("404s when the letter type doesn't exist", async () => {
    const cookie = await sessionCookie();
    const res = await app.request("/api/letter-categories/99", { method: "DELETE", headers: { Cookie: cookie } }, fakeEnv());
    expect(res.status).toBe(404);
  });

  it("deletes the letter type with no reassignment needed", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/letter-categories/1",
      { method: "DELETE", headers: { Cookie: cookie } },
      fakeEnv({ categories: [{ id: 1, name: "General correspondence", drafting_instruction: "", sort_order: 1 }] }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
