import { invoke } from "@tauri-apps/api/core";
import { db, getSettings } from "./db";

export type ChartHint = "bar" | "line" | "pie" | "none";

export interface AskResult {
  sql: string;
  columns: string[];
  rows: unknown[][];
  summary: string;
  chart_hint: ChartHint;
  elapsed_ms: number;
  truncated: boolean;
}

export interface AskOptions {
  question: string;
  /** Override the redact-by-default toggle for a single call. */
  redact?: boolean;
  /** Optional whitelist of tables the model may see. Empty = all. */
  allowedTables?: string[];
}

export async function askEchelon(opts: AskOptions): Promise<AskResult> {
  const settings = await getSettings();
  if (settings.ask_echelon_enabled === "0") {
    throw new Error("Ask Echelon is disabled in Configuration → Identity.");
  }
  if (settings.azure_ai_key_set !== "1") {
    throw new Error("Azure AI key is not configured. Set it in Configuration → Identity.");
  }
  // H-7: the Azure AI key is resolved server-side (see ask_echelon.rs) —
  // it never crosses the IPC boundary as a plaintext argument.
  const redact = opts.redact ?? (settings.ask_echelon_redact !== "0");
  return await invoke<AskResult>("ask_echelon", {
    args: {
      question: opts.question,
      redact,
      allowed_tables: opts.allowedTables ?? null,
    },
  });
}

export interface SavedQuery {
  id: number;
  question: string;
  sql: string;
  chart_hint: string | null;
  created_at: string;
}

export async function listSavedQueries(): Promise<SavedQuery[]> {
  const d = await db();
  return await d.select<SavedQuery[]>(
    "SELECT id, question, sql, chart_hint, created_at FROM saved_queries WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 50"
  );
}

export async function saveQuery(question: string, sql: string, chartHint: string): Promise<void> {
  const d = await db();
  await d.execute(
    "INSERT INTO saved_queries (question, sql, chart_hint) VALUES (?, ?, ?)",
    [question, sql, chartHint]
  );
}

export async function deleteSavedQuery(id: number): Promise<void> {
  const d = await db();
  await d.execute("UPDATE saved_queries SET deleted_at = datetime('now') WHERE id = ?", [id]);
}

// ── Question popularity log ─────────────────────────────────────────────

export interface AskedQuestion {
  question: string;
  ask_count: number;
  last_asked_at: string;
}

/** Bump the count for a question (case-insensitive), inserting if new. */
export async function logQuestion(question: string): Promise<void> {
  const q = question.trim();
  if (!q) return;
  const d = await db();
  // Try to bump first; if 0 rows affected, insert.
  await d.execute(
    "UPDATE asked_questions SET ask_count = ask_count + 1, last_asked_at = datetime('now') WHERE question = ? COLLATE NOCASE",
    [q]
  );
  await d.execute(
    "INSERT OR IGNORE INTO asked_questions (question) VALUES (?)",
    [q]
  );
}

export async function topAskedQuestions(limit = 10): Promise<AskedQuestion[]> {
  const d = await db();
  return await d.select<AskedQuestion[]>(
    "SELECT question, ask_count, last_asked_at FROM asked_questions ORDER BY ask_count DESC, last_asked_at DESC LIMIT ?",
    [limit]
  );
}

/** Convert result rows into a CSV string (RFC-4180-ish, quote if needed). */
export function resultToCsv(res: AskResult): string {
  const esc = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [res.columns.map(esc).join(",")];
  for (const r of res.rows) lines.push(r.map(esc).join(","));
  return lines.join("\r\n");
}
