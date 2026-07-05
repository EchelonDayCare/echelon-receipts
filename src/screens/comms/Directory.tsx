import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { listStudents, listYears } from "../../lib/db";
import type { Student } from "../../types";
import { parseRecipients } from "../../lib/email";
import { showAlert } from "../../lib/dialogs";

export default function Directory() {
  const nav = useNavigate();
  const [students, setStudents] = useState<Student[]>([]);
  const [years, setYears] = useState<number[]>([]);
  const [year, setYear] = useState<number | "all">("all");
  const [activeOnly, setActiveOnly] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    listYears().then((ys) => { setYears(ys); if (ys.length && year === "all") setYear(ys[0]); });
    // eslint-disable-next-line
  }, []);

  useEffect(() => {
    (async () => {
      const y = year === "all" ? undefined : year;
      const list = await listStudents(y, activeOnly);
      setStudents(list);
    })();
  }, [year, activeOnly]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return students;
    return students.filter((s) => {
      const hay = [s.name, s.father_name, s.mother_name, s.email].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [students, search]);

  const withEmail = filtered.filter((s) => parseRecipients(s.email).length > 0);

  const [copied, setCopied] = useState(false);
  async function copyAllEmails() {
    const all = Array.from(new Set(withEmail.flatMap((s) => parseRecipients(s.email)))).join(", ");
    if (!all) { await showAlert("No email addresses to copy.", { kind: "warning" }); return; }
    await navigator.clipboard.writeText(all);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  }

  function exportCsv() {
    const lines = ["Student,Father,Mother,Email,Active,Year"];
    for (const s of filtered) {
      const row = [s.name, s.father_name || "", s.mother_name || "", s.email || "", s.active ? "Y" : "N", String(s.year)]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",");
      lines.push(row);
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `contacts-${year}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div style={{ padding: 24, maxWidth: 1200 }}>
      <h1 style={{ marginTop: 0 }}>Contact Directory</h1>
      <p style={{ color: "var(--muted)", marginTop: -8 }}>
        Read-only view of parent contacts. Edit contact details in Roster.
      </p>

      <div className="card" style={{ padding: 12, marginBottom: 16, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <label>Year:
          <select value={year} onChange={(e) => setYear(e.target.value === "all" ? "all" : Number(e.target.value))} style={{ marginLeft: 6 }}>
            <option value="all">All</option>
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </label>
        <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} />
          Active only
        </label>
        <input placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ padding: 6, minWidth: 220 }} />
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button className="btn secondary" onClick={copyAllEmails}>{copied ? `✓ Copied ${withEmail.length}` : "Copy all emails"}</button>
          <button className="btn secondary" onClick={exportCsv}>Export CSV</button>
        </div>
      </div>

      <div style={{ color: "var(--muted)", marginBottom: 8 }}>
        {filtered.length} student{filtered.length === 1 ? "" : "s"} · {withEmail.length} with email
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ background: "#f8fafc", textAlign: "left" }}>
            <th style={{ padding: 8 }}>Student</th>
            <th style={{ padding: 8 }}>Parents</th>
            <th style={{ padding: 8 }}>Email</th>
            <th style={{ padding: 8 }}>Year</th>
            <th style={{ padding: 8 }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((s) => {
            const emails = parseRecipients(s.email);
            return (
              <tr key={s.id} style={{ borderTop: "1px solid var(--border)", opacity: s.active ? 1 : 0.6 }}>
                <td style={{ padding: 8 }}>{s.name}{!s.active && <span style={{ fontSize: 11, marginLeft: 6, color: "var(--muted)" }}>(inactive)</span>}</td>
                <td style={{ padding: 8, color: "var(--muted)" }}>{[s.father_name, s.mother_name].filter(Boolean).join(" · ") || "—"}</td>
                <td style={{ padding: 8 }}>{s.email || <span style={{ color: "var(--muted)" }}>none</span>}</td>
                <td style={{ padding: 8 }}>{s.year}</td>
                <td style={{ padding: 8 }}>
                  {emails.length > 0 && (
                    <button className="btn link" onClick={() => {
                      navigator.clipboard.writeText(emails.join(", "));
                    }}>Copy email</button>
                  )}
                  <button className="btn link" onClick={() => nav("/students/roster")}>Open in roster</button>
                </td>
              </tr>
            );
          })}
          {filtered.length === 0 && (
            <tr><td colSpan={5} style={{ padding: 24, textAlign: "center", color: "var(--muted)" }}>No contacts.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
