import { invoke } from "@tauri-apps/api/core";
import guide from "./helpGuide.json";

export interface HelpTopic {
  id: string;
  title: string;
  routes: string[];
  keywords: string[];
  summary: string;
  steps: string[];
  cautions: string[];
}

export interface HelpScreen {
  route: string;
  title: string;
  filters: Record<string, string>;
}

export interface HelpTurn {
  role: "user" | "assistant";
  content: string;
}

export interface HelpImage {
  mime_type: "image/jpeg" | "image/png";
  data_base64: string;
}

export interface HelpAnswer {
  answer: string;
  topic_ids: string[];
  evidence: string[];
  app_version: string;
}

export const HELP_TOPICS: readonly HelpTopic[] = guide;
export const HELP_OPEN_EVENT = "echelon:open-help";
export const HELP_CONTEXT_EVENT = "echelon:help-context";
export const MAX_HELP_IMAGES = 2;
export const MAX_HELP_IMAGE_BYTES = 4 * 1024 * 1024;
const SEARCH_STOP_WORDS = new Set(["a", "an", "and", "can", "do", "does", "how", "i", "in", "is", "my", "of", "on", "the", "to", "what", "why", "with"]);
const SNAPSHOT_ROUTES = new Set([
  "/", "/ask", "/students", "/students/roster", "/students/today", "/students/month",
  "/students/new", "/students/history", "/reports/overview", "/reports/monthly",
  "/students/reports", "/reports/aging", "/students/aging", "/reports/subsidy",
]);

export function supportsHelpSnapshot(route: string): boolean {
  return SNAPSHOT_ROUTES.has(route);
}

export function helpSuggestions(route: string): { label: string; question: string }[] {
  const topic = HELP_TOPICS.find((item) => item.routes.includes(route));
  const specific = ["/reports/aging", "/students/aging", "/reports/monthly", "/students/reports"].includes(route)
    ? { label: "Explain outstanding balances", question: "Why do outstanding balances appear, and how do I clear them safely?" }
    : route === "/staff/hours"
      ? { label: "Help me import a timesheet", question: "How do I import a staff timesheet and fix ambiguous columns?" }
      : route === "/students/attendance"
        ? { label: "Help me upload attendance", question: "How do I upload an attendance sheet and check the results before saving?" }
        : topic
          ? { label: `Walk me through ${topic.title}`, question: `Walk me through ${topic.title}, including what I should check before saving or making changes.` }
          : { label: "Find a feature", question: "How do I find the right feature for a task in this app?" };
  return [
    { label: "What can I do here?", question: "What can I do on this screen? Explain the main actions in simple terms." },
    specific,
    { label: "Explain a message or warning", question: "Can you help me understand a message or warning? Tell me what information or screenshot you need." },
  ];
}

export interface HelpCropBox { x: number; y: number; width: number; height: number }

export function helpCropFromPoints(start: { x: number; y: number }, end: { x: number; y: number },
  dimensions: { width: number; height: number }): HelpCropBox {
  const clamp = (value: number, max: number) => Math.max(0, Math.min(max, Math.round(value)));
  const x = Math.min(clamp(start.x, dimensions.width - 1), clamp(end.x, dimensions.width - 1));
  const y = Math.min(clamp(start.y, dimensions.height - 1), clamp(end.y, dimensions.height - 1));
  return {
    x, y,
    width: Math.max(1, Math.max(clamp(start.x, dimensions.width), clamp(end.x, dimensions.width)) - x),
    height: Math.max(1, Math.max(clamp(start.y, dimensions.height), clamp(end.y, dimensions.height)) - y),
  };
}

export function searchHelp(query: string, route: string): HelpTopic[] {
  const words = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word && !SEARCH_STOP_WORDS.has(word));
  return HELP_TOPICS.map((topic, index) => {
    const title = topic.title.toLowerCase();
    const text = [title, topic.summary, ...topic.keywords, ...topic.steps, ...topic.cautions].join(" ").toLowerCase();
    const matches = words.length === 0 || words.every((word) => text.includes(word));
    const score = (topic.routes.includes(route) ? 3 : 0) + words.filter((word) => title.includes(word)).length * 2;
    return { topic, matches, score, index };
  }).filter((entry) => entry.matches)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.topic);
}

export function helpScreenForRoute(route: string): HelpScreen {
  const exact = HELP_TOPICS.find((topic) => topic.routes.includes(route));
  return { route, title: exact?.title ?? "Echelon", filters: {} };
}

export function openHelp(question?: string) {
  window.dispatchEvent(new CustomEvent(HELP_OPEN_EVENT, { detail: { question } }));
}

export function boundedHelpHistory(turns: HelpTurn[]): HelpTurn[] {
  const recent = turns.slice(-10);
  while (recent[0]?.role === "assistant") recent.shift();
  const bounded: HelpTurn[] = [];
  let remaining = 24000;
  for (const turn of [...recent].reverse()) {
    const content = turn.content.slice(0, 6000);
    if (content.length > remaining) break;
    bounded.unshift({ role: turn.role, content });
    remaining -= content.length;
  }
  while (bounded[0]?.role === "assistant") bounded.shift();
  return bounded;
}

export async function askHelpCompanion(args: {
  question: string;
  history: HelpTurn[];
  screen: HelpScreen;
  images: HelpImage[];
  images_confirmed: boolean;
  include_data: boolean;
}): Promise<HelpAnswer> {
  return invoke<HelpAnswer>("ask_help_companion", { args });
}

export async function prepareHelpImage(file: File): Promise<HelpImage> {
  if (!["image/png", "image/jpeg"].includes(file.type)) {
    throw new Error("Choose a PNG or JPEG screenshot.");
  }
  if (file.size === 0 || file.size > MAX_HELP_IMAGE_BYTES) {
    throw new Error("Each screenshot must be nonempty and no larger than 4 MB.");
  }
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("This screenshot could not be opened. Try a different PNG or JPEG."));
      img.src = objectUrl;
    });
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 25_000_000) {
      throw new Error("Screenshot is too large. Crop it to the part you need help with.");
    }
    const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Screenshot preparation is unavailable on this device.");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL("image/png");
    const base64 = data.slice(data.indexOf(",") + 1);
    if (base64.length > Math.ceil(MAX_HELP_IMAGE_BYTES / 3) * 4) {
      throw new Error("Screenshot is too large after processing. Crop it and try again.");
    }
    return { mime_type: "image/png", data_base64: base64 };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
