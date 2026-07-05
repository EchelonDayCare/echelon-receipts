import { useEffect, useState } from "react";
import { listCommunications, type CommLogEntry } from "../../lib/comms";

const KIND_LABEL: Record<string, string> = {
  group_email: "Group Email",
  receipt: "Receipt",
  annual_receipt: "Annual Receipt",
  subsidy_stmt: "Subsidy Stmt",
  scheduled: "Scheduled",
  test: "Test",
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function History() {
  const [rows, setRows] = useState<CommLogEntry[]>([]);
  const [kind, setKind] = useState("all");
  const [status, setStatus] = useState("all");
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [detail, setDetail] = useState<CommLogEntry | null>(null);

  const refresh = () => listCommunications({ kind, status, from, to, search }).then(setRows);
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [kind, status, from, to]);

  return (
    <div style={{ padding: 24, maxWidth: 1200 }}>
      <h1 style={{ marginTop: 0 }}>Message History</h1>
      <p style={{ color: "var(--muted)", marginTop: -8 }}>
        Every email sent from this app — group emails, receipts, annual receipts, subsidy statements, and scheduled sends.
      </p>

      <div className="card" style={{ padding: 12, marginBottom: 16, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <label>Kind:
          <select value={kind} onChange={(e) => setKind(e.target.value)} style={{ marginLeft: 6 }}>
            <option value="all">All</option>
            <option value="group_email">Group email</option>
            <option value="receipt">Receipt</option>
            <option value="annual_receipt">Annual Receipt</option>
            <option value="subsidy_stmt">Subsidy statement</option>
            <option value="scheduled">Scheduled</option>
          </select>
        </label>
        <label>Status:
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ marginLeft: 6 }}>
            <option value="all">All</option>
            <option value="sent">Sent</option>
            <option value="partial">Partial</option>
            <option value="failed">Failed</option>
          </select>
        </label>
        <label>From: <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>To: <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <input placeholder="Search subject or recipient…" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === "Enter" && refresh()} style={{ padding: 6, minWidth: 220 }} />
        <button className="btn secondary" onClick={refresh}>Apply</button>
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ background: "#f8fafc", textAlign: "left" }}>
            <th style={{ padding: 8 }}>Sent</th>
            <th style={{ padding: 8 }}>Kind</th>
            <th style={{ padding: 8 }}>Subject</th>
            <th style={{ padding: 8 }}>Recipients</th>
            <th style={{ padding: 8 }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} onClick={() => setDetail(r)} style={{ borderTop: "1px solid var(--border)", cursor: "pointer" }}>
              <td style={{ padding: 8, whiteSpace: "nowrap" }}>{formatDate(r.sent_at)}</td>
              <td style={{ padding: 8 }}>{KIND_LABEL[r.kind] || r.kind}</td>
              <td style={{ padding: 8 }}>{r.subject}</td>
              <td style={{ padding: 8, color: "var(--muted)" }}>
                {r.recipient_count > 1 ? `${r.recipient_count} recipients` : r.recipients}
              </td>
              <td style={{ padding: 8 }}>
                <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 10, fontSize: 11, fontWeight: 600,
                  background: r.status === "sent" ? "#dcfce7" : r.status === "partial" ? "#fef3c7" : "#fee2e2",
                  color: r.status === "sent" ? "#166534" : r.status === "partial" ? "#92400e" : "#991b1b" }}>
                  {r.status}
                </span>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={5} style={{ padding: 24, textAlign: "center", color: "var(--muted)" }}>No messages found.</td></tr>
          )}
        </tbody>
      </table>

      {detail && (
        <div onClick={() => setDetail(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", padding: 24, borderRadius: 8, width: "90%", maxWidth: 720, maxHeight: "90vh", overflow: "auto" }}>
            <h2 style={{ marginTop: 0 }}>{detail.subject}</h2>
            <div style={{ color: "var(--muted)", fontSize: 13, marginBottom: 12 }}>
              {KIND_LABEL[detail.kind] || detail.kind} · {formatDate(detail.sent_at)} · status: {detail.status}
            </div>
            <div style={{ marginBottom: 12 }}><strong>Recipients ({detail.recipient_count}):</strong><br /><span style={{ color: "var(--muted)" }}>{detail.recipients}</span></div>
            {detail.attachment_names && (
              <div style={{ marginBottom: 12 }}><strong>Attachments:</strong> {(JSON.parse(detail.attachment_names) as string[]).join(", ")}</div>
            )}
            {detail.body && (
              <div>
                <strong>Body:</strong>
                <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit", background: "#f8fafc", padding: 12, borderRadius: 6, marginTop: 6 }}>{detail.body}</pre>
              </div>
            )}
            {detail.error && (
              <div style={{ background: "#fee2e2", color: "#991b1b", padding: 12, borderRadius: 6, marginTop: 12 }}>
                <strong>Error:</strong> {detail.error}
              </div>
            )}
            <div style={{ textAlign: "right", marginTop: 16 }}>
              <button className="btn" onClick={() => setDetail(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
