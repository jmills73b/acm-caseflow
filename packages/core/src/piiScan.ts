// The hard gate for Correspondence (see letters.ts): a deterministic
// pattern scan run over a drafted letter, checked *outside* the AI review
// step because a regex either matches or it doesn't -- unlike an LLM
// asserting "yes, I checked, it's clean," which is itself just a guess.
// This exists precisely because the drafting agent is only ever given
// placeholder tokens for personal data (see ARCHITECTURE.md's Auth model
// / Correspondence section) -- a match here means either a token leaked
// its real value somehow, or the AI invented identifying detail it
// shouldn't have, both of which should block before a human ever sees it
// as "clean."

const EMAIL_PATTERN = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const UK_PHONE_PATTERN = /(\+44\s?|0)(\d\s?){9,10}/;
// UK postcode, e.g. "SW1A 1AA" or "M1 1AE" -- deliberately permissive
// (matches the general shape) rather than the full BS7666 validation
// regex, since a false positive here just means an extra look, while a
// false negative means a real postcode slips through.
const UK_POSTCODE_PATTERN = /\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/i;
// National Insurance number, e.g. "QQ 12 34 56 C" -- matches the general
// shape (two letters, six digits, one letter) rather than the full set of
// prefix-letter exclusions real NINOs follow, same permissive-over-strict
// tradeoff as the postcode pattern above.
const NI_NUMBER_PATTERN = /\b[A-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/i;

export interface PiiScanMatch {
  kind: "email" | "phone" | "postcode" | "niNumber";
  match: string;
}

export interface PiiScanResult {
  clean: boolean;
  matches: PiiScanMatch[];
}

// Placeholder tokens ({{CLIENT_NAME}}, etc.) are stripped before scanning
// so the token syntax itself never trips a pattern -- the scan is only
// ever looking at what surrounds them.
function stripTokens(text: string): string {
  return text.replace(/\{\{[A-Z0-9_]+\}\}/g, " ");
}

export function scanForPii(text: string): PiiScanResult {
  const stripped = stripTokens(text);
  const matches: PiiScanMatch[] = [];

  const email = stripped.match(EMAIL_PATTERN);
  if (email) matches.push({ kind: "email", match: email[0] });

  const phone = stripped.match(UK_PHONE_PATTERN);
  if (phone) matches.push({ kind: "phone", match: phone[0].trim() });

  const postcode = stripped.match(UK_POSTCODE_PATTERN);
  if (postcode) matches.push({ kind: "postcode", match: postcode[0] });

  const niNumber = stripped.match(NI_NUMBER_PATTERN);
  if (niNumber) matches.push({ kind: "niNumber", match: niNumber[0] });

  return { clean: matches.length === 0, matches };
}
