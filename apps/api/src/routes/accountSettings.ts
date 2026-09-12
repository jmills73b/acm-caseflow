import { Hono } from "hono";
import type { AppEnv } from "../index";
import { requireAuth } from "./auth";
import { AI_MODELS, DEFAULT_MODEL, isValidAiModel } from "../anthropic";

const accountSettings = new Hono<AppEnv>();

// Every route here requires an existing session — the invite code that
// gates registration must never be readable by someone who isn't already
// signed in, or it stops gating anything.
accountSettings.use("*", requireAuth);

// Clients is foundational (other features reference client records) and
// Admin & Settings is where this very toggle lives — allowing either to
// be hidden would make the app unusable or lock the account out of ever
// re-enabling something.
const TOGGLEABLE_FEATURES = [
  "time",
  "invoices",
  "performance",
  "invoice-generator",
  "expenses",
  "tax",
  "tasks",
  "documents",
  "correspondence",
];

function parseDisabledFeatures(stored: string): string[] {
  try {
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === "string") : [];
  } catch {
    return [];
  }
}

accountSettings.get("/", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT invite_code, disabled_features, compliance_guidelines, ai_model FROM account_settings WHERE id = 1",
  ).first<{
    invite_code: string;
    disabled_features: string;
    compliance_guidelines: string;
    ai_model: string | null;
  }>();
  return c.json({
    inviteCode: row?.invite_code ?? "",
    disabledFeatures: parseDisabledFeatures(row?.disabled_features ?? "[]"),
    complianceGuidelines: row?.compliance_guidelines ?? "",
    aiModel: row?.ai_model || DEFAULT_MODEL,
  });
});

// Fed into the Correspondence review agent's prompt (see routes/letters.ts)
// -- kept admin-editable rather than hardcoded, since only the account
// holder actually knows which regulatory framework applies to their
// practice.
accountSettings.put("/compliance-guidelines", async (c) => {
  const { complianceGuidelines } = await c.req.json<{ complianceGuidelines?: string }>();
  const text = complianceGuidelines ?? "";

  await c.env.DB.prepare(
    "INSERT INTO account_settings (id, compliance_guidelines) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET compliance_guidelines = excluded.compliance_guidelines",
  )
    .bind(text)
    .run();

  return c.json({ complianceGuidelines: text });
});

// Applies to both of Correspondence's agents (drafting and review) --
// see getAccountAiSettings in routes/letters.ts.
accountSettings.put("/ai-model", async (c) => {
  const { aiModel } = await c.req.json<{ aiModel?: string }>();
  if (!isValidAiModel(aiModel)) {
    return c.json({ error: `aiModel must be one of: ${AI_MODELS.map((m) => m.id).join(", ")}` }, 400);
  }

  await c.env.DB.prepare(
    "INSERT INTO account_settings (id, ai_model) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET ai_model = excluded.ai_model",
  )
    .bind(aiModel)
    .run();

  return c.json({ aiModel });
});

accountSettings.put("/", async (c) => {
  const { inviteCode } = await c.req.json<{ inviteCode?: string }>();
  const trimmed = inviteCode?.trim();
  if (!trimmed) {
    return c.json({ error: "Enter an invite code" }, 400);
  }

  // An upsert rather than a plain UPDATE — the singleton row is created by
  // migration 0006, but a plain "WHERE id = 1" update silently affects zero
  // rows (and still reports success) if that row is ever missing.
  await c.env.DB.prepare(
    "INSERT INTO account_settings (id, invite_code) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET invite_code = excluded.invite_code",
  )
    .bind(trimmed)
    .run();

  return c.json({ inviteCode: trimmed });
});

accountSettings.put("/features", async (c) => {
  const { disabledFeatures } = await c.req.json<{ disabledFeatures?: unknown }>();
  if (!Array.isArray(disabledFeatures) || !disabledFeatures.every((key) => typeof key === "string")) {
    return c.json({ error: "disabledFeatures must be a list of feature keys" }, 400);
  }
  const invalid = disabledFeatures.filter((key) => !TOGGLEABLE_FEATURES.includes(key));
  if (invalid.length > 0) {
    return c.json({ error: `Not a toggleable feature: ${invalid.join(", ")}` }, 400);
  }

  const deduped = [...new Set(disabledFeatures)];
  await c.env.DB.prepare(
    "INSERT INTO account_settings (id, disabled_features) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET disabled_features = excluded.disabled_features",
  )
    .bind(JSON.stringify(deduped))
    .run();

  return c.json({ disabledFeatures: deduped });
});

export default accountSettings;
