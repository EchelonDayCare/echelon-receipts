// Lightweight version checker. Hits GitHub Releases API once per 24h max
// (cached via settings). No keys, no autoupdate, no ed25519 signing —
// just shows a banner with a download link if a newer tag is published.
import { getSettings, setSettings } from "./db";
import { logError } from "./errorLog";

const REPO = "EchelonDayCare/echelon-receipts";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 day

export interface UpdateStatus {
  current: string;
  latest: string | null;
  url: string | null;
  hasUpdate: boolean;
}

// "0.1.0" / "v0.1.0" → [0,1,0]
function parse(v: string): number[] {
  return v.replace(/^v/, "").split(/[.-]/).map((p) => {
    const n = parseInt(p, 10);
    return isNaN(n) ? 0 : n;
  });
}

function isNewer(latest: string, current: string): boolean {
  const a = parse(latest), b = parse(current);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i] ?? 0, bi = b[i] ?? 0;
    if (ai > bi) return true;
    if (ai < bi) return false;
  }
  return false;
}

export async function checkForUpdates(currentVersion: string, force = false): Promise<UpdateStatus> {
  const fallback: UpdateStatus = { current: currentVersion, latest: null, url: null, hasUpdate: false };
  const s = await getSettings();
  const last = parseInt(s["last_update_check_at"] || "0", 10);
  const cachedTag = s["last_update_tag"] || "";
  const cachedUrl = s["last_update_url"] || "";

  if (!force && cachedTag && Date.now() - last < CHECK_INTERVAL_MS) {
    return {
      current: currentVersion,
      latest: cachedTag,
      url: cachedUrl || null,
      hasUpdate: isNewer(cachedTag, currentVersion),
    };
  }

  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return fallback;
    const data = await res.json();
    const tag = (data.tag_name as string) || "";
    const url = (data.html_url as string) || `https://github.com/${REPO}/releases`;
    await setSettings({
      last_update_check_at: String(Date.now()),
      last_update_tag: tag,
      last_update_url: url,
    });
    return { current: currentVersion, latest: tag || null, url, hasUpdate: tag ? isNewer(tag, currentVersion) : false };
  } catch (e: any) {
    void logError("WARN", `update check failed: ${e?.message || e}`);
    return fallback;
  }
}
