// Settings → Stat Holidays tab. Lets the user opt-out of specific BC
// statutory holidays year-on-year. Selection persists in the
// `bc_stat_holidays_disabled_ids` setting (JSON string[]).
//
// Master toggle (Attendance screen checkbox + Settings > Backups > "Treat
// BC stat holidays as closed") still governs whether *any* BC holidays
// are applied. This tab controls *which* of the 12 apply when the master
// toggle is on.

import { useEffect, useState } from "react";
import {
  BC_HOLIDAY_CATALOG, bcStatHolidays,
} from "../lib/bcHolidays";
import {
  getDisabledBcHolidayIds,
  setDisabledBcHolidayIds,
  isBcHolidaysEnabled,
  setBcHolidaysEnabled,
} from "../lib/centreCalendar";
import { runClosureImpact, type ClosureImpactDate } from "./ClosureImpactDialog";

export default function HolidaysSettingsSection() {
  const [loaded, setLoaded] = useState(false);
  const [masterOn, setMasterOn] = useState(true);
  const [disabled, setDisabled] = useState<Set<string>>(new Set());
  // Snapshot of the disabled set at load / last successful save. Used
  // by `save()` to figure out which holidays are being *newly enabled*
  // (i.e. moved out of the disabled set) so we can warn about affected
  // shifts before writing the change.
  const [savedDisabled, setSavedDisabled] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const [on, off] = await Promise.all([
        isBcHolidaysEnabled(),
        getDisabledBcHolidayIds(),
      ]);
      setMasterOn(on);
      setDisabled(off);
      setSavedDisabled(new Set(off));
      setLoaded(true);
    })();
  }, []);

  // Lookahead window for closure-impact checks. Deliberately capped at
  // 26 weeks (~6 months) — staff scheduling is generally 4-8 weeks out,
  // so this covers the practical horizon without pulling a year+ of
  // holidays into the modal. Any live shift on an affected date past
  // this window will still be surfaced in the Schedule grid via the
  // warning-tint on the shift row when the owner navigates there.
  const IMPACT_LOOKAHEAD_DAYS = 26 * 7;

  // Build the set of ISO dates that would flip open → closed when the
  // supplied holiday ids become "enabled" (i.e. removed from the
  // disabled set), across the next IMPACT_LOOKAHEAD_DAYS.
  function futureHolidayDates(enabledIds: Set<string>): ClosureImpactDate[] {
    if (enabledIds.size === 0) return [];
    const today = new Date();
    const todayIso =
      `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-` +
      `${String(today.getDate()).padStart(2, "0")}`;
    const endDate = new Date(today);
    endDate.setDate(endDate.getDate() + IMPACT_LOOKAHEAD_DAYS);
    const endIso =
      `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, "0")}-` +
      `${String(endDate.getDate()).padStart(2, "0")}`;
    const fromYear = today.getFullYear();
    const toYear = endDate.getFullYear();
    const out: ClosureImpactDate[] = [];
    for (let y = fromYear; y <= toYear; y++) {
      for (const h of bcStatHolidays(y)) {
        if (!enabledIds.has(h.id)) continue;
        if (h.iso >= todayIso && h.iso <= endIso) out.push({ iso: h.iso, reason: h.name });
      }
    }
    return out;
  }

  async function toggleMaster(next: boolean) {
    // Only guard the OFF → ON direction (turning holidays on makes days
    // closed). ON → OFF opens more days and can't orphan anything.
    if (next && !masterOn) {
      const enabled = new Set(
        BC_HOLIDAY_CATALOG.map((h) => h.id).filter((id) => !disabled.has(id)),
      );
      const dates = futureHolidayDates(enabled);
      if (dates.length > 0) {
        const choice = await runClosureImpact({
          title: "Turning on stat holidays would close scheduled days",
          intro:
            `Some scheduled staff shifts fall on upcoming BC statutory holidays. ` +
            `Choose what to do with those shifts before turning the setting on.`,
          dates,
        });
        if (choice === "cancel") return;
      }
    }
    setMasterOn(next);
    await setBcHolidaysEnabled(next);
    showToast(next ? "Stat holidays turned ON" : "Stat holidays turned OFF");
  }

  function toggleHoliday(id: string, applies: boolean) {
    setDisabled((prev) => {
      const next = new Set(prev);
      if (applies) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    try {
      // Newly-enabled = present in savedDisabled but no longer in
      // current `disabled`. Only these matter for the closure-impact
      // warning — items being newly disabled make more days open, which
      // can never orphan a shift.
      const newlyEnabled = new Set<string>();
      for (const id of savedDisabled) {
        if (!disabled.has(id)) newlyEnabled.add(id);
      }
      if (masterOn && newlyEnabled.size > 0) {
        const dates = futureHolidayDates(newlyEnabled);
        if (dates.length > 0) {
          const choice = await runClosureImpact({
            title: "Enabling these holidays would close scheduled days",
            intro:
              `Some scheduled staff shifts fall on upcoming BC statutory ` +
              `holidays you're about to enable. Choose what to do with those ` +
              `shifts before saving.`,
            dates,
          });
          if (choice === "cancel") { setSaving(false); return; }
        }
      }
      await setDisabledBcHolidayIds([...disabled]);
      setSavedDisabled(new Set(disabled));
      showToast("Saved. Applies to every year going forward.");
    } catch (e: any) {
      showToast("Save failed: " + String(e?.message ?? e));
    } finally {
      setSaving(false);
    }
  }

  function showToast(msg: string) {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2500);
  }

  const enabledCount = BC_HOLIDAY_CATALOG.length - disabled.size;

  if (!loaded) return <div style={{ padding: 12 }}>Loading…</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h3 style={{ marginTop: 0 }}>Stat Holidays</h3>
        <p className="subtitle" style={{ marginTop: 0 }}>
          Pick which BC statutory holidays your centre observes as closed days. Your selection
          applies to every year — future years pick up the same rule until you change it.
        </p>
      </div>

      <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px",
                     background: "var(--muted-bg, #f7f7f7)", border: "1px solid var(--border)",
                     borderRadius: 8 }}>
        <input
          type="checkbox"
          checked={masterOn}
          onChange={(e) => toggleMaster(e.target.checked)}
        />
        <strong>Apply BC statutory holidays</strong>
        <span style={{ color: "var(--muted)", fontSize: 13 }}>
          {masterOn ? `— ${enabledCount} of ${BC_HOLIDAY_CATALOG.length} selected below` : "— off (weekends still apply)"}
        </span>
      </label>

      <div style={{ opacity: masterOn ? 1 : 0.5, pointerEvents: masterOn ? "auto" : "none" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
                      gap: 8, marginBottom: 12 }}>
          {BC_HOLIDAY_CATALOG.map((h) => {
            const applies = !disabled.has(h.id);
            return (
              <label key={h.id} style={{ display: "flex", alignItems: "center", gap: 8,
                                         padding: "8px 10px", border: "1px solid var(--border)",
                                         borderRadius: 6, cursor: "pointer",
                                         background: applies ? "var(--bg, #fff)" : "transparent" }}>
                <input
                  type="checkbox"
                  checked={applies}
                  onChange={(e) => toggleHoliday(h.id, e.target.checked)}
                />
                <span style={{ fontSize: 14 }}>{h.label}</span>
              </label>
            );
          })}
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button className="btn" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save Stat Holiday Selection"}
          </button>
          <button className="btn ghost" disabled={saving}
                  onClick={() => setDisabled(new Set())}>Select all</button>
          <button className="btn ghost" disabled={saving}
                  onClick={() => setDisabled(new Set(BC_HOLIDAY_CATALOG.map((h) => h.id)))}>Clear all</button>
        </div>

        <small style={{ color: "var(--muted)", display: "block", marginTop: 10 }}>
          After saving, the next time you open a month in Attendance the closed-day markers refresh.
          Existing manual overrides in the centre calendar are never touched.
        </small>
      </div>

      {toast && (
        <div style={{ position: "fixed", bottom: 20, right: 20, padding: "8px 14px",
                      background: "#111", color: "#fff", borderRadius: 6, fontSize: 13,
                      zIndex: 1000 }}>{toast}</div>
      )}
    </div>
  );
}
