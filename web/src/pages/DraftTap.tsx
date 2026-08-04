import { useEffect, useState } from "react";
import { apiClient, type TapPairing } from "../api";

// 010 T037/T038/T039 — install, pair, revoke, and verify without a draft.
//
// The token is shown ONCE: only its hash is stored, so it cannot be shown
// again. Revoking is always available, and never touches the ESPN account.

const TAP_URL = "/draft-tap.user.js";

export default function DraftTap() {
  const [pairings, setPairings] = useState<TapPairing[]>([]);
  const [fresh, setFresh] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState<"unknown" | "ok" | "failed">("unknown");

  const load = () => apiClient.listTapPairings().then((r) => setPairings(r.pairings));
  useEffect(() => {
    void load();
  }, []);

  async function create() {
    setBusy(true);
    try {
      const r = await apiClient.createTapPairing();
      setFresh(r.token);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setBusy(true);
    try {
      await apiClient.revokeTapPairing(id);
      await load();
    } finally {
      setBusy(false);
    }
  }

  // SC-006: confirm the tap can reach Draft Genie without waiting for a draft.
  async function checkHealth() {
    try {
      const res = await fetch("/api/tap/health");
      setHealth(res.ok ? "ok" : "failed");
    } catch {
      setHealth("failed");
    }
  }

  return (
    <div>
      <h1 className="page">Draft tap</h1>

      <div className="card">
        <p>
          ESPN does not publish draft picks while a draft is running — they exist only in the draft-room tab
          your own browser already has open. The draft tap is a small userscript that relays those picks to
          Draft Genie. It never connects to ESPN, never joins your draft, and can only send.
        </p>
        <p className="muted small">
          <strong>Desktop Chrome only.</strong> If you draft from an iPad, a phone, or the ESPN mobile app,
          live monitoring will not work — Draft Genie will say so rather than showing you a stale board.
        </p>
      </div>

      <div className="card">
        <h2>1. Install</h2>
        <ol>
          <li>
            Install <a href="https://www.tampermonkey.net/" target="_blank" rel="noreferrer">Tampermonkey</a> for Chrome.
          </li>
          <li>
            Turn on <strong>Allow user scripts</strong> at <code>chrome://extensions</code> — it defaults to{" "}
            <strong>off</strong> for new installs, and the script silently never runs without it.
          </li>
          <li>
            Open <a href={TAP_URL}>the draft tap</a> — Tampermonkey will offer to install it.
          </li>
        </ol>
        <p className="muted small">
          Before draft day, use Tampermonkey&apos;s <em>Check for userscript updates</em>. Script managers check on
          their own schedule, so a fix published today may not reach you automatically.
        </p>
      </div>

      <div className="card">
        <h2>2. Pair this browser</h2>
        {fresh ? (
          <>
            <p>
              Copy this token, then in the ESPN draft room open the Tampermonkey menu and choose{" "}
              <em>Draft Genie: paste pairing token</em>.
            </p>
            <pre className="token">{fresh}</pre>
            <p className="muted small">
              Shown once — only its hash is stored, so it cannot be displayed again. Create a new one if you
              lose it.
            </p>
          </>
        ) : (
          <button onClick={create} disabled={busy}>
            Create pairing token
          </button>
        )}
      </div>

      <div className="card">
        <h2>3. Check it works</h2>
        <button onClick={checkHealth} disabled={busy}>
          Test connection
        </button>{" "}
        {health === "ok" && <span>Draft Genie is reachable.</span>}
        {health === "failed" && <span>Could not reach Draft Genie.</span>}
        <p className="muted small">
          This confirms the ingest is up. To confirm the tap itself is attached, open your ESPN draft room and
          look for the Draft Genie badge in the corner. If ESPN changes something mid-season, the{" "}
          <a href="/draft-tap/self-test">self-test</a> replays a saved capture through the tap&apos;s own decode
          and privacy filter without needing a draft.
        </p>
      </div>

      <div className="card">
        <h2>Paired browsers</h2>
        {pairings.length === 0 && <p className="muted">None yet.</p>}
        <ul className="plain">
          {pairings.map((p) => (
            <li key={p.id}>
              <span>
                created {new Date(p.created_at).toLocaleDateString()}
                {p.last_used_at ? ` · last used ${new Date(p.last_used_at).toLocaleString()}` : " · never used"}
                {p.bound ? " · bound to one browser" : ""}
                {p.revoked ? " · revoked" : ""}
              </span>{" "}
              {!p.revoked && (
                <button onClick={() => revoke(p.id)} disabled={busy}>
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
        <p className="muted small">Revoking stops the relay immediately. It does not affect your ESPN account.</p>
      </div>
    </div>
  );
}
