-- Admin-configurable model for Correspondence's drafting/review agents
-- (routes/letters.ts), plus a ledger of every Anthropic call's token counts
-- so Admin can show a real cost estimate instead of an opaque "AI" line
-- item -- see docs/ARCHITECTURE.md's Correspondence section.
ALTER TABLE account_settings ADD COLUMN ai_model TEXT NOT NULL DEFAULT 'claude-haiku-4-5';

CREATE TABLE ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
