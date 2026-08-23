import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  websiteListMedia,
  websiteReplaceLogo,
  websiteReplaceOgImage,
  websiteWorkingCopyStatus,
  type MediaRecord,
} from "../../lib/website";

// Assets screen — manage the site logo, favicons, and OG image (v3.20.0 PR 3).
//
// Replace-logo also regenerates the 16/32/180 px favicon PNGs, so we
// don't expose a separate "replace favicon" button here — the intent
// is the daycare uploads one logo and everything else follows.

export default function Assets() {
  const nav = useNavigate();
  const [repoRoot, setRepoRoot] = useState<string | null>(null);
  const [logo, setLogo] = useState<MediaRecord | null>(null);
  const [og, setOg] = useState<MediaRecord | null>(null);
  const [favicons, setFavicons] = useState<MediaRecord[]>([]);
  const [busy, setBusy] = useState<"logo" | "og" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setErr(null);
    try {
      const [wc, logos, ogs, favs] = await Promise.all([
        websiteWorkingCopyStatus(),
        websiteListMedia("logo"),
        websiteListMedia("og_image"),
        websiteListMedia("favicon"),
      ]);
      setRepoRoot(wc.root);
      setLogo(logos.length > 0 ? logos[logos.length - 1] : null);
      setOg(ogs.length > 0 ? ogs[ogs.length - 1] : null);
      setFavicons(favs);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function assetUrl(rec: MediaRecord | null, filename?: string): string | null {
    if (!repoRoot) return null;
    const pick = filename ?? rec?.variants[0]?.filename;
    if (!pick) return null;
    const absPath = `${repoRoot}/repo/assets/img/${pick}`;
    return convertFileSrc(absPath);
  }

  async function pickAndReplaceLogo() {
    const picked = await open({
      multiple: false,
      filters: [
        {
          name: "Logo image",
          extensions: ["png", "jpg", "jpeg", "webp", "svg"],
        },
      ],
    });
    const path = pathFromDialog(picked);
    if (!path) return;
    setBusy("logo");
    setErr(null);
    setMsg(null);
    try {
      await websiteReplaceLogo(path);
      setMsg("Logo replaced. Favicons regenerated from the same source.");
      await refresh();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  async function pickAndReplaceOg() {
    const picked = await open({
      multiple: false,
      filters: [
        {
          name: "OG image",
          extensions: ["png", "jpg", "jpeg", "webp"],
        },
      ],
    });
    const path = pathFromDialog(picked);
    if (!path) return;
    setBusy("og");
    setErr(null);
    setMsg(null);
    try {
      await websiteReplaceOgImage(path);
      setMsg("OG image replaced (cropped to 1200×630).");
      await refresh();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  const logoThumb = assetUrl(logo);
  const ogThumb = og
    ? assetUrl(og, og.variants[0]?.filename ?? "og-image.png")
    : null;

  return (
    <div style={{ padding: 24, maxWidth: 1000, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button className="btn link" onClick={() => nav("/website")} style={{ padding: 0 }}>
          ← Website
        </button>
        <h1 style={{ margin: 0 }}>Site assets</h1>
      </div>
      <p style={{ color: "var(--muted, #64748b)", marginTop: 8 }}>
        Manage the logo, favicons, and Open Graph share image. Replacing
        the logo automatically regenerates the 16 × 16, 32 × 32, and
        180 × 180 px favicon PNGs from the same source image.
      </p>

      {err && (
        <div className="home-alert tone-danger" style={{ margin: "12px 0" }}>
          ⚠ {err}
        </div>
      )}
      {msg && (
        <div className="home-alert tone-info" style={{ margin: "12px 0" }}>
          ✓ {msg}
        </div>
      )}

      <section style={panelStyle}>
        <h3 style={{ marginTop: 0 }}>Logo</h3>
        <div style={{ display: "flex", gap: 20, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div
            style={{
              width: 240,
              minHeight: 160,
              padding: 12,
              border: "1px solid rgba(0,0,0,0.1)",
              borderRadius: 10,
              background: "#f8fafc",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {logoThumb ? (
              <img
                src={logoThumb}
                alt="current logo"
                style={{ maxWidth: "100%", maxHeight: 160, objectFit: "contain" }}
              />
            ) : (
              <span style={{ color: "#94a3b8", fontSize: 13 }}>No logo uploaded yet</span>
            )}
          </div>
          <div style={{ flex: 1, minWidth: 240 }}>
            <p style={{ fontSize: 13, color: "#64748b", margin: "0 0 12px" }}>
              {logo
                ? `${logo.source_filename} · ${logo.width}×${logo.height}px`
                : "Upload a square-ish source image (at least 512×512px) so favicons are crisp on retina displays."}
            </p>
            <button
              className="btn"
              onClick={pickAndReplaceLogo}
              disabled={busy !== null}
            >
              {busy === "logo" ? "Uploading…" : logo ? "Replace logo…" : "Upload logo…"}
            </button>
          </div>
        </div>
        {favicons.length > 0 && (
          <div style={{ marginTop: 14, fontSize: 12, color: "#64748b" }}>
            Favicons on disk:{" "}
            {(favicons[favicons.length - 1]?.variants || [])
              .map((v) => `${v.width}×${v.width} → ${v.filename}`)
              .join(", ") || "—"}
          </div>
        )}
      </section>

      <section style={panelStyle}>
        <h3 style={{ marginTop: 0 }}>Open Graph image</h3>
        <div style={{ display: "flex", gap: 20, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div
            style={{
              width: 320,
              height: 168,
              border: "1px solid rgba(0,0,0,0.1)",
              borderRadius: 10,
              background: "#f8fafc",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              overflow: "hidden",
            }}
          >
            {ogThumb ? (
              <img
                src={ogThumb}
                alt="OG image"
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
              />
            ) : (
              <span style={{ color: "#94a3b8", fontSize: 13 }}>No OG image uploaded yet</span>
            )}
          </div>
          <div style={{ flex: 1, minWidth: 240 }}>
            <p style={{ fontSize: 13, color: "#64748b", margin: "0 0 12px" }}>
              Displayed on Facebook, LinkedIn, and Slack when the site
              is shared. The image is cropped and resized to 1200 × 630 px.
            </p>
            <button
              className="btn"
              onClick={pickAndReplaceOg}
              disabled={busy !== null}
            >
              {busy === "og" ? "Uploading…" : og ? "Replace OG image…" : "Upload OG image…"}
            </button>
          </div>
        </div>
      </section>

      <section style={panelStyle}>
        <h3 style={{ marginTop: 0 }}>Favicons</h3>
        <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>
          Favicons are regenerated automatically from the logo. There's
          nothing to manage here — replace the logo above to update the
          16 × 16, 32 × 32, and 180 × 180 px PNGs.
        </p>
      </section>
    </div>
  );
}

function pathFromDialog(picked: unknown): string | null {
  if (picked == null) return null;
  if (Array.isArray(picked)) {
    for (const p of picked) {
      if (typeof p === "string") return p;
      const s = (p as { path?: string }).path;
      if (typeof s === "string") return s;
    }
    return null;
  }
  if (typeof picked === "string") return picked;
  const single = (picked as { path?: string }).path;
  return typeof single === "string" ? single : null;
}

const panelStyle: React.CSSProperties = {
  border: "1px solid rgba(0,0,0,0.1)",
  borderRadius: 12,
  background: "white",
  padding: 20,
  marginTop: 18,
};
