// Deterministic parser for bulk-delete commands typed into the AI
// Schedule Builder. Runs before the LLM path so short, unambiguous
// commands ("delete all shifts this week") skip the model entirely
// and route to a preview + confirm flow.
//
// Grammar (case-insensitive, all optional except a verb + a scope):
//   verb   ::= delete | clear | remove | cancel | wipe | purge
//   object ::= shift | shifts | schedule | all | everything
//   scope  ::= today | yesterday | tomorrow
//            | this|next|last week
//            | this|next|last month
//
// The verb and a scope are required. The object is required unless
// the text is short enough (≤5 words) that "delete today" is
// obviously about shifts. This keeps random text like "delete the
// email I sent last week" from firing the delete flow.
//
// v1 does NOT support per-staff filters ("delete Judy's shifts
// tomorrow"). Add if user asks — the intent parser returns null so
// the LLM path handles the request instead, which will fail with
// the usual "couldn't find shifts" message.

export type DeleteScopeKind = "day" | "week" | "month";

export interface DeleteScope {
  kind: DeleteScopeKind;
  /** Inclusive start (YYYY-MM-DD, local calendar). */
  startIso: string;
  /** Inclusive end (YYYY-MM-DD, local calendar). */
  endIso: string;
  /** Human phrase used in confirmation copy ("this week", "yesterday", …). */
  label: string;
}

export type PersonResolutionStatus = "unique" | "ambiguous" | "unresolved";

export interface PersonResolution {
  /** Token as typed by the user (original case). */
  token: string;
  status: PersonResolutionStatus;
  /** Roster id when `status === "unique"`. */
  staffId?: string;
  /** Names of the ambiguous candidates (only for `status === "ambiguous"`). */
  candidates?: string[];
}

export interface DeleteIntent {
  scope: DeleteScope;
  /**
   * Per-token resolution of any person names the user typed. Empty
   * array means the prompt named no one → an all-staff delete in
   * scope (still requires explicit confirmation in the UI). Any
   * `status !== "unique"` entry must hard-stop execution; the old
   * behaviour of silently dropping typos into "delete everyone" is
   * the bug this refactor fixes (v3.19.0 P1).
   */
  people: PersonResolution[];
  /**
   * Convenience: staff ids for the unique resolutions only. Present
   * for the safe path (all `people[].status === "unique"`); callers
   * MUST still check `people` for non-unique entries before using.
   */
  staffIds: string[];
  /** Original raw text the user typed. Kept for logging / debugging. */
  raw: string;
}

function pad(n: number): string { return String(n).padStart(2, "0"); }

function iso(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function mondayOf(d: Date): Date {
  const day = d.getDay(); // 0 = Sun
  const diff = day === 0 ? -6 : 1 - day;
  const c = new Date(d);
  c.setDate(c.getDate() + diff);
  c.setHours(0, 0, 0, 0);
  return c;
}

function dayScope(d: Date, label: string): DeleteScope {
  const s = iso(d);
  return { kind: "day", startIso: s, endIso: s, label };
}

function weekScope(monday: Date, label: string): DeleteScope {
  const sun = new Date(monday);
  sun.setDate(sun.getDate() + 6);
  return { kind: "week", startIso: iso(monday), endIso: iso(sun), label };
}

function monthScope(anyInMonth: Date, label: string): DeleteScope {
  const start = new Date(anyInMonth.getFullYear(), anyInMonth.getMonth(), 1);
  const end = new Date(anyInMonth.getFullYear(), anyInMonth.getMonth() + 1, 0);
  return { kind: "month", startIso: iso(start), endIso: iso(end), label };
}

// Scope rules. Order matters only for "this/next/last week" vs
// "this/next/last month" — those don't overlap so order is safe,
// but keep day-level scopes first for fast bailout on short prompts.
const RULES: Array<{ match: RegExp; build: (today: Date) => DeleteScope }> = [
  { match: /\btoday\b/i,               build: (t) => dayScope(t, "today") },
  {
    match: /\byesterday\b/i,
    build: (t) => {
      const d = new Date(t); d.setDate(d.getDate() - 1);
      return dayScope(d, "yesterday");
    },
  },
  {
    match: /\btomorrow\b/i,
    build: (t) => {
      const d = new Date(t); d.setDate(d.getDate() + 1);
      return dayScope(d, "tomorrow");
    },
  },
  { match: /\bthis\s+week\b/i,         build: (t) => weekScope(mondayOf(t), "this week") },
  {
    match: /\bnext\s+week\b/i,
    build: (t) => {
      const m = mondayOf(t); m.setDate(m.getDate() + 7);
      return weekScope(m, "next week");
    },
  },
  {
    match: /\blast\s+week\b/i,
    build: (t) => {
      const m = mondayOf(t); m.setDate(m.getDate() - 7);
      return weekScope(m, "last week");
    },
  },
  { match: /\bthis\s+month\b/i,        build: (t) => monthScope(t, "this month") },
  {
    match: /\bnext\s+month\b/i,
    build: (t) => monthScope(new Date(t.getFullYear(), t.getMonth() + 1, 1), "next month"),
  },
  {
    match: /\blast\s+month\b/i,
    build: (t) => monthScope(new Date(t.getFullYear(), t.getMonth() - 1, 1), "last month"),
  },
];

const DELETE_VERBS = /\b(delete|clear|remove|cancel|wipe|purge)\b/i;
const OBJECT_HINT = /\b(shift|shifts|shifty|schedule|schedules|everything|all)\b/i;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Words we ignore when scanning for capitalized person tokens. These
 * are the verbs, objects, scope markers, and common English glue
 * that appear in normal delete prompts and would otherwise be
 * misread as first names.
 */
const NAME_STOP_WORDS = new Set<string>([
  "delete", "clear", "remove", "cancel", "wipe", "purge",
  "shift", "shifts", "shifty", "schedule", "schedules", "everything", "all",
  "today", "yesterday", "tomorrow", "this", "next", "last", "week", "month",
  "of", "for", "the", "and", "a", "an", "from", "to", "in", "on", "at", "with",
  "please", "s",
  // month names — someone typing "delete August shifts" isn't naming a person
  "january", "february", "march", "april", "may", "june", "july",
  "august", "september", "october", "november", "december",
]);

/**
 * Extract candidate person-name tokens from the user's prompt. A
 * candidate is any capitalized alphabetic word that isn't a known
 * verb / scope / month. Users who type the whole prompt in lower
 * case get no person tokens — that's fine, "delete all shifts this
 * week" is genuinely all-staff. The regex-based first-name scanner
 * used to be roster-driven; now it's prompt-driven so a typo like
 * "delete Chlio's shifts today" surfaces as `unresolved` instead of
 * silently emptying the staff filter (P1 bug in v3.18.0).
 */
function extractPersonTokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\s,;.!?]+/)) {
    if (!raw) continue;
    // Strip possessive suffixes and any non-letter chrome.
    const cleaned = raw
      .replace(/['\u2019]s\b/i, "")
      .replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, "");
    if (!cleaned) continue;
    if (NAME_STOP_WORDS.has(cleaned.toLowerCase())) continue;
    // Must start with an uppercase letter in the original text.
    if (!/^[A-Z]/.test(cleaned)) continue;
    out.push(cleaned);
  }
  return out;
}

/**
 * Token-level roster resolution. For each capitalized token the
 * user typed we return exactly one `PersonResolution`:
 *   - unique     → matches one staff member (full name or unique first name)
 *   - ambiguous  → first name matches multiple staff members
 *   - unresolved → no roster match (typo, unknown name)
 *
 * Multi-word full-name matches are checked first so "Delete Judy
 * Chen" beats a bare "Judy" ambiguity when the roster contains a
 * second Judy. Tokens that are already consumed by a matched full
 * name (e.g. "Judy" and "Chen" for a "Judy Chen" match) are
 * skipped, so we don't double-count and don't emit spurious
 * "unresolved" for surnames.
 */
function resolvePeople(
  text: string,
  roster: Array<{ id: string; name: string }>,
): PersonResolution[] {
  const results: PersonResolution[] = [];
  const seenStaffIds = new Set<string>();
  const consumedTokens = new Set<string>();

  // Pass 1: multi-word full-name matches (case-insensitive, whole-word).
  for (const s of roster) {
    const full = s.name.trim();
    if (!full || !full.includes(" ")) continue;
    const re = new RegExp(`\\b${escapeRegex(full)}\\b`, "i");
    if (!re.test(text)) continue;
    if (!seenStaffIds.has(s.id)) {
      results.push({ token: full, status: "unique", staffId: s.id });
      seenStaffIds.add(s.id);
    }
    for (const w of full.split(/\s+/)) consumedTokens.add(w.toLowerCase());
  }

  // Pass 2: single-token candidates.
  for (const tok of extractPersonTokens(text)) {
    const lower = tok.toLowerCase();
    if (consumedTokens.has(lower)) continue;
    consumedTokens.add(lower);

    // Exact full-name match on a single-word roster entry.
    const fullMatches = roster.filter((s) => s.name.trim().toLowerCase() === lower);
    if (fullMatches.length === 1) {
      if (!seenStaffIds.has(fullMatches[0].id)) {
        results.push({ token: tok, status: "unique", staffId: fullMatches[0].id });
        seenStaffIds.add(fullMatches[0].id);
      }
      continue;
    }

    // First-name resolution.
    const firstMatches = roster.filter((s) => {
      const first = s.name.trim().split(/\s+/)[0];
      return first && first.toLowerCase() === lower;
    });
    if (firstMatches.length === 1) {
      if (!seenStaffIds.has(firstMatches[0].id)) {
        results.push({ token: tok, status: "unique", staffId: firstMatches[0].id });
        seenStaffIds.add(firstMatches[0].id);
      }
      continue;
    }
    if (firstMatches.length > 1) {
      results.push({
        token: tok,
        status: "ambiguous",
        candidates: firstMatches.map((s) => s.name),
      });
      continue;
    }
    results.push({ token: tok, status: "unresolved" });
  }
  return results;
}

/**
 * Try to parse `text` as a bulk-delete command. Returns `null` when it
 * doesn't look like a delete intent — the caller should then fall
 * through to the normal shift-creation LLM path.
 *
 * `roster` is the active staff list; when the text mentions specific
 * names those staff ids come back in `staffIds`. Empty `staffIds`
 * means "everyone in scope".
 *
 * `today` defaults to now(); tests pass a fixed date for determinism.
 */
export function parseDeleteIntent(
  text: string,
  roster: Array<{ id: string; name: string }> = [],
  today: Date = new Date(),
): DeleteIntent | null {
  const raw = text.trim();
  if (!raw) return null;

  if (!DELETE_VERBS.test(raw)) return null;

  // Object hint keeps random destructive-sounding sentences from
  // firing the flow. Short prompts (≤5 tokens) are exempt because
  // "delete today" is unambiguous in context.
  const tokens = raw.split(/\s+/);
  const shortAndObvious = tokens.length <= 5;
  if (!shortAndObvious && !OBJECT_HINT.test(raw)) return null;

  for (const rule of RULES) {
    if (rule.match.test(raw)) {
      const people = resolvePeople(raw, roster);
      const staffIds = people
        .filter((p) => p.status === "unique" && p.staffId)
        .map((p) => p.staffId as string);
      return {
        scope: rule.build(today),
        people,
        staffIds,
        raw,
      };
    }
  }
  return null;
}
