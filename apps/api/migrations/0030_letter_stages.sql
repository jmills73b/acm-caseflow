-- Correspondence becomes a staged, persisted workflow: Analysis -> Composition
-- -> Review (looping back to Composition as needed) -> Finalized. A "letter"
-- row now represents the whole session from the moment it's started, not
-- just the finished result -- draft_body stays '' until Composition
-- produces something, and every existing row (all previously-finished
-- letters) becomes 'finalized' since that's what they already are.
ALTER TABLE letters ADD COLUMN stage TEXT NOT NULL DEFAULT 'finalized';
ALTER TABLE letters ADD COLUMN analysis_messages TEXT NOT NULL DEFAULT '[]';
ALTER TABLE letters ADD COLUMN analysis_summary TEXT;
ALTER TABLE letters ADD COLUMN composition_messages TEXT NOT NULL DEFAULT '[]';
-- Append-only log of every review round: flags returned, the PII scan
-- result, and (once the user acts on it) which flags they picked and any
-- free-text feedback -- this is what "back to a previous stage" is safe
-- against (nothing is overwritten) and what feeds the finalize-time
-- process summary.
ALTER TABLE letters ADD COLUMN review_rounds TEXT NOT NULL DEFAULT '[]';
ALTER TABLE letters ADD COLUMN process_summary TEXT;
-- SQLite's ALTER TABLE ADD COLUMN only allows a constant default, not an
-- expression like datetime('now') -- application code sets this explicitly
-- on every insert/update instead of relying on a DB-level default.
ALTER TABLE letters ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
UPDATE letters SET updated_at = created_at WHERE updated_at = '';
