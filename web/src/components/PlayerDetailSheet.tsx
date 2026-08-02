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
                  {detail.breakdown.map((b) => (
                    <tr key={b.statId} style={b.covered ? {} : { opacity: 0.55 }}>
                      <td>
                        {b.label}
                        {!b.covered && <span className="badge warn" style={{ marginLeft: 6 }}>not projected</span>}
                      </td>
                      <td className="num">{b.projected ?? "—"}</td>
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
                Categories your league scores that the projection source doesn't cover count as zero.
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
