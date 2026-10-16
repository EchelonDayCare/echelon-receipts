import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { HELP_CONTEXT_EVENT } from "../lib/helpCompanion";

/** Publish only explicitly chosen non-identifying filter labels, never form or record contents. */
export function useHelpContext(title: string, filters: Record<string, string>) {
  const { pathname } = useLocation();
  const serialized = JSON.stringify(filters);
  useEffect(() => {
    window.dispatchEvent(new CustomEvent(HELP_CONTEXT_EVENT, {
      detail: { route: pathname, title, filters: JSON.parse(serialized) as Record<string, string> },
    }));
    return () => {
      window.dispatchEvent(new CustomEvent(HELP_CONTEXT_EVENT, {
        detail: { route: pathname, title, filters: {} },
      }));
    };
  }, [pathname, title, serialized]);
}
