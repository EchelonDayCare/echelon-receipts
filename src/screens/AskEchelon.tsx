import { useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, Legend, ResponsiveContainer,
} from "recharts";
import { showAlert, showConfirm } from "../lib/dialogs";
import {
  askEchelon, saveQuery, deleteSavedQuery, listSavedQueries, resultToCsv,
  type AskResult, type SavedQuery,
} from "../lib/askEchelon";
import { getSettings, setSettings } from "../lib/db";
import type { SettingsMap } from "../types";

const EXAMPLE_QUESTIONS = [
  "How many kids attended more than 15 days last month?",
  "Show me families with outstanding balances over $500",
  "What was revenue this quarter vs the same quarter last year?",
  "Which staff worked more than 40 hours any week last month?",
  "List credentials expiring in the next 60 days",
  "Total refunds issued this year, grouped by month",
];

const PIE_COLORS = ["#2563eb", "#0891b2", "#9333ea", "#c2410c", "#047857", "#dc2626", "#ca8a04"];

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
  const [showSql, setShowSql] = useState(false);
  const [sortBy, setSortBy] = useState<{ col: number; dir: "asc" | "desc" } | null>(null);
  const [placeholderIdx, setPlaceholderIdx] = useState(0);
  const [settings, setLocalSettings] = useState<SettingsMap>({});
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    getSettings().then(setLocalSettings);
    listSavedQueries().then(setSaved).catch(() => setSaved([]));
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
    setShowSql(false);
    try {
      const res = await askEchelon({ question: trimmed });
      setResult(res);
      setHistory((h) => {
        const filtered = h.filter((it) => it.question !== trimmed);
        return [{ question: trimmed, ts: Date.now() }, ...filtered].slice(0, 20);
      });
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
    <div style={{ padding: 24, maxWidth: 1400, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24 }}>Ask Echelon</h1>
          <p style={{ margin: "4px 0 0", color: "var(--muted)", fontSize: 13 }}>
            Ask questions in plain English. Answers come from your daycare data — nothing external.
          </p>
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center", fontSize: 12 }}>
          <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={settings.ask_echelon_redact !== "0"}
              onChange={toggleRedact}
            />
            Redact PII in AI context
          </label>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 260px", gap: 20 }}>
        <div>
          <div style={{ position: "relative", marginBottom: 12 }}>
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
                width: "100%", padding: "12px 90px 12px 14px", borderRadius: 10,
                border: "1px solid var(--border)", fontSize: 15, resize: "vertical",
                fontFamily: "inherit", boxSizing: "border-box",
              }}
              disabled={busy}
            />
            <button
              onClick={() => run(question)}
              disabled={busy || !question.trim()}
              style={{
                position: "absolute", right: 8, top: 8, padding: "8px 16px",
                borderRadius: 8, border: "none", background: "#2563eb", color: "white",
                cursor: busy ? "wait" : "pointer", opacity: (!question.trim() || busy) ? 0.5 : 1,
              }}
            >
              {busy ? "Thinking…" : "Ask"}
            </button>
          </div>

          {!result && !busy && !error && (
            <div>
              <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8 }}>Try one of these:</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {EXAMPLE_QUESTIONS.map((q) => (
                  <button
                    key={q}
                    onClick={() => { setQuestion(q); run(q); }}
                    style={{
                      padding: "8px 12px", borderRadius: 999, border: "1px solid var(--border)",
                      background: "var(--card, #f8fafc)", cursor: "pointer", fontSize: 13,
                    }}
                  >{q}</button>
                ))}
              </div>
            </div>
          )}

          {busy && (
            <div style={{ padding: 32, textAlign: "center", color: "var(--muted)" }}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>🤔</div>
              Reading your data, drafting SQL, running it…
            </div>
          )}

          {error && (
            <div className="today-item warn" style={{ marginTop: 8, whiteSpace: "pre-wrap" }}>
              <span className="today-dot">!</span>
              <span className="today-text">{error}</span>
            </div>
          )}

          {result && (
            <div style={{ marginTop: 16 }}>
              {result.summary && (
                <div style={{
                  padding: "14px 16px", borderRadius: 10, background: "#eff6ff",
                  border: "1px solid #bfdbfe", marginBottom: 16, fontSize: 15, lineHeight: 1.5,
                }}>
                  {result.summary}
                </div>
              )}

              <div style={{ display: "flex", gap: 12, marginBottom: 12, alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ fontSize: 12, color: "var(--muted)" }}>
                  {result.rows.length} row{result.rows.length === 1 ? "" : "s"}
                  {result.truncated ? " (capped at 500)" : ""} · {result.elapsed_ms} ms
                </span>
                <div style={{ flex: 1 }} />
                <button className="btn" onClick={onCopyCsv} disabled={result.rows.length === 0}>Copy as CSV</button>
                <button className="btn" onClick={onSaveReport}>Save as Report</button>
              </div>

              {result.rows.length > 0 && (
                <div style={{ overflow: "auto", border: "1px solid var(--border)", borderRadius: 8, maxHeight: 480 }}>
                  <table className="tbl" style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
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
                              padding: "8px 12px", textAlign: "left", cursor: "pointer",
                              borderBottom: "1px solid var(--border)", background: "var(--card, #f8fafc)",
                              position: "sticky", top: 0, userSelect: "none",
                            }}
                          >
                            {c}{sortBy?.col === i ? (sortBy.dir === "asc" ? " ▲" : " ▼") : ""}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sortedRows.map((r, ri) => (
                        <tr key={ri} style={{ borderBottom: "1px solid var(--border)" }}>
                          {r.map((v, ci) => (
                            <td key={ci} style={{ padding: "6px 12px" }}>
                              {v === null || v === undefined ? <span style={{ color: "var(--muted)" }}>—</span> : String(v)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <ChartArea result={result} rows={sortedRows} />

              <div style={{ marginTop: 12 }}>
                <button
                  onClick={() => setShowSql((s) => !s)}
                  style={{ border: "none", background: "transparent", color: "var(--muted)", cursor: "pointer", fontSize: 12, padding: 0 }}
                >
                  {showSql ? "▼ Hide SQL" : "▶ Show SQL"}
                </button>
                {showSql && (
                  <pre style={{
                    background: "#0f172a", color: "#e2e8f0", padding: 12, borderRadius: 8,
                    fontSize: 12, overflow: "auto", marginTop: 8,
                  }}>{result.sql}</pre>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Sidebar: history + saved */}
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {history.length > 0 && (
            <div>
              <div style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 8 }}>Recent this session</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {history.map((h, i) => (
                  <button
                    key={i}
                    onClick={() => { setQuestion(h.question); run(h.question); }}
                    style={{
                      textAlign: "left", background: "transparent", border: "none",
                      cursor: "pointer", padding: "6px 8px", borderRadius: 6, fontSize: 12,
                    }}
                  >{h.question}</button>
                ))}
              </div>
            </div>
          )}

          {saved.length > 0 && (
            <div>
              <div style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 8 }}>Saved reports</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {saved.map((s) => (
                  <div key={s.id} style={{ display: "flex", gap: 4, alignItems: "flex-start" }}>
                    <button
                      onClick={() => { setQuestion(s.question); run(s.question); }}
                      style={{
                        flex: 1, textAlign: "left", background: "transparent", border: "none",
                        cursor: "pointer", padding: "6px 8px", borderRadius: 6, fontSize: 12,
                      }}
                    >{s.question}</button>
                    <button
                      onClick={() => onDeleteSaved(s.id)}
                      title="Delete"
                      style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--muted)", fontSize: 12 }}
                    >×</button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
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
