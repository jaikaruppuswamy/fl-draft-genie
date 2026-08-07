import { useEffect, useState } from "react";
import { tapStateOf } from "../lib/observableState";
import { REDEEM_COPY, REFUSAL_COPY, type RedeemFailure, type RefusalReason } from "../../../tap/enable";

/**
 * The reason the tap gave, in words. Both maps live with the gate that produces
 * the reasons, so a new reason cannot be added without copy — and this is the
 * only surface that can show them: on Draft Genie's own origin the script
 * mounts no badge and registers no menu.
 */
function refusalCopy(reason: string | undefined): string {
  if (!reason) return "That didn't work. Reload the page and try again.";
  return (
    REFUSAL_COPY[reason as RefusalReason] ??
    REDEEM_COPY[reason as RedeemFailure] ??
    "That didn't work. Reload the page and try again."
  );
}
import { apiClient, type TapPairing } from "../api";

// 010 T037/T038/T039 — install, enable, revoke, and verify without a draft.
//
// 011 US3 replaced pairing with one acknowledgement. The old flow asked the
// owner to copy a 180-day bearer out of this page and paste it into a prompt()
// on ESPN's site — which meant rendering a credential into the DOM, where any
// same-origin script could read it, and making a person responsible for
// handling it. FR-017 forbids both.
//
// Now: the page asks the script for a commitment, sends the HASH to the server
// under session auth, and hands back an opaque claim. The script redeems it
// with the preimage the page never had. The credential reaches the extension
// and nothing else — this page never sees one, and there is nothing here to
// copy, show or lose.

const TAP_URL = "/draft-tap.user.js";

const TAP_LABEL: Record<string, string> = {
  not_installed: "Not installed",
  installed_not_enabled: "Installed, not enabled",
  enabled_idle: "Enabled, idle",
  relaying: "Relaying",
  unknown: "Can't tell",
};

export default function DraftTap() {
  const [pairings, setPairings] = useState<TapPairing[]>([]);
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState<"unknown" | "ok" | "failed">("unknown");
  const [enableMsg, setEnableMsg] = useState<string | null>(null);
  // The script stamps this at document-start, before React mounts — so there is
  // no ping, no pong and no race. Read once on mount.
  const [scriptVersion] = useState<string | null>(() =>
    document.documentElement.getAttribute("data-dg-tap"),
  );

  const load = () => apiClient.listTapPairings().then((r) => setPairings(r.pairings));

  // Decided in a pure module, merely rendered here — same discipline as the
  // draft room. `scriptDetected: null` is honest: until the userscript matches
  // this origin (011 T027) the page cannot tell "not installed" from "installed
  // but never enabled", and guessing between them is what sends someone to
  // re-do setup that was already working.
  const tapState = tapStateOf({
    // A real answer at last. Before the script matched this origin the page
    // genuinely could not tell "not installed" from "installed but never
    // enabled", and guessing between them is what sends someone to re-do setup
    // that was already working.
    scriptDetected: scriptVersion !== null,
    enablements: pairings.map((p) => ({
      lastUsedAt: p.last_used_at,
      revoked: p.revoked,
      // Passed through, not discarded: an enablement lasts 180 days and a season
      // is longer, so expiry is the ordinary way one ends.
      expiresAt: p.expires_at,
    })),
    nowMs: Date.now(),
  });
  useEffect(() => {
    void load();
  }, []);

  /**
   * One acknowledgement (FR-016).
   *
   * The page's whole role: relay a hash to the server and an opaque claim back
   * to the script. It never holds a credential, so there is nothing here for a
   * same-origin script to steal and nothing for the owner to handle.
   *
   * The click itself is not simulated anywhere — the script is listening for a
   * genuine one on this very button, and refuses anything else (FR-018).
   */
  async function enable() {
    if (scriptVersion === null) {
      setEnableMsg("Draft Genie can't see the draft tap in this browser. Install it above, then reload.");
      return;
    }
    setBusy(true);
    setEnableMsg(null);

    const done = new Promise<void>((resolve) => {
      const onCommit = (ev: Event) => {
        const commit = (ev as CustomEvent).detail?.commit as string | undefined;
        if (!commit) return;
        apiClient
          .enableTapClaim(commit)
          .then((r) =>
            document.dispatchEvent(
              new CustomEvent("dg:enable-claim", { detail: { claimId: r.claim_id, commit } }),
            ),
          )
          .catch(() => setEnableMsg("Draft Genie couldn't start that. Try again."));
      };
      const onResult = (ev: Event) => {
        const d = (ev as CustomEvent).detail as { ok: boolean; reason?: string } | null;
        // FR-021: say WHY, and what to do about it. Fifteen reasons are computed
        // in `tap/enable.ts` and every one of them was being collapsed into
        // "that didn't work" — on the one surface that can show them, since the
        // script mounts no badge and no menu on this origin.
        setEnableMsg(d?.ok ? null : refusalCopy(d?.reason));
        cleanup();
        void load().then(resolve);
      };
      const cleanup = () => {
        document.removeEventListener("dg:tap-commit", onCommit);
        document.removeEventListener("dg:enable-result", onResult);
      };
      document.addEventListener("dg:tap-commit", onCommit);
      document.addEventListener("dg:enable-result", onResult);
      // Bounded: if the extension never answers, say so rather than spinning.
      window.setTimeout(() => {
        cleanup();
        setEnableMsg((m) => m ?? "The draft tap didn't respond. Reload the page and try again.");
        resolve();
      }, 8000);
    });

    await done;
    setBusy(false);
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
        <h2>2. Turn it on</h2>
        <p>
          One click. Nothing to copy, and nothing to keep — the tap and Draft Genie arrange it between
          themselves.
        </p>
        {/* The attribute is what the userscript watches for. It carries no
            identifier and no secret; the script refuses a click on anything
            else. */}
        <button data-dg-tap-enable="" onClick={() => void enable()} disabled={busy}>
          {busy ? "Turning it on…" : "Turn on the draft tap"}
        </button>
        {enableMsg && <p className="muted small">{enableMsg}</p>}
        {scriptVersion === null && (
          <p className="muted small">
            Draft Genie can&apos;t see the draft tap in this browser yet. Install it above, then reload this
            page.
          </p>
        )}
      </div>

      <div className="card">
        <h2>3. Is it working?</h2>
        {/* 011 T020–T023 — the four states, each naming its remedy. This card
            used to offer only a reachability probe, which answered a question
            nobody was asking: on 2026-08-05 the tap was RELAYING and the page
            could not say so, so a working credential was revoked and replaced
            twice under time pressure. A state without evidence is a guess, and
            guesses under time pressure break things that were fine. */}
        <p>
          <strong>{TAP_LABEL[tapState.state]}</strong>
        </p>
        <p className="muted small">{tapState.remedy}</p>
        {tapState.evidence && (
          /* Evidence, not an assertion of health (FR-009). */
          <p className="muted small">
            Last relayed {new Date(tapState.evidence.lastRelayedAt).toLocaleString()}.
          </p>
        )}
        <button onClick={checkHealth} disabled={busy}>
          Test connection
        </button>{" "}
        {health === "ok" && <span>Draft Genie is reachable.</span>}
        {health === "failed" && <span>Could not reach Draft Genie.</span>}
        <p className="muted small">
          The connection test only proves the ingest is up — not that this browser is relaying. If ESPN
          changes something mid-season, the <a href="/draft-tap/self-test">self-test</a> replays a saved
          capture through the tap&apos;s own decode and privacy filter without needing a draft.
        </p>
      </div>

      {/* 011 T057/T058 — "paired" is gone from the product, so it is gone from
          here. Nothing is paired any more; browsers are ENABLED, one at a time,
          and each can be turned off on its own. */}
      <div className="card">
        <h2>Enabled browsers</h2>
        {pairings.length === 0 && <p className="muted">None yet.</p>}
        <ul className="plain">
          {pairings.map((p) => {
            const expired = Date.parse(p.expires_at) <= Date.now();
            return (
              <li key={p.id}>
                <span>
                  enabled {new Date(p.created_at).toLocaleDateString()}
                  {p.last_used_at ? ` · last relayed ${new Date(p.last_used_at).toLocaleString()}` : " · never relayed"}
                  {p.bound ? " · bound to one browser" : ""}
                  {/* Shown because it ends things silently: an enablement lasts
                      180 days and a season is longer, so expiry is the ordinary
                      way one finishes rather than an edge case. */}
                  {p.revoked ? " · turned off" : expired ? " · expired" : ""}
                </span>{" "}
                {!p.revoked && !expired && (
                  <button onClick={() => revoke(p.id)} disabled={busy}>
                    Turn off
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        <p className="muted small">
          Turning a browser off stops its relay immediately. <strong>It does not affect your ESPN
          account</strong> — nothing about your team, your league or your draft changes.
        </p>
        {/* 011 changed what this costs. Frames are league-shared now, so the
            manager who turns off the only running relay takes the whole
            league's feed down with it — including for people who never ran a
            tap and have no way to notice why. */}
        <p className="muted small">
          If yours is the only browser relaying, turning it off leaves everyone in that league without
          live picks — not just you.
        </p>
      </div>
    </div>
  );
}
