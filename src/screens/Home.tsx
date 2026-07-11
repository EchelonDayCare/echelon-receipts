import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getVersion } from "@tauri-apps/api/app";
import { getSettings } from "../lib/db";
import { DEFAULT_LOGO_DATA_URL } from "../lib/defaults";
import { checkForUpdates, type UpdateStatus } from "../lib/updateCheck";
import { askEchelon, logQuestion, type AskResult } from "../lib/askEchelon";
import { useHomeAlerts } from "../hooks/useHomeAlerts";
import AlertDot from "../components/AlertDot";
import type { TileKey } from "../lib/homeAlerts";
import type { SettingsMap } from "../types";

export default function Home() {
  const nav = useNavigate();
  const [s, setS] = useState<SettingsMap>({});
  const [staffEnabled, setStaffEnabled] = useState(false);
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [appVersion, setAppVersion] = useState<string>("");

  // Home-wide alert badges (tiles + Settings cog). Computed once at App
  // level in HomeAlertsProvider; we call refresh() on mount so alerts
  // reflect resolutions made in-tile (issuing a receipt, publishing the
  // schedule) even if the app never lost focus in between.
  const { snapshot: alerts, refresh: refreshAlerts } = useHomeAlerts();

  // Inline Ask Echelon state — v2.2.4 lets users query straight from Home.
  const [homeAskQ, setHomeAskQ] = useState("");
  const [askBusy, setAskBusy] = useState(false);
  const [askErr, setAskErr] = useState<string | null>(null);
  const [askResult, setAskResult] = useState<AskResult | null>(null);

  async function runHomeAsk() {
    const q = homeAskQ.trim();
    if (!q) return;
    setAskBusy(true); setAskErr(null); setAskResult(null);
    try {
      const res = await askEchelon({ question: q });
      setAskResult(res);
      void logQuestion(q).catch(() => {});
    } catch (e: any) {
      setAskErr(String(e?.message ?? e));
    } finally {
      setAskBusy(false);
    }
  }

  useEffect(() => {
    // P0: refresh alerts every time Home mounts so resolutions made
    // in-tile (issued receipts, published schedules) don't leave a stale
    // dot on Home. Cheap: the provider dedupes overlapping refreshes.
    refreshAlerts();

    (async () => {
      const settings = await getSettings();
      setS(settings);
      setStaffEnabled(settings.feature_staff_hours_enabled === "1");
    })();

    // Read the real Cargo version at runtime and use it for both the footer
    // and the update-check gating (hardcoding was showing v0.1.0 and turning
    // every release into a "downgrade" prompt).
    (async () => {
      try {
        const v = await getVersion();
        setAppVersion(v);
        const u = await checkForUpdates(v);
        if (u.hasUpdate) setUpdate(u);
      } catch {
        // On non-tauri builds (never in production) fall back silently.
      }
    })();
  }, [refreshAlerts]);

  const daycareName = s.daycare_name || "Echelon Daycare";
  const logo = s.logo_data_url || DEFAULT_LOGO_DATA_URL;

  // Route a tile click. If the tile carries alerts, prefer the sub-route
  // that owns the first alert (info scent — user lands on the exact page
  // that resolves the highest-severity concern instead of the tile default).
  const tileRoute = (key: TileKey, fallback: string): string => {
    const t = alerts.byTile[key];
    const sub = t?.items.find((i) => i.sub)?.sub;
    return sub ?? fallback;
  };

  const tileDot = (key: TileKey) => {
    const t = alerts.byTile[key];
    if (!t) return null;
    const title = t.items.map((i) => `• ${i.text}`).join("\n");
    return (
      <AlertDot
        tone={t.tone}
        size="md"
        count={t.count}
        title={title}
        style={{ position: "absolute", top: 12, right: 12 }}
      />
    );
  };

  return (
    <div className="home">
      <header className="home-head">
        <img src={logo} alt="Logo" className="home-logo" />
        <div>
          <h1 style={{ margin: 0 }}>{daycareName}</h1>
          <p className="subtitle" style={{ margin: 0 }}>
            {new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
          </p>
        </div>
      </header>

      {/* Ask Echelon — hero banner with inline query box + inline answer.
          v2.2.4: users can ask "how do I scan a credit-card statement?" from
          Home and get numbered UI-nav steps back without leaving the page. */}
      <form
        className="home-hero"
        onSubmit={(e) => { e.preventDefault(); void runHomeAsk(); }}
        style={{ display: "flex", flexDirection: "column", alignItems: "stretch", gap: 12, textAlign: "left" }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <button
            type="button"
            onClick={() => nav("/ask")}
            className="home-hero-icon"
            aria-label="Open Ask Echelon"
            title="Open Ask Echelon"
            style={{ background: "transparent", border: 0, padding: 0, cursor: "pointer" }}
          >
            🤖
          </button>
          <div className="home-hero-copy" style={{ flex: 1, minWidth: 0 }}>
            <div className="home-hero-eyebrow">AI Assistant</div>
            <h2 style={{ marginBottom: 6 }}>Ask Echelon</h2>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="text"
                value={homeAskQ}
                onChange={(e) => setHomeAskQ(e.target.value)}
                placeholder='e.g. "where do I scan a credit-card statement?" or "how many kids attended last week?"'
                aria-label="Ask Echelon a question"
                disabled={askBusy}
                style={{
                  flex: 1, minWidth: 0, padding: "10px 12px", borderRadius: 8,
                  border: "1px solid rgba(0,0,0,0.15)", fontSize: 14, fontFamily: "inherit",
                  background: "rgba(255,255,255,0.95)", color: "#111",
                }}
                onClick={(e) => e.stopPropagation()}
              />
              <button
                type="submit"
                className="btn"
                disabled={askBusy || !homeAskQ.trim()}
                style={{ flexShrink: 0 }}
                onClick={(e) => e.stopPropagation()}
              >
                {askBusy ? "Thinking…" : "✨ Ask"}
              </button>
            </div>
            <p style={{ marginTop: 6, opacity: 0.9, fontSize: 12 }}>
              Data questions ("revenue by month") or how-to questions ("how do I email a receipt?") — both work.
            </p>
          </div>
        </div>

        {(askErr || askResult) && (
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              padding: "14px 16px", borderRadius: 10,
              background: "rgba(255,255,255,0.97)", color: "#0f172a",
              border: "1px solid rgba(0,0,0,0.08)", fontSize: 14, lineHeight: 1.55,
              maxHeight: 340, overflowY: "auto",
            }}
          >
            {askErr && (
              <div style={{ color: "#991b1b", whiteSpace: "pre-wrap" }}>⚠ {askErr}</div>
            )}
            {askResult?.summary && (
              <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                <span style={{ fontSize: 18, flexShrink: 0 }}>✨</span>
                <span style={{ whiteSpace: "pre-wrap" }}>{askResult.summary}</span>
              </div>
            )}
            {askResult && askResult.rows.length > 0 && (
              <div style={{ marginTop: 10, fontSize: 12, color: "#475569" }}>
                {askResult.rows.length} row{askResult.rows.length === 1 ? "" : "s"} returned.{" "}
                <button
                  type="button"
                  className="btn link"
                  style={{ padding: 0, fontSize: 12 }}
                  onClick={(e) => { e.stopPropagation(); nav(`/ask?q=${encodeURIComponent(homeAskQ.trim())}`); }}
                >See full results →</button>
              </div>
            )}
            {askResult && askResult.rows.length === 0 && !askResult.summary && (
              <div style={{ color: "#475569" }}>No answer produced.</div>
            )}
          </div>
        )}
      </form>

      {alerts.partialLoad.length > 0 && (
        <button
          type="button"
          aria-label={`Some background checks didn't complete: ${alerts.partialLoad.join(", ")}. Click to retry.`}
          title={`Some background checks didn't complete:\n• ${alerts.partialLoad.join("\n• ")}\nDots on affected tiles may be incomplete.`}
          style={{
            margin: "8px 0 -4px",
            padding: "6px 10px",
            fontSize: 12,
            color: "#78350f",
            background: "#fef3c7",
            border: "1px solid #fcd34d",
            borderRadius: 6,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            cursor: "pointer",
            font: "inherit",
          }}
          onClick={() => refreshAlerts()}
        >
          <span aria-hidden>⚠︎</span>
          <span>Some checks didn't finish — click to retry</span>
        </button>
      )}

      <div className="home-tiles">
        <button className="home-tile students" style={{ position: "relative" }} onClick={() => nav(tileRoute("students", "/students/today"))}>
          {tileDot("students")}
          <div className="home-tile-icon">👶</div>
          <h2>Students</h2>
          <p>Receipts, subsidies, annual tax receipts, roster</p>
        </button>

        <button className="home-tile staff" style={{ position: "relative" }} onClick={() => nav(staffEnabled ? tileRoute("staff", "/staff/hours") : "/config/staff")}>
          {tileDot("staff")}
          <div className="home-tile-icon">👩‍🏫</div>
          <h2>Staff{staffEnabled ? "" : " (disabled)"}</h2>
          <p>{staffEnabled ? "Hours, credentials, drill log, payroll prep" : "Turn on in Configuration → Staff to enable."}</p>
        </button>

        <button className="home-tile comms" style={{ position: "relative" }} onClick={() => nav(tileRoute("comms", "/communications/compose"))}>
          {tileDot("comms")}
          <div className="home-tile-icon">✉️</div>
          <h2>Communications</h2>
          <p>Group email, templates, message history, contact directory</p>
        </button>

        <button className="home-tile waitlist" style={{ position: "relative" }} onClick={() => nav(tileRoute("waitlist", "/waitlist"))}>
          {tileDot("waitlist")}
          <div className="home-tile-icon">📝</div>
          <h2>Waitlist</h2>
          <p>Google Form applications, follow-ups, conversions to enrolled students</p>
        </button>

        <button className="home-tile expenses" style={{ position: "relative" }} onClick={() => nav(tileRoute("expenses", "/expenses/dashboard"))}>
          {tileDot("expenses")}
          <div className="home-tile-icon">💵</div>
          <h2>Expenses</h2>
          <p>Track spending, recurring bills, WCB/CRA remittance, P&L reports</p>
        </button>

        <button className="home-tile reports" style={{ position: "relative" }} onClick={() => nav(tileRoute("reports", "/reports/overview"))}>
          {tileDot("reports")}
          <div className="home-tile-icon">📊</div>
          <h2>Reports & Compliance</h2>
          <p>Revenue, aging, subsidies, licensing rosters, credentials, drills, AGM</p>
        </button>

        <button className="home-tile vault" style={{ position: "relative" }} onClick={() => nav(tileRoute("vault", "/vault"))}>
          {tileDot("vault")}
          <div className="home-tile-icon">🗂️</div>
          <h2>Document Vault</h2>
          <p>Licences, insurance, policies, staff & child records — with expiry alerts</p>
        </button>

        <button className="home-tile organizer" style={{ position: "relative" }} onClick={() => nav(tileRoute("organizer", "/organizer"))}>
          {tileDot("organizer")}
          <div className="home-tile-icon">🗓️</div>
          <h2>Organizer</h2>
          <p>Upcoming deadlines, meeting log, follow-ups — one calm dashboard</p>
        </button>

        <button className="home-tile graduation" style={{ position: "relative" }} onClick={() => nav(tileRoute("graduation", "/graduation"))}>
          {tileDot("graduation")}
          <div className="home-tile-icon">🎓</div>
          <h2>Graduation Day</h2>
          <p>Year-in-review reel, per-child videos, slideshow — from your photo library</p>
        </button>
      </div>

      {update?.hasUpdate && (
        <div className="home-alert tone-info" style={{ marginTop: 12 }}>
          <span>
            <strong>Update available:</strong> {update.latest} (you have v{update.current}).
          </span>
          <button className="btn link" onClick={() => update.url && void openUrl(update.url)}>
            Download →
          </button>
        </div>
      )}

      <footer className="home-foot">
        <span>{appVersion ? `v${appVersion} · ` : ""}Echelon Daycare</span>
      </footer>
    </div>
  );
}
