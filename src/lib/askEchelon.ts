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
  const apiKey = await invoke<string | null>("keychain_get", { key: "azure_ai_key" });
  if (!apiKey) throw new Error("Azure AI key not found in keychain.");
  const redact = opts.redact ?? (settings.ask_echelon_redact !== "0");
  return await invoke<AskResult>("ask_echelon", {
    args: {
      azure_ai_key: apiKey,
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
    "SELECT id, question, sql, chart_hint, created_at FROM saved_queries ORDER BY created_at DESC LIMIT 50"
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
  await d.execute("DELETE FROM saved_queries WHERE id = ?", [id]);
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
