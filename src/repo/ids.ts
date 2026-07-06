// UUID v4 + SHA-256 helpers shared by all Data-Contract-compliant repos.
//
// UUIDs are generated client-side per Data Contract §1. crypto.randomUUID is
// available in every WebView the app targets (Chromium on Windows, WKWebView
// on macOS >= 12). If it ever isn't, fall back to a manual v4.
export function uuidv4(): string {
  const c = (globalThis as any).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// UTC ISO 8601 with millisecond precision per Data Contract §2.
export function nowIso(): string { return new Date().toISOString(); }

// SHA-256 hex (lowercase) — content-addressable blob key.
// WebCrypto is fast enough for the 25 MB per-file cap; no need to hop to Rust.
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const buf = await crypto.subtle.digest("SHA-256", view as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// H-1: thrown by every optimistic-concurrency UPDATE (WHERE id = ? AND
// version = ?) when rowsAffected is 0 — i.e. someone else wrote first.
// Callers should catch this and prompt the user to reload/refetch rather
// than silently discarding the write or retrying blindly.
export class StaleWriteError extends Error {
  constructor(entity: string) {
    super(`${entity} was changed by another writer. Please reload and try again.`);
    this.name = "StaleWriteError";
  }
}
