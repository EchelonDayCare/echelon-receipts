import { useNavigate } from "react-router-dom";
import { useHomeAlerts } from "../hooks/useHomeAlerts";
import AlertDot from "./AlertDot";

/**
 * Floating settings gear pinned to the bottom-right of the Home screen
 * only. Mirrors the NotificationBell aesthetic — same border, radius,
 * and hover feel — so the two "utility corner buttons" feel like siblings.
 *
 * Renders a small badge dot when a setup gap exists (SMTP not configured,
 * cloud backup unconfigured or overdue). See lib/homeAlerts.ts.
 */
export default function SettingsFab({ size = 40 }: { size?: number }) {
  const nav = useNavigate();
  const { snapshot } = useHomeAlerts();
  const padding = Math.max(8, Math.round(size * 0.55));
  const needsSetup = snapshot.setup.needsSetup;
  const setupTone = snapshot.setup.items.some((i) => i.tone === "danger")
    ? "danger"
    : snapshot.setup.items.some((i) => i.tone === "warn")
      ? "warn"
      : "info";
  const setupTitle = needsSetup
    ? snapshot.setup.items.map((i) => `• ${i.text}`).join("\n")
    : undefined;

  return (
    <button
      onClick={() => nav("/config/identity")}
      aria-label={needsSetup ? "Open configuration (setup needed)" : "Open configuration"}
      title={setupTitle ?? "Configuration"}
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
      <span aria-hidden style={{ display: "inline-block" }}>⚙️</span>
      {needsSetup && (
        <AlertDot
          tone={setupTone}
          size="md"
          count={snapshot.setup.items.length}
          title={setupTitle}
          // Anchored to the button (position:fixed establishes the
          // containing block), not the emoji glyph — emoji bounding boxes
          // vary across Windows/macOS/Linux, so pegging the badge to
          // button geometry keeps it stable everywhere. Offset outside
          // the top-right corner so the pill reads as a notification
          // badge, matching the tile-dot placement on Home.
          style={{ position: "absolute", top: -6, right: -6 }}
        />
      )}
    </button>
  );
}
