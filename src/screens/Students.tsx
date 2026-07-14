import { showAlert, showConfirm, showPrompt } from "../lib/dialogs";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { listStudents, listYears, upsertStudent, deleteStudent, reactivateStudent, hardDeleteStudent, getSettings,
  listAccbForStudent, upsertAccb, deleteAccb } from "../lib/db";
import { parseRosterFile } from "../lib/excelImport";
import type { Student, AccbEntry, SettingsMap } from "../types";

export default function Students() {
  const now = new Date().getFullYear();
  const nav = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [years, setYears] = useState<number[]>([now]);
  const [year, setYear] = useState<number>(now);
  const [students, setStudents] = useState<Student[]>([]);
  const [editing, setEditing] = useState<Partial<Student> | null>(null);
  const [pendingImport, setPendingImport] = useState<{ path: string; year: number } | null>(null);
  const [settings, setSettings] = useState<SettingsMap>({});
  const [accbFor, setAccbFor] = useState<{ student: Student; entries: AccbEntry[] } | null>(null);
  const [accbDraft, setAccbDraft] = useState<{ year: number; month: number; amount: string; notes: string }>(
    { year: new Date().getFullYear(), month: new Date().getMonth() + 1, amount: "", notes: "" }
  );

  // Track a pending waitlist conversion. When the user saves the pre-filled
  // student, we call markConverted so the waitlist entry links to the new
  // student and moves to 'enrolled'. Cleared by the save handler.
  const [pendingWaitlistId, setPendingWaitlistId] = useState<number | null>(null);

  // Auto-open the Add Student modal when arriving with ?new=1 (from Today's
  // "+ New Student" quick action) OR with waitlist pre-fill params from the
  // Waitlist detail drawer's "Convert to Student" button.
  useEffect(() => {
    if (searchParams.get("new") === "1") {
      setEditing({ year, active: 1 });
      searchParams.delete("new");
      setSearchParams(searchParams, { replace: true });
      return;
    }
    // Waitlist pre-fill. Accepts: name, father_name, mother_name, email,
    // fromWaitlist=<id>. Everything else on the waitlist entry (phone, notes,
    // birthday) has no home on the students table, so we drop it silently.
    const fromWaitlist = searchParams.get("fromWaitlist");
    const name = searchParams.get("name");
    if (fromWaitlist && name) {
      setEditing({
        year,
        active: 1,
        name,
        father_name: searchParams.get("father_name") || null,
        mother_name: searchParams.get("mother_name") || null,
        email: searchParams.get("email") || null,
      });
      setPendingWaitlistId(Number(fromWaitlist) || null);
      // Strip the params so a refresh doesn't re-open the modal.
      ["fromWaitlist", "name", "father_name", "mother_name", "email"].forEach((k) => searchParams.delete(k));
      setSearchParams(searchParams, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refresh() {
    const ys = await listYears();
    const all = ys.length ? ys : [now];
    setYears(all);
    if (!all.includes(year)) setYear(all[0]);
    setStudents(await listStudents(year, false));
    setSettings(await getSettings());
  }
  useEffect(() => { refresh();   }, [year]);

  async function openAccb(s: Student) {
    const entries = await listAccbForStudent(s.id);
    setAccbFor({ student: s, entries });
    setAccbDraft({ year: new Date().getFullYear(), month: new Date().getMonth() + 1, amount: "", notes: "" });
  }
  async function refreshAccb() {
    if (!accbFor) return;
    setAccbFor({ ...accbFor, entries: await listAccbForStudent(accbFor.student.id) });
  }
  async function saveAccbRow() {
    if (!accbFor) return;
    const amt = parseFloat(accbDraft.amount);
    if (!Number.isFinite(amt) || amt < 0) { void showAlert("Enter a non-negative amount (0 clears the month)."); return; }
    if (amt === 0) {
      const existing = accbFor.entries.find((e) => e.year === accbDraft.year && e.month === accbDraft.month);
      if (existing) await deleteAccb(existing.id);
    } else {
      await upsertAccb(accbFor.student.id, accbDraft.year, accbDraft.month, amt, accbDraft.notes || null);
    }
    setAccbDraft({ ...accbDraft, amount: "", notes: "" });
    refreshAccb();
  }

  async function onHardDelete(s: Student) {
    try {
      const probe = await hardDeleteStudent(s.id, false);
      if (!probe.deleted && probe.receiptCount > 0) {
        const ok = await showConfirm(
          `⚠️  Permanently delete ${s.name}?\n\n` +
          `This student has ${probe.receiptCount} receipt${probe.receiptCount === 1 ? "" : "s"} on file. ` +
          `Deleting will also remove:\n` +
          `  • All ${probe.receiptCount} receipt${probe.receiptCount === 1 ? "" : "s"}\n` +
          `  • Any annual (CRA) receipts for this family\n` +
          `  • Any ACCB ledger entries\n` +
          `  • Any attendance records\n\n` +
          `⚠  CRA requires you to keep child-care receipts for 6 years after the tax year they were issued. Only proceed if you have already exported this family's records for backup, or the receipts were entered in error.\n\n` +
          `This CANNOT be undone. Use "Inactivate" instead if the student is real.\n\n` +
          `Continue?`,
          { kind: "warning" }
        );
        if (!ok) return;
        const typed = await showPrompt(`Type the student's full name to confirm permanent deletion:\n\n${s.name}`);
        if ((typed || "").trim().toLowerCase() !== s.name.trim().toLowerCase()) {
          void showAlert("Name did not match. Deletion cancelled.");
          return;
        }
        await hardDeleteStudent(s.id, true);
        refresh();
        return;
      }
      const ok = await showConfirm(`Permanently delete ${s.name}?\n\nNo receipts on file, so nothing else is affected.`);
      if (!ok) return;
      await hardDeleteStudent(s.id, true);
      refresh();
    } catch (e) {
      void showAlert("Delete failed: " + ((e as any)?.message || String(e)));
    }
  }

  async function onImport() {
    const path = await open({
      multiple: false,
      filters: [{ name: "Excel/CSV", extensions: ["xlsx", "xls", "csv"] }],
    });
    if (!path || Array.isArray(path)) return;
    // Try to auto-detect year from filename (e.g. "Echelon_Roster_2026.xlsx")
    const m = (path as string).match(/(20\d{2})/);
    const guessedYear = m ? parseInt(m[1], 10) : now;
    setPendingImport({ path: path as string, year: guessedYear });
  }

  async function runImport() {
    if (!pendingImport) return;
    const { path, year: targetYear } = pendingImport;
    setPendingImport(null);
    try {
      const bytes = await readFile(path);
      const imported = await parseRosterFile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
      if (!imported.length) {
        void showAlert("No rows found. Expected columns: Student Name, Father's Name, Mother's Name, Email ID");
        return;
      }
      const existing = new Set((await listStudents(targetYear, false)).map((s) => s.name.toLowerCase().trim()));
      let added = 0, skipped = 0;
      for (const s of imported) {
        if (existing.has(s.name.toLowerCase().trim())) { skipped++; continue; }
        await upsertStudent({ ...s, year: targetYear });
        added++;
      }
      setYear(targetYear);
      await refresh();
      // After import, scan for fuzzy duplicates (email/parent-matched, 90% name).
      // Re-read the roster because state updates asynchronously.
      const fresh = await listStudents(targetYear, false);
      const groups = findDuplicatesIn(fresh);
      if (groups.length > 0) {
        setDupePreview(groups);
        void showAlert(`Imported: ${added} added, ${skipped} skipped. Found ${groups.length} possible duplicate ${groups.length === 1 ? "group" : "groups"} — review below.`);
      } else {
        void showAlert(`Imported: ${added} added, ${skipped} skipped (duplicates).`);
      }
    } catch (err) {
      void showAlert("Import failed: " + (err instanceof Error ? err.message : String(err)));
    }
  }

  const [searchQ, setSearchQ] = useState("");
  const [missingEmailOnly, setMissingEmailOnly] = useState(false);
  const [dupePreview, setDupePreview] = useState<Student[][] | null>(null);

  function findDuplicatesIn(list: Student[]): Student[][] {
    const stripPoss = (x: string) => x.replace(/['']s\b/g, "");
    const cleanTokens = (s: string): string[] => {
      const x = stripPoss((s || "").toLowerCase());
      return x.replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);
    };
    const norm = (s: string) => cleanTokens(s).slice().sort().join(" ");
    // Split "First Middle Last" → { first, last } for sibling-safe compare.
    // Single-word names get first=last=that word (rare edge case).
    const splitName = (s: string): { first: string; last: string } => {
      const t = cleanTokens(s);
      if (t.length === 0) return { first: "", last: "" };
      if (t.length === 1) return { first: t[0], last: t[0] };
      return { first: t[0], last: t[t.length - 1] };
    };
    const normEmail = (s: string | null | undefined) => (s || "").trim().toLowerCase();
    function similar(a: string, b: string): number {
      if (!a || !b) return 0;
      if (a === b) return 1;
      const m = a.length, n = b.length;
      const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
      for (let i = 0; i <= m; i++) dp[i][0] = i;
      for (let j = 0; j <= n; j++) dp[0][j] = j;
      for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
        dp[i][j] = a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
      }
      return 1 - dp[m][n] / Math.max(m, n);
    }
    const parent: number[] = list.map((_, i) => i);
    const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const A = list[a], B = list[b];
        const na = splitName(A.name), nb = splitName(B.name);
        // Sibling-safe: last names must match exactly (after norm), and
        // first names must be ≥95% similar. Blocks Sara/Sarah, Alex/Alexa,
        // Jayden/Kayden even when parents match.
        if (!na.last || !nb.last || na.last !== nb.last) continue;
        if (similar(na.first, nb.first) < 0.95) continue;
        const ea = normEmail(A.email), eb = normEmail(B.email);
        const fa = norm(A.father_name || ""), fb = norm(B.father_name || "");
        const ma = norm(A.mother_name || ""), mb = norm(B.mother_name || "");
        const emailMatch = ea && eb && ea === eb;
        const fatherMatch = fa && fb && fa === fb;
        const motherMatch = ma && mb && ma === mb;
        if (emailMatch || fatherMatch || motherMatch) union(a, b);
      }
    }
    const groups = new Map<number, Student[]>();
    list.forEach((s, i) => {
      const r = find(i);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r)!.push(s);
    });
    return [...groups.values()].filter((g) => g.length > 1);
  }

  function findDuplicates(): Student[][] {
    return findDuplicatesIn(students);
  }

  async function runDedupe() {
    if (!dupePreview) return;
    let deleted = 0;
    let skipped = 0;
    for (const group of dupePreview) {
      // Keep priority: active first, then highest id (newest). All others
      // are removal candidates.
      const sorted = [...group].sort((a, b) => {
        if (a.active !== b.active) return b.active - a.active; // active=1 first
        return b.id - a.id;                                    // newest first
      });
      const [, ...dupes] = sorted;
      for (const d of dupes) {
        try {
          const res = await hardDeleteStudent(d.id);
          if (res.deleted) deleted++; else skipped++;
        } catch { skipped++; }
      }
    }
    setDupePreview(null);
    refresh();
    const parts: string[] = [];
    parts.push(`Removed ${deleted} duplicate${deleted === 1 ? "" : "s"}`);
    if (skipped > 0) parts.push(`${skipped} skipped (have receipts)`);
    void showAlert(parts.join(", ") + ".");
  }

  const visibleStudents = (() => {
    const q = searchQ.trim().toLowerCase();
    return students.filter((s) => {
      if (missingEmailOnly && (s.email || "").trim() !== "") return false;
      if (!q) return true;
      const hay = [s.name, s.father_name, s.mother_name, s.email].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    });
  })();

  return (
    <div>
      <h1>Students</h1>
      <p className="subtitle">Per-year roster. Receipts always snapshot the parent names at time of issue, so editing here won't change past receipts.</p>

      <div className="toolbar">
        <label style={{ fontSize: 13, color: "var(--muted)" }}>Year:</label>
        <select value={year} onChange={(e) => setYear(parseInt(e.target.value, 10))}>
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <input
          type="search"
          placeholder="Search name, parent, or email…"
          value={searchQ}
          onChange={(e) => setSearchQ(e.target.value)}
          style={{ padding: "6px 10px", minWidth: 240 }}
        />
        <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 4 }}>
          <input type="checkbox" checked={missingEmailOnly} onChange={(e) => setMissingEmailOnly(e.target.checked)} />
          Missing email only
        </label>
        <div className="grow" />
        <button className="btn secondary" onClick={() => setEditing({ year, active: 1 })}>+ Add Student</button>
        <button className="btn secondary" onClick={async () => {
          const strip = (v: string | null | undefined): string | null => {
            if (v == null) return null;
            let out = String(v).replace(/[\u2019']s\b\s*$/i, "");
            out = out.replace(/[\u2019']s\s+/gi, " ").replace(/\s{2,}/g, " ").trim();
            return out || null;
          };
          let fixed = 0;
          for (const s of students) {
            const n = strip(s.name);
            const f = strip(s.father_name);
            const m = strip(s.mother_name);
            if (n !== s.name || f !== s.father_name || m !== s.mother_name) {
              if (!n) continue; // don't blank a name
              await upsertStudent({ ...s, name: n, father_name: f, mother_name: m });
              fixed++;
            }
          }
          await refresh();
          void showAlert(fixed === 0 ? "No names needed cleaning." : `Cleaned ${fixed} record${fixed === 1 ? "" : "s"}.`);
        }}>Clean names</button>
        <button className="btn secondary" onClick={() => {
          const groups = findDuplicates();
          if (groups.length === 0) { void showAlert("No duplicates found."); return; }
          setDupePreview(groups);
        }}>Find duplicates</button>
        <button className="btn" onClick={onImport}>Import from Excel</button>
      </div>

      {students.length === 0 ? (
        <div className="empty">No students for {year}. Click <b>Import from Excel</b> to load a yearly roster.</div>
      ) : visibleStudents.length === 0 ? (
        <div className="empty">No students match the current filter.</div>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Student</th><th>Father</th><th>Mother</th><th>Email</th><th>Status</th><th></th>
            </tr>
          </thead>
          <tbody>
            {visibleStudents.map((s) => (
              <tr key={s.id}>
                <td>{s.name}</td>
                <td>{s.father_name || "—"}</td>
                <td>{s.mother_name || "—"}</td>
                <td>{s.email || "—"}</td>
                <td>{s.active ? <span className="badge ok">Active</span> : <span className="badge warn">Inactive</span>}</td>
                <td style={{ textAlign: "right" }}>
                  <button className="btn ghost" onClick={() => setEditing(s)}>Edit</button>
                  {settings.subsidies_enabled === "1" && (
                    <button className="btn ghost" onClick={() => openAccb(s)}>ACCB…</button>
                  )}
                  {s.active === 1 && (
                    <button className="btn ghost" style={{ color: "var(--danger)" }}
                      onClick={async () => { if (await showConfirm(`Mark ${s.name} inactive?`)) { await deleteStudent(s.id); refresh(); } }}>
                      Inactivate
                    </button>
                  )}
                  {s.active === 0 && (
                    <button className="btn ghost" style={{ color: "var(--ok, #15803d)" }}
                      onClick={async () => { if (await showConfirm(`Reactivate ${s.name}?`)) { await reactivateStudent(s.id); refresh(); } }}>
                      Activate
                    </button>
                  )}
                  <button className="btn ghost" style={{ color: "var(--danger)" }}
                    onClick={async () => { await onHardDelete(s); }}>
                    Delete…
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setEditing(null); }}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)",
            display: "flex", alignItems: "flex-start", justifyContent: "center",
            paddingTop: 80, zIndex: 1000,
          }}
        >
          <div className="card" style={{ width: "min(640px, 92vw)", maxHeight: "85vh", overflow: "auto", margin: 0 }}>
            <h3 style={{ marginTop: 0 }}>{editing.id ? "Edit Student" : "Add Student"}</h3>
          <div className="row">
            <div className="field">
              <label>Student Name</label>
              <input value={editing.name || ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </div>
            <div className="field">
              <label>Year</label>
              <input type="number" value={editing.year ?? year} onChange={(e) => setEditing({ ...editing, year: parseInt(e.target.value, 10) })} />
            </div>
          </div>
          <div className="row">
            <div className="field">
              <label>Father's Name</label>
              <input value={editing.father_name || ""} onChange={(e) => setEditing({ ...editing, father_name: e.target.value })} />
            </div>
            <div className="field">
              <label>Mother's Name</label>
              <input value={editing.mother_name || ""} onChange={(e) => setEditing({ ...editing, mother_name: e.target.value })} />
            </div>
          </div>
          <div className="field">
            <label>Email</label>
            <input value={editing.email || ""} onChange={(e) => setEditing({ ...editing, email: e.target.value })} />
          </div>
          {settings.subsidies_enabled === "1" && (
            <div className="field">
              <label>Gross Monthly Fee Override ($) <small style={{ color: "var(--muted)" }}>— blank uses daycare default ({settings.gross_monthly_fee || "not set"})</small></label>
              <input
                type="number" step="0.01"
                value={editing.gross_override == null ? "" : String(editing.gross_override)}
                onChange={(e) => {
                  const v = e.target.value.trim();
                  setEditing({ ...editing, gross_override: v === "" ? null : parseFloat(v) });
                }}
                placeholder="(use default)" />
            </div>
          )}
          {(() => {
            const gradYearNum = parseInt(settings.grad_year || "", 10);
            const gradYearValid = Number.isFinite(gradYearNum) && gradYearNum > 0;
            const isGraduating = gradYearValid && editing.graduation_year === gradYearNum;
            return (
              <>
                <div className="field" style={{ marginTop: 6 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: gradYearValid ? "pointer" : "not-allowed" }}>
                    <input
                      type="checkbox"
                      disabled={!gradYearValid}
                      checked={isGraduating}
                      onChange={(e) => {
                        if (!gradYearValid) return;
                        setEditing({
                          ...editing,
                          graduation_year: e.target.checked ? gradYearNum : null,
                          graduation_note: e.target.checked ? (editing.graduation_note ?? "") : null,
                        });
                      }}
                    />
                    <span>Graduating this year{gradYearValid ? ` (${gradYearNum})` : ""}</span>
                    {!gradYearValid && (
                      <small style={{ color: "var(--muted)" }}>
                        — set the graduation year in Settings → Graduation Day
                      </small>
                    )}
                  </label>
                </div>
                {isGraduating && (
                  <div className="field">
                    <label>Graduation note <small style={{ color: "var(--muted)" }}>— appears on this child&apos;s slide in the graduation deck</small></label>
                    <textarea
                      rows={3}
                      value={editing.graduation_note ?? ""}
                      placeholder="e.g. Aarav loved building block towers and taught everyone the names of every dinosaur. We&apos;ll miss his big questions."
                      onChange={(e) => setEditing({ ...editing, graduation_note: e.target.value })}
                      style={{ width: "100%", resize: "vertical", fontFamily: "inherit" }}
                    />
                  </div>
                )}
              </>
            );
          })()}
          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn" onClick={async () => {
              if (!editing.name?.trim()) { void showAlert("Name required."); return; }
              const saved = await upsertStudent({
                id: editing.id, name: editing.name.trim(),
                father_name: editing.father_name || null,
                mother_name: editing.mother_name || null,
                email: editing.email || null,
                year: editing.year || year, active: editing.active ?? 1,
                gross_override: editing.gross_override ?? null,
                graduation_year: editing.graduation_year ?? null,
                graduation_note: editing.graduation_note ?? null,
              });
              // If this save was launched from the Waitlist "Convert to Student"
              // flow, link the waitlist entry to the new student and jump back
              // to the waitlist so the operator sees the enrolled row.
              if (pendingWaitlistId && saved.id) {
                try {
                  const { markConverted } = await import("../lib/waitlist");
                  await markConverted(pendingWaitlistId, saved.id);
                  setPendingWaitlistId(null);
                  setEditing(null);
                  nav("/waitlist/enrolled");
                  return;
                } catch (e: any) {
                  // The child was created successfully but the waitlist
                  // link update failed. Stay on Students, tell the user
                  // exactly what happened, and leave the waitlist id
                  // pending so a retry (edit → Save again) will re-attempt
                  // the link without duplicating the roster row.
                  await showAlert(
                    `Student saved, but couldn't mark waitlist entry as enrolled:\n\n${String(e?.message ?? e)}\n\nOpen the waitlist and mark it manually, or Save again to retry.`,
                    { kind: "warning" },
                  );
                  refresh();
                  return;
                }
              }
              setEditing(null); refresh();
            }}>Save</button>
            <button className="btn secondary" onClick={() => setEditing(null)}>Cancel</button>
          </div>
          </div>
        </div>
      )}
      {dupePreview && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setDupePreview(null); }}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)",
            display: "flex", alignItems: "flex-start", justifyContent: "center",
            paddingTop: 80, zIndex: 1000,
          }}
        >
          <div className="card" style={{ width: "min(720px, 94vw)", maxHeight: "82vh", overflow: "auto", margin: 0 }}>
            <h3 style={{ marginTop: 0 }}>Duplicate Students</h3>
            <p style={{ color: "var(--muted)", fontSize: 13, marginTop: -4 }}>
              Matched on same email (exact) and/or student name (≥90% similar). The oldest record in each group will be kept; the rest will be permanently removed.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 8 }}>
              {dupePreview.map((group, gi) => {
                const sorted = [...group].sort((a, b) => {
                  if (a.active !== b.active) return b.active - a.active;
                  return b.id - a.id;
                });
                return (
                  <div key={gi} style={{ border: "1px solid var(--border, #ddd)", borderRadius: 6, padding: 8 }}>
                    <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 4 }}>Group {gi + 1}</div>
                    {sorted.map((s, i) => (
                      <div key={s.id} style={{ display: "flex", gap: 8, fontSize: 13, padding: "2px 0" }}>
                        <span style={{ minWidth: 60, color: i === 0 ? "var(--ok, #15803d)" : "var(--danger, #b91c1c)" }}>
                          {i === 0 ? "KEEP" : "REMOVE"}
                        </span>
                        <span style={{ flex: 1 }}><b>{s.name}</b></span>
                        <span style={{ flex: 1, color: "var(--muted)" }}>{s.email || "—"}</span>
                        <span style={{ color: s.active ? "var(--ok, #15803d)" : "var(--muted)" }}>
                          {s.active ? "active" : "inactive"}
                        </span>
                        <span style={{ color: "var(--muted)" }}>id {s.id}</span>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
              <button className="btn" style={{ background: "var(--danger, #b91c1c)", color: "#fff" }} onClick={runDedupe}>
                Remove {dupePreview.reduce((n, g) => n + (g.length - 1), 0)} duplicate{dupePreview.reduce((n, g) => n + (g.length - 1), 0) === 1 ? "" : "s"}
              </button>
              <button className="btn secondary" onClick={() => setDupePreview(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
      {pendingImport && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setPendingImport(null); }}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)",
            display: "flex", alignItems: "flex-start", justifyContent: "center",
            paddingTop: 120, zIndex: 1000,
          }}
        >
          <div className="card" style={{ width: "min(420px, 92vw)", margin: 0 }}>
            <h3 style={{ marginTop: 0 }}>Import Roster</h3>
            <p style={{ color: "var(--muted)", fontSize: 13, marginTop: -4 }}>
              File: <code>{pendingImport.path.split(/[/\\]/).pop()}</code>
            </p>
            <div className="field">
              <label>Roster Year</label>
              <input
                type="number"
                value={pendingImport.year}
                onChange={(e) => setPendingImport({ ...pendingImport, year: parseInt(e.target.value, 10) || now })}
                autoFocus
              />
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
              <button className="btn" onClick={runImport}>Import</button>
              <button className="btn secondary" onClick={() => setPendingImport(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
      {accbFor && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setAccbFor(null); }}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)",
            display: "flex", alignItems: "flex-start", justifyContent: "center",
            paddingTop: 60, zIndex: 1000,
          }}
        >
          <div className="card" style={{ width: "min(680px, 94vw)", maxHeight: "85vh", overflow: "auto", margin: 0 }}>
            <h3 style={{ marginTop: 0 }}>ACCB Ledger — {accbFor.student.name}</h3>
            <p style={{ color: "var(--muted)", fontSize: 13, marginTop: -4 }}>
              Affordable Child Care Benefit amount the BC government paid to Echelon on this family&apos;s behalf, per month.
              Used to deduct from the gross fee when computing what the parent paid out-of-pocket on the monthly receipt.
            </p>

            <div className="row">
              <div className="field" style={{ maxWidth: 110 }}>
                <label>Year</label>
                <input type="number" value={accbDraft.year}
                  onChange={(e) => setAccbDraft({ ...accbDraft, year: parseInt(e.target.value, 10) || now })} />
              </div>
              <div className="field" style={{ maxWidth: 110 }}>
                <label>Month</label>
                <select value={accbDraft.month} onChange={(e) => setAccbDraft({ ...accbDraft, month: parseInt(e.target.value, 10) })}>
                  {[1,2,3,4,5,6,7,8,9,10,11,12].map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <div className="field" style={{ maxWidth: 140 }}>
                <label>Amount ($)</label>
                <input type="number" step="0.01" value={accbDraft.amount}
                  onChange={(e) => setAccbDraft({ ...accbDraft, amount: e.target.value })} />
              </div>
              <div className="field">
                <label>Notes</label>
                <input value={accbDraft.notes}
                  onChange={(e) => setAccbDraft({ ...accbDraft, notes: e.target.value })} />
              </div>
            </div>
            <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
              <button className="btn" onClick={saveAccbRow}>Add / Update</button>
              <span style={{ color: "var(--muted)", fontSize: 12, alignSelf: "center" }}>
                Tip: setting amount to 0 deletes that month&apos;s entry.
              </span>
            </div>

            {accbFor.entries.length === 0 ? (
              <div className="empty">No ACCB entries yet.</div>
            ) : (
              <table className="data">
                <thead>
                  <tr><th>Year</th><th>Month</th><th>Amount</th><th>Notes</th><th></th></tr>
                </thead>
                <tbody>
                  {accbFor.entries.map((e) => (
                    <tr key={e.id}>
                      <td>{e.year}</td>
                      <td>{e.month}</td>
                      <td>${e.amount.toFixed(2)}</td>
                      <td>{e.notes || "—"}</td>
                      <td style={{ textAlign: "right" }}>
                        <button className="btn ghost" style={{ color: "var(--danger)" }}
                          onClick={async () => { if (await showConfirm("Delete this ACCB entry?")) { await deleteAccb(e.id); refreshAccb(); } }}>
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
              <button className="btn secondary" onClick={() => setAccbFor(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
