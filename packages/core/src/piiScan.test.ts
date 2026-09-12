import { describe, expect, it } from "vitest";
import { scanForPii } from "./piiScan";

describe("scanForPii", () => {
  it("reports clean for a letter using only placeholder tokens", () => {
    const result = scanForPii(
      "Dear {{CLIENT_NAME}},\n\nRe: Fee Estimate.\n\nKind regards,\n{{YOUR_NAME}}\n\n{{CLIENT_ADDRESS}}",
    );
    expect(result).toEqual({ clean: true, matches: [] });
  });

  it("flags an email address", () => {
    const result = scanForPii("Please reply to sarah.whitfield@example.com with any questions.");
    expect(result.clean).toBe(false);
    expect(result.matches).toContainEqual({ kind: "email", match: "sarah.whitfield@example.com" });
  });

  it("flags a UK phone number", () => {
    const result = scanForPii("You can reach me on 07911 123456 any weekday.");
    expect(result.clean).toBe(false);
    expect(result.matches.some((m) => m.kind === "phone")).toBe(true);
  });

  it("flags a UK postcode", () => {
    const result = scanForPii("The property at 12 High Street, SW1A 1AA was inspected last week.");
    expect(result.clean).toBe(false);
    expect(result.matches).toContainEqual({ kind: "postcode", match: "SW1A 1AA" });
  });

  it("flags a National Insurance number", () => {
    const result = scanForPii("For reference, her NI number is QQ123456C.");
    expect(result.clean).toBe(false);
    expect(result.matches.some((m) => m.kind === "niNumber")).toBe(true);
  });

  it("does not let placeholder token syntax itself trip a match", () => {
    const result = scanForPii("{{CLIENT_ADDRESS_LINE_1}} {{CLIENT_POSTCODE}} {{YOUR_EMAIL}}");
    expect(result).toEqual({ clean: true, matches: [] });
  });

  it("reports every distinct kind of match found, not just the first", () => {
    const result = scanForPii("Contact test@example.com or SW1A 1AA for details.");
    expect(result.matches.map((m) => m.kind).sort()).toEqual(["email", "postcode"]);
  });
});
