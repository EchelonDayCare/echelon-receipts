import { describe, it, expect } from "vitest";
import { h, emailHeaderSafe, sanitizeImageDataUrl } from "./html";

describe("htmlEscape / h", () => {
  it("escapes the five HTML metacharacters", () => {
    expect(h("<img src=x onerror=alert(1)>")).toBe(
      "&lt;img src=x onerror=alert(1)&gt;",
    );
    expect(h("&")).toBe("&amp;");
    expect(h('"')).toBe("&quot;");
    expect(h("'")).toBe("&#039;");
  });

  it("returns empty string for null/undefined", () => {
    expect(h(null)).toBe("");
    expect(h(undefined)).toBe("");
  });

  it("stringifies non-string input", () => {
    expect(h(42)).toBe("42");
    expect(h(false)).toBe("false");
  });
});

describe("emailHeaderSafe", () => {
  it("strips CR/LF/tab and trims", () => {
    expect(emailHeaderSafe("Echelon\r\nBcc: attacker@evil")).toBe(
      "Echelon Bcc: attacker@evil",
    );
    expect(emailHeaderSafe("  Padded  ")).toBe("Padded");
  });
});

describe("sanitizeImageDataUrl (v3.19.0 P0)", () => {
  // A minimal valid base64 payload (1×1 transparent PNG).
  const TINY_PNG =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";

  it("accepts a canonical image/png data URL", () => {
    const good = `data:image/png;base64,${TINY_PNG}`;
    expect(sanitizeImageDataUrl(good)).toBe(good);
  });

  it("accepts jpeg, jpg, gif, webp, svg+xml", () => {
    for (const mime of ["jpeg", "jpg", "gif", "webp", "svg+xml"]) {
      const url = `data:image/${mime};base64,AAAA`;
      expect(sanitizeImageDataUrl(url)).toBe(url);
    }
  });

  it("rejects the classic attribute-breakout payload", () => {
    // What a malicious logo_data_url would look like if a user pasted a raw
    // XSS payload into the Settings field. Must NOT round-trip.
    expect(sanitizeImageDataUrl('x" onerror="alert(1)')).toBe("");
    expect(sanitizeImageDataUrl('"><script>alert(1)</script>')).toBe("");
  });

  it("rejects javascript: and other scheme URLs", () => {
    expect(sanitizeImageDataUrl("javascript:alert(1)")).toBe("");
    expect(sanitizeImageDataUrl("data:text/html;base64,PHNjcmlwdD4=")).toBe("");
    // Non-base64 data URLs (e.g. text/plain, no encoding) also refused.
    expect(sanitizeImageDataUrl("data:image/png,notbase64")).toBe("");
  });

  it("rejects http/https URLs even for images", () => {
    // Defence-in-depth: bundled defaults are data URLs. Allowing HTTP would
    // let a compromised Settings value phone home / leak the print job.
    expect(sanitizeImageDataUrl("http://evil.example/logo.png")).toBe("");
    expect(sanitizeImageDataUrl("https://cdn.example/logo.png")).toBe("");
  });

  it("rejects non-image MIME types", () => {
    expect(sanitizeImageDataUrl("data:image/bmp;base64,AAAA")).toBe("");
    expect(sanitizeImageDataUrl("data:application/pdf;base64,AAAA")).toBe("");
  });

  it("rejects empty, null, undefined, and non-strings", () => {
    expect(sanitizeImageDataUrl("")).toBe("");
    expect(sanitizeImageDataUrl("   ")).toBe("");
    expect(sanitizeImageDataUrl(null)).toBe("");
    expect(sanitizeImageDataUrl(undefined)).toBe("");
    // Numbers, objects, etc. never come from Settings but must not crash.
    expect(sanitizeImageDataUrl(42)).toBe("");
    expect(sanitizeImageDataUrl({})).toBe("");
  });

  it("rejects oversize payloads (> ~2 MB base64)", () => {
    // Payload just over the limit — a paste accident or an attack.
    const bloat = "A".repeat(2 * 1024 * 1024 + 1);
    const url = `data:image/png;base64,${bloat}`;
    expect(sanitizeImageDataUrl(url)).toBe("");
  });

  it("rejects base64 with illegal characters", () => {
    expect(sanitizeImageDataUrl("data:image/png;base64,not!valid@base64")).toBe(
      "",
    );
  });

  it("trims leading/trailing whitespace before validating", () => {
    const good = `data:image/png;base64,${TINY_PNG}`;
    expect(sanitizeImageDataUrl(`  ${good}  `)).toBe(good);
  });
});
