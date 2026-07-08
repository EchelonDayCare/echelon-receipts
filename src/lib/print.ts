// Cross-platform print helper.
//
// On macOS (WKWebView) `window.print()` is unreliable in Tauri v2 — it can
// silently no-op depending on where the click originates. We route every
// Print button through this helper, which asks the native Tauri window to
// invoke the platform print dialog directly.
//
// Falls back to `window.print()` if the invoke fails (e.g. dev-server
// preview outside Tauri) so browser preview keeps working.
import { invoke } from "@tauri-apps/api/core";

let warned = false;

export async function printCurrentWindow(): Promise<void> {
  try {
    await invoke("print_current_window", { label: null });
  } catch (e) {
    if (!warned) {
      console.warn("[print] native print failed, falling back to window.print():", e);
      warned = true;
    }
    try { window.print(); } catch { /* nothing else to try */ }
  }
}

// Prints an ad-hoc HTML document (e.g. a receipt, a PDF preview, a report).
// Historically we used a hidden iframe + iframe.contentWindow.print(), but on
// macOS WKWebView (Tauri v2) that path is unreliable — the dialog often never
// opens. Instead we inject the HTML into the main document behind an @media
// print overlay that hides everything else, then trigger the native print via
// the Rust command. Cleans up afterward regardless of user action.
export async function printHtmlDocument(html: string, opts?: { delayMs?: number }): Promise<void> {
  const delayMs = opts?.delayMs ?? 350;
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
  // Strip <html>/<head>/<body> wrappers if present so we can inline the payload.
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const headMatch = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  if (headMatch) {
    // Copy any <style> tags from the source doc so print CSS is preserved.
    const tmp = document.createElement("div");
    tmp.innerHTML = headMatch[1];
    tmp.querySelectorAll("style, link[rel='stylesheet']").forEach((el) => {
      container.appendChild(el.cloneNode(true));
    });
  }
  container.insertAdjacentHTML("beforeend", bodyMatch ? bodyMatch[1] : html);
  document.body.appendChild(container);

  // Wait for layout / image decode.
  await new Promise((r) => setTimeout(r, delayMs));
  try {
    await printCurrentWindow();
  } finally {
    // Give the print dialog a beat to snapshot the page, then clean up.
    setTimeout(() => {
      container.remove();
      style.remove();
    }, 1000);
  }
}
