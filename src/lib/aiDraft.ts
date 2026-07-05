// AI-drafting for AGM Minutes sections.
//
// Reads aggregate financial / staffing / enrollment stats for a fiscal year,
// then asks Azure OpenAI (same endpoint the rest of the app uses) to produce
// polished prose that fits the Society's AGM tone: formal, factual, one
// paragraph per section unless the section is a bullet list.
//
// No student names or receipt-line detail leaves the laptop — only aggregate
// counts, dollar totals, and voluntarily-entered staff names.

import { invoke } from "@tauri-apps/api/core";
import { db, getSettings } from "./db";
import { fiscalYearBounds, fiscalYearLabel } from "./fiscalYear";
import type { AgmMinutes, ChairmanBlock } from "./agmMinutes";

// Endpoint constants must match src-tauri/src/ask_echelon.rs
const AZURE_ENDPOINT = "https://ai-nse.openai.azure.com";
const CHAT_DEPLOY = "gpt-4.1";
const CHAT_API_VER = "2025-04-01-preview";

// ─── Year context ──────────────────────────────────────────────────────

export interface YearContext {
  yearLabel: string;                 // "2025-26"
  fyStart: number;
  // Enrollment
  activeChildren: number;
  totalRoster: number;
  receiptsIssued: number;
  // Revenue (net of refunds)
  grossRevenue: number;              // sum of receipts.amount minus refunds
  ccfriTotal: number;
  accbTotal: number;
  parentPaidTotal: number;           // gross - ccfri - accb
  // Expenses
  expensesTotal: number;
  topExpenseCategories: Array<{ category: string; amount: number }>;
  // Staff
  activeStaff: Array<{ name: string; role: string | null }>;
  credentialsExpiringSoon: Array<{ staff: string; type: string; expiry: string }>;
  drillsCompleted: number;
  // Comparison to prior year (optional)
  priorGrossRevenue?: number;
  priorExpensesTotal?: number;
  priorActiveChildren?: number;
}

async function safeSelectOne<T>(sql: string, args: any[] = [], fallback: T): Promise<T> {
  try {
    const d = await db();
    const rows = await d.select<T[]>(sql, args);
    return rows[0] ?? fallback;
  } catch { return fallback; }
}
async function safeSelect<T>(sql: string, args: any[] = []): Promise<T[]> {
  try {
    const d = await db();
    return await d.select<T[]>(sql, args);
  } catch { return []; }
}

export async function gatherYearContext(fyStart: number): Promise<YearContext> {
  const { start, end } = fiscalYearBounds(fyStart);
  const rosterYear = fyStart + 1;

  const enroll = await safeSelectOne<{ active: number; total: number }>(
    "SELECT SUM(CASE WHEN active=1 THEN 1 ELSE 0 END) AS active, COUNT(*) AS total FROM students WHERE year=?",
    [rosterYear],
    { active: 0, total: 0 }
  );

  const rcpt = await safeSelectOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM receipts WHERE voided=0 AND date>=? AND date<=?",
    [start, end], { n: 0 }
  );

  const rev = await safeSelectOne<{ gross: number; ccfri: number; accb: number }>(
    `SELECT
        COALESCE(SUM(CASE WHEN is_refund=1 THEN -amount ELSE amount END), 0) AS gross,
        COALESCE(SUM(CASE WHEN is_refund=1 THEN -ccfri_amount ELSE ccfri_amount END), 0) AS ccfri,
        COALESCE(SUM(CASE WHEN is_refund=1 THEN -accb_amount ELSE accb_amount END), 0) AS accb
      FROM receipts WHERE voided=0 AND date>=? AND date<=?`,
    [start, end], { gross: 0, ccfri: 0, accb: 0 }
  );

  const exp = await safeSelectOne<{ total: number }>(
    "SELECT COALESCE(SUM(amount),0) AS total FROM expenses WHERE date>=? AND date<=?",
    [start, end], { total: 0 }
  );

  const topCats = await safeSelect<{ category: string; amount: number }>(
    `SELECT category, SUM(amount) AS amount
       FROM expenses WHERE date>=? AND date<=?
       GROUP BY category ORDER BY amount DESC LIMIT 5`,
    [start, end]
  );

  const staff = await safeSelect<{ name: string; role: string | null }>(
    "SELECT name, role FROM staff WHERE active=1 ORDER BY name COLLATE NOCASE"
  );

  const credExp = await safeSelect<{ staff: string; type: string; expiry: string }>(
    `SELECT s.name AS staff, c.type, c.expiry_date AS expiry
       FROM staff_credentials c JOIN staff s ON s.id=c.staff_id
      WHERE c.expiry_date IS NOT NULL AND c.expiry_date <= date(?, '+90 days') AND c.expiry_date >= ?
      ORDER BY c.expiry_date`,
    [end, start]
  );

  const drills = await safeSelectOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM staff_drills WHERE drill_date>=? AND drill_date<=?",
    [start, end], { n: 0 }
  );

  // Prior year (best-effort)
  let priorGross: number | undefined;
  let priorExp: number | undefined;
  let priorActive: number | undefined;
  try {
    const py = fiscalYearBounds(fyStart - 1);
    const pRev = await safeSelectOne<{ gross: number }>(
      "SELECT COALESCE(SUM(CASE WHEN is_refund=1 THEN -amount ELSE amount END),0) AS gross FROM receipts WHERE voided=0 AND date>=? AND date<=?",
      [py.start, py.end], { gross: 0 }
    );
    const pExp = await safeSelectOne<{ total: number }>(
      "SELECT COALESCE(SUM(amount),0) AS total FROM expenses WHERE date>=? AND date<=?",
      [py.start, py.end], { total: 0 }
    );
    const pAct = await safeSelectOne<{ active: number }>(
      "SELECT SUM(CASE WHEN active=1 THEN 1 ELSE 0 END) AS active FROM students WHERE year=?",
      [fyStart], { active: 0 }
    );
    priorGross = pRev.gross || 0;
    priorExp = pExp.total || 0;
    priorActive = pAct.active || 0;
  } catch { /* ignore */ }

  return {
    yearLabel: fiscalYearLabel(fyStart),
    fyStart,
    activeChildren: enroll.active || 0,
    totalRoster: enroll.total || 0,
    receiptsIssued: rcpt.n || 0,
    grossRevenue: rev.gross || 0,
    ccfriTotal: rev.ccfri || 0,
    accbTotal: rev.accb || 0,
    parentPaidTotal: (rev.gross || 0) - (rev.ccfri || 0) - (rev.accb || 0),
    expensesTotal: exp.total || 0,
    topExpenseCategories: topCats,
    activeStaff: staff,
    credentialsExpiringSoon: credExp,
    drillsCompleted: drills.n || 0,
    priorGrossRevenue: priorGross,
    priorExpensesTotal: priorExp,
    priorActiveChildren: priorActive,
  };
}

// ─── Azure chat helper ─────────────────────────────────────────────────

async function azureChat(system: string, user: string, maxTokens = 400): Promise<string> {
  const settings = await getSettings();
  if (settings.azure_ai_key_set !== "1") {
    throw new Error("Azure AI key is not configured. Set it in Configuration → Identity.");
  }
  const apiKey = await invoke<string | null>("keychain_get", { key: "azure_ai_key" });
  if (!apiKey) throw new Error("Azure AI key not found in keychain.");

  const url = `${AZURE_ENDPOINT}/openai/deployments/${CHAT_DEPLOY}/chat/completions?api-version=${CHAT_API_VER}`;
  const body = {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.3,
    max_completion_tokens: maxTokens,
  };
  const resp = await fetch(url, {
    method: "POST",
    headers: { "api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`Azure OpenAI HTTP ${resp.status}: ${t.slice(0, 200)}`);
  }
  const json = await resp.json();
  const content: string = json?.choices?.[0]?.message?.content ?? "";
  return content.trim();
}

// ─── Section drafters ──────────────────────────────────────────────────

const BASE_TONE =
  "You are drafting minutes for a BC non-profit daycare's Annual General Meeting. " +
  "Tone: formal, factual, concise. Use past tense (\"was presented\", \"were noted\"). " +
  "Do NOT invent numbers, names or events — only reference facts provided in the data. " +
  "Never use markdown, headings, bullets or symbols. Reply with plain prose only.";

function fmtMoney(n: number): string {
  return `$${(n || 0).toLocaleString("en-CA", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function financialFacts(c: YearContext): string {
  const lines: string[] = [];
  lines.push(`Fiscal year: ${c.yearLabel}`);
  lines.push(`Active children: ${c.activeChildren} (${c.totalRoster} on roster)`);
  lines.push(`Receipts issued: ${c.receiptsIssued}`);
  lines.push(`Gross revenue: ${fmtMoney(c.grossRevenue)}`);
  if (c.ccfriTotal) lines.push(`CCFRI subsidy total: ${fmtMoney(c.ccfriTotal)}`);
  if (c.accbTotal) lines.push(`ACCB subsidy total: ${fmtMoney(c.accbTotal)}`);
  lines.push(`Parent-paid portion: ${fmtMoney(c.parentPaidTotal)}`);
  lines.push(`Total expenses: ${fmtMoney(c.expensesTotal)}`);
  if (c.topExpenseCategories.length) {
    lines.push(`Top expense categories: ${c.topExpenseCategories.map((x) => `${x.category} ${fmtMoney(x.amount)}`).join(", ")}`);
  }
  if (c.priorGrossRevenue !== undefined) {
    lines.push(`Prior year revenue: ${fmtMoney(c.priorGrossRevenue)}, prior year expenses: ${fmtMoney(c.priorExpensesTotal || 0)}`);
  }
  return lines.join("\n");
}

function staffFacts(c: YearContext): string {
  const lines: string[] = [];
  lines.push(`Active staff (${c.activeStaff.length}): ${c.activeStaff.map((s) => s.role ? `${s.name} (${s.role})` : s.name).join(", ") || "none listed"}`);
  if (c.credentialsExpiringSoon.length) {
    lines.push(`Credentials expiring/expired: ${c.credentialsExpiringSoon.map((x) => `${x.staff}—${x.type} on ${x.expiry}`).join("; ")}`);
  }
  lines.push(`Emergency drills completed: ${c.drillsCompleted}`);
  return lines.join("\n");
}

export async function draftFinancialReport(c: YearContext): Promise<string> {
  const facts = financialFacts(c);
  const user =
    `Write one short paragraph (2–4 sentences) for the "Financial Report" section of the AGM minutes. ` +
    `Summarise the year's financial health at a high level. Mention gross revenue, subsidies received, and total expenses. ` +
    `End with "Note: Financial report is attached." on a new line.\n\nDATA:\n${facts}`;
  return await azureChat(BASE_TONE, user, 300);
}

export async function draftStaffingChallenges(c: YearContext): Promise<string> {
  const facts = staffFacts(c);
  const user =
    `Write one short paragraph (2–3 sentences) for the "Staffing Challenges" sub-section of General Discussion. ` +
    `Focus on staffing continuity, credentials due for renewal (if any), and any workforce risks implied by the data. ` +
    `If nothing notable, say the daycare maintained a stable, qualified team.\n\nDATA:\n${facts}`;
  return await azureChat(BASE_TONE, user, 250);
}

export async function draftFacilitiesMaintenance(c: YearContext): Promise<string> {
  const facts = staffFacts(c) + "\n" + financialFacts(c);
  const user =
    `Write one short paragraph (2–3 sentences) for the "Facilities Maintenance" sub-section of General Discussion. ` +
    `Reference any maintenance-related expense categories if present, and drill completion for safety. ` +
    `If no maintenance-specific data, say the facility was well-maintained and safety drills were conducted regularly.\n\nDATA:\n${facts}`;
  return await azureChat(BASE_TONE, user, 250);
}

export async function draftChairmanBlock(heading: string, c: YearContext, wantBullets: boolean): Promise<string | string[]> {
  const facts = financialFacts(c) + "\n" + staffFacts(c);
  const user =
    `Write the body text for the "${heading.replace(/:$/, "")}" sub-heading of the Chairman's Report in the AGM minutes.\n` +
    (wantBullets
      ? `Reply with 3–6 short bullet points. One bullet per line. No leading dashes or bullets — plain lines only.`
      : `Reply with one short paragraph (2–4 sentences).`) +
    `\n\nDATA:\n${facts}`;
  const raw = await azureChat(BASE_TONE, user, wantBullets ? 350 : 250);
  if (wantBullets) {
    return raw.split(/\r?\n/).map((s) => s.replace(/^\s*[-•*]\s*/, "").trim()).filter(Boolean);
  }
  return raw;
}

// ─── Whole-document drafter ─────────────────────────────────────────────

export async function draftEntireMinutes(m: AgmMinutes, c: YearContext): Promise<AgmMinutes> {
  const next: AgmMinutes = JSON.parse(JSON.stringify(m));

  // 4. Financial Report body
  try { next.financialReportBody = await draftFinancialReport(c); } catch { /* keep existing */ }

  // 5. General Discussion
  try { next.staffingChallenges = await draftStaffingChallenges(c); } catch { /* keep */ }
  try { next.facilitiesMaintenance = await draftFacilitiesMaintenance(c); } catch { /* keep */ }

  // 3. Chairman's Report — draft blocks whose current body is empty, preserving
  //    the user's existing text (including auto-filled Children Enrollment).
  const filled: ChairmanBlock[] = [];
  for (const b of next.chairmanReport) {
    const isList = Array.isArray(b.body);
    const isEmpty = isList ? (b.body as string[]).length === 0 : ((b.body as string).trim() === "");
    if (!isEmpty) { filled.push(b); continue; }
    try {
      const body = await draftChairmanBlock(b.heading, c, isList);
      filled.push({ heading: b.heading, body });
    } catch {
      filled.push(b);
    }
  }
  next.chairmanReport = filled;
  return next;
}
