// Cross-platform print helper.
//
// On macOS (WKWebView) and some Windows (WebView2) configurations
// `window.print()` and even the native `WebviewWindow::print()` command
// silently no-op — no dialog, no error. We route every Print button
// through this helper, which tries the native path first and then a
// bulletproof browser fallback: it snapshots the current print-only
// DOM subtree, writes it to a temp .html file, and opens it in the
// default browser so the user can use the browser's own print preview.
//
// v2.6.4: added browser fallback + `printCurrentWindowViaBrowser()`
// escape hatch for print flows where the native command is known to
// no-op silently (Windows WebView2 regression).
import { invoke } from "@tauri-apps/api/core";
import { showAlert } from "./dialogs";

// Capture the real browser `window.print` BEFORE main.tsx monkey-patches
// it to route back through `printCurrentWindow`. Without this snapshot,
// every fallback call to `window.print()` would re-enter this helper and
// (worst case) infinite-loop. main.tsx imports this module first, so we
// win the initialization race.
const NATIVE_WINDOW_PRINT: () => void = typeof window !== "undefined" && typeof window.print === "function"
  ? window.print.bind(window)
  : () => { /* no-op in non-browser contexts (e.g. tests) */ };

let warned = false;

// Serialize the print-only DOM plus any <style> tags into a
// standalone HTML document, targeted at the browser fallback.
function snapshotPrintDocument(): string {
  // Collect every stylesheet + <style> from the head so print CSS survives.
  const styleNodes = Array.from(document.querySelectorAll("style"));
  const inlineStyles = styleNodes.map((s) => `<style>${s.textContent ?? ""}</style>`).join("\n");
  // Snapshot every `.print-only` block currently in the DOM. The Schedule tab
  // switches between a week-print-block and a month-print-block; whichever one
  // is mounted is what the user wants to print.
  const printOnly = Array.from(document.querySelectorAll(".print-only"))
    .map((el) => (el as HTMLElement).outerHTML)
    .join("\n");
  const body = printOnly
    || document.body.innerHTML;  // last resort — dump the whole body
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Echelon — Print</title>
  ${inlineStyles}
  <style>
    /* Force the print-only content to display in the browser tab too. */
    .print-only { display: block !important; visibility: visible !important; position: static !important; }
    body { background: #fff; color: #000; margin: 0; padding: 12px; font-family: system-ui, sans-serif; }
  </style>
  <script>
    window.addEventListener("load", function () {
      // Small delay so styles settle before the dialog opens.
      setTimeout(function () { window.print(); }, 250);
    });
  </script>
</head>
<body>${body}</body>
</html>`;
}

async function tryBrowserFallback(): Promise<boolean> {
  // v2.6.4 security: refuse to snapshot the raw document body — that
  // would leak PII (receipts, medical data, recovery codes) from
  // screens that don't have a purpose-built `.print-only` wrapper.
  // Callers who legitimately want the browser fallback must render a
  // `.print-only` block; if none exists we return false so the caller
  // can surface a proper error.
  const printOnlyCount = document.querySelectorAll(".print-only").length;
  if (printOnlyCount === 0) {
    console.warn("[print] browser fallback refused — no .print-only scoping block on this screen");
    return false;
  }
  try {
    const html = snapshotPrintDocument();
    await invoke("print_html_via_browser", { html });
    return true;
  } catch (e) {
    console.warn("[print] browser fallback failed:", e);
    return false;
  }
}

/**
 * Invoke the native Tauri print command AND verify a print dialog
 * actually opened by watching for the webview's `beforeprint` event.
 * On WebView2/WKWebView configs where native print silently no-ops,
 * `beforeprint` never fires — this lets us detect that and escalate
 * instead of returning a false success.
 *
 * v2.6.4 (Codex/Sonnet R3 CRITICAL): fixes "print does nothing, no
 * error" on affected Windows setups.
 *
 * @returns true only if the native dialog was proven to have opened.
 */
async function invokeNativePrintVerified(timeoutMs = 600): Promise<boolean> {
  let beforePrintFired = false;
  const handler = () => { beforePrintFired = true; };
  window.addEventListener("beforeprint", handler);
  try {
    // Fire the native call and give the webview up to `timeoutMs` to
    // emit `beforeprint`. On working configs, `beforeprint` fires
    // synchronously before invoke resolves. On broken configs, invoke
    // resolves Ok but no event fires.
    const invokePromise = invoke("print_current_window", { label: null });
    await invokePromise;
    // The event may still be in flight — give one microtask + a tiny
    // grace period so a same-tick event has a chance to arrive.
    await new Promise((r) => setTimeout(r, timeoutMs));
    return beforePrintFired;
  } catch (e) {
    if (!warned) {
      console.warn("[print] native invoke threw:", e);
      warned = true;
    }
    return false;
  } finally {
    window.removeEventListener("beforeprint", handler);
  }
}

export async function printCurrentWindow(): Promise<void> {
  // v2.6.4: native path first (in-app print dialog), so PII stays
  // inside the Tauri webview. Only fall back to the browser path if
  // the caller has rendered a `.print-only` scoping block and native
  // fails. tryBrowserFallback() refuses if no scoping is present.
  const nativeWorked = await invokeNativePrintVerified();
  if (nativeWorked) return;
  // Native didn't actually open a dialog. Try browser fallback
  // (only works if the screen has a `.print-only` block).
  const browserOk = await tryBrowserFallback();
  if (browserOk) return;
  // v2.6.4 (Codex/Sonnet R3 CRITICAL): if neither native nor the
  // scoped browser fallback worked, the previous behaviour was to
  // silently fire a raw window.print() and hope for the best — on
  // affected WebView2 setups that just no-ops with no feedback,
  // leaving the user thinking they printed a report/recovery code
  // when nothing happened. Instead: give them explicit, actionable
  // feedback so they know to write it down or try Ctrl+P.
  try { NATIVE_WINDOW_PRINT(); } catch { /* nothing else to try */ }
  await showAlert(
    "The print dialog did not open. This is a known issue on some Windows setups.\n\n" +
    "Try one of these instead:\n" +
    "  • Press Ctrl+P to trigger the browser print dialog directly\n" +
    "  • Use the Export CSV / Save as PDF button if available on this screen\n" +
    "  • Take a screenshot (Windows: Win+Shift+S)",
    { kind: "warning" },
  );
}

/**
 * Explicit browser-fallback entry point. Use ONLY on screens that render
 * a `.print-only` scoping block; otherwise the browser tab would expose
 * the raw DOM. Intended for the Schedule tab where native print silently
 * no-ops on some Windows/WebView2 configurations.
 *
 * @throws Error if the browser fallback refuses (no `.print-only` block)
 *   or every path failed. Callers must surface via showAlert.
 */
export async function printCurrentWindowViaBrowser(): Promise<void> {
  const ok = await tryBrowserFallback();
  if (ok) return;
  // Fallback: verified native path.
  const nativeWorked = await invokeNativePrintVerified();
  if (nativeWorked) return;
  // Last resort: raw window.print().
  try { NATIVE_WINDOW_PRINT(); } catch { /* fall through */ }
  throw new Error(
    "Could not open the print dialog. If nothing appears, check that a default browser is installed, and that this screen has a print-friendly layout.",
  );
}

// Prints an ad-hoc HTML document (e.g. a receipt, a PDF preview, a report).
// Historically we used a hidden iframe + iframe.contentWindow.print(), but on
// macOS WKWebView (Tauri v2) that path is unreliable — the dialog often never
// opens. Instead we inject the HTML into the main document behind an @media
// print overlay that hides everything else, then trigger the native print via
// the Rust command. Cleans up afterward regardless of user action.
//
// v3.0.2 (macOS regression): the in-app injection + native print path on
// macOS WKWebView was found to snapshot the on-screen viewport rather than
// applying the injected `@media print` rules — users got printouts of the
// app UI (title, upload zone, buttons) instead of the print sheet HTML.
// Route macOS through the browser fallback first (which opens the HTML in
// the default browser and calls window.print() there — reliable everywhere).
const IS_MAC: boolean = typeof navigator !== "undefined"
  && /Macintosh|Mac OS X/i.test(navigator.userAgent);

export async function printHtmlDocument(html: string, opts?: { delayMs?: number }): Promise<void> {
  const delayMs = opts?.delayMs ?? 350;

  // macOS-first: browser fallback is the reliable path. The legacy in-app
  // path silently printed the on-screen viewport instead of our HTML,
  // shipping child-name-only sheets to the printer (v3.0.2 bug report).
  if (IS_MAC) {
    try {
      await browserPrintHtmlDocument(html);
      return;
    } catch (e) {
      if (!warned) {
        console.warn("[print] macOS browser path failed, trying in-app native as fallback:", e);
        warned = true;
      }
      // Fall through to legacy path as last resort.
    }
  }

  // Windows / Linux (and macOS last-resort): primary path is the legacy
  // DOM-inject + native print. This keeps PII-heavy receipts and reports
  // inside the Tauri webview, off the disk, and out of browser history.
  // Only if native print fails (rare — user's default browser is closed,
  // temp dir is unwritable, etc.) do we escalate to the browser fallback.
  try {
    await legacyPrintHtmlDocument(html, delayMs);
    return;
  } catch (e) {
    if (!warned) {
      console.warn("[print] in-app native print failed, escalating to browser fallback:", e);
      warned = true;
    }
  }
  // Browser fallback — the caller-provided HTML has already been
  // reviewed for what it contains, so this is safe.
  await browserPrintHtmlDocument(html);
}

async function browserPrintHtmlDocument(html: string): Promise<void> {
  const hasHtmlTag = /<html[\s>]/i.test(html);
  const printable = hasHtmlTag
    ? injectPrintScript(html)
    : `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Echelon — Print</title>
  <style>
    body { background: #fff; color: #000; margin: 0; padding: 12px; font-family: system-ui, sans-serif; }
    @page { margin: 0.5in; }
  </style>
  <script>
    window.addEventListener("load", function () {
      setTimeout(function () { window.print(); }, 250);
    });
  </script>
</head>
<body>${html}</body>
</html>`;
  await invoke("print_html_via_browser", { html: printable });
}

// Inject `<script>window.print()</script>` into an existing full HTML
// doc so opening it in the browser auto-prints.
function injectPrintScript(html: string): string {
  const script = `<script>window.addEventListener("load", function () { setTimeout(function () { window.print(); }, 250); });</script>`;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${script}</head>`);
  if (/<body[^>]*>/i.test(html)) return html.replace(/<body([^>]*)>/i, `<head>${script}</head><body$1>`);
  return `${html}\n${script}`;
}

async function legacyPrintHtmlDocument(html: string, delayMs: number): Promise<void> {
  const existing = document.getElementById("__print_area");
  if (existing) existing.remove();
  const existingStyle = document.getElementById("__print_area_style");
  if (existingStyle) existingStyle.remove();

  const style = document.createElement("style");
  style.id = "__print_area_style";
  style.textContent = `
    #__print_area { display: none; }
    @media print {
      body > *:not(#__print_area) { display: none !important; }
      #__print_area { display: block !important; position: static !important; }
      @page { margin: 0.5in; }
    }
  `;
  document.head.appendChild(style);

  const container = document.createElement("div");
  container.id = "__print_area";
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const headMatch = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  if (headMatch) {
    const tmp = document.createElement("div");
    tmp.innerHTML = headMatch[1];
    tmp.querySelectorAll("style, link[rel='stylesheet']").forEach((el) => {
      container.appendChild(el.cloneNode(true));
    });
  }
  container.insertAdjacentHTML("beforeend", bodyMatch ? bodyMatch[1] : html);
  document.body.appendChild(container);

  await new Promise((r) => setTimeout(r, delayMs));
  let opened = false;
  try {
    // v2.6.4 (Codex/Sonnet R3 CRITICAL): use the verified native path
    // that watches for `beforeprint` — otherwise a silent WebView2
    // no-op returns Ok and the outer `printHtmlDocument`'s escalation
    // to `print_html_via_browser` never fires.
    opened = await invokeNativePrintVerified();
  } finally {
    setTimeout(() => {
      container.remove();
      style.remove();
    }, 1000);
  }
  if (!opened) {
    throw new Error("native print dialog did not open");
  }
}
