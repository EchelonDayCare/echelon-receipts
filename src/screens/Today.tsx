import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { listStudents, listReceipts, getSettings } from "../lib/db";
import type { Student, Receipt, SettingsMap } from "../types";

interface Attention {
  kind: "error" | "warn";
  text: string;
  cta?: { label: string; to: string };
}

const MONTHS = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

export default function Today() {
  const nav = useNavigate();
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  const [students, setStudents] = useState<Student[]>([]);
  const [thisMonthReceipts, setThisMonthReceipts] = useState<Receipt[]>([]);
  const [settings, setSettings] = useState<SettingsMap>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const [s, r, st] = await Promise.all([
        listStudents(year, true),
        listReceipts({ year, month }),
        getSettings(),
      ]);
      setStudents(s);
      setThisMonthReceipts(r.filter(x => !x.voided));
      setSettings(st);
      setLoading(false);
    })();
  }, [year, month]);

  if (loading) return <div className="content-inner"><p className="subtitle">Loading…</p></div>;

  // ----- Compute things -----
  const issuedStudentIds = new Set(thisMonthReceipts.map(r => r.student_id));
  const pendingCount = students.length - issuedStudentIds.size;
  const collected = thisMonthReceipts.reduce((s, r) => s + (r.amount || 0), 0);

  const missingEmail = students.filter(s => !s.email || !s.email.trim());
  const monthLabel = `${MONTHS[month - 1]} ${year}`;

  // ----- Attention items -----
  const attention: Attention[] = [];
  if (!settings.daycare_name || !settings.daycare_name.trim()) {
    attention.push({ kind: "error", text: "Daycare name is not set on receipts.", cta: { label: "Open Settings", to: "/settings" } });
  }
  if (!settings.smtp_user || !settings.smtp_user.trim()) {
    attention.push({ kind: "error", text: "Email is not configured — receipts can be saved but not emailed.", cta: { label: "Set up email", to: "/settings" } });
  }
  if (!settings.pdf_folder || !settings.pdf_folder.trim()) {
    attention.push({ kind: "warn", text: "No PDF folder is set. Receipts will save to a temporary location.", cta: { label: "Choose folder", to: "/settings" } });
  }
  if (missingEmail.length > 0) {
    attention.push({ kind: "warn", text: `${missingEmail.length} active ${missingEmail.length === 1 ? "student is" : "students are"} missing a parent email.`, cta: { label: "Fix on Students", to: "/students" } });
  }
  if (pendingCount > 0 && students.length > 0) {
    attention.push({ kind: "warn", text: `${pendingCount} of ${students.length} students don't yet have a receipt for ${monthLabel}.`, cta: { label: "Issue receipts", to: "/new" } });
  }

  // ----- Coming up -----
  const upcoming: { when: string; what: string; cta?: { label: string; to: string } }[] = [];
  // Annual receipts: surface in Dec / Jan / Feb
  if (month === 12) {
    upcoming.push({ when: "Next month", what: `Annual tax receipts for ${year} will be ready to send in January.`, cta: { label: "Preview", to: "/annual" } });
  } else if (month === 1 || month === 2) {
    upcoming.push({ when: "This month", what: `It's time to send annual tax receipts for ${year - 1}.`, cta: { label: "Send annual receipts", to: "/annual" } });
  }
  // Backup reminder (we don't have a real backup timestamp yet — show informational)
  if (!settings.last_backup_at) {
    upcoming.push({ when: "Anytime", what: "Recommended: back up your database. Auto-backup will be added in the next update." });
  }

  return (
    <div className="content-inner">
      <h1>Today</h1>
      <p className="subtitle">{now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</p>

      {/* Big primary actions */}
      <div className="today-actions">
        <button className="btn big" onClick={() => nav("/new")}>+ New Receipt</button>
        <button className="btn secondary big" onClick={() => nav("/students")}>+ New Student</button>
        <button className="btn secondary big" onClick={() => nav("/history")}>Open Receipt History</button>
      </div>

      {/* Needs attention */}
      <section className="today-section">
        <h2>Needs your attention</h2>
        {attention.length === 0 ? (
          <div className="today-ok">✅ Nothing urgent. {monthLabel} receipts are on track.</div>
        ) : (
          <ul className="today-list">
            {attention.map((a, i) => (
              <li key={i} className={`today-item ${a.kind}`}>
                <span className="today-dot" aria-hidden>●</span>
                <span className="today-text">{a.text}</span>
                {a.cta && <Link to={a.cta.to} className="btn ghost">{a.cta.label} →</Link>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* This month */}
      <section className="today-section">
        <h2>This month — {monthLabel}</h2>
        <div className="today-grid">
          <div className="today-stat">
            <div className="lbl">Receipts issued</div>
            <div className="val">{thisMonthReceipts.length}<span className="of"> / {students.length}</span></div>
          </div>
          <div className="today-stat">
            <div className="lbl">Collected</div>
            <div className="val">${collected.toFixed(2)}</div>
          </div>
          <div className="today-stat">
            <div className="lbl">Active students</div>
            <div className="val">{students.length}</div>
          </div>
        </div>
      </section>

      {/* Coming up */}
      {upcoming.length > 0 && (
        <section className="today-section">
          <h2>Coming up</h2>
          <ul className="today-list">
            {upcoming.map((u, i) => (
              <li key={i} className="today-item info">
                <span className="today-when">{u.when}</span>
                <span className="today-text">{u.what}</span>
                {u.cta && <Link to={u.cta.to} className="btn ghost">{u.cta.label} →</Link>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
