import { loadXLSX } from "./lazy";

export interface ImportedStudent {
  name: string;
  father_name: string | null;
  mother_name: string | null;
  email: string | null;
}

// Accept common header variations and map to canonical fields
const HEADERS = {
  name: ["student name", "student's name", "student", "child", "name"],
  father: ["father's name", "father name", "father", "dad"],
  mother: ["mother's name", "mother name", "mother", "mom"],
  email: ["email id", "email", "e-mail", "email address", "parent email"],
};

function norm(s: any): string {
  return String(s ?? "").trim().toLowerCase();
}

// Strip trailing possessive ('s / ’s, with optional stray space before it)
// on any name token. Roster spreadsheets from Luxmi's paper sheets often
// carry the possessive form ("Adella Buitrago's") because the paper header
// reads "Adella's row". Print sheets, receipts, and reports all want the
// clean form. Applied at import time so the DB stores the clean value.
function stripPossessive(v: string | null): string | null {
  if (v == null) return v;
  // Trailing "'s" or "’s" only — DO NOT strip a bare trailing "s"
  // ("Jaques", "Lewis", "Adams" must stay intact).
  let out = v.replace(/[\u2019']s\b\s*$/i, "");
  // Also strip embedded "'s " between tokens (e.g. "Beau's Andrew Seymour").
  out = out.replace(/[\u2019']s\s+/gi, " ");
  return out.replace(/\s{2,}/g, " ").trim() || null;
}
function pick(row: Record<string, any>, keys: string[]): string | null {
  for (const k of Object.keys(row)) {
    if (keys.includes(norm(k))) {
      const v = row[k];
      const s = v == null ? "" : String(v).trim();
      return s || null;
    }
  }
  return null;
}

export async function parseRosterFile(file: ArrayBuffer): Promise<ImportedStudent[]> {
  const XLSX = await loadXLSX();
  const wb = XLSX.read(file, { type: "array" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, any>>(sheet, { defval: "" });
  const out: ImportedStudent[] = [];
  for (const r of rows) {
    const rawName = pick(r, HEADERS.name);
    const name = stripPossessive(rawName);
    if (!name) continue;
    out.push({
      name,
      father_name: stripPossessive(pick(r, HEADERS.father)),
      mother_name: stripPossessive(pick(r, HEADERS.mother)),
      email: pick(r, HEADERS.email),
    });
  }
  return out;
}
