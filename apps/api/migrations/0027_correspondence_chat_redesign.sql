-- Correspondence redesign: letter type is now free text set once at the
-- start of a conversational drafting flow (see letters.ts's POST /chat),
-- rather than picked from an admin-managed category list -- and the old
-- structured "facts" fields (amount/reference/date/tone) fold into that
-- same conversation instead of separate inputs. No production data
-- depended on any of these yet (nothing real has been saved through the
-- feature), so this drops rather than migrates them.

ALTER TABLE letters DROP COLUMN letter_category_id;
ALTER TABLE letters DROP COLUMN amount;
ALTER TABLE letters DROP COLUMN reference;
ALTER TABLE letters DROP COLUMN key_date;
ALTER TABLE letters DROP COLUMN tone;
ALTER TABLE letters DROP COLUMN bespoke_request;
ALTER TABLE letters ADD COLUMN letter_type TEXT;

DROP TABLE letter_categories;
