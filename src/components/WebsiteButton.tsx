import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { isWebsiteCmsEnabled } from "../lib/website";

// Round globe button that sits in the fixed top-right stack next to the
// notification bell and lock button on the Home screen. Replaces the
// "Website" home tile so the CMS shortcut lives with the other utility
// icons instead of taking a full tile slot.
export default function WebsiteButton({ size = 40 }: { size?: number }) {
  const nav = useNavigate();
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    isWebsiteCmsEnabled()
      .then((v) => { if (!cancelled) setEnabled(v); })
      .catch(() => { if (!cancelled) setEnabled(false); });
    return () => { cancelled = true; };
  }, []);

  if (!enabled) return null;

  const padding = Math.max(8, Math.round(size * 0.55));

  return (
    <button
      type="button"
      onClick={() => nav("/website")}
      aria-label="Open Website CMS"
      title="Website"
      style={{
        background: "var(--panel, #fff)",
        border: "1px solid var(--border)",
        borderRadius: 12,
        padding: `${padding}px ${padding + 2}px`,
        color: "#1a1f36",
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        lineHeight: 1,
        boxShadow: "0 6px 20px -8px rgba(15, 23, 42, 0.35)",
        transition: "transform 160ms ease-out, box-shadow 160ms ease-out, background 160ms ease-out",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.transform = "translateY(-2px)";
        (e.currentTarget as HTMLButtonElement).style.boxShadow =
          "0 10px 24px -8px rgba(15, 23, 42, 0.45)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.transform = "translateY(0)";
        (e.currentTarget as HTMLButtonElement).style.boxShadow =
          "0 6px 20px -8px rgba(15, 23, 42, 0.35)";
      }}
    >
      <span aria-hidden style={{ fontSize: size, lineHeight: 1 }}>🌐</span>
    </button>
  );
}
