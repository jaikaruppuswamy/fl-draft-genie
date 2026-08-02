import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { apiClient, LeagueSummary, RequestError } from "../api";
import { draftCountdown, formatLocal, relativeAge } from "../lib/time";

export default function Dashboard() {
  const [leagues, setLeagues] = useState<LeagueSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const load = useCallback(() => {
    apiClient
      .listLeagues()
      .then((r) => setLeagues(r.leagues))
      .catch((err) => setError(err instanceof RequestError ? err.message : "Failed to load leagues."));
  }, []);
  useEffect(load, [load]);

  async function remove(league: LeagueSummary) {
    if (!window.confirm(`Remove "${league.name}" from Draft Genie? (Nothing changes on ESPN.)`)) return;
    await apiClient.deleteLeague(league.id);
    load();
  }

  if (error) return <div className="banner error">{error}</div>;
  if (!leagues) return <div className="empty">Loading…</div>;

  const credsFailing = leagues.some((l) => l.credentials_status === "failing");

  return (
    <div>
      <div className="row">
        <h1 className="page">Your leagues</h1>
        <div className="actions" style={{ marginTop: 0 }}>
          <Link to="/setup">
            <button className="secondary">ESPN cookies</button>
          </Link>
          <Link to="/connect">
            <button>Connect league</button>
          </Link>
        </div>
      </div>

      {credsFailing && (
        <div className="banner error">
          Your ESPN cookies stopped working — synced data is preserved, but refreshes are paused.{" "}
          <Link to="/setup">Refresh cookies</Link>
        </div>
      )}

      {leagues.length === 0 ? (
        <div className="empty">
          <p>No leagues yet.</p>
          <p className="muted">
            Add your <Link to="/setup">ESPN cookies</Link>, then{" "}
            <Link to="/connect">connect your first league</Link>.
          </p>
        </div>
      ) : (
        leagues.map((l) => (
          <div key={l.id} className="card clickable" onClick={() => navigate(`/leagues/${l.id}`)}>
            <div className="row">
              <div>
                <h2>{l.name}</h2>
                <div className="muted">
                  {l.team_count} teams · {l.scoring_summary} · you: {l.my_team.name}
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div>
                  {l.draft.scheduled_at ? (
                    <>
                      <span className="badge info">draft {draftCountdown(l.draft.scheduled_at)}</span>{" "}
                      <span className="muted small">{formatLocal(l.draft.scheduled_at)}</span>
                    </>
                  ) : (
                    <span className="muted small">draft date not set</span>
                  )}
                </div>
                <div className="small" style={{ marginTop: "0.35rem" }}>
                  {l.sync_status === "failed" ? (
                    <span className="badge failed">sync failed · showing {relativeAge(l.last_sync_at)}</span>
                  ) : (
                    <span className="muted">synced {relativeAge(l.last_sync_at)}</span>
                  )}{" "}
                  {l.draft.order_published && <span className="badge ok">draft order in</span>}
                </div>
              </div>
            </div>
            {!l.draft.supported && (
              <div className="banner warn" style={{ marginTop: "0.75rem", marginBottom: 0 }}>
                This league's draft type isn't a live online snake draft — live-draft assistance
                covers online snake drafts initially. Settings still sync normally.
              </div>
            )}
            <div className="actions">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  navigate(`/leagues/${l.id}/board`);
                }}
              >
                Player board
              </button>
              <button
                className="secondary"
                onClick={(e) => {
                  e.stopPropagation();
                  void remove(l);
                }}
              >
                Remove
              </button>
            </div>
          </div>
        ))
      )}
      <p className="muted small" style={{ marginTop: "var(--space-4)" }}>
        Design preview: <Link to="/design/draft">draft-day screen</Link> (feature 007)
      </p>
    </div>
  );
}
