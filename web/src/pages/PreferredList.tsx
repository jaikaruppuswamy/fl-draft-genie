// 006 T046 — the preferred-player list (FR-019).
//
// The one page this feature ships. It is NOT the draft room — 007 owns that —
// and it is used BEFORE draft day, not during it. It exists because nothing
// else owns the list, and without it the preference rule could never fire on a
// real draft.
//
// The search below is `LeagueBoard.tsx`'s, deliberately unchanged: same
// substring match on a lowercased name, same position filter, over the same
// board response. Writing a second one would be a second thing to keep in step
// for no benefit — and the board endpoint already returns the whole board, so
// no search endpoint and no name index were needed.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { apiClient, BoardResponse, PreferredResponse, RequestError } from "../api";
import LeagueNav from "../components/LeagueNav";

const POSITION_ORDER = ["QB", "RB", "WR", "TE", "K", "DST"];

export default function PreferredList() {
  const { id } = useParams<{ id: string }>();
  const [board, setBoard] = useState<BoardResponse | null>(null);
  const [preferred, setPreferred] = useState<PreferredResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [empty, setEmpty] = useState(false);
  const [filter, setFilter] = useState<string>("ALL");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<number | null>(null);

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
    apiClient
      .getPreferred(id)
      .then(setPreferred)
      .catch((err) => setError(err instanceof RequestError ? err.message : "Failed to load your list."));
  }, [id]);
  useEffect(load, [load]);

  const chosen = useMemo(
    () => new Set((preferred?.players ?? []).map((p) => p.espn_player_id)),
    [preferred],
  );

  async function toggle(playerId: number, on: boolean) {
    if (!id) return;
    setBusy(playerId);
    try {
      if (on) await apiClient.addPreferred(id, playerId);
      else await apiClient.removePreferred(id, playerId);
      setPreferred(await apiClient.getPreferred(id));
    } catch (err) {
      setError(err instanceof RequestError ? err.message : "That didn't save — try again.");
    } finally {
      setBusy(null);
    }
  }

  const positions = useMemo(() => {
    if (!board) return [];
    const present = new Set(board.players.map((p) => p.position));
    return POSITION_ORDER.filter((p) => present.has(p));
  }, [board]);

  // LeagueBoard.tsx:53-61, unchanged.
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
      <div className="banner warn">
        Projections haven't been fetched yet, so there is no board to choose from. Open the player board and
        refresh them first.
      </div>
    );
  }
  if (!board || !preferred) return <p className="muted">Loading…</p>;

  const offBoard = preferred.players.filter((p) => !p.on_board);

  return (
    <div>
      <h1 className="page">Preferred players</h1>
      <LeagueNav leagueId={id!} />

      <p className="muted small">
        Players you mark here can be recommended a little earlier than their value alone would justify — up to
        about one round — and Draft Genie says when a preference is what moved them. It never lifts a
        materially worse player to the top.
      </p>

      <h2 className="section">Your list ({preferred.players.length})</h2>
      {preferred.players.length === 0 ? (
        <p className="muted">Nothing marked yet. Find players below and add them.</p>
      ) : (
        <ul className="plain">
          {preferred.players.map((p) => (
            <li key={p.espn_player_id} className="row" style={{ alignItems: "baseline" }}>
              <span>
                {p.name ?? `Player ${p.espn_player_id}`}
                {p.position && <span className="muted small"> · {p.position}</span>}
                {p.team && <span className="muted small"> · {p.team}</span>}
                {/* FR-021: the row survives, and we say plainly why it is inert. */}
                {!p.on_board && (
                  <span className="badge warn" style={{ marginLeft: 8 }}>
                    no longer on the board — cannot be recommended
                  </span>
                )}
              </span>
              <button
                className="secondary"
                disabled={busy === p.espn_player_id}
                onClick={() => toggle(p.espn_player_id, false)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {offBoard.length > 0 && (
        <p className="muted small">
          {offBoard.length} player{offBoard.length === 1 ? " has" : "s have"} left the board — released,
          retired, or no longer listed by ESPN. They are kept here in case they return, and simply never
          recommended.
        </p>
      )}

      <h2 className="section">Add players</h2>
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
          aria-label="Search players"
        />
      </div>

      <table className="board-table">
        <thead>
          <tr>
            <th style={{ textAlign: "left" }}>Player</th>
            <th>Pos</th>
            <th>Team</th>
            <th>Proj</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {visible.slice(0, 200).map((p) => {
            const on = chosen.has(p.espn_player_id);
            return (
              <tr key={p.espn_player_id}>
                <td>{p.name}</td>
                <td>
                  {p.position}
                  {p.position_rank}
                </td>
                <td>{p.team}</td>
                <td>{p.projected_points ?? "—"}</td>
                <td>
                  <button
                    className={on ? "secondary" : ""}
                    disabled={busy === p.espn_player_id}
                    onClick={() => toggle(p.espn_player_id, !on)}
                  >
                    {on ? "Remove" : "Add"}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {visible.length > 200 && (
        <p className="muted small">
          Showing the first 200 of {visible.length}. Narrow the search or pick a position.
        </p>
      )}
    </div>
  );
}
