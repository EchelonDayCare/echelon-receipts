import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installGlobalErrorHandlers } from "./lib/errorLog";

installGlobalErrorHandlers();

// v2.6.4: Do NOT monkey-patch window.print here. The previous patch
// routed every window.print() call through printCurrentWindow() which
// falls back to a full-DOM snapshot dumped to an unencrypted temp file.
// For report screens without a `.print-only` scoping wrapper this
// leaked plaintext PII (receipts, medical data, master recovery codes)
// to disk + browser history. Each screen must opt in explicitly via
// printCurrentWindow / printCurrentWindowViaBrowser / printHtmlDocument
// so we know the snapshot target is safe.

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
