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

export interface DeleteIntent {
  scope: DeleteScope;
  /**
   * Staff filter matched against the roster. When empty the delete
   * covers everyone in scope; when non-empty only these staff ids
   * are cancelled. Matching is case-insensitive on either the full
   * name or the first token ("Judy" matches "Judy Chen").
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
 * Match roster names against `text` (case-insensitive) using either
 * the full name or the first name token. Returns staff ids of the
 * hits, preserving roster order.
 */
function matchStaff(text: string, roster: Array<{ id: string; name: string }>): string[] {
  const hits: string[] = [];
  for (const s of roster) {
    const trimmed = s.name.trim();
    if (!trimmed) continue;
    const first = trimmed.split(/\s+/)[0];
    const patterns = [
      new RegExp(`\\b${escapeRegex(trimmed)}\\b`, "i"),
      new RegExp(`\\b${escapeRegex(first)}\\b`, "i"),
    ];
    if (patterns.some((p) => p.test(text))) {
      hits.push(s.id);
    }
  }
  return hits;
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
      return {
        scope: rule.build(today),
        staffIds: matchStaff(raw, roster),
        raw,
      };
    }
  }
  return null;
}
