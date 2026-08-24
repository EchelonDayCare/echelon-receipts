// Focus trap helper for modal dialogs and drawers.
//
// When a modal opens, keyboard users must not be able to Tab out of it
// into the still-mounted-but-behind main app (invisible focus that lands
// on off-screen widgets is a well-known accessibility failure mode).
//
// Usage:
//   const containerRef = useFocusTrap(open);
//   return <div ref={containerRef}>...</div>;
//
// Behaviour:
//   * On open: remembers whatever element had focus, then moves focus
//     to the first focusable element inside the container.
//   * On Tab / Shift+Tab: wraps focus around inside the container so
//     it never escapes.
//   * On close: restores focus to the element that had it before the
//     modal opened, so the owner returns to where they were.

import { useEffect, useRef } from "react";

// Elements considered focusable inside the trap. Deliberately broad;
// [tabindex="-1"] is excluded because that's the programmatic-focus-only
// convention.
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex=\"-1\"])",
].join(",");

export function useFocusTrap<T extends HTMLElement>(active: boolean) {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    if (!active) return;
    const container = ref.current;
    if (!container) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Focus the first focusable descendant (or the container itself if
    // it's tabbable) so keyboard users start inside.
    const focusables = () =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter((el) => el.offsetParent !== null || el === document.activeElement);

    const initial = focusables()[0];
    if (initial && typeof initial.focus === "function") {
      // Delay one tick so the modal is fully painted (some callers
      // still manage their own initial focus for a specific input).
      setTimeout(() => initial.focus(), 0);
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const list = focusables();
      if (list.length === 0) {
        e.preventDefault();
        return;
      }
      const first = list[0];
      const last = list[list.length - 1];
      const activeEl = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        // Wrap backward.
        if (activeEl === first || !container.contains(activeEl)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        // Wrap forward.
        if (activeEl === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    container.addEventListener("keydown", onKeyDown);
    return () => {
      container.removeEventListener("keydown", onKeyDown);
      // Restore focus so keyboard users return to their launch point.
      if (previouslyFocused && document.contains(previouslyFocused)) {
        try { previouslyFocused.focus(); } catch { /* best-effort */ }
      }
    };
  }, [active]);

  return ref;
}
