import { describe, it, expect } from "vitest";
import { uuidv4, nowIso, sha256Hex, StaleWriteError } from "./ids";

describe("repo/ids", () => {
  it("uuidv4 produces a well-formed v4 UUID", () => {
    const id = uuidv4();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it("uuidv4 produces distinct values", () => {
    const a = uuidv4();
    const b = uuidv4();
    expect(a).not.toBe(b);
  });

  it("nowIso produces a UTC ISO-8601 string with millisecond precision", () => {
    const iso = nowIso();
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // Round-trips through Date without throwing / losing precision.
    expect(new Date(iso).toISOString()).toBe(iso);
  });

  it("sha256Hex hashes deterministically and matches a known vector", async () => {
    // SHA-256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    const empty = new Uint8Array(0);
    const hash = await sha256Hex(empty);
    expect(hash).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("sha256Hex is stable for identical input", async () => {
    const bytes = new TextEncoder().encode("echelon-receipts");
    const h1 = await sha256Hex(bytes);
    const h2 = await sha256Hex(bytes);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("StaleWriteError carries a helpful, entity-specific message", () => {
    const err = new StaleWriteError("Shift");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("StaleWriteError");
    expect(err.message).toContain("Shift");
    expect(err.message.toLowerCase()).toContain("reload");
  });
});
