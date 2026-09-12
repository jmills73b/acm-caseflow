-- Whether a saved letter was drafted as a printed letter or an email --
-- changes both the drafting agent's system prompt (routes/letters.ts) and
-- how it's exported (apps/web/src/letterExport.ts). Defaults to 'letter'
-- since that's every letter saved before this column existed.
ALTER TABLE letters ADD COLUMN format TEXT NOT NULL DEFAULT 'letter';
