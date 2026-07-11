// v2.6.1 alert-dot primitive.
//
// Two sizes: `sm` (sidebar sub-items, ~7px) and `md` (home tiles, ~10px
// with an inline count when >1). Colors driven by tone. Purely visual —
// consumers wire the tooltip text.

import type { CSSProperties } from "react";
import type { Tone } from "../lib/homeAlerts";

const TONE_COLOR: Record<Tone, string> = {
  danger: "#dc2626",
  warn:   "#d97706",
  info:   "#2563eb",
};

export function AlertDot({
  tone,
  size = "sm",
  count,
  title,
  style,
}: {
  tone: Tone;
  size?: "sm" | "md";
  /** If provided and > 1, renders as a count pill instead of a bare dot. */
  count?: number;
  title?: string;
  style?: CSSProperties;
}) {
  const color = TONE_COLOR[tone];
  const showCount = typeof count === "number" && count > 1;
  const isMd = size === "md";

  if (showCount) {
    return (
      <span
        aria-label={title}
        title={title}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          minWidth: isMd ? 18 : 14,
          height: isMd ? 18 : 14,
          padding: isMd ? "0 5px" : "0 4px",
          borderRadius: 999,
          background: color,
          color: "#fff",
          fontSize: isMd ? 11 : 10,
          fontWeight: 700,
          lineHeight: 1,
          boxShadow: "0 0 0 2px var(--panel, #fff)",
          ...style,
        }}
      >
        {count}
      </span>
    );
  }

  const dim = isMd ? 10 : 7;
  return (
    <span
      aria-label={title}
      title={title}
      style={{
        display: "inline-block",
        width: dim,
        height: dim,
        borderRadius: "50%",
        background: color,
        boxShadow: "0 0 0 2px var(--panel, #fff)",
        ...style,
      }}
    />
  );
}

export default AlertDot;
