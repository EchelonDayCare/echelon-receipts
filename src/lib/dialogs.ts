// Cross-platform replacement for window.alert / confirm / prompt.
//
// On Tauri + WebView2 (Windows), native window.alert / confirm / prompt
// dialogs frequently open BEHIND the main app window, blocking the JS event
// loop synchronously. The user sees stuck "Saving…" buttons or Delete actions
// that appear to do nothing, when in reality a hidden dialog is waiting for a
// click. This wrapper routes through the Tauri dialog plugin (which reliably
// z-orders above the WebView on both Windows and macOS) plus an in-app modal
// prompt (the Tauri v2 dialog plugin has no native text-prompt).
import { message, ask } from "@tauri-apps/plugin-dialog";

export function showAlert(
  msg: string,
  opts?: { title?: string; kind?: "info" | "warning" | "error" },
): Promise<void> {
  return message(msg, {
    title: opts?.title ?? "Echelon Receipts",
    kind: opts?.kind ?? "info",
  }).then(() => undefined);
}

export function showConfirm(
  msg: string,
  opts?: {
    title?: string;
    okLabel?: string;
    cancelLabel?: string;
    kind?: "info" | "warning" | "error";
  },
): Promise<boolean> {
  return ask(msg, {
    title: opts?.title ?? "Confirm",
    okLabel: opts?.okLabel,
    cancelLabel: opts?.cancelLabel,
    kind: opts?.kind ?? "warning",
  });
}

// In-app prompt. Bound at startup by <PromptHost /> in App.tsx.
type PromptReq = {
  message: string;
  defaultValue: string;
  resolve: (v: string | null) => void;
};
let _promptSubscriber: ((r: PromptReq) => void) | null = null;
export function _bindPromptHost(sub: typeof _promptSubscriber) {
  _promptSubscriber = sub;
}

export function showPrompt(msg: string, defaultValue = ""): Promise<string | null> {
  return new Promise((resolve) => {
    if (!_promptSubscriber) {
      // Fallback to native prompt if the host isn't mounted yet (shouldn't
      // happen in practice; belt-and-braces so calls never hang forever).
      resolve(window.prompt(msg, defaultValue));
      return;
    }
    _promptSubscriber({ message: msg, defaultValue, resolve });
  });
}
