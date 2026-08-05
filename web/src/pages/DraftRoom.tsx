// 007 — the draft room. THE screen, on draft day.
//
// This file is a RENDERING SHELL. It holds the reducer's state, performs the
// effects the reducer returns, and decides nothing. Every judgement — when to
// fetch, what counts as complete, which reason to headline — lives in
// `lib/draftRoom.ts` and `lib/draftRoomSelectors.ts`, which are pure and
// therefore testable without a browser.
//
// That split is not tidiness. SC-001 ("a recommendation is current before the
// owner's turn begins") has to be measured OFFLINE (FR-024), and it cannot fail
// in a render — it fails by deciding to fetch too late. Putting the decision
// here would have meant a jsdom test stack that measured the wrong thing.
//
// TWO FAILURES ARE SHOWN SEPARATELY, and conflating them is the mistake this
// screen most needs to avoid:
//
//   reachability  — can the browser reach DRAFT GENIE?      remedy: wait
//   withholding   — is the TAP still delivering picks?      remedy: go check
//                                                                    its tab
//
// During a live draft a wrong diagnosis costs a pick.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  apiClient,
  BoardResponse,
  DraftStatus,
  RankedBoardResponse,
  RecRecommendation,
  RequestError,
} from "../api";
import { connectDraftStream, type DraftFrame } from "../lib/draftSocket";
import { initialState, reduce, type Effect, type RoomInput, type RoomState } from "../lib/draftRoom";
import { boardGrid, railEntries, rosterView, type PlayerLookup } from "../lib/draftRoomSelectors";
import RecommendationPanel from "../components/RecommendationPanel";
import { relativeAge } from "../lib/time";

/** Copy for 005's withholding verdicts — reused, not rewritten. */
const WITHHOLD_COPY: Record<string, string> = {
  not_receiving:
    "Not receiving picks. The draft-room tab IS the tap — check it is still open, then reload it.",
  incompatible:
    "The tap no longer understands ESPN's draft messages, so picks are NOT being captured. Update the tap.",
  version_rejected: "The tap is running a version this server no longer accepts. Update the userscript.",
};

export default function DraftRoom() {
  const { id } = useParams<{ id: string }>();

  // The reducer is the brain; `useReducer` just hosts it. `at` is passed in on
  // every dispatch, because the reducer never reads a clock.
  const [state, rawDispatch] = useReducer(
    (s: RoomState, input: RoomInput) => reduce(s, input, Date.now()).state,
    initialState(),
  );
  const pending = useRef<Effect[]>([]);
  const dispatch = useCallback((input: RoomInput) => {
    // Effects are computed alongside the state; capture them for the effect
    // runner below rather than performing them inside the reducer.
    pending.current.push(...reduce(stateRef.current, input, Date.now()).effects);
    rawDispatch(input);
  }, []);
  const stateRef = useRef(state);
  stateRef.current = state;

  const [status, setStatus] = useState<DraftStatus | null>(null);
  const [board, setBoard] = useState<BoardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<{ playerId: number; preloaded?: RecRecommendation } | null>(null);

  // --- the slow-changing half: the board, for names, and the session header --
  useEffect(() => {
    if (!id) return;
    apiClient.getBoard(id).then(setBoard).catch(() => setBoard(null));
    apiClient
      .getDraftStatus(id)
      .then(setStatus)
      .catch((err) => setError(err instanceof RequestError ? err.message : "Couldn't load the draft."));
  }, [id]);

  // The room asks on open, so it is never blank waiting for a first pick that
  // may be an hour away — or, pre-draft, may never come at all.
  useEffect(() => {
    if (id) dispatch({ kind: "opened" });
  }, [id, dispatch]);

  // --- the frame source: 005's socket, unchanged ----------------------------
  useEffect(() => {
    if (!id) return;
    const conn = connectDraftStream(id, {
      onFrame: (frame: DraftFrame) => dispatch({ kind: "frame", frame }),
      onReachability: (s) => dispatch({ kind: "reachability", state: s }),
    });
    return () => conn.close();
  }, [id, dispatch]);

  // --- the effect runner: performs what the reducer DESCRIBED ---------------
  useEffect(() => {
    if (!id) return;
    const effects = pending.current;
    pending.current = [];
    for (const effect of effects) {
      if (effect.kind === "fetchRecommendation") {
        const forRevision = stateRef.current.revision;
        apiClient
          .getRecommendations(id)
          .then((b: RankedBoardResponse) =>
            dispatch({ kind: "recommendation", board: b as never, forRevision: b.revision }),
          )
          // A failure must still clear `inFlight`, or the screen wedges.
          .catch(() => dispatch({ kind: "recommendation", board: null, forRevision }));
      } else {
        apiClient
          .getDraftSnapshot(id)
          .then((snap) =>
            dispatch({
              kind: "frame",
              frame: { type: "snapshot", epoch: state.epoch ?? "", seq: 0, state: snap } as DraftFrame,
            }),
          )
          .catch(() => {});
      }
    }
  }, [state, id, dispatch]);

  const players = useMemo((): Map<number, PlayerLookup> => {
    const m = new Map<number, PlayerLookup>();
    for (const p of board?.players ?? []) {
      m.set(p.espn_player_id, { name: p.name, position: p.position, team: p.team });
    }
    return m;
  }, [board]);

  const teamCount = 12;
  const rounds = state.totalPicks > 0 ? Math.ceil(state.totalPicks / teamCount) : 15;
  const grid = useMemo(
    () => boardGrid(state, players, teamCount, rounds),
    [state, players, rounds],
  );
  const roster = useMemo(() => rosterView(state, players), [state, players]);
  const rail = useMemo(() => railEntries(state), [state]);

  if (error) return <div className="banner error">{error}</div>;

  const withheld = state.recommendation?.withheld ?? null;
  const tapWithholding = status?.withholding ?? null;

  // --- FR-023: three states, distinguishable WITHOUT reading text -----------
  // Tokens already in styles.css from the ratified system. No new colours, and
  // no animation that would pull the eye during someone else's pick.
  const turn = state.myTurnState;
  const railBorder =
    turn === "on_the_clock"
      ? "3px solid var(--color-accent-700)"
      : turn === "on_deck"
        ? "3px solid var(--color-accent-2-600)"
        : "1px solid var(--color-neutral-300)";
  const railHeaderBg =
    turn === "on_the_clock" ? "var(--color-accent-700)" : turn === "on_deck" ? "var(--color-accent-2-300)" : "transparent";
  const railHeaderFg = turn === "on_the_clock" ? "var(--color-accent-100)" : "var(--color-text)";

  return (
    <div>
      <div className="row">
        <h1 className="page">Draft room</h1>
        <div className="actions" style={{ marginTop: 0 }}>
          {/* FR-018: link to 006's page. NEVER reimplement list management. */}
          <Link to={`/leagues/${id}/preferred`}>
            <button className="secondary">Preferred list</button>
          </Link>
          <Link to={`/leagues/${id}/board`}>
            <button className="secondary">Player board</button>
          </Link>
          <Link to={`/leagues/${id}`}>
            <button className="secondary">League</button>
          </Link>
        </div>
      </div>

      {/* Draft Genie's reachability. NOT whether picks are arriving. */}
      {state.reachability !== "connected" && (
        <div className="banner warn">
          {state.reachability === "polling"
            ? "Cannot reach Draft Genie — falling back to polling. Your picks are still being captured by the tap."
            : "Reconnecting to Draft Genie…"}
        </div>
      )}

      {/* 005's verdict: the TAP has stopped delivering. Different remedy. */}
      {tapWithholding && (
        <div className="banner error">
          <strong>Recommendations withheld.</strong>{" "}
          {WITHHOLD_COPY[tapWithholding] ?? "The draft picture is not trustworthy."}
        </div>
      )}

      {/* FR-017: pre-draft. The order is stated as unknown, never invented. */}
      {state.phase === "pre_draft" && (
        <div className="banner info">
          {status?.armed ? "Waiting for the first pick." : "The draft hasn't started."}{" "}
          {state.order === null && "ESPN hasn't published the draft order yet."}
          {board?.freshness && ` Projections updated ${relativeAge(board.freshness.fetched_at)}.`}
        </div>
      )}

      {/* FR-022: complete, by whichever route got there first. */}
      {state.phase === "complete" && state.completion && (
        <div className="banner ok">
          <strong>Draft complete.</strong>{" "}
          {state.completion.by === "both"
            ? "Both the completion signal and the pick count agree."
            : state.completion.by === "signal"
              ? "Reported complete by the draft feed."
              : "Every pick has been observed."}
          {/* FR-022b: a disagreement is SURFACED, not resolved. It is the first
              real evidence about which route to trust — the signal has never
              fired in production, and the pick count depends on a draft length
              that has been wrong before. */}
          {state.completion.divergent && (
            <span className="muted small">
              {" "}
              (the two completion checks disagreed — recorded for diagnosis)
            </span>
          )}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 318px", gap: "var(--space-3)" }}>
        {/* ---- the full grid, per the ratified layout ---- */}
        <div style={{ minWidth: 0, overflowX: "auto" }}>
          <div className="row" style={{ marginBottom: 8 }}>
            <strong>Draft board</strong>
            <span className="muted small">
              {/* FR-010: null is UNKNOWN, never "0" — a zero here reads as
                  "you're on the clock" and would be actively misleading. */}
              {state.picksUntilMyTurn === null
                ? "picks until your turn: —"
                : state.picksUntilMyTurn === 0
                  ? "you're on the clock"
                  : `${state.picksUntilMyTurn} picks until your turn`}
            </span>
          </div>
          <table className="board-table">
            <tbody>
              {grid.rounds.map((round) => (
                <tr key={round.label}>
                  <th style={{ textAlign: "left" }}>{round.label}</th>
                  {round.cells.map((cell) => (
                    <td
                      key={cell.overall}
                      style={{
                        outline: cell.mine ? "1px solid var(--color-accent-700)" : "none",
                        background: cell.current ? "var(--color-accent-100)" : undefined,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {cell.player ? (
                        <>
                          {cell.player.name}
                          <span className="muted small"> {cell.player.position}</span>
                        </>
                      ) : (
                        <span className="muted small">{cell.label}</span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* ---- the 318px rail ---- */}
        <div style={{ border: railBorder, borderRadius: "var(--radius-lg)", padding: "var(--space-2)" }}>
          <div
            style={{
              background: railHeaderBg,
              color: railHeaderFg,
              borderRadius: "var(--radius-sm, 8px)",
              padding: "6px 10px",
              marginBottom: 8,
              fontWeight: 700,
            }}
          >
            {turn === "on_the_clock" ? "You're on the clock" : turn === "on_deck" ? "On deck" : "Recommended"}
          </div>

          {withheld ? (
            <div className="banner error">
              <strong>Withheld.</strong> {withheld.detail}
            </div>
          ) : rail.length === 0 ? (
            <p className="muted small">No recommendation yet.</p>
          ) : (
            <ul className="plain">
              {rail.map((r) => (
                <li key={r.playerId}>
                  <button
                    className="secondary"
                    style={{ width: "100%", textAlign: "left", minHeight: 0, padding: "6px 8px" }}
                    onClick={() =>
                      setOpen({
                        playerId: r.playerId,
                        preloaded: state.recommendation?.shortlist.find(
                          (s) => (s as unknown as { playerId: number }).playerId === r.playerId,
                        ) as unknown as RecRecommendation,
                      })
                    }
                  >
                    <strong>{r.name}</strong>{" "}
                    <span className="muted small">
                      {r.position} · {r.finalValue}
                    </span>
                    {r.preferred && (
                      <span className="badge info" style={{ marginLeft: 6 }}>
                        preferred{r.preferredValue !== null ? ` +${r.preferredValue}` : ""}
                      </span>
                    )}
                    {/* FR-006: the headline is visible with NO interaction, and
                        is never empty — an empty headline is a bare name. */}
                    <div className="muted small">{r.headline}</div>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <h3 style={{ marginBottom: 4 }}>Your roster</h3>
          {roster.slots.length === 0 ? (
            <p className="muted small">Nothing drafted yet.</p>
          ) : (
            <ul className="plain">
              {roster.slots.map((s) => (
                <li key={s.position} className="small">
                  <strong>{s.position}</strong> {s.players.map((p) => p.name).join(", ")}
                </li>
              ))}
            </ul>
          )}
          {roster.stillNeeded && (
            <p className={roster.forced ? "banner warn" : "muted small"}>{roster.stillNeeded}</p>
          )}
        </div>
      </div>

      {open && id && (
        <RecommendationPanel
          leagueId={id}
          playerId={open.playerId}
          preloaded={open.preloaded}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
