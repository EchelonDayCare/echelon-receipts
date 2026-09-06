import { useState } from "react";
import DataCleanupModal from "./DataCleanupModal";

// Icon button that sits in the fixed top-right stack, right under the
// lock button. Opens the Data Cleanup modal so an owner can permanently
// clear test/dummy data (students, receipts, attendance, waitlist,
// expenses) before a real launch — without ever touching Settings,
// Security, templates, or Website config.
export default function DataCleanupButton({ size = 40 }: { size?: number }) {
  const [open, setOpen] = useState(false);
  const padding = Math.max(8, Math.round(size * 0.55));

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Clear test data"
        title="Clear test data"
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
        <span aria-hidden style={{ fontSize: size, lineHeight: 1 }}>🧹</span>
      </button>
      {open && <DataCleanupModal onClose={() => setOpen(false)} />}
    </>
  );
}
