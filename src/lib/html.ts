// Shared HTML escape for any user-controlled value interpolated into receipt
// HTML, PDF, email body, or subsidy statement. Parent / student / daycare names,
// descriptions, comments, etc. flow into ${...} template literals — without
// escaping, a value like `<img src=x onerror=...>` would execute in the Tauri
// webview (which has full IPC access) when the receipt is previewed/printed.
//
// Use for VALUES only — do not pass full HTML through this. For attribute
// contexts (src, href), keep using validated URLs / data URIs.
export function htmlEscape(s: unknown): string {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Convenience alias for terse use inside template literals: ${h(name)}
export const h = htmlEscape;

// Strip CR/LF (and tabs that become spaces) from anything that goes into an
// email header (subject, From name, recipient label). Prevents SMTP header
// injection when a daycare name or label contains "\nBcc: attacker@evil".
export function emailHeaderSafe(s: unknown): string {
  if (s === null || s === undefined) return "";
  return String(s).replace(/[\r\n\t]+/g, " ").trim();
}

// v3.19.0 (P0 security): whitelist an image src for use inside `<img src="...">`
// attributes in HTML that we later hand to `insertAdjacentHTML` via
// printHtmlDocument. Only base64 data URLs for image MIME types are accepted;
// anything else (HTTP, javascript:, malformed, oversize) returns "" so the
// caller can fall back to the bundled default.
//
// This is a whitelist, not a filter: no attempt to "clean" bad input. If the
// producer of `logo_data_url` / `signature_data_url` is compromised (Settings
// screen accepts any picked file → converted to data URL locally), we still
// refuse to render a payload like  x" onerror="alert(1)  as an active handler.
//
// Callers should ALSO wrap the return with h(...) when interpolating into the
// attribute, as belt-and-suspenders defence.
const IMAGE_DATA_URL_RE =
  /^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/;

// ~2 MB base64-encoded max — realistic centre logos are < 300 kB. Larger
// values are almost certainly a paste accident or an attack.
const MAX_IMAGE_DATA_URL_LEN = 2 * 1024 * 1024;

export function sanitizeImageDataUrl(input: unknown): string {
  if (input === null || input === undefined) return "";
  const s = String(input).trim();
  if (s.length === 0 || s.length > MAX_IMAGE_DATA_URL_LEN) return "";
  return IMAGE_DATA_URL_RE.test(s) ? s : "";
}
