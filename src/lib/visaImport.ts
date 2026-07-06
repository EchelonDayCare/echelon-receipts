// Visa / credit-card statement extraction — thin wrapper around the Rust
// `extract_visa_statement` command (which calls Azure Mistral Document AI).
import { invoke } from "@tauri-apps/api/core";

export interface ExtractedVisaTxn {
  date: string;                        // yyyy-mm-dd
  merchant: string;
  amount: number;                      // + charge, - payment/refund
  foreign_amount: string | null;
  category_guess: string | null;
}

export interface ExtractVisaResult {
  statement_period: string | null;
  card_last4: string | null;
  statement_total: number | null;
  transactions: ExtractedVisaTxn[];
  raw_text: string;
}

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
}

export async function extractVisaStatement(opts: {
  fileBytes: Uint8Array;
  mimeType: string;
}): Promise<ExtractVisaResult> {
  const file_b64 = bytesToB64(opts.fileBytes);
  return await invoke<ExtractVisaResult>("extract_visa_statement", {
    args: { file_b64, mime_type: opts.mimeType },
  });
}

// ─── Category auto-mapping ────────────────────────────────────────────
// Maps common Canadian merchant patterns to our internal expense category
// codes. Applied on top of the model's own category_guess as a fallback /
// override. Returns a category value from EXPENSE_CATEGORIES.
const KEYWORD_MAP: Array<[RegExp, string]> = [
  [/\bpayment\b|thank\s*you/i, "__PAYMENT__"],   // sentinel — exclude by default
  [/\binterest\b|finance\s+charge/i, "bank_fees"],
  [/\bannual\s+fee\b|foreign\s+currency\s+conversion/i, "bank_fees"],

  [/costco|walmart|superstore|save[- ]?on[- ]?foods|safeway|t\s*&\s*t|save\s*on|whole\s*foods|no\s*frills/i, "food_groceries"],
  [/staples|office\s*depot|amazon|dollarama|dollar\s*tree/i, "supplies_office"],
  [/michaels|scholar\'?s|toys/i, "supplies_program"],

  [/bc\s*hydro|hydro\s*one|fortisbc/i, "utilities_hydro"],
  [/telus|rogers|bell|shaw|koodo|fido|freedom\s*mobile/i, "utilities_phone"],
  [/telus.*internet|rogers.*internet|shaw.*internet|novus/i, "utilities_internet"],
  [/fortis.*gas|terasen/i, "utilities_gas"],
  [/city\s*of|metro\s*vancouver|epcor.*water/i, "utilities_water"],

  [/insurance|icbc|belairdirect|intact/i, "insurance"],
  [/translink|compass/i, "compass_transit"],
  [/petro|shell|esso|chevron|husky|7-?eleven/i, "vehicle"],
  [/uber|lyft|taxi/i, "vehicle"],
  [/microsoft|google|adobe|apple|dropbox|zoom|canva|quickbooks|sage/i, "software"],
  [/facebook|meta|google\s*ads|linkedin|indeed/i, "advertising"],
  [/tim\s*hortons|starbucks|mcdonald|subway|restaurant|cafe|coffee|pizza/i, "meals_entertainment"],
  [/home\s*depot|rona|canadian\s*tire|lowes|handyman/i, "maintenance"],
  [/lawyer|accountant|cpa|law\s*offices|notary/i, "professional_fees"],
  [/training|red\s*cross|first\s*aid|ece\s*bc|childcare\s*bc/i, "training"],
];

export const PAYMENT_SENTINEL = "__PAYMENT__";

export function guessCategory(merchant: string, modelHint: string | null): string {
  const hay = `${merchant} ${modelHint || ""}`;
  for (const [re, cat] of KEYWORD_MAP) {
    if (re.test(hay)) return cat;
  }
  return "misc";
}
