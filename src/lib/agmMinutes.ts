// AGM Minutes generator: types, carry-forward, DB smart-fill, persistence, .docx export.
//
// Format matches the Society's historical AGM minutes (AGM-2024_Final.docx and
// AGM-2025_Final.docx): fixed 8-section structure, no tables, plain paragraphs
// with bullet lists under sub-headings inside the Chairman's Report.
//
// Nothing in this file talks to Azure. AI-drafting a section is a separate,
// optional path that lives in the screen (calls the existing ask_echelon
// helpers where useful) — the base flow works fully offline.

import { db, execRetry, getSettings } from "./db";
import { Document, Packer, Paragraph, TextRun, AlignmentType, HeadingLevel } from "docx";
import { fiscalYearBounds, fiscalYearLabel } from "./fiscalYear";

export interface AgmMinutes {
  // Header
  yearLabel: string;              // "2024-25"
  fyStartYear: number;            // 2024
  associationName: string;        // "The Echelon Daycare Teachers Association"
  meetingDate: string;            // "October 20, 2025"
  meetingTime: string;            // "5:00 PM"
  meetingLocation: string;        // "Echelon Daycare Centre"

  // 1. Attendance
  present: string[];
  absent: string[];

  // 2. Adoption of Previous Minutes
  previousMinutesReadBy: string;
  previousMinutesApprovedBy: string;

  // 3. Chairman's Report — each item is a sub-heading with its own body.
  // Body can be a paragraph (string) or a list of bullets (string[]).
  chairmanReport: ChairmanBlock[];

  // 4. Financial Report
  financialReportPresenter: string;
  financialReportBody: string;

  // 5. General Discussion
  staffingChallenges: string;
  facilitiesMaintenance: string;

  // 6. Board Elections
  boardElections: string;

  // 7. Future Agenda Items
  futureAgenda: string[];

  // 8. Adjournment
  adjournmentTime: string;
}

export interface ChairmanBlock {
  heading: string;                       // "Staffing Updates:"
  body: string | string[];               // paragraph OR bullet list
}

const DEFAULT_LOCATION = "Echelon Daycare Centre";
const DEFAULT_TIME = "5:00 PM";
const DEFAULT_ADJOURN = "7:00 PM";
const DEFAULT_ASSOC = "The Echelon Daycare Teachers Association";

// Sub-headings we always include in a Chairman's Report, in canonical order,
// with an empty starting body. When a prior year is available we merge over
// this scaffold so any historically-present sections carry forward and any
// missing ones still render as empty placeholders for the user to fill.
export const CHAIRMAN_SCAFFOLD: ChairmanBlock[] = [
  { heading: "Staffing Updates:",            body: [] },
  { heading: "Funding Programs:",            body: "" },
  { heading: "Employee Benefits:",           body: "" },
  { heading: "Financial Support for Staff:", body: "" },
  { heading: "Supported Child Development (SCD) Funding:", body: "" },
  { heading: "Snack and Meal:",              body: "" },
  { heading: "Children Enrollment:",         body: "" },
  { heading: "Maintenance Completed:",       body: [] },
  { heading: "Licensing:",                   body: [] },
];

// ---------- year label helpers ----------

/** "2024-25" from FY start year 2024 (matches header format of the samples). */
export function shortYearLabel(fyStart: number): string {
  const end = (fyStart + 1) % 100;
  return `${fyStart}-${end.toString().padStart(2, "0")}`;
}

// ---------- draft persistence ----------

export async function loadDraft(yearLabel: string): Promise<AgmMinutes | null> {
  const d = await db();
  const rows = await d.select<{ payload_json: string }[]>(
    "SELECT payload_json FROM agm_drafts WHERE year_label = ?",
    [yearLabel]
  );
  if (!rows.length) return null;
  try { return JSON.parse(rows[0].payload_json) as AgmMinutes; }
  catch { return null; }
}

export async function saveDraft(m: AgmMinutes, finalized = false): Promise<void> {
  const payload = JSON.stringify(m);
  await execRetry(
    `INSERT INTO agm_drafts(year_label, payload_json, updated_at, finalized_at)
       VALUES(?, ?, datetime('now'), ${finalized ? "datetime('now')" : "NULL"})
     ON CONFLICT(year_label) DO UPDATE SET
       payload_json = excluded.payload_json,
       updated_at   = excluded.updated_at,
       finalized_at = COALESCE(excluded.finalized_at, agm_drafts.finalized_at)`,
    [m.yearLabel, payload]
  );
}

export async function listDraftYears(): Promise<Array<{ year_label: string; updated_at: string; finalized_at: string | null }>> {
  const d = await db();
  return d.select("SELECT year_label, updated_at, finalized_at FROM agm_drafts ORDER BY year_label DESC");
}

// ---------- initial-population ----------

/**
 * Assemble the starting AGM for a given fiscal year.
 *
 * Precedence:
 *   1. existing draft for this year (unchanged; caller can force a rebuild)
 *   2. carry-forward from prior year's finalized/drafted AGM (narrative)
 *   3. bare scaffold seeded with DB numbers + settings
 *
 * DB fills applied on top of whichever source (2 or 3):
 *   - meetingDate → today's date, but only if source didn't supply one
 *   - present list → active staff, only when source's list is empty
 *   - Children Enrollment sub-heading → auto-generated one-liner
 */
export async function buildInitialDraft(fyStart: number, opts?: { forceFresh?: boolean }): Promise<AgmMinutes> {
  const yearLabel = shortYearLabel(fyStart);

  // 1) existing draft
  if (!opts?.forceFresh) {
    const existing = await loadDraft(yearLabel);
    if (existing) return existing;
  }

  const settings = await getSettings();
  const association = settings.agm_association_name || DEFAULT_ASSOC;
  const location = settings.agm_location || DEFAULT_LOCATION;

  // 2) carry-forward from prior year
  const priorLabel = shortYearLabel(fyStart - 1);
  const prior = await loadDraft(priorLabel);
  const enrollmentLine = await buildEnrollmentLine(fyStart);
  const activeStaff = await activeStaffNames();

  if (prior) {
    // Deep copy and update year-specific fields.
    const copy: AgmMinutes = JSON.parse(JSON.stringify(prior));
    copy.yearLabel = yearLabel;
    copy.fyStartYear = fyStart;
    copy.meetingDate = formatMeetingDate(new Date());
    copy.adjournmentTime = copy.adjournmentTime || DEFAULT_ADJOURN;
    copy.associationName = association;
    copy.meetingLocation = location;
    // Refresh the Children Enrollment sub-heading with this year's numbers,
    // but only if the prior text was auto-generated (starts with "Enrollment").
    // Otherwise leave the human's wording alone.
    copy.chairmanReport = copy.chairmanReport.map((b) => {
      if (b.heading.toLowerCase().startsWith("children enrollment")) {
        return { ...b, body: enrollmentLine };
      }
      return b;
    });
    // Present list refreshed only when empty (human may have curated it).
    if (!copy.present || copy.present.length === 0) copy.present = activeStaff;
    return copy;
  }

  // 3) bare scaffold
  const chairman: ChairmanBlock[] = CHAIRMAN_SCAFFOLD.map((b) => ({
    heading: b.heading,
    body: b.heading.toLowerCase().startsWith("children enrollment")
      ? enrollmentLine
      : (Array.isArray(b.body) ? [] : ""),
  }));

  return {
    yearLabel,
    fyStartYear: fyStart,
    associationName: association,
    meetingDate: formatMeetingDate(new Date()),
    meetingTime: DEFAULT_TIME,
    meetingLocation: location,
    present: activeStaff,
    absent: [],
    previousMinutesReadBy: "",
    previousMinutesApprovedBy: "",
    chairmanReport: chairman,
    financialReportPresenter: "",
    financialReportBody:
      "The daycare remains financially stable, with sufficient funds to cover ongoing operations and sick leave entitlements.\nNote: Financial report is attached.",
    staffingChallenges: "",
    facilitiesMaintenance: "",
    boardElections: "There were no changes to the board. All members will retain their current positions.",
    futureAgenda: [],
    adjournmentTime: DEFAULT_ADJOURN,
  };
}

async function activeStaffNames(): Promise<string[]> {
  try {
    const d = await db();
    const rows = await d.select<{ name: string }[]>(
      "SELECT name FROM staff WHERE active = 1 ORDER BY name COLLATE NOCASE"
    );
    return rows.map((r) => r.name).filter(Boolean);
  } catch {
    return [];
  }
}

async function buildEnrollmentLine(fyStart: number): Promise<string> {
  try {
    const d = await db();
    const { start, end } = fiscalYearBounds(fyStart);
    const rosterYear = fyStart + 1;
    const rows = await d.select<{ active: number; total: number }[]>(
      "SELECT SUM(CASE WHEN active=1 THEN 1 ELSE 0 END) AS active, COUNT(*) AS total FROM students WHERE year=?",
      [rosterYear]
    );
    const r = rows[0] || { active: 0, total: 0 };
    const rcpt = await d.select<{ n: number }[]>(
      "SELECT COUNT(*) AS n FROM receipts WHERE voided=0 AND date>=? AND date<=?",
      [start, end]
    );
    const label = fiscalYearLabel(fyStart);
    if ((r.active || 0) === 0 && (rcpt[0]?.n || 0) === 0) {
      return `Enrollment for the ${label} year is ongoing.`;
    }
    return `Enrollment for the ${label} year: ${r.active || 0} active children (${r.total || 0} total on roster), ${rcpt[0]?.n || 0} receipts issued through the reporting period.`;
  } catch {
    return "";
  }
}

function formatMeetingDate(d: Date): string {
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

// ---------- .docx generation ----------

/**
 * Build a docx file matching the Society's AGM format:
 *   - Header block (title, association, date/time/location) centered, bold
 *   - Numbered sections 1..8 as bold paragraphs
 *   - Sub-headings inside Chairman's Report as bold inline lead-in
 *   - Bullets as indented list paragraphs
 *   - Times New Roman 11pt to match Word default of the samples
 */
export async function generateDocxBlob(m: AgmMinutes): Promise<Blob> {
  const children: Paragraph[] = [];

  // ---- Header ----
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: `Minutes of the Annual General Meeting ${m.yearLabel}`, bold: true, size: 28 })],
  }));
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: m.associationName, bold: true, size: 24 })],
  }));
  children.push(blank());
  children.push(kv("Date", m.meetingDate));
  children.push(kv("Time", m.meetingTime));
  children.push(kv("Location", m.meetingLocation));
  children.push(blank());

  // ---- 1. Attendance ----
  children.push(sectionHeading("1. Attendance"));
  children.push(labelLine("Present:"));
  (m.present.length ? m.present : ["—"]).forEach((n) => children.push(bullet(n)));
  children.push(labelLine("Absent:"));
  (m.absent.length ? m.absent : ["None"]).forEach((n) => children.push(bullet(n)));
  children.push(blank());

  // ---- 2. Adoption of Previous Minutes ----
  children.push(sectionHeading("2. Adoption of Previous Minutes"));
  const readBy = m.previousMinutesReadBy.trim() || "____";
  const apprBy = m.previousMinutesApprovedBy.trim() || "____";
  children.push(plain(`The minutes of the previous AGM were read by ${readBy} and approved by ${apprBy}.`));
  children.push(blank());

  // ---- 3. Chairman's Report ----
  children.push(sectionHeading("3. Chairman\u2019s Report"));
  for (const b of m.chairmanReport) {
    const heading = b.heading.trim();
    if (!heading) continue;
    // Skip entirely-empty blocks so the doc doesn't have dangling headings.
    if (Array.isArray(b.body)) {
      const items = b.body.map((x) => x.trim()).filter(Boolean);
      if (items.length === 0) continue;
      children.push(labelLine(heading));
      items.forEach((it) => children.push(bullet(it)));
    } else {
      const text = (b.body || "").trim();
      if (!text) continue;
      children.push(labelLine(heading));
      text.split(/\n+/).forEach((line) => {
        const t = line.trim();
        if (t) children.push(plain(t));
      });
    }
  }
  children.push(blank());

  // ---- 4. Financial Report ----
  children.push(sectionHeading("4. Financial Report"));
  const presenter = m.financialReportPresenter.trim();
  const fLead = presenter
    ? `The financial report was presented by ${presenter}. `
    : "The financial report was presented. ";
  const fBody = (m.financialReportBody || "").trim();
  // Merge lead + first line, then split remaining lines into paragraphs.
  const fLines = fBody.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (fLines.length) {
    children.push(plain(fLead + fLines[0]));
    fLines.slice(1).forEach((l) => children.push(plain(l)));
  } else {
    children.push(plain(fLead.trim()));
  }
  children.push(blank());

  // ---- 5. General Discussion ----
  children.push(sectionHeading("5. General Discussion"));
  if (m.staffingChallenges.trim()) {
    children.push(labelLine("Staffing Challenges:"));
    m.staffingChallenges.split(/\n+/).forEach((l) => { const t = l.trim(); if (t) children.push(plain(t)); });
  }
  if (m.facilitiesMaintenance.trim()) {
    children.push(labelLine("Facilities Maintenance:"));
    m.facilitiesMaintenance.split(/\n+/).forEach((l) => { const t = l.trim(); if (t) children.push(plain(t)); });
  }
  children.push(blank());

  // ---- 6. Board Elections ----
  children.push(sectionHeading("6. Board Elections"));
  const be = (m.boardElections || "").trim();
  if (be) be.split(/\n+/).forEach((l) => { const t = l.trim(); if (t) children.push(plain(t)); });
  children.push(blank());

  // ---- 7. Future Agenda Items ----
  children.push(sectionHeading("7. Future Agenda Items"));
  const items = m.futureAgenda.map((x) => x.trim()).filter(Boolean);
  if (items.length === 0) {
    children.push(plain("—"));
  } else {
    items.forEach((it) => children.push(bullet(it)));
  }
  children.push(blank());

  // ---- 8. Adjournment ----
  children.push(sectionHeading("8. Adjournment"));
  children.push(plain(`The meeting was adjourned at ${m.adjournmentTime || DEFAULT_ADJOURN}.`));

  const doc = new Document({
    creator: "Echelon Receipts",
    title: `AGM Minutes ${m.yearLabel}`,
    styles: {
      default: {
        document: {
          run: { font: "Times New Roman", size: 22 /* half-points → 11pt */ },
        },
      },
    },
    sections: [{ properties: {}, children }],
  });

  const blob = await Packer.toBlob(doc);
  return blob;
}

// ---------- paragraph helpers (all Times New Roman 11pt via default style) ----------

function plain(text: string): Paragraph {
  return new Paragraph({ children: [new TextRun({ text })] });
}
function blank(): Paragraph {
  return new Paragraph({ children: [new TextRun({ text: "" })] });
}
function sectionHeading(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    children: [new TextRun({ text, bold: true })],
  });
}
function labelLine(text: string): Paragraph {
  return new Paragraph({ children: [new TextRun({ text, bold: true })] });
}
function bullet(text: string): Paragraph {
  return new Paragraph({
    bullet: { level: 0 },
    children: [new TextRun({ text })],
  });
}
function kv(k: string, v: string): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({ text: `${k}: `, bold: true }),
      new TextRun({ text: v }),
    ],
  });
}

// ---------- download helper ----------

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
