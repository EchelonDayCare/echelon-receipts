import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), execute: vi.fn(), select: vi.fn(), checkpointWal: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("./db", () => ({
  db: async () => ({ select: mocks.select, execute: mocks.execute }),
  serializeWrite: async (fn: () => Promise<unknown>) => fn(),
  checkpointWal: mocks.checkpointWal,
}));
import { runDataCleanup } from "./dataCleanup";

describe("accounting cleanup safeguards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.select.mockResolvedValue([{ n: 1 }]);
  });
  it.each(["students", "receipts", "expenses"] as const)("blocks %s before backup or mutation", async (category) => {
    await expect(runDataCleanup([category])).rejects.toThrow("Accounting is active");
    expect(mocks.checkpointWal).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("does not silently continue when accounting state cannot be read", async () => {
    mocks.select.mockRejectedValueOnce(new Error("Database unavailable"));
    await expect(runDataCleanup(["expenses"])).rejects.toThrow("Database unavailable");
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("preserves backed-up nonfinancial cleanup when accounting is active", async () => {
    mocks.checkpointWal.mockResolvedValue({ busy: 0 });
    mocks.invoke.mockResolvedValue("Synthetic safety backup");
    mocks.execute.mockResolvedValue({ rowsAffected: 2 });
    await runDataCleanup(["attendance"]);
    expect(mocks.invoke).toHaveBeenCalledWith("backup_before_data_cleanup");
    expect(mocks.execute).toHaveBeenCalledWith("BEGIN IMMEDIATE");
    expect(mocks.execute.mock.calls.some(([sql]) => sql.startsWith("DELETE FROM child_attendance"))).toBe(true);
    expect(mocks.execute).toHaveBeenCalledWith("COMMIT");
    expect(mocks.execute.mock.calls.some(([sql]) => /DELETE FROM (receipts|expenses|students)/.test(sql))).toBe(false);
  });
});
