import { useEffect, useRef } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";

// Tauri v2 intercepts native OS drag-drop at the webview layer, so the
// DOM `onDrop` handler never receives the paths — `dataTransfer.files`
// is empty by the time it fires. `onDragDropEvent` is the correct
// entry point on the desktop app.
//
// This hook wraps subscription + StrictMode-safe cleanup + extension
// filtering + reentrancy guard so any tab that accepts drag-drop
// uploads can consume it with one hook call.
//
// The `cancelled` flag guards against the classic React async-effect
// leak: if the effect is torn down (StrictMode double-mount, route
// change) before `onDragDropEvent` resolves, we immediately release
// the listener instead of leaking a duplicate that would double-fire.

export type DragDropOptions = {
  /** Regex tested against every dropped path. Non-matching paths are dropped. */
  extensions: RegExp;
  /** If false, only the first matching path is used. Defaults to true. */
  multi?: boolean;
  /** Called on drag enter/over. */
  onEnter?: () => void;
  /** Called on drag leave. */
  onLeave?: () => void;
  /** Called when the drop completes with the filtered paths. Empty array = no matches. */
  onDrop: (paths: string[]) => void | Promise<void>;
  /** Called when the drop had files but none matched the extensions. */
  onWrongType?: () => void;
  /** When true, ignore drop events entirely (e.g. an upload is already in progress). */
  disabled?: boolean;
};

export function useTauriDragDrop(opts: DragDropOptions): void {
  // Freshest opts without needing to re-subscribe every render.
  const ref = useRef(opts);
  ref.current = opts;

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      try {
        const wv = getCurrentWebview();
        const un = await wv.onDragDropEvent(async (event) => {
          const opt = ref.current;
          if (opt.disabled) return;
          const t = event.payload.type;
          if (t === "over" || t === "enter") {
            opt.onEnter?.();
            return;
          }
          if (t === "leave") {
            opt.onLeave?.();
            return;
          }
          if (t === "drop") {
            opt.onLeave?.();
            const paths =
              (event.payload as { paths?: string[] }).paths ?? [];
            if (paths.length === 0) return;
            const matched = paths.filter((p) => opt.extensions.test(p));
            if (matched.length === 0) {
              opt.onWrongType?.();
              return;
            }
            const final = opt.multi === false ? matched.slice(0, 1) : matched;
            await opt.onDrop(final);
          }
        });
        if (cancelled) {
          un();
        } else {
          unlisten = un;
        }
      } catch {
        // Non-Tauri host (test runner) — silently no-op.
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);
}
