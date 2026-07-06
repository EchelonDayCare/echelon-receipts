import { describe, it, expect } from "vitest";
import { toLocalIso, isVoiceConfigured } from "./voice";

describe("lib/voice", () => {
  it("toLocalIso emits ISO-8601 with local offset, not Z", () => {
    // Build a Date whose fields we control regardless of the runner's TZ.
    const d = new Date(2026, 6, 7, 9, 30, 15); // 2026-07-07 09:30:15 local
    const iso = toLocalIso(d);
    // Shape: 2026-07-07T09:30:15±HH:MM (no trailing Z).
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    expect(iso.endsWith("Z")).toBe(false);
    // Prefix matches the local wall-clock fields we set.
    expect(iso.startsWith("2026-07-07T09:30:15")).toBe(true);
  });

  it("toLocalIso zero-pads single-digit fields", () => {
    const d = new Date(2026, 0, 3, 4, 5, 6); // 2026-01-03 04:05:06
    expect(toLocalIso(d).startsWith("2026-01-03T04:05:06")).toBe(true);
  });

  it("isVoiceConfigured requires endpoint URL, stored key, and enabled flag", () => {
    // Missing everything.
    expect(isVoiceConfigured({})).toBe(false);

    // Just the endpoint isn't enough.
    expect(isVoiceConfigured({ azure_whisper_endpoint: "https://x.openai.azure.com/openai/deployments/whisper" })).toBe(false);

    // Endpoint + key but disabled flag.
    expect(isVoiceConfigured({
      azure_whisper_endpoint: "https://x.openai.azure.com/openai/deployments/whisper",
      azure_whisper_key_set: "1",
      voice_organizer_enabled: "0",
    })).toBe(false);

    // Fully configured, enabled by default (missing flag treated as on).
    expect(isVoiceConfigured({
      azure_whisper_endpoint: "https://x.openai.azure.com/openai/deployments/whisper",
      azure_whisper_key_set: "1",
    })).toBe(true);

    // Fully configured with explicit enable.
    expect(isVoiceConfigured({
      azure_whisper_endpoint: "https://x.openai.azure.com/openai/deployments/whisper",
      azure_whisper_key_set: "1",
      voice_organizer_enabled: "1",
    })).toBe(true);
  });

  it("isVoiceConfigured treats whitespace-only endpoint as unconfigured", () => {
    expect(isVoiceConfigured({
      azure_whisper_endpoint: "   ",
      azure_whisper_key_set: "1",
    })).toBe(false);
  });
});
