import { FormEvent, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { apiClient, RequestError } from "../api";

export default function SignIn() {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<"email" | "code">("email");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const [params] = useSearchParams();

  async function requestCode(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiClient.requestCode(email);
      setStage("code");
    } catch (err) {
      setError(err instanceof RequestError ? err.message : "Something went wrong — try again.");
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await apiClient.verifyCode(email, code);
      localStorage.setItem("dg_email", res.account.email);
      navigate("/");
    } catch (err) {
      setError(err instanceof RequestError ? err.message : "Something went wrong — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center">
      <h1 className="page">
        Draft <span style={{ color: "var(--color-accent)" }}>Genie</span>
      </h1>
      <div className="card">
        <h2>Sign in</h2>
        <p className="muted">
          No password — we email you a 6-digit code (or tap the link in the email).
        </p>
        {params.get("error") === "expired_link" && (
          <div className="banner error">That sign-in link expired — request a new one.</div>
        )}
        {error && <div className="banner error">{error}</div>}
        {stage === "email" ? (
          <form onSubmit={requestCode}>
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <div className="actions">
              <button disabled={busy || !email}>Send code</button>
            </div>
          </form>
        ) : (
          <form onSubmit={verify}>
            <p className="muted">
              Code sent to <strong>{email}</strong>. It's valid for 10 minutes.
            </p>
            <label htmlFor="code">6-digit code</label>
            <input
              id="code"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
            />
            <div className="actions">
              <button disabled={busy || code.length !== 6}>Sign in</button>
              <button type="button" className="secondary" onClick={() => setStage("email")}>
                Different email
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
