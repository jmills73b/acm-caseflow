import { describe, expect, it } from "vitest";
import { createSessionToken } from "@acm-caseflow/core";
import app from "../index";
import type { Env } from "../index";

const SECRET = "test-secret";

async function sessionCookie(): Promise<string> {
  const token = await createSessionToken({ userId: 1, exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);
  return `session=${token}`;
}

function fakeEnv(
  options: { inviteCode?: string; disabledFeatures?: string[]; complianceGuidelines?: string } = {},
): Env {
  let inviteCode = options.inviteCode ?? "";
  let disabledFeatures = JSON.stringify(options.disabledFeatures ?? []);
  let complianceGuidelines = options.complianceGuidelines ?? "";

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
          first: async <T,>() =>
            ({
              invite_code: inviteCode,
              disabled_features: disabledFeatures,
              compliance_guidelines: complianceGuidelines,
            }) as T,
          run: async () => {
            if (sql.includes("SET invite_code")) {
              const [newCode] = boundArgs as [string];
              inviteCode = newCode;
            } else if (sql.includes("SET disabled_features")) {
              const [newFeatures] = boundArgs as [string];
              disabledFeatures = newFeatures;
            } else if (sql.includes("SET compliance_guidelines")) {
              const [newGuidelines] = boundArgs as [string];
              complianceGuidelines = newGuidelines;
            }
            return { success: true, meta: {} };
          },
        };
        return statement;
      },
    } as unknown as D1Database,
  };
}

describe("GET /api/account-settings", () => {
  it("rejects a request with no session", async () => {
    const res = await app.request("/api/account-settings", {}, fakeEnv());
    expect(res.status).toBe(401);
  });

  it("returns the current invite code and disabled features", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/account-settings",
      { headers: { Cookie: cookie } },
      fakeEnv({ inviteCode: "LETMEIN", disabledFeatures: ["time"] }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ inviteCode: "LETMEIN", disabledFeatures: ["time"], complianceGuidelines: "" });
  });

  it("returns defaults when nothing has been set yet", async () => {
    const cookie = await sessionCookie();
    const res = await app.request("/api/account-settings", { headers: { Cookie: cookie } }, fakeEnv());
    expect(await res.json()).toEqual({ inviteCode: "", disabledFeatures: [], complianceGuidelines: "" });
  });
});

describe("PUT /api/account-settings", () => {
  it("rejects a request with no session", async () => {
    const res = await app.request("/api/account-settings", { method: "PUT" }, fakeEnv());
    expect(res.status).toBe(401);
  });

  it("rejects an empty invite code", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/account-settings",
      { method: "PUT", headers: { Cookie: cookie }, body: JSON.stringify({ inviteCode: "   " }) },
      fakeEnv(),
    );
    expect(res.status).toBe(400);
  });

  it("saves a new invite code", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/account-settings",
      { method: "PUT", headers: { Cookie: cookie }, body: JSON.stringify({ inviteCode: "NEWCODE123" }) },
      fakeEnv({ inviteCode: "OLDCODE" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ inviteCode: "NEWCODE123" });
  });
});

describe("PUT /api/account-settings/features", () => {
  it("rejects a request with no session", async () => {
    const res = await app.request("/api/account-settings/features", { method: "PUT" }, fakeEnv());
    expect(res.status).toBe(401);
  });

  it("rejects a non-array body", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/account-settings/features",
      { method: "PUT", headers: { Cookie: cookie }, body: JSON.stringify({ disabledFeatures: "time" }) },
      fakeEnv(),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a key that isn't toggleable", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/account-settings/features",
      { method: "PUT", headers: { Cookie: cookie }, body: JSON.stringify({ disabledFeatures: ["clients"] }) },
      fakeEnv(),
    );
    expect(res.status).toBe(400);
  });

  it("rejects an unknown feature key", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/account-settings/features",
      { method: "PUT", headers: { Cookie: cookie }, body: JSON.stringify({ disabledFeatures: ["nonsense"] }) },
      fakeEnv(),
    );
    expect(res.status).toBe(400);
  });

  it("saves a valid set of disabled features, deduplicated", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/account-settings/features",
      {
        method: "PUT",
        headers: { Cookie: cookie },
        body: JSON.stringify({ disabledFeatures: ["time", "tasks", "time"] }),
      },
      fakeEnv(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ disabledFeatures: ["time", "tasks"] });
  });

  it("accepts documents as a toggleable key", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/account-settings/features",
      { method: "PUT", headers: { Cookie: cookie }, body: JSON.stringify({ disabledFeatures: ["documents"] }) },
      fakeEnv(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ disabledFeatures: ["documents"] });
  });

  it("persists an empty list to re-enable everything", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/account-settings/features",
      { method: "PUT", headers: { Cookie: cookie }, body: JSON.stringify({ disabledFeatures: [] }) },
      fakeEnv({ disabledFeatures: ["time"] }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ disabledFeatures: [] });
  });

  it("accepts correspondence as a toggleable key", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/account-settings/features",
      { method: "PUT", headers: { Cookie: cookie }, body: JSON.stringify({ disabledFeatures: ["correspondence"] }) },
      fakeEnv(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ disabledFeatures: ["correspondence"] });
  });
});

describe("PUT /api/account-settings/compliance-guidelines", () => {
  it("rejects a request with no session", async () => {
    const res = await app.request("/api/account-settings/compliance-guidelines", { method: "PUT" }, fakeEnv());
    expect(res.status).toBe(401);
  });

  it("saves new compliance guidelines text", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/account-settings/compliance-guidelines",
      {
        method: "PUT",
        headers: { Cookie: cookie },
        body: JSON.stringify({ complianceGuidelines: "Always state GDPR data-minimisation principles." }),
      },
      fakeEnv({ complianceGuidelines: "old text" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ complianceGuidelines: "Always state GDPR data-minimisation principles." });
  });

  it("accepts clearing the guidelines to an empty string", async () => {
    const cookie = await sessionCookie();
    const res = await app.request(
      "/api/account-settings/compliance-guidelines",
      { method: "PUT", headers: { Cookie: cookie }, body: JSON.stringify({}) },
      fakeEnv({ complianceGuidelines: "old text" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ complianceGuidelines: "" });
  });
});
