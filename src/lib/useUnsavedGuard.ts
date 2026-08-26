// v3.24.4 (#6): unsaved-changes guard for forms that own significant
// user work. This app uses a non-data `HashRouter`, so we cannot call
// `useBlocker` here — that hook only works for data routers. Instead we
// fall back to the same pattern the website editor already uses:
//   1. `beforeunload` — catches the whole browser tab / desktop window
//      being closed while dirty.
//   2. custom hash-link interception — catches in-app route changes from
//      sidebar links / `#` navigation while dirty and asks the user to
//      confirm before leaving.
//
// Usage:
//   const isDirty = useMemo(() => amount !== "" || comments !== "" || ...);
//   const blocker = useUnsavedGuard(isDirty);
//   ...
//   {blocker.state === "blocked" && (
//     <ConfirmLeave onStay={blocker.reset} onLeave={blocker.proceed} />
//   )}

import { useEffect, useState } from "react";

export type Blocker = {
  state: "idle" | "blocked";
  reset: () => void;
  proceed: () => void;
};

export function useUnsavedGuard(isDirty: boolean): Blocker {
  const [state, setState] = useState<"idle" | "blocked">("idle");
  const [pendingHash, setPendingHash] = useState<string | null>(null);

  useEffect(() => {
    if (!isDirty) {
      setState("idle");
      setPendingHash(null);
      return;
    }

    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Chrome/Edge require returnValue to be truthy to show the prompt.
      e.returnValue = "";
      return "";
    };

    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

      const target = e.target as HTMLElement | null;
      const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;

      const href = anchor.getAttribute("href") || "";
      if (!href.startsWith("#/")) return;

      const currentHash = window.location.hash || "#/";
      if (href === currentHash) return;

      e.preventDefault();
      e.stopPropagation();
      setPendingHash(href);
      setState("blocked");
    };

    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);

    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [isDirty]);

  const reset = () => {
    setState("idle");
    setPendingHash(null);
  };

  const proceed = () => {
    if (pendingHash) {
      const next = pendingHash.startsWith("#") ? pendingHash : `#${pendingHash}`;
      window.location.hash = next;
    }
    reset();
  };

  return { state, reset, proceed };
}
