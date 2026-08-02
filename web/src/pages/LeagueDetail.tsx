import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiClient, LeagueDetail as Detail, RequestError } from "../api";
import { formatLocal, relativeAge } from "../lib/time";

export default function LeagueDetail() {
  const { id } = useParams<{ id: string }>();
  const [league, setLeague] = useState<Detail | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(() => {
    if (!id) return;
    apiClient
      .getLeague(id)
      .then(setLeague)
      .catch((err) => setError(err instanceof RequestError ? err.message : "Failed to load league."));
  }, [id]);
  useEffect(load, [load]);

  async function syncNow() {
    if (!id) return;
    setSyncing(true);
    setWarning(null);
    try {
      const fresh = await apiClient.syncLeague(id);
      setLeague(fresh);
      if (fresh.warning) setWarning(fresh.warning);
    } catch (err) {
      setWarning(err instanceof RequestError ? err.message : "Sync failed — try again.");
    } finally {
      setSyncing(false);
    }
  }

  if (error) return <div className="banner error">{error}</div>;
  if (!league) return <div className="empty">Loading…</div>;

  const orderNames = league.draft_order
    ? league.draft_order.map(
        (teamId) => league.teams.find((t) => t.espn_team_id === teamId)?.name ?? `Team ${teamId}`,
      )
    : null;

  return (
    <div>
      <div className="row">
        <h1 className="page">{league.name}</h1>
        <div className="actions" style={{ marginTop: 0 }}>
          <Link to={`/leagues/${id}/board`}>
            <button>Player board</button>
          </Link>
          <button className="secondary" onClick={syncNow} disabled={syncing}>
            {syncing ? "Syncing…" : "Sync now"}
          </button>
          <Link to="/">
            <button className="secondary">Back</button>
          </Link>
        </div>
      </div>

      <p className="muted">
        Season {league.season} · {league.team_count} teams · {league.scoring_summary} · you:{" "}
        {league.my_team.name} · synced {relativeAge(league.last_sync_at)}
      </p>

      {warning && <div className="banner warn">{warning}</div>}
      {league.sync_status === "failed" && !warning && (
        <div className="banner warn">
          Last refresh failed — showing settings from {relativeAge(league.last_sync_at)}.
        </div>
      )}
      {league.credentials_status === "failing" && (
        <div className="banner error">
          ESPN cookies need a refresh before this league can sync again.{" "}
          <Link to="/setup">Update cookies</Link>
        </div>
      )}
      {!league.draft.supported && (
        <div className="banner warn">
          Live-draft assistance covers online snake drafts initially — this league's draft type is
          different, but settings sync works fully.
        </div>
      )}

      <div className="grid-2">
        <div className="card">
          <h2>Draft</h2>
          <p>
            {league.draft.scheduled_at ? formatLocal(league.draft.scheduled_at) : "Date not set"}{" "}
            {league.draft.type && <span className="badge info">{league.draft.type.toLowerCase()}</span>}
          </p>
          {orderNames ? (
            <>
              <h2>Draft order</h2>
              <ol>
                {orderNames.map((name, i) => (
                  <li key={i} style={name === league.my_team.name ? { color: "var(--color-accent-700)", fontWeight: 600 } : {}}>
                    {name}
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <p className="muted small">
              Draft order not published yet — ESPN reveals it about an hour before the draft. Draft
              Genie checks every few minutes during that window automatically.
            </p>
          )}
        </div>

        <div className="card">
          <h2>Roster slots</h2>
          <table>
            <tbody>
              {league.roster_slots.map((s) => (
                <tr key={s.slotId}>
                  <td>{s.label}</td>
                  <td className="num">{s.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2>Scoring rules</h2>
        <table>
          <thead>
            <tr>
              <th>Category</th>
              <th className="num">Points</th>
            </tr>
          </thead>
          <tbody>
            {league.scoring_rules.map((r) => (
              <tr key={r.statId}>
                <td>{r.label}</td>
                <td className="num">{r.points}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>Teams</h2>
        <table>
          <tbody>
            {league.teams.map((t) => (
              <tr key={t.espn_team_id}>
                <td>
                  {t.name}
                  {t.espn_team_id === league.my_team.espn_team_id && (
                    <span className="badge info" style={{ marginLeft: "0.5rem" }}>
                      you
                    </span>
                  )}
                </td>
                <td className="muted">{t.manager_names.join(", ") || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
