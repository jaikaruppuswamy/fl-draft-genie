// 007 T028/T029 — the full breakdown (FR-006a, FR-009).
//
// The ratified rail is 318px and holds about one line per player. 006 emits up
// to eight signed adjustments with named reasons, plus missing inputs and the
// alternatives it weighed. That does not fit, so the headline stays on the rail
// and everything else opens here.
//
// Modelled on `PlayerDetailSheet` rather than inventing a second panel idiom —
// the owner should not have to learn two ways of asking "why?".
//
// Works for ANY player, not just the shortlist head: 006's deterministic engine
// will give exactly the answer the rail would have given, which is what lets
// this open on a player ranked 60th without the engine emitting 60 explanations
// per pick.

import { useEffect, useState } from "react";
import { apiClient, RecRecommendation, RequestError } from "../api";

export default function RecommendationPanel({
  leagueId,
  playerId,
  preloaded,
  onClose,
}: {
  leagueId: string;
  playerId: number;
  /** The shortlist already carries the explanation; skip the round trip. */
  preloaded?: RecRecommendation;
  onClose: () => void;
}) {
  const [rec, setRec] = useState<RecRecommendation | null>(preloaded ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (preloaded) {
      setRec(preloaded);
      return;
    }
    apiClient
      .getRecommendationForPlayer(leagueId, playerId)
      .then(setRec)
      .catch((err) =>
        setError(err instanceof RequestError ? err.message : "Couldn't load the reasoning."),
      );
  }, [leagueId, playerId, preloaded]);

  const e = rec?.explanation;

  return (
    // Same idiom as PlayerDetailSheet, deliberately: `dialog-backdrop` /
    // `dialog` / `dialog-title` already exist and already behave correctly.
    // Inventing a second set of class names would be exactly the two
    // interaction patterns this panel was supposed to avoid.
    <div className="dialog-backdrop" onClick={onClose} style={{ zIndex: 20 }}>
      <div
        className="dialog"
        onClick={(ev) => ev.stopPropagation()}
        style={{ maxHeight: "85vh", overflowY: "auto", width: "min(560px, 100%)" }}
        role="dialog"
        aria-label="Why this player"
      >
        <div className="row">
          <div className="dialog-title">{rec?.name ?? "…"}</div>
          <button className="secondary" onClick={onClose}>
            Close
          </button>
        </div>

        {error && <div className="banner error">{error}</div>}
        {!rec && !error && <div className="empty">Loading…</div>}

        {rec && e && (
          <>
            <p className="muted small">
              {rec.position} · {rec.team} · rank {rec.rank}
            </p>

            {/* FR-025: when the pick is forced the engine is not choosing, and
                that outranks every adjustment below. */}
            {e.forcedBy && <div className="banner warn">{e.forcedBy}</div>}

            <table className="board-table">
              <tbody>
                <tr>
                  <td>Value before rules</td>
                  <td style={{ textAlign: "right" }}>{e.rawValue}</td>
                </tr>
                {/* Every adjustment, with its direction and its size. The values
                    below sum to the difference between the two totals — 006
                    asserts that invariant, and showing them all is what makes it
                    checkable by eye. */}
                {e.adjustments.map((a) => (
                  <tr key={a.rule}>
                    <td>
                      <span className={a.direction === "up" ? "badge" : "badge warn"}>{a.rule}</span>{" "}
                      {a.reason}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {a.magnitude > 0 ? "+" : ""}
                      {a.magnitude}
                    </td>
                  </tr>
                ))}
                <tr>
                  <td>
                    <strong>Value used for ranking</strong>
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <strong>{e.finalValue}</strong>
                  </td>
                </tr>
              </tbody>
            </table>

            {/* FR-008: an empty list is stated, never rendered as a blank area. */}
            {e.adjustments.length === 0 && (
              <p className="muted">No rule applied — this player is ranked on value alone.</p>
            )}

            {e.missing.length > 0 && (
              <>
                <h3 style={{ marginBottom: 4 }}>Not known</h3>
                <ul className="plain">
                  {e.missing.map((m) => (
                    <li key={m.input} className="muted small">
                      {m.detail}
                    </li>
                  ))}
                </ul>
              </>
            )}

            {e.alternatives.length > 0 && (
              <>
                <h3 style={{ marginBottom: 4 }}>Considered instead</h3>
                <ul className="plain">
                  {e.alternatives.map((a) => (
                    <li key={a.playerId} className="small">
                      {a.name} <span className="muted">({a.finalValue})</span>
                    </li>
                  ))}
                </ul>
              </>
            )}

            <p className="muted small">
              A round is worth about {e.roundValue} in this league's scoring — every adjustment above is a
              fraction of that.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
