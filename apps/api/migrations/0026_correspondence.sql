-- Correspondence: AI-drafted letters that never see real personal data.
-- The drafting/review agents only ever receive placeholder tokens
-- ({{CLIENT_NAME}}, {{CLIENT_ADDRESS}}, {{YOUR_NAME}}) for anything
-- personally identifying -- draft_body stores exactly what the AI
-- produced, tokens included, which is why it's safe to keep in plain
-- text here with no encryption, unlike documents.r2_key's contents.
--
-- Deletes are soft, same convention as documents: deleted_at/deleted_by
-- rather than removing the row.

CREATE TABLE letter_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  drafting_instruction TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE letters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  letter_category_id INTEGER REFERENCES letter_categories(id),
  amount REAL,
  reference TEXT,
  key_date TEXT,
  tone TEXT,
  personal_fields TEXT NOT NULL DEFAULT '[]', -- JSON array of token names used, e.g. ["CLIENT_NAME","CLIENT_ADDRESS"]
  bespoke_request TEXT,
  draft_body TEXT NOT NULL,
  review_flags TEXT,          -- JSON array of {severity, text} from the compliance reviewer, null until reviewed
  pii_scan_clean INTEGER,     -- 1/0/null: null until the deterministic pattern scan has run against this draft
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  deleted_by INTEGER REFERENCES users(id)
);

-- The compliance/privacy guidelines text fed into the review agent's
-- prompt -- deliberately admin-editable rather than hardcoded, since only
-- the account holder actually knows which regulatory framework applies to
-- their practice.
ALTER TABLE account_settings ADD COLUMN compliance_guidelines TEXT NOT NULL DEFAULT '';
