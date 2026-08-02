import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiClient, BoardResponse, RequestError } from "../api";
import { relativeAge } from "../lib/time";
import PlayerDetailSheet from "../components/PlayerDetailSheet";

const POSITION_ORDER = ["QB", "RB", "WR", "TE", "K", "DST"];

export default function LeagueBoard() {
  const { id } = useParams<{ id: string }>();
  const [board, setBoard] = useState<BoardResponse | null>(null);
  const [empty, setEmpty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("ALL");
  const [search, setSearch] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [openPlayer, setOpenPlayer] = useState<number | null>(null);

  const load = useCallback(() => {
    if (!id) return;
    setEmpty(false);
    apiClient
      .getBoard(id)
      .then(setBoard)
      .catch((err) => {
        if (err instanceof RequestError && err.body.error === "no_projections") setEmpty(true);
        else setError(err instanceof RequestError ? err.message : "Failed to load the board.");
      });
  }, [id]);
  useEffect(load, [load]);

  async function refresh() {
    setRefreshing(true);
    setNotice(null);
    try {
      const res = await apiClient.refreshProjections();
      setNotice(`Projections refreshed — ${res.player_count} players.`);
      load();
    } catch (err) {
      setNotice(err instanceof RequestError ? err.message : "Refresh failed — try again.");
    } finally {
      setRefreshing(false);
    }
  }

  const positions = useMemo(() => {
    if (!board) return [];
    const present = new Set(board.players.map((p) => p.position));
    return POSITION_ORDER.filter((p) => present.has(p));
  }, [board]);

  const visible = useMemo(() => {
    if (!board) return [];
    const q = search.trim().toLowerCase();
    return board.players.filter((p) => {
      if (filter !== "ALL" && !p.eligible_positions.includes(filter) && p.position !== filter) return false;
      if (q && !p.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [board, filter, search]);

  if (error) return <div className="banner error">{error}</div>;

  if (empty) {
    return (
      <div>
        <h1 className="page">Player board</h1>
        <div className="empty">
          <p>No projections yet.</p>
          <p className="muted">
            Draft Genie hasn't fetched season projections for the first time. Trigger it now — it
            takes a few seconds.
          </p>
          <button onClick={refresh} disabled={refreshing}>
            {refreshing ? "Fetching…" : "Fetch projections"}
          </button>
          {notice && <p className="muted small" style={{ marginTop: "var(--space-3)" }}>{notice}</p>}
        </div>
      </div>
    );
  }

  if (!board) return <div className="empty">Loading…</div>;

  // 003 FR-004: tier groupings when a single-position filter is active —
  // grouped mode orders by tier (untiered last), points within tier.
  const grouped = filter !== "ALL" && filter !== "FLEX";
  const projected = visible
    .filter((p) => p.projected_points !== null)
    .sort((a, b) => {
      if (grouped) {
        const ta = a.tier ?? Infinity;
        const tb = b.tier ?? Infinity;
        if (ta !== tb) return ta - tb;
      }
      return (b.projected_points ?? 0) - (a.projected_points ?? 0);
    });
  const unprojected = visible.filter((p) => p.projected_points === null);

  return (
    <div>
      <div className="row">
        <h1 className="page">Player board</h1>
        <div className="actions" style={{ marginTop: 0 }}>
          <button className="secondary" onClick={refresh} disabled={refreshing}>
            {refreshing ? "Refreshing…" : "Refresh projections"}
          </button>
          <Link to={`/leagues/${id}`}>
            <button className="secondary">League</button>
          </Link>
        </div>
      </div>

      <p className="muted small">
        Projections updated {relativeAge(board.freshness.fetched_at)}
        {board.freshness.stale && (
          <span className="badge warn" style={{ marginLeft: 8 }}>stale — refresh due</span>
        )}
        {" · "}points are computed in this league's scoring
      </p>
      {notice && <div className="banner warn">{notice}</div>}

      <div className="row" style={{ marginBottom: "var(--space-3)", justifyContent: "flex-start" }}>
        <div className="actions" style={{ marginTop: 0 }}>
          {["ALL", ...positions].map((p) => (
            <button
              key={p}
              className={filter === p ? "" : "secondary"}
              style={{ minHeight: 36, padding: "4px 14px" }}
              onClick={() => setFilter(p)}
            >
              {p === "ALL" ? "All" : p}
            </button>
          ))}
        </div>
        <input
          placeholder="Search players…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ maxWidth: 260 }}
        />
      </div>

      <div className="card" style={{ padding: "var(--space-2) var(--space-3)" }}>
        <table className="board-table">
          <thead>
            <tr>
              <th>Player</th>
              <th>Pos</th>
              <th>Tier</th>
              <th>Team</th>
              <th>Bye</th>
              <th>ADP</th>
              <th>Proj pts</th>
            </tr>
          </thead>
          <tbody>
            {projected.map((p, i) => {
              const prev = i > 0 ? projected[i - 1] : null;
              const tierBoundary =
                grouped && p.tier !== null && (prev === null || prev.tier !== p.tier);
              return [
                tierBoundary ? (
                  <tr key={`tier-${p.tier}-${p.espn_player_id}`} className="tier-divider">
                    <td colSpan={7}>Tier {p.tier}</td>
                  </tr>
                ) : null,
                <tr key={p.espn_player_id} onClick={() => setOpenPlayer(p.espn_player_id)} style={{ cursor: "pointer" }}>
                  <td>{p.name}</td>
                  <td>
                    <span className="badge info">
                      {p.position}
                      {p.position_rank}
                    </span>
                  </td>
                  <td className="num muted">{p.tier ?? "—"}</td>
                  <td className="muted">{p.team}</td>
                  <td className="num muted">{p.bye_week ?? "—"}</td>
                  <td className="num muted">{p.adp ?? "—"}</td>
                  <td className="num" style={{ fontWeight: 700 }}>{p.projected_points}</td>
                </tr>,
              ];
            })}
          </tbody>
        </table>
        {unprojected.length > 0 && (
          <>
            <p className="muted small" style={{ margin: "var(--space-2) 0 0" }}>
              No projection yet ({unprojected.length}):
            </p>
            <p className="muted small" style={{ margin: 0 }}>
              {unprojected.map((p) => `${p.name} (${p.position}, ${p.team})`).join(" · ")}
            </p>
          </>
        )}
      </div>

      {openPlayer !== null && id && (
        <PlayerDetailSheet leagueId={id} playerId={openPlayer} onClose={() => setOpenPlayer(null)} />
      )}
    </div>
  );
}
