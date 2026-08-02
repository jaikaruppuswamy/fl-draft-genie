import { useEffect, useState } from "react";
import { apiClient, PlayerDetail, RequestError } from "../api";

// US3 (T021): the projection's derivation — stat × league value → points,
// summing to the total (constitution VII).
export default function PlayerDetailSheet({
  leagueId,
  playerId,
  onClose,
}: {
  leagueId: string;
  playerId: number;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<PlayerDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiClient
      .getPlayerDetail(leagueId, playerId)
      .then(setDetail)
      .catch((err) =>
        setError(err instanceof RequestError ? err.message : "Failed to load player detail."),
      );
  }, [leagueId, playerId]);

  // 003 FR-001: only covered categories are listed; uncovered ones collapse
  // into a count note (explainability preserved without the clutter).
  const covered = detail?.breakdown.filter((b) => b.covered) ?? [];
  const uncovered = detail?.breakdown.filter((b) => !b.covered) ?? [];

  return (
    <div className="dialog-backdrop" onClick={onClose} style={{ zIndex: 20 }}>
      <div className="dialog" onClick={(e) => e.stopPropagation()} style={{ maxHeight: "85vh", overflowY: "auto", width: "min(520px, 100%)" }}>
        {error && <div className="banner error">{error}</div>}
        {!detail && !error && <div className="empty">Loading…</div>}
        {detail && (
          <>
            <div className="row">
              <div>
                <div className="dialog-title">{detail.player.name}</div>
                <div className="muted small">
                  {detail.player.position}
                  {detail.player.position_rank !== null && detail.player.position_rank}
                  {" · "}
                  {detail.player.team}
                  {detail.player.bye_week !== null && ` · bye ${detail.player.bye_week}`}
                  {detail.player.adp !== null && ` · ADP ${detail.player.adp}`}
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontFamily: "var(--font-heading)", fontSize: 25 }}>
                  {detail.total ?? "—"}
                </div>
                <div className="muted small">projected pts</div>
              </div>
            </div>

            {detail.signals && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "var(--space-2)" }}>
                {[
                  { name: "Team offense", block: detail.signals.offense },
                  { name: "Schedule", block: detail.signals.sos },
                  { name: "O-line", block: detail.signals.oline },
                  { name: "Bye week", block: null, bye: detail.signals.bye_week },
                ].map((s) => (
                  <div
                    key={s.name}
                    style={{
                      borderRadius: "var(--radius-md)",
                      background: "var(--color-neutral-100)",
                      padding: "var(--space-2) var(--space-3)",
                    }}
                  >
                    <div className="muted small">{s.name}</div>
                    {"bye" in s ? (
                      <div style={{ fontWeight: 700 }}>{s.bye ?? "—"}</div>
                    ) : s.block ? (
                      <div>
                        <span style={{ fontWeight: 700 }}>#{s.block.rank}</span>{" "}
                        <span className="muted small">{s.block.label}</span>
                      </div>
                    ) : (
                      <div className="muted">—</div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {detail.breakdown.length === 0 ? (
              <p className="muted">No projection for this player yet.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Category</th>
                    <th className="num">Projected</th>
                    <th className="num">× Value</th>
                    <th className="num">Points</th>
                  </tr>
                </thead>
                <tbody>
                  {covered.map((b) => (
                    <tr key={b.statId}>
                      <td>{b.label}</td>
                      <td className="num">{b.projected}</td>
                      <td className="num">{b.points_per}</td>
                      <td className="num">{b.points}</td>
                    </tr>
                  ))}
                  <tr>
                    <td style={{ fontWeight: 700 }}>Total</td>
                    <td />
                    <td />
                    <td className="num" style={{ fontWeight: 700 }}>{detail.total ?? "—"}</td>
                  </tr>
                </tbody>
              </table>
            )}
            {uncovered.length > 0 && (
              <p className="muted small">
                {uncovered.length} league scoring {uncovered.length === 1 ? "category" : "categories"} not
                covered by projections (counted as zero).
              </p>
            )}
            <div className="dialog-actions">
              <button className="secondary" onClick={onClose}>Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
