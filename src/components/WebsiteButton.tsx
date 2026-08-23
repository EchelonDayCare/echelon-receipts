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

  return (
    <button
      type="button"
      onClick={() => nav("/website")}
      aria-label="Open Website CMS"
      title="Website"
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        border: "1px solid #e3e6ee",
        background: "#fff",
        color: "#1a1f36",
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        boxShadow: "0 1px 3px rgba(15,23,42,0.08)",
        transition: "background 160ms ease-out, transform 160ms ease-out",
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "#f6f7fb"; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "#fff"; }}
    >
      <svg
        width={Math.round(size * 0.55)}
        height={Math.round(size * 0.55)}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18" />
        <path d="M12 3a14 14 0 0 1 0 18" />
        <path d="M12 3a14 14 0 0 0 0 18" />
      </svg>
    </button>
  );
}
