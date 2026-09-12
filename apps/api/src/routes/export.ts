import { Hono } from "hono";
import type { AppEnv } from "../index";
import { requireAuth } from "./auth";

const dataExport = new Hono<AppEnv>();

dataExport.use("*", requireAuth);

// Every table except users and account_settings — passwords and the
// invite code are secrets, not business data, and have no place in a file
// that might get emailed or dropped in a shared drive as a backup.
const TABLES = [
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
] as const;

// Raw table rows (snake_case, straight from D1) rather than the
// camelCase/computed shapes the list endpoints return — a backup's job is
// to preserve the ground truth that's actually stored, not derived fields
// like an invoice's lag days, which can always be recalculated later.
dataExport.get("/", async (c) => {
  const results = await Promise.all(
    TABLES.map((table) => c.env.DB.prepare(`SELECT * FROM ${table}`).all()),
  );

  const tables: Record<string, unknown[]> = {};
  TABLES.forEach((table, i) => {
    tables[table] = results[i].results;
  });

  return c.json({ exportedAt: new Date().toISOString(), tables });
});

export default dataExport;
