// Cached lazy loaders for heavyweight libraries so they don't bloat cold start.
let html2pdfPromise: Promise<any> | null = null;
export function loadHtml2Pdf(): Promise<any> {
  if (!html2pdfPromise) {
    html2pdfPromise = import("html2pdf.js").then((m: any) => m.default ?? m);
  }
  return html2pdfPromise;
}

let xlsxPromise: Promise<typeof import("xlsx")> | null = null;
export function loadXLSX(): Promise<typeof import("xlsx")> {
  if (!xlsxPromise) {
    xlsxPromise = import("xlsx");
  }
  return xlsxPromise;
}

// Yields to the browser so React can flush a re-paint between heavy operations.
// Without this, a tight `for (await ...)` loop blocks the UI thread and progress
// updates only appear after the whole batch finishes.
export function yieldToUI(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
