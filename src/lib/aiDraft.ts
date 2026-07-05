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
import { logError } from "./errorLog";

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
  } catch (e: any) {
    void logError("WARN", `[aiDraft.safeSelectOne] ${e?.message || e}\nSQL: ${sql.slice(0, 200)}`);
    return fallback;
  }
}
async function safeSelect<T>(sql: string, args: any[] = []): Promise<T[]> {
  try {
    const d = await db();
    return await d.select<T[]>(sql, args);
  } catch (e: any) {
    void logError("WARN", `[aiDraft.safeSelect] ${e?.message || e}\nSQL: ${sql.slice(0, 200)}`);
    return [];
  }
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

  // Revenue: gross uses COALESCE(gross_amount, amount) — older rows predating
  // migration 005 have gross_amount = NULL and their `amount` was the full fee
  // before we split out subsidies. Parent-paid uses `amount` (already net of
  // subsidies for post-migration rows).
  const rev = await safeSelectOne<{ gross: number; ccfri: number; accb: number; parent_paid: number }>(
    `SELECT
        COALESCE(SUM(CASE WHEN is_refund=1 THEN -COALESCE(gross_amount, amount) ELSE COALESCE(gross_amount, amount) END), 0) AS gross,
        COALESCE(SUM(CASE WHEN is_refund=1 THEN -COALESCE(ccfri_amount,0) ELSE COALESCE(ccfri_amount,0) END), 0) AS ccfri,
        COALESCE(SUM(CASE WHEN is_refund=1 THEN -COALESCE(accb_amount,0) ELSE COALESCE(accb_amount,0) END), 0) AS accb,
        COALESCE(SUM(CASE WHEN is_refund=1 THEN -amount ELSE amount END), 0) AS parent_paid
      FROM receipts WHERE voided=0 AND date>=? AND date<=?`,
    [start, end], { gross: 0, ccfri: 0, accb: 0, parent_paid: 0 }
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

  // Staff active AT ANY POINT during the fiscal year (not just currently active).
  // Uses staff.created_at (assumed <= start of FY means hired before/during) and
  // staff.archived_at (NULL = still active). Best-effort — falls back to current
  // active roster if the timestamps are missing on older rows.
  const staff = await safeSelect<{ name: string; role: string | null }>(
    `SELECT DISTINCT name, role
       FROM staff
      WHERE (created_at IS NULL OR created_at <= ?)
        AND (archived_at IS NULL OR archived_at >= ?)
      ORDER BY name COLLATE NOCASE`,
    [end, start]
  );

  // Credentials whose expiry falls INSIDE the fiscal year (expired during FY)
  // or within 90 days after FY-end (upcoming renewal risk noted at AGM time).
  const credExp = await safeSelect<{ staff: string; type: string; expiry: string }>(
    `SELECT s.name AS staff, c.type, c.expiry_date AS expiry
       FROM staff_credentials c JOIN staff s ON s.id=c.staff_id
      WHERE c.expiry_date IS NOT NULL
        AND c.expiry_date >= ?
        AND c.expiry_date <= date(?, '+90 days')
      ORDER BY c.expiry_date`,
    [start, end]
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
      "SELECT COALESCE(SUM(CASE WHEN is_refund=1 THEN -COALESCE(gross_amount, amount) ELSE COALESCE(gross_amount, amount) END),0) AS gross FROM receipts WHERE voided=0 AND date>=? AND date<=?",
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
  } catch (e: any) { void logError("WARN", `[aiDraft prior-year] ${e?.message || e}`); }

  return {
    yearLabel: fiscalYearLabel(fyStart),
    fyStart,
    activeChildren: enroll.active || 0,
    totalRoster: enroll.total || 0,
    receiptsIssued: rcpt.n || 0,
    grossRevenue: rev.gross || 0,
    ccfriTotal: rev.ccfri || 0,
    accbTotal: rev.accb || 0,
    parentPaidTotal: rev.parent_paid || 0,
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

const CHAT_TIMEOUT_MS = 45_000;

/**
 * Combine an external AbortSignal with a timeout-driven AbortController.
 * Returns the effective controller so callers can abort explicitly and a
 * cleanup function that must be called after fetch resolves/rejects.
 */
function combinedController(external?: AbortSignal): { controller: AbortController; cleanup: () => void } {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(new DOMException("Timeout", "TimeoutError")), CHAT_TIMEOUT_MS);
  const onExtAbort = () => controller.abort(external!.reason);
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener("abort", onExtAbort, { once: true });
  }
  return {
    controller,
    cleanup: () => {
      clearTimeout(t);
      if (external) external.removeEventListener("abort", onExtAbort);
    },
  };
}

async function recordAiEvent(section: string, prompt: string, response: string, model: string, yearLabel?: string): Promise<void> {
  try {
    const d = await db();
    await d.execute(
      `INSERT INTO agm_ai_events(year_label, section, model, prompt_text, response_text, created_at)
       VALUES(?, ?, ?, ?, ?, datetime('now'))`,
      [yearLabel || null, section, model, prompt, response]
    );
  } catch (e: any) {
    void logError("WARN", `[aiDraft.recordAiEvent] ${e?.message || e}`);
  }
}

async function azureChat(
  system: string, user: string, maxTokens = 400, signal?: AbortSignal,
  audit?: { section: string; yearLabel?: string },
): Promise<string> {
  const settings = await getSettings();
  if (settings.azure_ai_key_set !== "1") {
    throw new Error("Azure AI key is not configured. Set it in Configuration → Identity.");
  }
  if (settings.agm_ai_enabled === "0") {
    throw new Error("AGM AI drafting is disabled. Enable it in Settings → AGM AI.");
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
  const { controller, cleanup } = combinedController(signal);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      throw new Error(`Azure OpenAI HTTP ${resp.status}: ${t.slice(0, 200)}`);
    }
    const json = await resp.json();
    const content: string = (json?.choices?.[0]?.message?.content ?? "").trim();
    if (audit) {
      void recordAiEvent(audit.section, `SYSTEM:\n${system}\n\nUSER:\n${user}`, content, CHAT_DEPLOY, audit.yearLabel);
    }
    return content;
  } finally {
    cleanup();
  }
}

// Neutralise attempts to inject instructions via user-editable strings (headings,
// chairperson names, etc.). Injection is low-risk here (local, own key) but board
// audit logs shouldn't show "ignore previous instructions" attacks succeeding.
function sanitizePromptString(s: string): string {
  return (s || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/["\\]/g, "")
    .slice(0, 200);
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

export async function draftFinancialReport(c: YearContext, signal?: AbortSignal): Promise<string> {
  const facts = financialFacts(c);
  const user =
    `Write one short paragraph (2–4 sentences) for the "Financial Report" section of the AGM minutes. ` +
    `Summarise the year's financial health at a high level. Mention gross revenue, subsidies received, and total expenses. ` +
    `End with "Note: Financial report is attached." on a new line.\n\nDATA:\n${facts}`;
  return await azureChat(BASE_TONE, user, 300, signal, { section: "financialReport", yearLabel: c.yearLabel });
}

export async function draftStaffingChallenges(c: YearContext, signal?: AbortSignal): Promise<string> {
  const facts = staffFacts(c);
  const user =
    `Write one short paragraph (2–3 sentences) for the "Staffing Challenges" sub-section of General Discussion. ` +
    `Focus on staffing continuity, credentials due for renewal (if any), and any workforce risks implied by the data. ` +
    `If nothing notable, say the daycare maintained a stable, qualified team.\n\nDATA:\n${facts}`;
  return await azureChat(BASE_TONE, user, 250, signal, { section: "staffingChallenges", yearLabel: c.yearLabel });
}

export async function draftFacilitiesMaintenance(c: YearContext, signal?: AbortSignal): Promise<string> {
  const facts = staffFacts(c) + "\n" + financialFacts(c);
  const user =
    `Write one short paragraph (2–3 sentences) for the "Facilities Maintenance" sub-section of General Discussion. ` +
    `Reference any maintenance-related expense categories if present, and drill completion for safety. ` +
    `If no maintenance-specific data, say the facility was well-maintained and safety drills were conducted regularly.\n\nDATA:\n${facts}`;
  return await azureChat(BASE_TONE, user, 250, signal, { section: "facilitiesMaintenance", yearLabel: c.yearLabel });
}

export async function draftChairmanBlock(heading: string, c: YearContext, wantBullets: boolean, signal?: AbortSignal): Promise<string | string[]> {
  const facts = financialFacts(c) + "\n" + staffFacts(c);
  const safeHeading = sanitizePromptString(heading.replace(/:$/, ""));
  const user =
    `Write the body text for the "${safeHeading}" sub-heading of the Chairman's Report in the AGM minutes.\n` +
    (wantBullets
      ? `Reply with 3–6 short bullet points. One bullet per line. No leading dashes or bullets — plain lines only.`
      : `Reply with one short paragraph (2–4 sentences).`) +
    `\n\nDATA:\n${facts}`;
  const raw = await azureChat(BASE_TONE, user, wantBullets ? 350 : 250, signal, { section: `chairman:${safeHeading}`, yearLabel: c.yearLabel });
  if (wantBullets) {
    return raw.split(/\r?\n/).map((s) => s.replace(/^\s*[-•*]\s*/, "").trim()).filter(Boolean);
  }
  return raw;
}

// ─── Whole-document drafter ─────────────────────────────────────────────

export interface DraftAllOpts {
  signal?: AbortSignal;
  /** Original draft as returned by buildInitialDraft — used to detect user edits.
   *  A field is overwritten by AI only if the current value still matches the
   *  initial value (i.e. the user hasn't touched it). */
  initial?: AgmMinutes;
}

function sameStringField(cur: string, init: string): boolean {
  return (cur || "").trim() === (init || "").trim();
}
function sameBlockBody(cur: string | string[], init: string | string[]): boolean {
  const norm = (v: string | string[]) => Array.isArray(v) ? v.map(s => s.trim()).filter(Boolean).join("\n") : (v || "").trim();
  return norm(cur) === norm(init);
}

export async function draftEntireMinutes(m: AgmMinutes, c: YearContext, opts: DraftAllOpts = {}): Promise<AgmMinutes> {
  const next: AgmMinutes = JSON.parse(JSON.stringify(m));
  const init = opts.initial;
  const signal = opts.signal;

  const canOverwriteFin = !init || sameStringField(next.financialReportBody, init.financialReportBody);
  const canOverwriteStaff = !init || sameStringField(next.staffingChallenges, init.staffingChallenges);
  const canOverwriteFac = !init || sameStringField(next.facilitiesMaintenance, init.facilitiesMaintenance);

  if (canOverwriteFin) {
    try { next.financialReportBody = await draftFinancialReport(c, signal); }
    catch (e: any) { if (e?.name === "AbortError") throw e; void logError("WARN", `[draftEntireMinutes fin] ${e?.message || e}`); }
  }
  if (canOverwriteStaff) {
    try { next.staffingChallenges = await draftStaffingChallenges(c, signal); }
    catch (e: any) { if (e?.name === "AbortError") throw e; void logError("WARN", `[draftEntireMinutes staff] ${e?.message || e}`); }
  }
  if (canOverwriteFac) {
    try { next.facilitiesMaintenance = await draftFacilitiesMaintenance(c, signal); }
    catch (e: any) { if (e?.name === "AbortError") throw e; void logError("WARN", `[draftEntireMinutes fac] ${e?.message || e}`); }
  }

  // Chairman's Report — draft blocks whose body is either empty OR unchanged from initial.
  const initBlocks = init?.chairmanReport ?? [];
  const filled: ChairmanBlock[] = [];
  for (const b of next.chairmanReport) {
    const isList = Array.isArray(b.body);
    const isEmpty = isList ? (b.body as string[]).length === 0 : ((b.body as string).trim() === "");
    const initBlock = initBlocks.find((x) => x.heading === b.heading);
    const unchanged = initBlock ? sameBlockBody(b.body, initBlock.body) : true;
    if (!isEmpty && !unchanged) { filled.push(b); continue; }
    try {
      const body = await draftChairmanBlock(b.heading, c, isList, signal);
      filled.push({ heading: b.heading, body });
    } catch (e: any) {
      if (e?.name === "AbortError") throw e;
      void logError("WARN", `[draftEntireMinutes chairman:${b.heading}] ${e?.message || e}`);
      filled.push(b);
    }
  }
  next.chairmanReport = filled;
  return next;
}
