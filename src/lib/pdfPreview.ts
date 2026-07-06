// Cross-platform in-app PDF preview.
//
// Renders a hidden DOM tree → runs html2pdf → creates a Blob URL → mounts a
// fullscreen modal that shows the PDF in an <iframe>. Windows WebView2 and
// macOS WKWebView both render Blob-URL PDFs inline (same experience). The
// "Print" button asks the iframe to print the PDF file (not the surrounding
// app chrome), so on Mac the print dialog appears from inside the app instead
// of handing off to Preview.app.
import { loadHtml2Pdf } from "./lazy";
import { showAlert } from "./dialogs";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";

export type PdfPreviewOpts = {
  html: string;
  filename?: string;      // suggested filename for Save-As
  title?: string;         // window / modal title
  format?: "letter" | "a4";
  margin?: number;        // inches
};

export async function showPdfPreview(opts: PdfPreviewOpts): Promise<void> {
  const {
    html,
    filename = "document.pdf",
    title = "PDF preview",
    format = "letter",
    margin = 0.4,
  } = opts;

  // Render offscreen so html2pdf can measure real layout.
  const host = document.createElement("div");
  host.style.position = "fixed";
  host.style.left = "-10000px";
  host.style.top = "0";
  host.innerHTML = html;
  document.body.appendChild(host);
  const target = (host.querySelector(".sheet") as HTMLElement) || host;

  let blob: Blob;
  try {
    const html2pdf = await loadHtml2Pdf();
    blob = await html2pdf()
      .from(target)
      .set({
        margin,
        filename,
        image: { type: "jpeg", quality: 0.95 },
        html2canvas: { scale: 1.5, useCORS: true, backgroundColor: "#ffffff" },
        jsPDF: { unit: "in", format, orientation: "portrait" },
      })
      .outputPdf("blob");
  } catch (e) {
    document.body.removeChild(host);
    await showAlert("Could not build PDF: " + (e as Error).message);
    return;
  }
  document.body.removeChild(host);

  const url = URL.createObjectURL(blob);

  // Modal chrome
  const backdrop = document.createElement("div");
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");
  Object.assign(backdrop.style, {
    position: "fixed", inset: "0", background: "rgba(0,0,0,0.55)",
    display: "flex", flexDirection: "column", alignItems: "center",
    justifyContent: "center", zIndex: "10000", padding: "24px",
  } as CSSStyleDeclaration);

  const panel = document.createElement("div");
  Object.assign(panel.style, {
    background: "#fff", color: "#111", borderRadius: "10px",
    boxShadow: "0 20px 60px rgba(0,0,0,0.45)",
    width: "min(1000px, 100%)", height: "min(900px, 92vh)",
    display: "flex", flexDirection: "column", overflow: "hidden",
  } as CSSStyleDeclaration);

  const header = document.createElement("div");
  Object.assign(header.style, {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "10px 14px", borderBottom: "1px solid #e5e7eb", gap: "8px",
  } as CSSStyleDeclaration);
  const h = document.createElement("div");
  h.textContent = title;
  h.style.fontWeight = "600";
  const actions = document.createElement("div");
  actions.style.display = "flex";
  actions.style.gap = "6px";

  function mkBtn(label: string, primary = false): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    Object.assign(b.style, {
      padding: "6px 12px", borderRadius: "6px", cursor: "pointer",
      border: primary ? "1px solid #2563eb" : "1px solid #cbd5e1",
      background: primary ? "#2563eb" : "#fff",
      color: primary ? "#fff" : "#111", fontSize: "13px",
    } as CSSStyleDeclaration);
    return b;
  }

  const printBtn = mkBtn("Print", true);
  const saveBtn  = mkBtn("Save as PDF…");
  const closeBtn = mkBtn("Close");
  actions.append(printBtn, saveBtn, closeBtn);
  header.append(h, actions);

  const iframe = document.createElement("iframe");
  iframe.src = url;
  iframe.title = title;
  Object.assign(iframe.style, {
    flex: "1", width: "100%", border: "0", background: "#525659",
  } as CSSStyleDeclaration);

  panel.append(header, iframe);
  backdrop.append(panel);
  document.body.appendChild(backdrop);

  function cleanup() {
    URL.revokeObjectURL(url);
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") cleanup();
  }
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) cleanup();
  });
  closeBtn.addEventListener("click", cleanup);

  printBtn.addEventListener("click", () => {
    try {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
    } catch (e) {
      void showAlert("Print failed: " + (e as Error).message);
    }
  });

  saveBtn.addEventListener("click", async () => {
    try {
      const dest = await save({
        defaultPath: filename,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (!dest) return;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await writeFile(dest, bytes);
      await showAlert("Saved: " + dest);
    } catch (e) {
      await showAlert("Save failed: " + (e as Error).message);
    }
  });
}
