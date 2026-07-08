import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installGlobalErrorHandlers } from "./lib/errorLog";
import { printCurrentWindow } from "./lib/print";

installGlobalErrorHandlers();

// macOS WKWebView (Tauri v2) unreliably dispatches window.print(). Route all
// callsites through the native Tauri command instead so Print buttons work
// identically on Windows and Mac. We keep the same synchronous signature by
// firing-and-forgetting the promise; every caller in the app treats it that
// way already.
const nativePrint = window.print.bind(window);
window.print = () => { void printCurrentWindow().catch(() => nativePrint()); };

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
