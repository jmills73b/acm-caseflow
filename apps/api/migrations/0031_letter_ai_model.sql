-- Per-letter AI model choice, made once on the setup screen when a session
-- is created (defaults to the cheapest option -- see letters.ts's POST /)
-- and fixed for that session's lifetime. Nullable: existing letters fall
-- back to the account's own configured default model at call time.
ALTER TABLE letters ADD COLUMN ai_model TEXT;
