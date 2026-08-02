import { FormEvent, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { apiClient, CredentialState, RequestError } from "../api";
import { relativeAge } from "../lib/time";

export default function CredentialSetup() {
  const [current, setCurrent] = useState<CredentialState | null>(null);
  const [espnS2, setEspnS2] = useState("");
  const [swid, setSwid] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    void apiClient.getCredentials().then(setCurrent).catch(() => {});
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const res = await apiClient.putCredentials(espnS2, swid);
      setSaved(
        res.leagues_revalidated > 0
          ? `Cookies saved (${res.swid_masked}); ${res.leagues_revalidated} league(s) re-validated.`
          : `Cookies saved and verified with ESPN (${res.swid_masked}).`,
      );
      setEspnS2("");
      setSwid("");
      const fresh = await apiClient.getCredentials();
      setCurrent(fresh);
      if (res.leagues_revalidated === 0) setTimeout(() => navigate("/connect"), 900);
    } catch (err) {
      setError(err instanceof RequestError ? err.message : "Something went wrong — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1 className="page">ESPN connection</h1>
      {current?.present && (
        <div className="card">
          <div className="row">
            <div>
              Stored cookies: <strong>{current.swid_masked}</strong>{" "}
              <span className={`badge ${current.status === "working" ? "ok" : "failed"}`}>
                {current.status === "working" ? "working" : "needs refresh"}
              </span>
            </div>
            <div className="muted small">last verified {relativeAge(current.last_validated_at)}</div>
          </div>
          {current.status === "failing" && (
            <p className="muted small">
              ESPN stopped accepting these cookies — paste fresh values below. Your leagues and
              settings are untouched.
            </p>
          )}
        </div>
      )}
      <div className="card">
        <h2>How to get your two ESPN cookies</h2>
        <ol className="steps">
          <li>
            Sign in at <strong>fantasy.espn.com</strong> in a desktop browser.
          </li>
          <li>
            Open developer tools (⌥⌘I on Mac / F12 elsewhere) → <strong>Application</strong> (Chrome)
            or <strong>Storage</strong> (Firefox/Safari) → Cookies → espn.com.
          </li>
          <li>
            Copy the value of <strong>espn_s2</strong> (long) and <strong>SWID</strong> (looks like{" "}
            {"{XXXXXXXX-…}"}). Extra quotes or missing braces are fine — we clean them up.
          </li>
          <li>Draft Genie only reads your leagues. It never asks for your ESPN password.</li>
        </ol>
      </div>
      <div className="card">
        <h2>{current?.present ? "Replace cookies" : "Paste cookies"}</h2>
        {error && <div className="banner error">{error}</div>}
        {saved && <div className="banner warn">{saved}</div>}
        <form onSubmit={save}>
          <label htmlFor="s2">espn_s2</label>
          <input id="s2" value={espnS2} onChange={(e) => setEspnS2(e.target.value)} required />
          <label htmlFor="swid">SWID</label>
          <input id="swid" value={swid} onChange={(e) => setSwid(e.target.value)} required />
          <div className="actions">
            <button disabled={busy || !espnS2 || !swid}>Verify &amp; save</button>
            <Link to="/">
              <button type="button" className="secondary">
                Back to dashboard
              </button>
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}
