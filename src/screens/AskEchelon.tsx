import { useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, Legend, ResponsiveContainer,
} from "recharts";
import { showAlert, showConfirm } from "../lib/dialogs";
import {
  askEchelon, saveQuery, deleteSavedQuery, listSavedQueries, resultToCsv,
  logQuestion, topAskedQuestions,
  type AskResult, type SavedQuery, type AskedQuestion,
} from "../lib/askEchelon";
import { getSettings, setSettings } from "../lib/db";
import type { SettingsMap } from "../types";

const EXAMPLE_QUESTIONS = [
  "How many kids attended more than 15 days last month?",
  "Show me families with outstanding balances over $500",
  "What was revenue this quarter vs same quarter last year?",
  "Which staff worked more than 40 hours any week last month?",
  "List credentials expiring in the next 60 days",
  "Total refunds issued this year, grouped by month",
  "Which parents haven't paid this month?",
  "Average daily attendance by month this year",
  "How much did we spend on supplies last quarter?",
  "Staff whose First Aid certificate expires soon",
];

const PIE_COLORS = ["#2563eb", "#0891b2", "#9333ea", "#c2410c", "#047857", "#dc2626", "#ca8a04"];

/** True when the result is 0 rows, or every cell in every row is null/0/"" —
 *  in which case the summary alone tells the whole story and the table is
 *  just noise. */
function isEffectivelyEmpty(r: AskResult): boolean {
  if (r.rows.length === 0) return true;
  return r.rows.every((row) =>
    row.every((v) => v === null || v === undefined || v === "" || v === 0)
  );
}

/** Render a single cell. Columns whose name is/ends with 'json' or whose value
 *  looks like a JSON blob get masked — showing the raw string would just be
 *  noise. Anything else long is truncated with a hover-to-see-full tooltip. */
function renderCell(v: unknown, colName?: string): React.ReactNode {
  if (v === null || v === undefined) return <span style={{ color: "var(--muted)" }}>—</span>;
  const s = String(v);
  const looksJsonName = !!colName && /(^|_)json$/i.test(colName);
  const looksJsonValue = s.length > 80 && (s.startsWith("{") || s.startsWith("["));
  if (looksJsonName || looksJsonValue) {
    return <span style={{ color: "var(--muted)", fontStyle: "italic" }}>[data blob — {s.length} chars]</span>;
  }
  if (s.length > 240) {
    return <span title={s}>{s.slice(0, 240)}…</span>;
  }
  return s;
}


type Row = unknown[];

interface HistoryItem {
  question: string;
  ts: number;
}

export default function AskEchelon() {
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AskResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [saved, setSaved] = useState<SavedQuery[]>([]);
  const [topAsked, setTopAsked] = useState<AskedQuestion[]>([]);
  const [sortBy, setSortBy] = useState<{ col: number; dir: "asc" | "desc" } | null>(null);
  const [placeholderIdx, setPlaceholderIdx] = useState(0);
  const [settings, setLocalSettings] = useState<SettingsMap>({});
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const refreshSidebar = async () => {
    try {
      const [t, s] = await Promise.all([topAskedQuestions(10), listSavedQueries()]);
      setTopAsked(t);
      setSaved(s);
    } catch { /* ignore */ }
  };

  useEffect(() => {
    getSettings().then(setLocalSettings);
    refreshSidebar();
    const t = window.setInterval(
      () => setPlaceholderIdx((i) => (i + 1) % EXAMPLE_QUESTIONS.length),
      3500,
    );
    return () => window.clearInterval(t);
  }, []);

  async function run(q: string) {
    const trimmed = q.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setSortBy(null);
    try {
      const res = await askEchelon({ question: trimmed });
      setResult(res);
      setHistory((h) => {
        const filtered = h.filter((it) => it.question !== trimmed);
        return [{ question: trimmed, ts: Date.now() }, ...filtered].slice(0, 20);
      });
      logQuestion(trimmed).then(refreshSidebar).catch(() => {});
    } catch (e: any) {
      const msg = String(e?.message ?? e ?? "Unknown error");
      // Don't leak raw SQLite errors — the model or user may have crafted a
      // bad question, they don't need to see internals.
      if (/SQL parse error|Only SELECT|multiple statements|comments|Non-SELECT/i.test(msg)) {
        setError("I couldn't turn that into a safe SQL query. Try rephrasing.");
      } else if (/network|timeout|unreachable|send:/i.test(msg)) {
        setError("AI service unreachable. Check your internet connection.");
      } else if (/key/i.test(msg)) {
        setError(msg);
      } else {
        setError("I couldn't answer that. Try rephrasing.\n\nDetails: " + msg);
      }
    } finally {
      setBusy(false);
    }
  }

  async function onSaveReport() {
    if (!result) return;
    const label = window.prompt("Save this question as a report?", question.trim());
    if (!label || !label.trim()) return;
    await saveQuery(label.trim(), result.sql, result.chart_hint);
    setSaved(await listSavedQueries());
    await showAlert("Saved.");
  }

  async function onDeleteSaved(id: number) {
    if (!await showConfirm("Delete this saved question?")) return;
    await deleteSavedQuery(id);
    setSaved(await listSavedQueries());
  }

  async function onCopyCsv() {
    if (!result) return;
    const csv = resultToCsv(result);
    try {
      await navigator.clipboard.writeText(csv);
      await showAlert(`Copied ${result.rows.length} row${result.rows.length === 1 ? "" : "s"} to clipboard as CSV.`);
    } catch (e: any) {
      await showAlert("Copy failed: " + (e?.message || e), { kind: "error" });
    }
  }

  async function toggleRedact() {
    const next = settings.ask_echelon_redact === "0" ? "1" : "0";
    await setSettings({ ask_echelon_redact: next });
    setLocalSettings({ ...settings, ask_echelon_redact: next });
  }

  const sortedRows = useMemo(() => {
    if (!result) return [] as Row[];
    if (!sortBy) return result.rows;
    const { col, dir } = sortBy;
    const copy = result.rows.slice();
    copy.sort((a, b) => {
      const av = a[col];
      const bv = b[col];
      if (av === bv) return 0;
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      const an = typeof av === "number" ? av : parseFloat(String(av));
      const bn = typeof bv === "number" ? bv : parseFloat(String(bv));
      let cmp: number;
      if (!Number.isNaN(an) && !Number.isNaN(bn)) cmp = an - bn;
      else cmp = String(av).localeCompare(String(bv));
      return dir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [result, sortBy]);

  return (
    <div style={{ padding: "24px 32px 40px", maxWidth: 1400, margin: "0 auto" }}>
      {/* Hero header */}
      <div style={{
        background: "linear-gradient(135deg, #eff6ff 0%, #f0f9ff 60%, #ecfdf5 100%)",
        border: "1px solid #dbeafe", borderRadius: 16, padding: "24px 28px", marginBottom: 20,
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 28, letterSpacing: "-0.02em", display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 28 }}>🤖</span> Ask Echelon
            </h1>
            <p style={{ margin: "6px 0 0", color: "#475569", fontSize: 14 }}>
              Ask anything about your daycare — attendance, revenue, staff, credentials, expenses.
            </p>
          </div>
          <label style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer", fontSize: 12, color: "#475569", background: "rgba(255,255,255,.7)", padding: "6px 10px", borderRadius: 999, border: "1px solid rgba(255,255,255,.9)" }}>
            <input
              type="checkbox"
              checked={settings.ask_echelon_redact !== "0"}
              onChange={toggleRedact}
            />
            Redact PII in AI context
          </label>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: 24 }}>
        <div>
          {/* Big search input */}
          <div style={{
            position: "relative", marginBottom: 20,
            background: "#ffffff", borderRadius: 14, border: "1px solid var(--border)",
            boxShadow: "0 1px 3px rgba(15,23,42,.04), 0 4px 12px rgba(15,23,42,.04)",
          }}>
            <textarea
              ref={inputRef}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if ((e.key === "Enter" && (e.metaKey || e.ctrlKey)) || (e.key === "Enter" && !e.shiftKey && question.trim())) {
                  e.preventDefault();
                  run(question);
                }
              }}
              placeholder={`e.g. ${EXAMPLE_QUESTIONS[placeholderIdx]}`}
              rows={2}
              style={{
                width: "100%", padding: "18px 130px 18px 20px", borderRadius: 14,
                border: "none", fontSize: 16, resize: "vertical",
                fontFamily: "inherit", boxSizing: "border-box", outline: "none",
                background: "transparent", minHeight: 68,
              }}
              disabled={busy}
            />
            <button
              onClick={() => run(question)}
              disabled={busy || !question.trim()}
              style={{
                position: "absolute", right: 10, top: 10, padding: "10px 22px",
                borderRadius: 10, border: "none",
                background: (!question.trim() || busy) ? "#94a3b8" : "linear-gradient(135deg, #2563eb, #1d4ed8)",
                color: "white", cursor: busy ? "wait" : "pointer",
                fontSize: 14, fontWeight: 600, boxShadow: "0 2px 6px rgba(37,99,235,.25)",
                transition: "transform .05s",
              }}
            >
              {busy ? "Thinking…" : "Ask →"}
            </button>
          </div>

          {!result && !busy && !error && (
            <div>
              <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 10, textTransform: "uppercase", letterSpacing: ".06em", fontWeight: 600 }}>Try one of these</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10 }}>
                {EXAMPLE_QUESTIONS.slice(0, 6).map((q) => (
                  <button
                    key={q}
                    onClick={() => { setQuestion(q); run(q); }}
                    style={{
                      padding: "14px 16px", borderRadius: 12, border: "1px solid var(--border)",
                      background: "#ffffff", cursor: "pointer", fontSize: 13, textAlign: "left",
                      lineHeight: 1.4, transition: "transform .1s, box-shadow .1s",
                    }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.boxShadow = "0 4px 12px rgba(37,99,235,.08)"; (e.currentTarget as HTMLButtonElement).style.borderColor = "#93c5fd"; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.boxShadow = "none"; (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--border)"; }}
                  >💡 {q}</button>
                ))}
              </div>
            </div>
          )}

          {busy && (
            <div style={{ padding: 48, textAlign: "center", color: "var(--muted)" }}>
              <div style={{ fontSize: 40, marginBottom: 10, animation: "pulse 1.4s ease-in-out infinite" }}>🤔</div>
              <div style={{ fontSize: 14 }}>Thinking…</div>
            </div>
          )}

          {error && (
            <div style={{
              padding: "14px 16px", borderRadius: 12, background: "#fef2f2",
              border: "1px solid #fecaca", color: "#7f1d1d", fontSize: 14, whiteSpace: "pre-wrap",
            }}>
              {error}
            </div>
          )}

          {result && (
            <div>
              {result.summary && (
                <div style={{
                  padding: "18px 20px", borderRadius: 14,
                  background: "linear-gradient(135deg, #eff6ff, #f0f9ff)",
                  border: "1px solid #bfdbfe", marginBottom: 18, fontSize: 15, lineHeight: 1.55,
                  color: "#0f172a", display: "flex", gap: 12, alignItems: "flex-start",
                }}>
                  <span style={{ fontSize: 20, flexShrink: 0 }}>✨</span>
                  <span>{result.summary}</span>
                </div>
              )}

              {isEffectivelyEmpty(result) ? null : (
                <>
                  <div style={{ display: "flex", gap: 12, marginBottom: 12, alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ fontSize: 12, color: "var(--muted)" }}>
                      {result.rows.length} row{result.rows.length === 1 ? "" : "s"}
                      {result.truncated ? " (showing first 500)" : ""}
                    </span>
                    <div style={{ flex: 1 }} />
                    <button className="btn secondary" onClick={onCopyCsv}>Copy as CSV</button>
                    <button className="btn" onClick={onSaveReport}>⭐ Save as Report</button>
                  </div>

                  <div style={{ overflow: "auto", border: "1px solid var(--border)", borderRadius: 12, maxHeight: 480, background: "#ffffff" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                    <thead>
                      <tr>
                        {result.columns.map((c, i) => (
                          <th
                            key={i}
                            onClick={() => setSortBy((prev) =>
                              prev?.col === i
                                ? { col: i, dir: prev.dir === "asc" ? "desc" : "asc" }
                                : { col: i, dir: "asc" }
                            )}
                            style={{
                              padding: "12px 14px", textAlign: "left", cursor: "pointer",
                              borderBottom: "1px solid var(--border)", background: "#f8fafc",
                              position: "sticky", top: 0, userSelect: "none",
                              fontSize: 11, textTransform: "uppercase", letterSpacing: ".06em",
                              color: "#475569", fontWeight: 600,
                            }}
                          >
                            {c}{sortBy?.col === i ? (sortBy.dir === "asc" ? " ▲" : " ▼") : ""}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sortedRows.map((r, ri) => (
                        <tr key={ri} style={{ borderBottom: "1px solid #f1f5f9", background: ri % 2 === 0 ? "#ffffff" : "#fafbfc" }}>
                          {r.map((v, ci) => (
                            <td key={ci} style={{ padding: "10px 14px", maxWidth: 360, wordBreak: "break-word" }}>
                              {renderCell(v, result.columns[ci])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                </>
              )}

              <ChartArea result={result} rows={sortedRows} />
            </div>
          )}
        </div>

        {/* Right sidebar: Top asked (or suggestions) + saved reports */}
        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          <TopAskedPanel
            topAsked={topAsked}
            onPick={(q) => { setQuestion(q); run(q); }}
          />

          {saved.length > 0 && (
            <SidebarPanel title="⭐ Saved reports" accent="#ca8a04">
              {saved.map((s) => (
                <div key={s.id} style={{ display: "flex", gap: 4, alignItems: "center" }}>
                  <button
                    onClick={() => { setQuestion(s.question); run(s.question); }}
                    style={sidebarItemStyle}
                    onMouseEnter={(e) => (e.currentTarget as HTMLButtonElement).style.background = "#fef9c3"}
                    onMouseLeave={(e) => (e.currentTarget as HTMLButtonElement).style.background = "transparent"}
                  >{s.question}</button>
                  <button
                    onClick={() => onDeleteSaved(s.id)}
                    title="Delete"
                    style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--muted)", fontSize: 14, padding: "0 4px" }}
                  >×</button>
                </div>
              ))}
            </SidebarPanel>
          )}

          {history.length > 0 && (
            <SidebarPanel title="🕘 Recent this session" accent="#64748b">
              {history.slice(0, 8).map((h, i) => (
                <button
                  key={i}
                  onClick={() => { setQuestion(h.question); run(h.question); }}
                  style={sidebarItemStyle}
                  onMouseEnter={(e) => (e.currentTarget as HTMLButtonElement).style.background = "#f1f5f9"}
                  onMouseLeave={(e) => (e.currentTarget as HTMLButtonElement).style.background = "transparent"}
                >{h.question}</button>
              ))}
            </SidebarPanel>
          )}
        </div>
      </div>

      <style>{`
        @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .5 } }
      `}</style>
    </div>
  );
}

const sidebarItemStyle: React.CSSProperties = {
  flex: 1, textAlign: "left", background: "transparent", border: "none",
  cursor: "pointer", padding: "8px 10px", borderRadius: 8, fontSize: 12.5,
  lineHeight: 1.35, color: "#334155", transition: "background .1s",
};

function SidebarPanel({ title, accent, children }: { title: string; accent: string; children: React.ReactNode }) {
  return (
    <div style={{ background: "#ffffff", border: "1px solid var(--border)", borderRadius: 12, padding: 14 }}>
      <div style={{
        fontSize: 11, color: accent, textTransform: "uppercase",
        letterSpacing: ".08em", marginBottom: 8, fontWeight: 700,
      }}>{title}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>{children}</div>
    </div>
  );
}

function TopAskedPanel({
  topAsked, onPick,
}: { topAsked: AskedQuestion[]; onPick: (q: string) => void }) {
  // Show "top asked" once we have at least 5 recorded questions. Below that,
  // the ranking isn't meaningful — show 10 suggestions instead.
  const useTop = topAsked.length >= 5;
  const items: { text: string; badge?: string }[] = useTop
    ? topAsked.map((t) => ({ text: t.question, badge: t.ask_count > 1 ? `${t.ask_count}×` : undefined }))
    : EXAMPLE_QUESTIONS.slice(0, 10).map((q) => ({ text: q }));

  return (
    <SidebarPanel
      title={useTop ? "🔥 Top questions asked" : "💡 Suggestions"}
      accent={useTop ? "#dc2626" : "#2563eb"}
    >
      {items.map((it, i) => (
        <button
          key={i}
          onClick={() => onPick(it.text)}
          style={{ ...sidebarItemStyle, display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}
          onMouseEnter={(e) => (e.currentTarget as HTMLButtonElement).style.background = useTop ? "#fef2f2" : "#eff6ff"}
          onMouseLeave={(e) => (e.currentTarget as HTMLButtonElement).style.background = "transparent"}
        >
          <span>{it.text}</span>
          {it.badge && (
            <span style={{
              fontSize: 10, background: "#fee2e2", color: "#991b1b",
              padding: "2px 6px", borderRadius: 999, whiteSpace: "nowrap", fontWeight: 600, flexShrink: 0,
            }}>{it.badge}</span>
          )}
        </button>
      ))}
    </SidebarPanel>
  );
}

// ── Chart rendering ──────────────────────────────────────────────────────

function ChartArea({ result, rows }: { result: AskResult; rows: Row[] }) {
  if (result.chart_hint === "none" || rows.length === 0 || rows.length > 100) return null;
  if (result.columns.length < 2) return null;

  // Heuristic: first column is the label/dimension, second is a numeric value.
  // If the second column isn't numeric, don't render.
  const nameKey = result.columns[0];
  const valKey = result.columns[1];
  const data = rows.map((r) => {
    const raw = r[1];
    const n = typeof raw === "number" ? raw : parseFloat(String(raw));
    return { name: String(r[0] ?? ""), value: Number.isFinite(n) ? n : 0 };
  });
  if (data.every((d) => d.value === 0)) return null;

  const box: React.CSSProperties = {
    marginTop: 16, background: "var(--card, #ffffff)", padding: 12,
    border: "1px solid var(--border)", borderRadius: 8, height: 320,
  };

  if (result.chart_hint === "line") {
    return (
      <div style={box}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data}>
            <XAxis dataKey="name" fontSize={11} />
            <YAxis fontSize={11} />
            <Tooltip />
            <Legend />
            <Line type="monotone" dataKey="value" name={valKey} stroke="#2563eb" strokeWidth={2} />
          </LineChart>
        </ResponsiveContainer>
        <div style={{ fontSize: 11, color: "var(--muted)", textAlign: "center" }}>{nameKey}</div>
      </div>
    );
  }
  if (result.chart_hint === "pie") {
    return (
      <div style={box}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" outerRadius={110} label={(d: any) => d.name}>
              {data.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
            </Pie>
            <Tooltip />
          </PieChart>
        </ResponsiveContainer>
      </div>
    );
  }
  // bar (default)
  return (
    <div style={box}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data}>
          <XAxis dataKey="name" fontSize={11} />
          <YAxis fontSize={11} />
          <Tooltip />
          <Legend />
          <Bar dataKey="value" name={valKey} fill="#2563eb" />
        </BarChart>
      </ResponsiveContainer>
      <div style={{ fontSize: 11, color: "var(--muted)", textAlign: "center" }}>{nameKey}</div>
    </div>
  );
}
