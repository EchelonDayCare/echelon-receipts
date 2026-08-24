// Cached lazy loaders for heavyweight libraries so they don't bloat cold start.
let html2pdfPromise: Promise<any> | null = null;
export function loadHtml2Pdf(): Promise<any> {
  if (!html2pdfPromise) {
    html2pdfPromise = import("html2pdf.js").then((m: any) => m.default ?? m);
  }
  return html2pdfPromise;
}

// SheetJS is loaded from the maintained fork `@e965/xlsx` (v0.20.x). The
// community-npm `xlsx@0.18.5` is frozen at a version with two published
// CVEs (prototype pollution CVE-2023-30533 and ReDoS CVE-2024-22363);
// `@e965/xlsx` is the same API with the fixes backported.
let xlsxPromise: Promise<typeof import("@e965/xlsx")> | null = null;
export function loadXLSX(): Promise<typeof import("@e965/xlsx")> {
  if (!xlsxPromise) {
    xlsxPromise = import("@e965/xlsx");
  }
  return xlsxPromise;
}

// Yields to the browser so React can flush a re-paint between heavy operations.
// Without this, a tight `for (await ...)` loop blocks the UI thread and progress
// updates only appear after the whole batch finishes.
export function yieldToUI(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
