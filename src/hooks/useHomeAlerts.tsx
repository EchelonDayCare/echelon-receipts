// v2.6.1 Home-alert context provider.
//
// One computation per foreground session, shared between Home tiles,
// module sidebars, and the Settings cog badge. Re-runs on window focus
// so long-open sessions pick up newly-issued receipts / expired creds
// without a full reload.

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { computeHomeAlerts, type HomeAlertsSnapshot } from "../lib/homeAlerts";

const EMPTY: HomeAlertsSnapshot = {
  byTile: {},
  bySidebar: {},
  setup: { smtp: false, backup: false, needsSetup: false, items: [] },
  computedAt: "",
};

interface Ctx {
  snapshot: HomeAlertsSnapshot;
  refresh: () => void;
  loading: boolean;
}

const HomeAlertsCtx = createContext<Ctx>({
  snapshot: EMPTY,
  refresh: () => {},
  loading: false,
});

export function HomeAlertsProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<HomeAlertsSnapshot>(EMPTY);
  const [loading, setLoading] = useState(false);
  const inflight = useRef<Promise<void> | null>(null);

  const refresh = useCallback(() => {
    if (inflight.current) return;
    setLoading(true);
    const p = computeHomeAlerts()
      .then((snap) => setSnapshot(snap))
      .catch((e) => console.warn("[useHomeAlerts] compute failed:", e))
      .finally(() => {
        setLoading(false);
        inflight.current = null;
      });
    inflight.current = p;
  }, []);

  useEffect(() => {
    refresh();
    const onFocus = () => refresh();
    const onVis = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [refresh]);

  return (
    <HomeAlertsCtx.Provider value={{ snapshot, refresh, loading }}>
      {children}
    </HomeAlertsCtx.Provider>
  );
}

export function useHomeAlerts(): Ctx {
  return useContext(HomeAlertsCtx);
}
