import { useNavigate } from "react-router-dom";
import type { ReactElement } from "react";

// Gallery landing (v3.23.0): chooser between Photos and Videos, mirroring
// the site-side /gallery chooser page. This is the target of the sidebar
// "Gallery" nav item and of the Gallery tile on the main Website screen.
export default function GalleryLanding() {
  const nav = useNavigate();

  const tiles: Array<{
    key: "photos" | "videos";
    to: string;
    label: string;
    desc: string;
    accent: string;
    icon: ReactElement;
  }> = [
    {
      key: "photos",
      to: "/website/gallery-photos",
      label: "Photos",
      desc: "Upload, reorder, caption, and moderate site photos.",
      accent: "linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)",
      icon: (
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <circle cx="8.5" cy="10" r="1.5" />
          <path d="M21 15l-5-5-9 9" />
        </svg>
      ),
    },
    {
      key: "videos",
      to: "/website/gallery-videos",
      label: "Videos",
      desc: "Upload gallery videos with AI-suggested titles and drag-to-reorder playlist.",
      accent: "linear-gradient(135deg, #0ea5e9 0%, #6366f1 100%)",
      icon: (
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="M10 9l5 3-5 3V9z" fill="white" stroke="white" />
        </svg>
      ),
    },
  ];

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <button className="btn link" onClick={() => nav("/website")} style={{ padding: 0 }}>
          ← Website
        </button>
        <h1 style={{ margin: 0 }}>Gallery</h1>
        <div style={{ marginLeft: "auto" }}>
          <button className="btn" onClick={() => nav("/website/preview?page=gallery")}>
            Preview →
          </button>
        </div>
      </div>

      <p style={{ color: "var(--muted, #64748b)", marginTop: 0, marginBottom: 24 }}>
        Visitors see a chooser between Photos and Videos. Pick a section to manage its content.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          gap: 20,
        }}
      >
        {tiles.map((t) => (
          <button
            key={t.key}
            onClick={() => nav(t.to)}
            style={{
              textAlign: "left",
              padding: 0,
              borderRadius: 14,
              border: "1px solid rgba(0,0,0,0.08)",
              background: "white",
              cursor: "pointer",
              overflow: "hidden",
              boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
              transition: "transform 160ms ease-out, box-shadow 160ms ease-out",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = "translateY(-2px)";
              e.currentTarget.style.boxShadow = "0 10px 24px rgba(15,23,42,0.12)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = "translateY(0)";
              e.currentTarget.style.boxShadow = "0 1px 2px rgba(0,0,0,0.04)";
            }}
          >
            <div
              style={{
                height: 140,
                background: t.accent,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {t.icon}
            </div>
            <div style={{ padding: 18 }}>
              <div style={{ fontWeight: 600, fontSize: 17 }}>{t.label}</div>
              <div style={{ fontSize: 13, color: "var(--muted, #64748b)", marginTop: 6, lineHeight: 1.5 }}>
                {t.desc}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
