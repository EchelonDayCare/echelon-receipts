import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgmMinutes } from "./agmMinutes";

const mocks = vi.hoisted(() => ({
  execute: vi.fn().mockResolvedValue({}),
  settings: vi.fn().mockResolvedValue({ azure_ai_key_set: "1", agm_ai_enabled: "1" }),
  invoke: vi.fn().mockResolvedValue("synthetic-key"),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("./db", () => ({ db: async () => ({ execute: mocks.execute }), getSettings: mocks.settings }));
vi.mock("./errorLog", () => ({ logError: vi.fn() }));
vi.mock("./finance", () => ({ finance: vi.fn() }));
import { applyRewordedSections, minutesRewordSections, parseRewordedSections, rewordMinutes } from "./aiDraft";

const minutes: AgmMinutes = {
  yearLabel: "2025-26", fyStartYear: 2025, associationName: "Synthetic Society",
  meetingDate: "October 20, 2026", meetingTime: "5:00 PM", meetingLocation: "Centre",
  present: ["Test Person"], absent: [], previousMinutesReadBy: "Reader", previousMinutesApprovedBy: "Approver",
  chairmanReport: [{ heading: "Licensing:", body: ["we done 2 visits", ""] }, { heading: "Empty:", body: "" }],
  financialReportPresenter: "Presenter", financialReportBody: "we spent $1,200.50 on repairs",
  staffingChallenges: "", facilitiesMaintenance: "", boardElections: "the board was elected",
  futureAgenda: ["discuss garden"], adjournmentTime: "7:00 PM",
};

describe("AGM rewording", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });
  it("selects narrative only, including ungrounded sections, without metadata or empty bodies", () => {
    expect(minutesRewordSections(minutes).map((s) => s.id)).toEqual([
      "chairman:0", "financialReportBody", "boardElections", "futureAgenda",
    ]);
  });
  it("applies wording without mutating the original, names, headings or other fields", () => {
    const next = applyRewordedSections(minutes, [
      { id: "chairman:0", text: ["We completed 2 visits.", ""] },
      { id: "boardElections", text: "The board was elected." },
    ]);
    expect(next.chairmanReport[0]).toEqual({ heading: "Licensing:", body: ["We completed 2 visits.", ""] });
    expect(next.present).toEqual(minutes.present);
    expect(next.meetingDate).toBe(minutes.meetingDate);
    expect(next.financialReportBody).toBe(minutes.financialReportBody);
    expect(minutes.boardElections).toBe("the board was elected");
  });
  it("accepts structured prose and preserves the exact list shape", () => {
    const original = [{ id: "one", text: ["we done 2 visits", ""] }];
    expect(parseRewordedSections('[{"id":"one","text":["We completed 2 visits.",""]}]', original))
      .toEqual([{ id: "one", text: ["We completed 2 visits.", ""] }]);
  });
  it.each([
    "not JSON", "[]", '[{"id":"wrong","text":"Repairs cost $1,200.50."}]',
    '[{"id":"financialReportBody","text":"Repairs cost $1,500.50."}]',
    '[{"id":"financialReportBody","text":""}]',
    '[{"id":"financialReportBody","text":["Repairs cost $1,200.50."]}]',
  ])("rejects malformed, missing, empty or fact-changing output: %s", (raw) => {
    expect(() => parseRewordedSections(raw, [{ id: "financialReportBody", text: minutes.financialReportBody }])).toThrow();
  });
  it("rejects removed list items and duplicate section ids", () => {
    expect(() => parseRewordedSections('[{"id":"x","text":["One."]}]', [{ id: "x", text: ["one", "two"] }])).toThrow();
    expect(() => parseRewordedSections('[{"id":"x","text":"One."},{"id":"x","text":"Two."}]',
      [{ id: "x", text: "one" }, { id: "y", text: "two" }])).toThrow();
  });
  it("uses only selected text, audits the action and does not require financial source data", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '[{"id":"boardElections","text":"The board was elected."}]' } }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const next = await rewordMinutes(minutes, undefined, "boardElections");
    expect(next.boardElections).toBe("The board was elected.");
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(JSON.parse(body.messages[1].content)).toEqual([{ id: "boardElections", text: "the board was elected" }]);
    expect(body.messages[1].content).not.toContain("Test Person");
    expect(mocks.execute.mock.calls[0][1]).toContain("reword:boardElections");
  });
  it("rejects blank or oversized selections before contacting Azure", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(rewordMinutes(minutes, undefined, "staffingChallenges")).rejects.toThrow("Type some text");
    await expect(rewordMinutes({ ...minutes, boardElections: "x".repeat(12001) })).rejects.toThrow("too much text");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("surfaces service errors and leaves the original text unchanged", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Unavailable", { status: 503 })));
    await expect(rewordMinutes(minutes, undefined, "boardElections")).rejects.toThrow("503");
    expect(minutes.boardElections).toBe("the board was elected");
  });
});
