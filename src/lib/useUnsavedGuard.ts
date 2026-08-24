// v3.24.4 (#6): unsaved-changes guard for forms that own significant
// user work. Combines two mechanisms:
//   1. `beforeunload` — catches the whole browser tab / desktop window
//      being closed while dirty. Browser shows the native confirm.
//   2. `useBlocker` (react-router v6.20+) — catches in-app navigation
//      (route change from a Link, back button, sidebar click) while
//      dirty. Renders a `<ConfirmLeaveModal>` via the returned blocker
//      state so the form can render its own prompt.
//
// Usage:
//   const isDirty = useMemo(() => amount !== "" || comments !== "" || ...);
//   const blocker = useUnsavedGuard(isDirty);
//   ...
//   {blocker.state === "blocked" && (
//     <ConfirmLeave onStay={blocker.reset} onLeave={blocker.proceed} />
//   )}

import { useEffect } from "react";
import { useBlocker, type Blocker } from "react-router-dom";

export function useUnsavedGuard(isDirty: boolean): Blocker {
  // Blocks any in-app navigation attempt while dirty. `useBlocker` needs
  // a stable predicate to avoid re-subscribing every render — closing
  // over `isDirty` in a lambda is fine here because react-router reads
  // the latest closure each nav attempt.
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    if (!isDirty) return false;
    // Same-URL navigations (e.g. React StrictMode double-invoke) should
    // never prompt.
    return currentLocation.pathname !== nextLocation.pathname;
  });

  // Native beforeunload for window-close / OS-level tab close.
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Chrome/Edge require returnValue to be truthy to show the prompt.
      e.returnValue = "";
      return "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  return blocker;
}
