import { useEffect, useRef, useState } from "react";

interface Props {
  items: { label: string; onClick: () => void; disabled?: boolean; danger?: boolean; title?: string }[];
}

export default function RowMenu({ items }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className="rowmenu" ref={ref}>
      <button className="btn ghost rowmenu-trigger"
        aria-label="More actions" aria-expanded={open}
        onClick={() => setOpen(o => !o)}>⋯</button>
      {open && (
        <div className="rowmenu-pop" role="menu">
          {items.map((it, i) => (
            <button key={i}
              role="menuitem"
              className={"rowmenu-item" + (it.danger ? " danger" : "")}
              disabled={it.disabled}
              title={it.title}
              onClick={() => { setOpen(false); it.onClick(); }}>
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
