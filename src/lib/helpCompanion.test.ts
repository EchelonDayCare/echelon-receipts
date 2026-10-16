import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HELP_TOPICS, boundedHelpHistory, helpCropFromPoints, helpScreenForRoute, helpSuggestions, prepareHelpImage, searchHelp, supportsHelpSnapshot,
  type HelpTurn,
} from "./helpCompanion";
import fs from "node:fs";
import path from "node:path";

afterEach(() => vi.unstubAllGlobals());

describe("bundled feature guide", () => {
  it("has unique IDs, real static routes and meaningful instructions", () => {
    expect(new Set(HELP_TOPICS.map((topic) => topic.id)).size).toBe(HELP_TOPICS.length);
    const app = fs.readFileSync(path.resolve("src/App.tsx"), "utf8");
    for (const topic of HELP_TOPICS) {
      expect(topic.id).toMatch(/^[a-z0-9-]+$/);
      expect(topic.steps.length).toBeGreaterThan(0);
      expect(topic.title.length).toBeGreaterThan(3);
      for (const route of topic.routes) {
        expect(route).toMatch(/^\/[a-z0-9/-]*$/);
        expect(route).not.toContain("..");
        const isConfig = /^\/config\/[a-z]+$/.test(route);
        expect(route === "/" || isConfig || app.includes(`path="${route}"`), route).toBe(true);
      }
    }
  });

  it("prioritizes screen-related topics but lets every guide topic be found", () => {
    const route = HELP_TOPICS.find((topic) => topic.routes.length)?.routes[0] ?? "/";
    expect(searchHelp("", route)[0].routes).toContain(route);
    for (const topic of HELP_TOPICS) {
      expect(searchHelp(topic.title, "/").some((found) => found.id === topic.id)).toBe(true);
    }
    expect(searchHelp("zzzz-no-such-feature", "/")).toEqual([]);
    expect(searchHelp("How do I settle an outstanding balance?", "/reports/monthly").length).toBeGreaterThan(0);
  });

  it("only uses pathname context, not identifying URL parameters", () => {
    expect(helpScreenForRoute("/students/roster").filters).toEqual({});
    expect(helpScreenForRoute("/unknown").title).toBe("Echelon");
  });

  it("only offers automatic snapshots on receipt and roster screens", () => {
    expect(supportsHelpSnapshot("/reports/monthly")).toBe(true);
    expect(supportsHelpSnapshot("/students/reports")).toBe(true);
    expect(supportsHelpSnapshot("/students/roster")).toBe(true);
    expect(supportsHelpSnapshot("/staff/hours")).toBe(false);
    expect(supportsHelpSnapshot("/vault")).toBe(false);
  });
});

describe("bounded follow-up history", () => {
  it("retains at most five complete exchanges", () => {
    const turns: HelpTurn[] = Array.from({ length: 16 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user", content: String(index),
    }));
    const history = boundedHelpHistory(turns);
    expect(history).toHaveLength(10);
    expect(history[0]).toEqual({ role: "user", content: "6" });
    expect(history[9].content).toBe("15");
  });

  describe("plain-language help shortcuts", () => {
    it("suggests tasks that belong to the current screen without sending anything", () => {
      expect(helpSuggestions("/staff/hours")[1].question).toContain("ambiguous columns");
      expect(helpSuggestions("/students/attendance")[1].question).toContain("attendance sheet");
      expect(helpSuggestions("/reports/monthly")[1].question).toContain("outstanding");
      expect(helpSuggestions("/staff/credentials")[1].question).toContain("Staff Credentials");
      expect(helpSuggestions("/reports/credentials")[1].question).toContain("Staff Credentials");
      expect(helpSuggestions("/unknown")).toHaveLength(3);
    });
  });

  describe("visual screenshot selection", () => {
    it("supports dragging in either direction using original image pixels", () => {
      const dimensions = { width: 300, height: 200 };
      expect(helpCropFromPoints({ x: 15, y: 20 }, { x: 165, y: 120 }, dimensions))
        .toEqual({ x: 15, y: 20, width: 150, height: 100 });
      expect(helpCropFromPoints({ x: 165, y: 120 }, { x: 15, y: 20 }, dimensions))
        .toEqual({ x: 15, y: 20, width: 150, height: 100 });
    });

    it("clamps an out-of-bounds drag and prevents zero-sized crops", () => {
      const dimensions = { width: 300, height: 200 };
      expect(helpCropFromPoints({ x: -50, y: -10 }, { x: 500, y: 300 }, dimensions))
        .toEqual({ x: 0, y: 0, width: 300, height: 200 });
      expect(helpCropFromPoints({ x: 300, y: 200 }, { x: 300, y: 200 }, dimensions))
        .toEqual({ x: 299, y: 199, width: 1, height: 1 });
      expect(helpCropFromPoints({ x: 10.4, y: 20.2 }, { x: 10.4, y: 20.2 }, dimensions))
        .toEqual({ x: 10, y: 20, width: 1, height: 1 });
    });
  });

  it("bounds characters without retaining an orphan assistant reply", () => {
    const turns: HelpTurn[] = Array.from({ length: 10 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user", content: "x".repeat(10000),
    }));
    const history = boundedHelpHistory(turns);
    expect(history.reduce((total, turn) => total + turn.content.length, 0)).toBeLessThanOrEqual(24000);
    expect(history.every((turn) => turn.content.length <= 6000)).toBe(true);
    expect(history[0]?.role).toBe("user");
  });
});

describe("screenshot preparation", () => {
  it("rejects unsupported formats and oversized/empty files before decoding", async () => {
    await expect(prepareHelpImage(new File(["fake"], "secret.html", { type: "text/html" }))).rejects.toThrow("PNG or JPEG");
    await expect(prepareHelpImage(new File([], "empty.png", { type: "image/png" }))).rejects.toThrow("nonempty");
    await expect(prepareHelpImage(new File([new Uint8Array(4 * 1024 * 1024 + 1)], "big.png", { type: "image/png" }))).rejects.toThrow("4 MB");
  });

  it("re-encodes images and scales the longest side to 1600 pixels", async () => {
    const revoke = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: () => "blob:synthetic", revokeObjectURL: revoke });
    class SyntheticImage {
      naturalWidth = 3200;
      naturalHeight = 2400;
      onload: (() => void) | null = null;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal("Image", SyntheticImage);
    const draw = vi.fn();
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: draw }), toDataURL: () => "data:image/png;base64,c3ludGhldGlj" };
    vi.stubGlobal("document", { createElement: () => canvas });
    const image = await prepareHelpImage(new File(["synthetic"], "screen.png", { type: "image/png" }));
    expect(canvas.width).toBe(1600);
    expect(canvas.height).toBe(1200);
    expect(draw).toHaveBeenCalledOnce();
    expect(image).toEqual({ mime_type: "image/png", data_base64: "c3ludGhldGlj" });
    expect(revoke).toHaveBeenCalledWith("blob:synthetic");
  });

  it("releases object URLs after a decoding error", async () => {
    const revoke = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: () => "blob:bad", revokeObjectURL: revoke });
    class BrokenImage {
      onerror: (() => void) | null = null;
      set src(_value: string) { queueMicrotask(() => this.onerror?.()); }
    }
    vi.stubGlobal("Image", BrokenImage);
    await expect(prepareHelpImage(new File(["not an image"], "bad.png", { type: "image/png" }))).rejects.toThrow("could not be opened");
    expect(revoke).toHaveBeenCalledWith("blob:bad");
  });
});
