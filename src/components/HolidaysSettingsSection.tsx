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
  BC_HOLIDAY_CATALOG,
} from "../lib/bcHolidays";
import {
  getDisabledBcHolidayIds,
  setDisabledBcHolidayIds,
  isBcHolidaysEnabled,
  setBcHolidaysEnabled,
} from "../lib/centreCalendar";

export default function HolidaysSettingsSection() {
  const [loaded, setLoaded] = useState(false);
  const [masterOn, setMasterOn] = useState(true);
  const [disabled, setDisabled] = useState<Set<string>>(new Set());
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
      setLoaded(true);
    })();
  }, []);

  async function toggleMaster(next: boolean) {
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
      await setDisabledBcHolidayIds([...disabled]);
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
