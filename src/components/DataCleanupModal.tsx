// v3.25.0 — Data Cleanup modal (top-right icon stack, below the lock).
//
// Lets the owner permanently clear categories of test/dummy data before
// a real launch (e.g. "New Family Welcome" test students & receipts
// entered during setup). Deliberately NOT a single "reset everything"
// action:
//   * Category checkboxes — nothing is deleted unless explicitly picked.
//   * Live COUNT preview per category before any delete runs, computed
//     from the exact same query the delete uses (see dataCleanup.ts).
//   * Mandatory (non-skippable) encrypted-DB safety backup first.
//   * Typed confirmation phrase restates the exact scope being deleted
//     (e.g. "DELETE 2026-09") so changing the year/month/mode after
//     typing it always invalidates the previous confirmation.
//   * Extra confirmation required if any already-emailed Annual Tax
//     Receipt falls inside the selected scope.
//   * Settings / Security / Templates / Website config are never touched.
import { useEffect, useMemo, useState } from "react";
import {
  CLEANUP_CATEGORY_LABELS,
  CLEANUP_CASCADE_NOTE,
  getCleanupCounts,
  getAvailableYears,
  hasEmailedAnnualReceiptsInScope,
  categoryResourcesForScope,
  runDataCleanup,
  type CleanupCategory,
  type CleanupCounts,
  type DateScope,
} from "../lib/dataCleanup";
import { showAlert } from "../lib/dialogs";

const CATEGORY_ORDER: CleanupCategory[] = [
  "students",
  "receipts",
  "attendance",
  "waitlist",
  "expenses",
];

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// The exact phrase the owner must type — restates the scope so a change
// to the year/month/mode dropdown always invalidates whatever was typed
// before (fixes: changing Year after typing DELETE used to leave the
// button armed against the NEW scope with the OLD confirmation still
// satisfied).
function requiredPhrase(scope: DateScope | null): string {
  if (!scope) return "DELETE ALL";
  return `DELETE ${scope.year}${scope.month ? `-${String(scope.month).padStart(2, "0")}` : ""}`;
}

export default function DataCleanupModal({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<"category" | "year">("category");
  const [availableYears, setAvailableYears] = useState<number[]>([]);
  const [year, setYear] = useState<number | null>(null);
  const [month, setMonth] = useState<number | "all">("all");

  const [counts, setCounts] = useState<CleanupCounts | null>(null);
  const [countsLoading, setCountsLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<CleanupCategory>>(new Set());
  const [confirmText, setConfirmText] = useState("");
  const [ackEmailed, setAckEmailed] = useState(false);
  const [hasEmailedAnnual, setHasEmailedAnnual] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ backupPath: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const scope: DateScope | null =
    mode === "year" && year != null ? { year, month: month === "all" ? undefined : month } : null;
  const phrase = requiredPhrase(scope);

  // Load the list of years that actually have data, once, up front.
  // Deliberately does NOT auto-select a year — a destructive dialog
  // should never pre-arm itself against live data; the owner must
  // explicitly choose.
  useEffect(() => {
    let cancelled = false;
    getAvailableYears()
      .then((years) => { if (!cancelled) setAvailableYears(years); })
      .catch(() => { /* non-fatal — year mode simply won't have a default */ });
    return () => { cancelled = true; };
  }, []);

  // Re-fetch counts whenever the scope (mode/year/month) changes, AND
  // invalidate anything already typed/checked — the confirmation phrase
  // itself changes with scope (see requiredPhrase), but the checkbox and
  // stale "0 records" flash while loading also need clearing so the
  // Delete button can never fire against numbers from a previous scope.
  useEffect(() => {
    let cancelled = false;
    setCounts(null);
    setCountsLoading(true);
    setLoadErr(null);
    setConfirmText("");
    setAckEmailed(false);
    setHasEmailedAnnual(false);
    Promise.all([getCleanupCounts(scope), hasEmailedAnnualReceiptsInScope(scope)])
      .then(([c, emailed]) => {
        if (cancelled) return;
        setCounts(c);
        setHasEmailedAnnual(emailed);
        setCountsLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setLoadErr(String(e?.message ?? e));
        setCountsLoading(false);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, year, month]);

  // "students" (roster) is never touched in year-scoped mode. Drop it
  // from selection if the user switches into year mode with it checked.
  useEffect(() => {
    if (mode === "year" && selected.has("students")) {
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete("students");
        return next;
      });
    }
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const visibleCategories = useMemo(
    () => (mode === "year" ? CATEGORY_ORDER.filter((c) => c !== "students") : CATEGORY_ORDER),
    [mode],
  );

  function toggle(cat: CleanupCategory) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat); else next.add(cat);
      return next;
    });
    // Any change to what's selected invalidates a previously typed
    // confirmation — the total it was confirming just changed.
    setConfirmText("");
  }

  const selectedCategories = visibleCategories.filter((c) => selected.has(c));
  const selectedCount = selectedCategories.length;
  const totalRows = counts
    ? selectedCategories.reduce((sum, c) => sum + counts[c], 0)
    : 0;
  // Month-scoped mode skips annual_receipts entirely (see dataCleanup.ts)
  // — tell the user explicitly if that's why their "receipts" pick looks
  // smaller than expected, instead of leaving it unexplained.
  const annualSkippedForMonth =
    mode === "year" && month !== "all" && selected.has("receipts");

  const requiresEmailedAck = hasEmailedAnnual && selected.has("receipts") && !annualSkippedForMonth;
  const canRun =
    selectedCount > 0 &&
    !countsLoading &&
    confirmText.trim().toUpperCase() === phrase &&
    (!requiresEmailedAck || ackEmailed) &&
    !busy &&
    (mode === "category" || year != null);

  async function onRun() {
    if (!canRun) return;
    setBusy(true);
    setErr(null);
    try {
      const result = await runDataCleanup(Array.from(selected), scope);
      setDone({ backupPath: result.backupPath });
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div style={backdrop} role="dialog" aria-modal="true" aria-labelledby="cleanup-done-title">
        <div style={modal}>
          <h2 id="cleanup-done-title" style={{ margin: "0 0 8px", fontSize: 18, color: "#065f46" }}>
            ✓ Test data cleared
          </h2>
          <p style={{ margin: "0 0 12px", fontSize: 14, color: "#374151", lineHeight: 1.5 }}>
            A safety backup of the database was saved before anything was deleted, in case you need to
            recover any of this data later.
          </p>
          <div style={{ ...listBox, wordBreak: "break-all" }}>{done.backupPath}</div>
          <div style={{ marginTop: 16, display: "flex", justifyContent: "flex-end" }}>
            <button type="button" className="btn primary" onClick={() => { onClose(); window.location.reload(); }}>
              Done — reload app
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={backdrop} role="dialog" aria-modal="true" aria-labelledby="cleanup-title">
      <div style={modal}>
        <h2 id="cleanup-title" style={{ margin: "0 0 6px", fontSize: 18, color: "#7c2d12" }}>
          ⚠ Clear test data
        </h2>
        <p style={{ margin: "0 0 12px", color: "#374151", fontSize: 14, lineHeight: 1.45 }}>
          Pick exactly what to permanently delete before going live. Settings, Security, email templates,
          and Website configuration are never touched by this tool.
        </p>

        {loadErr && (
          <div style={{ ...listBox, borderColor: "#fecaca", background: "#fef2f2", color: "#991b1b" }}>
            Couldn't load record counts: {loadErr}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <button
            type="button"
            onClick={() => setMode("category")}
            disabled={busy}
            style={modeTab(mode === "category")}
          >
            Whole categories
          </button>
          <button
            type="button"
            onClick={() => setMode("year")}
            disabled={busy}
            style={modeTab(mode === "year")}
          >
            Only one year/month
          </button>
        </div>

        {mode === "year" && (
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 12 }}>
            <label style={{ fontSize: 13, color: "#374151" }}>
              Year
              <select
                value={year ?? ""}
                onChange={(e) => setYear(e.target.value ? Number(e.target.value) : null)}
                disabled={busy || availableYears.length === 0}
                style={selectStyle}
              >
                <option value="">Choose a year…</option>
                {availableYears.length === 0 && <option value="" disabled>No dated records found</option>}
                {availableYears.map((y) => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </label>
            <label style={{ fontSize: 13, color: "#374151" }}>
              Month
              <select
                value={month}
                onChange={(e) => setMonth(e.target.value === "all" ? "all" : Number(e.target.value))}
                disabled={busy || year == null}
                style={selectStyle}
              >
                <option value="all">Whole year</option>
                {MONTH_NAMES.map((name, i) => (
                  <option key={name} value={i + 1}>{name}</option>
                ))}
              </select>
            </label>
          </div>
        )}

        {mode === "year" && year != null && (
          <div style={{ ...listBox, marginBottom: 12 }}>
            Only records dated in {year}{month !== "all" ? `-${String(month).padStart(2, "0")}` : ""} are
            deleted. All other years, and the full student/kid roster, are left untouched.
            {annualSkippedForMonth && (
              <>
                {" "}Annual Tax Receipts are a whole-year document, so they are <strong>not</strong> deleted
                when only a month is selected — clear the whole year (no month) to remove them too.
              </>
            )}
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {visibleCategories.map((cat) => {
            const applies = mode === "category" || categoryResourcesForScope(cat, scope).length > 0;
            const count = counts ? counts[cat] : null;
            return (
              <label key={cat} style={{ ...choiceRow, opacity: applies ? 1 : 0.55 }}>
                <input
                  type="checkbox"
                  checked={selected.has(cat)}
                  onChange={() => toggle(cat)}
                  disabled={busy || (mode === "year" && year == null)}
                />
                <span style={{ flex: 1 }}>
                  <strong>{CLEANUP_CATEGORY_LABELS[cat]}</strong>
                  <span style={{ color: "#6b7280", marginLeft: 8 }}>
                    {countsLoading ? "…" : count != null ? `${count} record${count === 1 ? "" : "s"}` : "…"}
                  </span>
                </span>
              </label>
            );
          })}
        </div>

        {mode === "category" && selected.has("students") && (
          <div style={{ ...listBox, marginTop: 10 }}>{CLEANUP_CASCADE_NOTE}</div>
        )}

        {requiresEmailedAck && (
          <div style={{ ...listBox, marginTop: 10, borderColor: "#fca5a5", background: "#fef2f2", color: "#991b1b" }}>
            <label style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={ackEmailed}
                onChange={(e) => setAckEmailed(e.target.checked)}
                disabled={busy}
              />
              <span>
                At least one Annual Tax Receipt in this scope has <strong>already been emailed</strong> to a
                family. Deleting it removes the app's own record of a document they may rely on for their tax
                filing. I understand and want to delete it anyway.
              </span>
            </label>
          </div>
        )}

        {selectedCount > 0 && (
          <div style={{ marginTop: 12, fontSize: 13, color: "#7c2d12" }}>
            This will permanently delete <strong>{totalRows}</strong> row{totalRows === 1 ? "" : "s"} across{" "}
            {selectedCount} categor{selectedCount === 1 ? "y" : "ies"}
            {scope ? ` from ${scope.year}${scope.month ? `-${String(scope.month).padStart(2, "0")}` : ""} only` : ""}.
            A safety backup runs first.
          </div>
        )}

        {err && (
          <div style={{ ...listBox, marginTop: 10, borderColor: "#fecaca", background: "#fef2f2", color: "#991b1b" }}>
            {err}
          </div>
        )}

        <div style={{ marginTop: 14 }}>
          <label style={{ fontSize: 13, color: "#374151", display: "block", marginBottom: 4 }}>
            Type <strong>{phrase}</strong> to confirm
          </label>
          <input
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            disabled={busy || selectedCount === 0 || (mode === "year" && year == null)}
            placeholder={phrase}
            style={{
              width: "100%", padding: "8px 10px", borderRadius: 8,
              border: "1px solid #d1d5db", fontSize: 14,
            }}
          />
        </div>

        <div style={{ marginTop: 16, display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            style={{ background: "#b91c1c", borderColor: "#b91c1c" }}
            onClick={onRun}
            disabled={!canRun}
          >
            {busy ? "Backing up & deleting…" : `Delete ${totalRows} record${totalRows === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// Standalone entry point used by DataCleanupButton — keeps the button
// component free of modal-visibility state duplication elsewhere.
export async function alertUnlockRequired() {
  await showAlert("Unlock the app before running a data cleanup.", { kind: "warning" });
}

const backdrop: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,.55)",
  display: "flex", alignItems: "center", justifyContent: "center",
  zIndex: 2000,
};
const modal: React.CSSProperties = {
  background: "#fff", color: "#111", borderRadius: 10,
  padding: 20, width: "min(560px, 92vw)", maxHeight: "90vh", overflowY: "auto",
  border: "1px solid #fed7aa",
  boxShadow: "0 20px 60px rgba(0,0,0,.25)",
};
const listBox: React.CSSProperties = {
  padding: 10, borderRadius: 8, background: "#fff7ed",
  border: "1px solid #fed7aa", fontSize: 13, color: "#7c2d12",
};
const choiceRow: React.CSSProperties = {
  display: "flex", alignItems: "flex-start", gap: 10,
  padding: 10, borderRadius: 8, border: "1px solid #e5e7eb",
  cursor: "pointer", fontSize: 14,
};
const selectStyle: React.CSSProperties = {
  display: "block", marginTop: 3, padding: "6px 8px",
  borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13,
};
function modeTab(active: boolean): React.CSSProperties {
  return {
    flex: 1, padding: "8px 10px", borderRadius: 8, fontSize: 13, fontWeight: 600,
    border: active ? "1px solid #b91c1c" : "1px solid #e5e7eb",
    background: active ? "#fef2f2" : "#fff",
    color: active ? "#7c2d12" : "#374151",
    cursor: "pointer",
  };
}
