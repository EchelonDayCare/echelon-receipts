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
