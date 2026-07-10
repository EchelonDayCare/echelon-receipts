import { useNavigate } from "react-router-dom";

/**
 * Floating settings gear pinned to the bottom-right of every screen
 * (except the Configuration section itself). Mirrors the NotificationBell
 * aesthetic — same border, radius, and hover feel — so the two "utility
 * corner buttons" feel like siblings.
 */
export default function SettingsFab({ size = 40 }: { size?: number }) {
  const nav = useNavigate();
  const padding = Math.max(8, Math.round(size * 0.55));

  return (
    <button
      onClick={() => nav("/config/identity")}
      aria-label="Open configuration"
      title="Configuration"
      style={{
        position: "fixed",
        bottom: 24,
        right: 28,
        zIndex: 900,
        background: "var(--panel, #fff)",
        border: "1px solid var(--border)",
        borderRadius: 12,
        padding: `${padding}px ${padding + 2}px`,
        cursor: "pointer",
        fontSize: size,
        lineHeight: 1,
        boxShadow: "0 6px 20px -8px rgba(15, 23, 42, 0.35)",
        transition: "transform 160ms ease-out, box-shadow 160ms ease-out",
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
      <span aria-hidden>⚙️</span>
    </button>
  );
}
