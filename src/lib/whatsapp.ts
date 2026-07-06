// wa.me URL construction for the Staff Schedule publish flow. WhatsApp's
// public link scheme accepts either "https://wa.me/{intl_phone}?text=..." or
// "https://api.whatsapp.com/send". The wa.me variant opens the mobile app if
// installed on iOS/Android and falls back to the web client on desktop, which
// is what we want for the Mac desk use case Luxmi has.
//
// Phase 1: owner clicks each generated link → OS opens WhatsApp Web →
// pre-filled message → owner hits Send. Nothing automated, nothing that
// could get the phone number flagged.
export function buildWaMeUrl(phoneE164: string, message: string): string {
  const cleanPhone = phoneE164.replace(/\D/g, ""); // digits only, no + sign
  const encoded = encodeURIComponent(message);
  return `https://wa.me/${cleanPhone}?text=${encoded}`;
}

// E.164: leading "+", up to 15 total digits, first digit 1-9.
const E164 = /^\+[1-9]\d{1,14}$/;
export function isValidE164(phone: string): boolean {
  return E164.test(phone.trim());
}

// Render a mustache-style template with the provided token map. Only supports
// {{ token }} — no logic, no partials, no filters. Missing tokens are left
// blank so a half-configured template still sends something reasonable.
export function renderTemplate(template: string, tokens: Record<string, string>): string {
  return template.replace(/{{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*}}/g, (_m, key) => tokens[key] ?? "");
}
