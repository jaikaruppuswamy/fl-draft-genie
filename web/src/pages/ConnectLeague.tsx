import { FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { apiClient, RequestError, TeamChoice } from "../api";

export default function ConnectLeague() {
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState<TeamChoice | null>(null);
  const navigate = useNavigate();

  async function connect(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const league = await apiClient.connectLeague(ref);
      navigate(`/leagues/${league.id}`);
    } catch (err) {
      if (err instanceof RequestError && err.status === 409) {
        setChoice(err.body as unknown as TeamChoice);
      } else if (err instanceof RequestError) {
        if (err.body.error === "no_credentials") {
          setError("Add your ESPN cookies first — redirecting…");
          setTimeout(() => navigate("/setup"), 1200);
        } else {
          setError(err.message);
        }
      } else {
        setError("Something went wrong — try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function pickTeam(espnTeamId: number) {
    if (!choice) return;
    setBusy(true);
    setError(null);
    try {
      const league = await apiClient.completeConnect(choice.connect_token, espnTeamId);
      navigate(`/leagues/${league.id}`);
    } catch (err) {
      setError(err instanceof RequestError ? err.message : "Something went wrong — try again.");
      if (err instanceof RequestError && err.body.error === "expired_connect_token") setChoice(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1 className="page">Connect a league</h1>
      {!choice ? (
        <div className="card">
          <p className="muted">
            Paste your ESPN league URL (from the browser address bar on your league page) or the
            numeric league ID.
          </p>
          {error && <div className="banner error">{error}</div>}
          <form onSubmit={connect}>
            <label htmlFor="ref">League URL or ID</label>
            <input
              id="ref"
              placeholder="https://fantasy.espn.com/football/league?leagueId=…"
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              required
            />
            <div className="actions">
              <button disabled={busy || !ref}>Connect</button>
              <Link to="/">
                <button type="button" className="secondary">
                  Cancel
                </button>
              </Link>
            </div>
          </form>
        </div>
      ) : (
        <div className="card">
          <h2>Which team is yours?</h2>
          <p className="muted">
            We couldn't match your ESPN identity to a team automatically. Pick yours — if none of
            these are you, this league can't be connected (you need a team in the league).
          </p>
          {error && <div className="banner error">{error}</div>}
          <table>
            <tbody>
              {choice.teams.map((t) => (
                <tr key={t.espn_team_id}>
                  <td>{t.name}</td>
                  <td className="muted">{t.manager_names.join(", ") || "—"}</td>
                  <td className="num">
                    <button disabled={busy} onClick={() => pickTeam(t.espn_team_id)}>
                      This is me
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="actions">
            <button className="secondary" onClick={() => setChoice(null)}>
              None of these — cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
