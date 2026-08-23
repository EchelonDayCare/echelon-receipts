import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  websitePatStatus,
  websitePatVerifyAndStore,
  websitePatDisconnect,
  type PatVerification,
} from "../../lib/website";

// PAT wizard. The token itself never lives in React state after
// verification succeeds — it goes straight into the OS keychain and
// the input field is cleared. Verification hits
// GET /repos/EchelonDayCare/echelon-website which the Rust command
// implements. On successful verify the token is stored; the frontend
// then only sees a boolean "connected" from now on.
export default function Settings() {
  const nav = useNavigate();
  const [connected, setConnected] = useState<boolean | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PatVerification | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function reload() {
    try {
      const s = await websitePatStatus();
      setConnected(s.connected);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function onVerify() {
    if (!token.trim()) {
      setErr("Paste a token first.");
      return;
    }
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      const r = await websitePatVerifyAndStore(token.trim());
      setResult(r);
      if (r.ok) {
        setToken(""); // wipe from memory
        await reload();
      }
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function onDisconnect() {
    if (!confirm("Remove the GitHub token from this device?")) return;
    setBusy(true);
    setErr(null);
    try {
      await websitePatDisconnect();
      setResult(null);
      await reload();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: 24, maxWidth: 800, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button className="btn link" onClick={() => nav("/website")} style={{ padding: 0 }}>
          ← Website
        </button>
        <h1 style={{ margin: 0 }}>GitHub connection</h1>
      </div>

      <p style={{ color: "var(--muted, #64748b)", marginTop: 8 }}>
        The Website module needs a fine-grained personal access token with{" "}
        <b>contents:write</b> permission on{" "}
        <code>EchelonDayCare/echelon-website</code>. The token is verified
        against the GitHub API and, on success, stored securely in your OS
        keychain — it never leaves this machine.
      </p>

      <section style={panelStyle}>
        <div style={{ fontSize: 14, marginBottom: 12 }}>
          Status:{" "}
          <b>
            {connected === null
              ? "…"
              : connected
              ? "Connected ✓"
              : "Not connected"}
          </b>
        </div>
        {!connected && (
          <>
            <label style={{ display: "block", fontSize: 13 }}>
              Paste your fine-grained PAT
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="github_pat_…"
                autoComplete="off"
                style={inputStyle}
              />
            </label>
            <button className="btn" onClick={onVerify} disabled={busy} style={{ marginTop: 12 }}>
              {busy ? "Verifying…" : "Verify & connect"}
            </button>
          </>
        )}
        {connected && (
          <button className="btn" onClick={onDisconnect} disabled={busy}>
            Disconnect
          </button>
        )}
      </section>

      {err && (
        <div className="home-alert tone-danger" style={{ margin: "12px 0" }}>
          ⚠ {err}
        </div>
      )}

      {result && (
        <div
          className={result.ok ? "home-alert tone-info" : "home-alert tone-danger"}
          style={{ margin: "12px 0" }}
        >
          <div>{result.message}</div>
          {result.user_login && (
            <div style={{ fontSize: 12, marginTop: 4 }}>Token owner: {result.user_login}</div>
          )}
        </div>
      )}

      <details style={{ marginTop: 24, fontSize: 13, color: "var(--muted, #64748b)" }}>
        <summary style={{ cursor: "pointer" }}>How do I create a fine-grained PAT?</summary>
        <ol style={{ marginTop: 8, lineHeight: 1.6 }}>
          <li>
            Go to GitHub → Settings → Developer settings → Personal access
            tokens → Fine-grained tokens → "Generate new token".
          </li>
          <li>
            Set <b>Repository access</b> = "Only select repositories" →{" "}
            <code>EchelonDayCare/echelon-website</code>.
          </li>
          <li>
            Set <b>Repository permissions → Contents</b> = "Read and write".
          </li>
          <li>
            Set an expiration (90 days is a good default) and generate. Copy
            the token immediately — GitHub only shows it once — and paste
            above.
          </li>
        </ol>
      </details>
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  marginTop: 16,
  padding: 16,
  borderRadius: 10,
  border: "1px solid rgba(0,0,0,0.1)",
  background: "white",
};

const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: "8px 10px",
  marginTop: 4,
  fontSize: 14,
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  borderRadius: 6,
  border: "1px solid rgba(0,0,0,0.15)",
};
