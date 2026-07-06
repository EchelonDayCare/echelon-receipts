import { describe, it, expect } from "vitest";
import { buildWaMeUrl, isValidE164, renderTemplate } from "./whatsapp";

describe("lib/whatsapp", () => {
  it("buildWaMeUrl strips non-digits from the phone and URL-encodes the message", () => {
    const url = buildWaMeUrl("+1 (604) 555-0100", "Hello, Jane! Your shift is 9-5.");
    expect(url).toBe("https://wa.me/16045550100?text=Hello%2C%20Jane!%20Your%20shift%20is%209-5.");
  });

  it("isValidE164 accepts well-formed E.164 numbers and rejects malformed ones", () => {
    expect(isValidE164("+16045550100")).toBe(true);
    expect(isValidE164("6045550100")).toBe(false); // missing '+'
    expect(isValidE164("+0123456789")).toBe(false); // leading 0 after '+'
    expect(isValidE164("+1")).toBe(false); // too short
  });

  it("renderTemplate substitutes known tokens and blanks unknown ones", () => {
    const out = renderTemplate("Hi {{name}}, your balance is {{amount}}. Unknown: {{nope}}", {
      name: "Sam", amount: "$42.00",
    });
    expect(out).toBe("Hi Sam, your balance is $42.00. Unknown: ");
  });
});
