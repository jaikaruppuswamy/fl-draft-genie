import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { apiClient, type DraftSnapshot, type DraftStatus } from "../api";

// 005 T027 — the deliberately plain diagnostic page (FR-025).
//
// EXPLICITLY THROWAWAY SCAFFOLDING. 007 owns the designed draft room and
// replaces this wholesale, so it is intentionally NOT styled to the design
// system — dressing it up would invite it to survive, and a half-designed
// draft room is worse than an obviously temporary one.
//
// What it must prove: that picks arrive, in order, with who is on the clock,
// how far the owner's turn is, and — when advice is being withheld — WHY.
// FR-016: a state with no explanation is the silent failure this feature
// exists to prevent, so the withholding banner always says what to do.

const REFRESH_MS = 2_000;

const WITHHOLD_COPY: Record<string, string> = {
  not_receiving:
    "Not receiving picks. The draft-room tab IS the tap — check it is still open, then reload it.",
  incompatible:
    "The tap no longer understands ESPN's draft messages, so picks are NOT being captured. Update the tap.",
  version_rejected: "Draft Genie does not understand this version of the tap. Update it.",
};

export default function DraftDiagnostics() {
  const { id } = useParams<{ id: string }>();
  const [status, setStatus] = useState<DraftStatus | null>(null);
  const [snap, setSnap] = useState<DraftSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    const load = async () => {
      try {
        const s = await apiClient.getDraftStatus(id);
        if (!alive) return;
        setStatus(s);
        setError(null);
        if (!s.armed) {
          setSnap(null);
          return;
        }
        setSnap(await apiClient.getDraftSnapshot(id));
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    void load();
    // Polling here is a property of this THROWAWAY page, not of the feature.
    // Phase 4 replaces it with the WebSocket the session already fans out on.
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id]);

  if (error) return <pre style={{ padding: 16, color: "#a00" }}>{error}</pre>;
  if (!status) return <p style={{ padding: 16 }}>Loading…</p>;

  return (
    <div style={{ padding: 16, font: "13px ui-monospace, monospace" }}>
      <p style={{ opacity: 0.6 }}>
        Throwaway diagnostic view (005 FR-025). Feature 007 replaces this entirely.
      </p>

      {status.withholding && (
        <p style={{ background: "#7a2020", color: "#fff", padding: "8px 12px", borderRadius: 4 }}>
          <strong>Recommendations withheld.</strong> {WITHHOLD_COPY[status.withholding] ?? status.withholding}
        </p>
      )}

      <h2>Session</h2>
      <ul>
        <li>armed: {String(status.armed)}</li>
        <li>status: {status.status}</li>
        {status.detail && <li>{status.detail}</li>}
        {status.tap && (
          <>
            <li>
              tap: {status.tap.state ?? "—"} (v{status.tap.version ?? "?"})
              {status.tap.hidden && " — tab hidden, so the liveness tolerance is wider"}
            </li>
            <li>
              last heartbeat: {status.tap.lastHeartbeatAt ?? "never"}
              {status.tap.lapsed && " — LAPSED"}
            </li>
          </>
        )}
      </ul>

      {snap && (
        <>
          <h2>Draft</h2>
          <ul>
            <li>
              picks: {snap.picks.length}
              {snap.totalPicks > 0 ? ` / ${snap.totalPicks}` : " / ?"}
            </li>
            <li>on the clock: {snap.onTheClock ?? "—"}</li>
            {/* A dash, never a zero: an unknown order has no honest countdown. */}
            <li>picks until my turn: {snap.picksUntilMyTurn ?? "—"}</li>
            <li>order trust: {snap.orderTrust}</li>
            <li>revision: {snap.revision}</li>
            <li>complete: {String(snap.complete)}</li>
          </ul>

          <h2>Picks</h2>
          <table cellPadding={4}>
            <thead>
              <tr>
                <th align="left">#</th>
                <th align="left">team</th>
                <th align="left">player</th>
                <th align="left">observed</th>
              </tr>
            </thead>
            <tbody>
              {[...snap.picks].reverse().map((p) => (
                <tr key={p.overall}>
                  <td>{p.overall}</td>
                  <td>{p.teamId}</td>
                  {/* Negative ids are D/ST and are shown as-is, never filtered. */}
                  <td>{p.playerId}</td>
                  <td>{p.observedAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
