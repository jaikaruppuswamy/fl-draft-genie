// 007 — the draft room. THE screen, on draft day.
//
// REBUILT 2026-08-05 to actually match the ratified design. The first version
// carried the right DATA but almost none of the design: a plain table of round
// rows with no team columns, and a rail of three plain blocks. FR-019 says the
// screen must match `/design/draft`, and T053 — "verify DraftRoom against
// DraftBoard in the browser" — was marked done without being run. It is the one
// check that would have caught it.
//
// The layout below is `DraftBoard.tsx`'s, structure for structure:
//   * a 28px gutter + 12 team columns, headed by manager name and needs;
//   * round rows of position-tinted cells, the owner's column ringed;
//   * a rail of five blocks — turn pill, best pick, the queue, roster needs,
//     byes.
//
// This file remains a RENDERING SHELL. Every judgement — when to fetch, what
// counts as complete, which reason to headline — lives in the pure reducer and
// selectors, which is what lets SC-001 be measured offline (FR-024).
//
// TWO FAILURES ARE SHOWN SEPARATELY, and conflating them is the mistake this
// screen most needs to avoid:
//   reachability — can the browser reach DRAFT GENIE?   remedy: wait
//   withholding  — is the TAP still delivering picks?   remedy: go check its tab

import { CSSProperties, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import {
  apiClient,
  BoardResponse,
  DraftStatus,
  LeagueDetail,
  RankedBoardResponse,
  RecRecommendation,
  RequestError,
} from "../api";
import { connectDraftStream, type DraftFrame } from "../lib/draftSocket";
import { initialState, reduce, type Effect, type RoomInput, type RoomState } from "../lib/draftRoom";
import { railEntries, type PlayerLookup } from "../lib/draftRoomSelectors";
import RecommendationPanel from "../components/RecommendationPanel";
import LeagueNav from "../components/LeagueNav";

/** The design's position tints — same tokens, same mapping. */
const TINT: Record<string, string> = {
  QB: "var(--color-accent-500)",
  RB: "var(--color-accent-2-300)",
  WR: "var(--color-accent-300)",
  TE: "var(--color-accent-2-500)",
  K: "var(--color-neutral-300)",
  DST: "var(--color-neutral-300)",
};
const INK: Record<string, string> = {
  QB: "var(--color-accent-900)",
  RB: "var(--color-accent-2-800)",
  WR: "var(--color-accent-800)",
  TE: "var(--color-accent-2-900)",
  K: "var(--color-neutral-800)",
  DST: "var(--color-neutral-800)",
};

const kicker: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: "var(--color-neutral-700)",
};
const posPill = (pos: string, big = false): CSSProperties => ({
  display: "grid",
  placeItems: "center",
  height: big ? 22 : 20,
  minWidth: big ? 36 : 30,
  borderRadius: 999,
  background: TINT[pos] ?? "var(--color-neutral-300)",
  color: INK[pos] ?? "var(--color-neutral-800)",
  fontWeight: 700,
  fontSize: big ? 11 : 10,
});
/**
 * Wrap to TWO lines instead of truncating.
 *
 * At 12 columns even a full-width viewport gives each manager ~120px, and
 * `nowrap + ellipsis` turned "Kenji" into "Ke…" and most player names into
 * initials. Height is the cheap dimension here — the owner scrolls vertically
 * without complaint — so names fold rather than vanish.
 */
const twoLines = (fontSize: number, lineHeight = 1.15): CSSProperties => ({
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical",
  overflow: "hidden",
  overflowWrap: "anywhere",
  fontSize,
  lineHeight,
  // Reserve both lines so cells in a row stay aligned whether their name wraps
  // or not — a ragged grid is harder to scan than a slightly taller one.
  minHeight: `${(fontSize * lineHeight * 2).toFixed(1)}px`,
});

const card: CSSProperties = {
  borderRadius: "var(--radius-lg)",
  background: "var(--color-surface)",
  padding: "var(--space-3) var(--space-4)",
  display: "grid",
  gap: "var(--space-2)",
};

const WITHHOLD_COPY: Record<string, string> = {
  not_receiving:
    "Not receiving picks. The draft-room tab IS the tap — check it is still open, then reload it.",
  incompatible:
    "The tap no longer understands ESPN's draft messages, so picks are NOT being captured. Update the tap.",
  version_rejected: "The tap is running a version this server no longer accepts. Update the userscript.",
};

export default function DraftRoom() {
  const { id } = useParams<{ id: string }>();

  const [state, rawDispatch] = useReducer(
    (s: RoomState, input: RoomInput) => reduce(s, input, Date.now()).state,
    initialState(),
  );
  const stateRef = useRef(state);
  stateRef.current = state;
  const pending = useRef<Effect[]>([]);
  const dispatch = useCallback((input: RoomInput) => {
    pending.current.push(...reduce(stateRef.current, input, Date.now()).effects);
    rawDispatch(input);
  }, []);

  const [status, setStatus] = useState<DraftStatus | null>(null);
  const [board, setBoard] = useState<BoardResponse | null>(null);
  const [league, setLeague] = useState<LeagueDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<{ playerId: number; preloaded?: RecRecommendation } | null>(null);

  useEffect(() => {
    if (!id) return;
    apiClient.getBoard(id).then(setBoard).catch(() => setBoard(null));
    apiClient
      .getLeague(id)
      .then((l) => {
        setLeague(l);
        // The reducer cannot learn this from the stream — tell it.
        dispatch({ kind: "identity", myTeamId: l.my_team?.espn_team_id ?? null });
      })
      .catch(() => setLeague(null));
    apiClient
      .getDraftStatus(id)
      .then(setStatus)
      .catch((err) => setError(err instanceof RequestError ? err.message : "Couldn't load the draft."));
  }, [id, dispatch]);

  // Ask on open, so the room is never blank waiting for a first pick that may
  // be an hour away — or, pre-draft, may never come at all.
  useEffect(() => {
    if (id) dispatch({ kind: "opened" });
  }, [id, dispatch]);

  useEffect(() => {
    if (!id) return;
    const conn = connectDraftStream(id, {
      onFrame: (frame: DraftFrame) => dispatch({ kind: "frame", frame }),
      onReachability: (s) => dispatch({ kind: "reachability", state: s }),
    });
    return () => conn.close();
  }, [id, dispatch]);

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

  const players = useMemo((): Map<number, PlayerLookup & { bye: number | null }> => {
    const m = new Map<number, PlayerLookup & { bye: number | null }>();
    for (const p of board?.players ?? []) {
      m.set(p.espn_player_id, { name: p.name, position: p.position, team: p.team, bye: p.bye_week });
    }
    return m;
  }, [board]);

  const rail = useMemo(() => railEntries(state), [state]);
  const rec = state.recommendation;
  const needs = rec?.needs ?? [];

  // Team columns, in DRAFT order.
  //
  // 001 already publishes `draft_order` on the league once ESPN releases it —
  // roughly an hour before the draft — so the columns are correct before a
  // session has armed. Falls back to the session's order, then to league order.
  // When none is known the columns are still the league's teams, and FR-017's
  // "not published yet" banner says so rather than the grid implying an order
  // that does not exist.
  const teams = useMemo(() => {
    const all = league?.teams ?? [];
    if (all.length === 0) return [];
    const order = league?.draft_order ?? state.order;
    if (!order) return all;
    const sorted = order
      .map((tid) => all.find((t) => t.espn_team_id === tid))
      .filter((t): t is NonNullable<typeof t> => !!t);
    return sorted.length === all.length ? sorted : all;
  }, [league, state.order]);

  const teamCount = teams.length || league?.team_count || 12;
  const rounds = state.totalPicks > 0 ? Math.ceil(state.totalPicks / teamCount) : 15;
  const byOverall = useMemo(() => new Map(state.picks.map((p) => [p.overall, p])), [state.picks]);
  const frontier = state.picks.length + 1;

  // The owner's byes, for the design's bye grid — a join over the board, not a
  // rule, so it belongs here rather than in the engine.
  const myByes = useMemo(() => {
    const counts = new Map<number, number>();
    for (const p of state.picks) {
      if (state.myTeamId === null || p.teamId !== state.myTeamId) continue;
      const bye = players.get(p.playerId)?.bye;
      if (bye != null) counts.set(bye, (counts.get(bye) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => a[0] - b[0]);
  }, [state.picks, state.myTeamId, players]);

  if (error) return <div className="banner error">{error}</div>;

  const withheld = rec?.withheld ?? null;
  const tapWithholding = status?.withholding ?? null;
  const turn = state.myTurnState;
  const best = rail[0];
  const gridCols = `28px repeat(${teamCount},minmax(0,1fr))`;

  return (
    <div>
      {/* ---- header: league summary + live indicator, per the design ---- */}
      <div className="row">
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", flexWrap: "wrap" }}>
          <strong style={{ fontSize: 16 }}>{league?.name ?? "Draft room"}</strong>
          <span style={{ fontSize: 13, color: "var(--color-neutral-700)", fontVariantNumeric: "tabular-nums" }}>
            {teamCount} teams · {league?.scoring_summary ?? "—"}
            {state.picks.length > 0 && ` · round ${Math.floor(state.picks.length / teamCount) + 1} of ${rounds}`}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 13,
              fontWeight: 700,
              color:
                state.reachability === "connected" ? "var(--color-accent-2-700)" : "var(--color-accent-700)",
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 999,
                background:
                  state.reachability === "connected"
                    ? "var(--color-accent-2-600)"
                    : "var(--color-accent-600)",
              }}
            />
            {state.reachability === "connected"
              ? "Live"
              : state.reachability === "polling"
                ? "Polling"
                : "Reconnecting"}
          </span>
        </div>
      </div>

      {/* The same bar every league page carries, so the owner can move between
          them without going via the league page first. */}
      <LeagueNav leagueId={id!} />

      {state.reachability === "polling" && (
        <div className="banner warn">
          Cannot reach Draft Genie — falling back to polling. Your picks are still being captured by the tap.
        </div>
      )}
      {tapWithholding && (
        <div className="banner error">
          <strong>Recommendations withheld.</strong>{" "}
          {WITHHOLD_COPY[tapWithholding] ?? "The draft picture is not trustworthy."}
        </div>
      )}
      {state.phase === "pre_draft" && (
        <div className="banner info">
          {status?.armed ? "Waiting for the first pick." : "The draft hasn't started."}{" "}
          {state.order === null && "ESPN hasn't published the draft order yet."}
        </div>
      )}
      {state.phase === "complete" && state.completion && (
        <div className="banner ok">
          <strong>Draft complete.</strong>{" "}
          {state.completion.by === "both"
            ? "Both the completion signal and the pick count agree."
            : state.completion.by === "signal"
              ? "Reported complete by the draft feed."
              : "Every pick has been observed."}
          {state.completion.divergent && (
            <span className="muted small"> (the two completion checks disagreed — recorded for diagnosis)</span>
          )}
        </div>
      )}

      <div className="room-layout">
        {/* ================= the draft board ================= */}
        {/* `alignContent: start` matters: without it this column stretches to
            match the taller rail and its three grid rows balloon — the team
            headers rendered 101px tall instead of ~30px. */}
        <div style={{ display: "grid", gap: "var(--space-2)", minWidth: 0, alignContent: "start" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
            <strong style={{ fontSize: 15 }}>Draft board</strong>
            <div style={{ marginLeft: "auto", display: "flex", gap: "var(--space-2)", fontSize: 11 }}>
              {["QB", "RB", "WR", "TE"].map((p) => (
                <span key={p} style={{ ...posPill(p), minWidth: 34 }}>
                  {p}
                </span>
              ))}
              <span style={{ ...posPill("K"), minWidth: 46 }}>K / DST</span>
            </div>
          </div>

          {/* team columns — the part that was missing entirely */}
          <div style={{ display: "grid", gridTemplateColumns: gridCols, gap: 3 }}>
            <span />
            {teams.map((t) => {
              const mine = t.espn_team_id === state.myTeamId;
              return (
                <span
                  key={t.espn_team_id}
                  style={{
                    display: "grid",
                    gap: 1,
                    padding: "5px 7px",
                    borderRadius: "var(--radius-sm) var(--radius-sm) 0 0",
                    background: mine ? "var(--color-accent-700)" : "var(--color-neutral-200)",
                    minWidth: 0,
                  }}
                >
                  <strong
                    style={{
                      ...twoLines(12),
                      color: mine ? "var(--color-accent-100)" : "var(--color-text)",
                    }}
                  >
                    {t.manager_names[0] ?? t.name}
                  </strong>
                  <span
                    style={{
                      fontSize: 9.5,
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      minHeight: 12,
                      color: mine ? "var(--color-accent-200)" : "var(--color-neutral-600)",
                    }}
                  >
                    {/* Only the owner's needs are knowable — 006 computes them
                        for the connected team, not for opponents. Saying
                        nothing beats inventing something. */}
                    {mine
                      ? needs
                          .filter((n) => n.unfilled > 0)
                          .map((n) => n.position)
                          .slice(0, 2)
                          .join(" ") || "set"
                      : " "}
                  </span>
                </span>
              );
            })}
          </div>

          <div style={{ display: "grid", gridAutoRows: "1fr", gap: 3 }}>
            {Array.from({ length: rounds }, (_, r) => {
              const round = r + 1;
              return (
                <div key={round} style={{ display: "grid", gridTemplateColumns: gridCols, gap: 3 }}>
                  <span
                    style={{
                      display: "grid",
                      placeItems: "center",
                      fontSize: 11,
                      fontWeight: 700,
                      fontVariantNumeric: "tabular-nums",
                      color: "var(--color-neutral-600)",
                    }}
                  >
                    R{round}
                  </span>
                  {Array.from({ length: teamCount }, (_, c) => {
                    // Snake: even rounds run right to left, derived from the
                    // round — never from a field on the pick (010 disproved
                    // the field-3-is-the-round reading at 5 of 70).
                    const slot = round % 2 === 1 ? c + 1 : teamCount - c;
                    const overall = (round - 1) * teamCount + slot;
                    const pick = byOverall.get(overall);
                    const info = pick ? players.get(pick.playerId) : undefined;
                    const mine = teams[c]?.espn_team_id === state.myTeamId;
                    return (
                      <div
                        key={c}
                        style={{
                          borderRadius: "var(--radius-sm)",
                          background: info
                            ? (TINT[info.position] ?? "var(--color-neutral-200)")
                            : overall === frontier
                              ? "var(--color-accent-100)"
                              : "var(--color-neutral-100)",
                          boxShadow: mine ? "inset 0 0 0 1px var(--color-accent-700)" : "none",
                          padding: "3px 8px",
                          display: "grid",
                          alignContent: "center",
                          gap: 1,
                          minWidth: 0,
                          overflow: "hidden",
                        }}
                      >
                        <strong
                          style={{
                            ...twoLines(12, 1.1),
                            color: info ? (INK[info.position] ?? "var(--color-text)") : "var(--color-neutral-600)",
                          }}
                        >
                          {/* A pick whose player is not on the board still shows
                              — obscure, newly added, or a negative D/ST id. */}
                          {info?.name ?? (pick ? `#${pick.playerId}` : "")}
                        </strong>
                        <span
                          style={{
                            fontSize: 9.5,
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            color: "var(--color-neutral-700)",
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          {info ? `${info.team} · ${info.position}` : `${round}.${String(slot).padStart(2, "0")}`}
                        </span>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>

        {/* ================= the rail ================= */}
        <div className="room-rail">
          {/* 1. turn pill — FR-023's three visual states */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "var(--space-3)",
              padding: "var(--space-2) var(--space-4)",
              borderRadius: 999,
              background:
                turn === "on_the_clock"
                  ? "var(--color-accent-700)"
                  : turn === "on_deck"
                    ? "var(--color-accent-2-300)"
                    : "var(--color-neutral-200)",
              color: turn === "on_the_clock" ? "var(--color-accent-100)" : "var(--color-text)",
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase" }}>
              {turn === "on_the_clock" ? "Your pick" : turn === "on_deck" ? "On deck" : "Recommended"}
            </span>
            <span style={{ fontSize: 15, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
              {/* NOT a countdown. The design shows ESPN's pick clock; the tap
                  does not relay it, so showing one would be inventing it.
                  Picks-until-turn is what we actually know. */}
              {state.picksUntilMyTurn === null
                ? "—"
                : state.picksUntilMyTurn === 0
                  ? "now"
                  : `in ${state.picksUntilMyTurn}`}
            </span>
          </div>

          {/* 2. best pick now */}
          {withheld ? (
            <div className="banner error">
              <strong>Withheld.</strong> {withheld.detail}
            </div>
          ) : best ? (
            <div style={{ ...card, boxShadow: "var(--shadow-md)" }}>
              <span style={{ ...kicker, color: "var(--color-accent-700)", letterSpacing: "0.14em" }}>
                Best pick now
              </span>
              <div style={{ display: "flex", alignItems: "baseline", gap: "var(--space-2)" }}>
                <span style={posPill(best.position, true)}>{best.position}</span>
                <span style={{ fontFamily: "var(--font-heading)", fontSize: 25, lineHeight: 1.05 }}>
                  {best.name}
                </span>
              </div>
              <span style={{ fontSize: 12.5, color: "var(--color-neutral-700)", fontVariantNumeric: "tabular-nums" }}>
                {best.team} · <strong style={{ color: "var(--color-accent-2-700)" }}>{best.finalValue} VBD</strong>
                {best.preferred && best.preferredValue !== null && (
                  <>
                    {" · "}
                    <span className="badge info">preferred +{best.preferredValue}</span>
                  </>
                )}
              </span>
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.4, color: "var(--color-neutral-800)" }}>
                {best.headline}
              </p>
              <button
                className="secondary"
                style={{ minHeight: 34, fontSize: 13 }}
                onClick={() =>
                  setOpen({
                    playerId: best.playerId,
                    preloaded: rec?.shortlist.find(
                      (s) => (s as unknown as { playerId: number }).playerId === best.playerId,
                    ) as unknown as RecRecommendation,
                  })
                }
              >
                Why?
              </button>
            </div>
          ) : (
            <div style={card}>
              <span style={kicker}>Best pick now</span>
              <p className="muted small" style={{ margin: 0 }}>
                No recommendation yet.
              </p>
            </div>
          )}

          {/* 3. then, in order */}
          {rail.length > 1 && (
            <div style={card}>
              <span style={kicker}>Then, in order</span>
              {rail.slice(1).map((r) => (
                <div
                  key={r.playerId}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "14px 30px minmax(0,1fr) auto",
                    alignItems: "center",
                    gap: "var(--space-2)",
                    cursor: "pointer",
                  }}
                  onClick={() =>
                    setOpen({
                      playerId: r.playerId,
                      preloaded: rec?.shortlist.find(
                        (s) => (s as unknown as { playerId: number }).playerId === r.playerId,
                      ) as unknown as RecRecommendation,
                    })
                  }
                >
                  <span style={{ fontSize: 11, color: "var(--color-neutral-600)", fontVariantNumeric: "tabular-nums" }}>
                    {r.rank}
                  </span>
                  <span style={posPill(r.position)}>{r.position}</span>
                  <span style={{ display: "flex", alignItems: "baseline", gap: 5, minWidth: 0 }}>
                    <strong style={{ fontSize: 13.5, whiteSpace: "nowrap" }}>{r.name}</strong>
                    <span
                      style={{
                        fontSize: 11,
                        color: "var(--color-neutral-700)",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {r.team} · {r.headline}
                    </span>
                  </span>
                  <span
                    style={{
                      fontSize: 12.5,
                      fontWeight: 700,
                      color: "var(--color-accent-2-700)",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {r.finalValue}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* 4. roster needs — bars, from 006's structured needs */}
          <div style={card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span style={kicker}>Roster needs</span>
              {state.picksUntilMyTurn !== null && state.picksUntilMyTurn > 0 && (
                <span style={{ fontSize: 11, color: "var(--color-accent-700)", fontVariantNumeric: "tabular-nums" }}>
                  next in {state.picksUntilMyTurn}
                </span>
              )}
            </div>
            {needs.length === 0 ? (
              <p className="muted small" style={{ margin: 0 }}>
                Not known yet.
              </p>
            ) : (
              needs.map((n) => {
                const urgent = n.unfilled > 0 && rec?.forced === true;
                return (
                  <div key={n.position} style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                    <span
                      style={{
                        width: 34,
                        fontSize: 12,
                        fontWeight: 700,
                        color: urgent ? "var(--color-accent-700)" : "var(--color-neutral-700)",
                      }}
                    >
                      {n.position}
                    </span>
                    <span style={{ flex: 1, display: "flex", gap: 4 }}>
                      {Array.from({ length: n.required }, (_, i) => (
                        <i
                          key={i}
                          style={{
                            flex: 1,
                            height: 11,
                            borderRadius: 999,
                            background:
                              i < n.owned
                                ? "var(--color-accent-2-600)"
                                : urgent
                                  ? "var(--color-accent-200)"
                                  : "var(--color-neutral-300)",
                            outline: urgent && i >= n.owned ? "1px dashed var(--color-accent-400)" : "none",
                          }}
                        />
                      ))}
                    </span>
                    <span
                      style={{
                        fontSize: 12,
                        color: urgent ? "var(--color-accent-700)" : "var(--color-neutral-700)",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {n.owned}/{n.required}
                    </span>
                  </div>
                );
              })
            )}
          </div>

          {/* 5. byes — a join over the board, not a rule */}
          {myByes.length > 0 && (
            <div style={card}>
              <span style={kicker}>Byes</span>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(6,minmax(0,1fr))", gap: 4 }}>
                {myByes.map(([week, count]) => (
                  <span
                    key={week}
                    title={`${count} player${count === 1 ? "" : "s"} on bye in week ${week}`}
                    style={{
                      aspectRatio: "1",
                      borderRadius: "var(--radius-sm)",
                      display: "grid",
                      placeItems: "center",
                      fontSize: 11,
                      fontVariantNumeric: "tabular-nums",
                      fontWeight: count > 1 ? 700 : 400,
                      background:
                        count >= 3
                          ? "var(--color-accent-700)"
                          : count === 2
                            ? "var(--color-accent-300)"
                            : "var(--color-neutral-200)",
                      color: count >= 3 ? "var(--color-accent-100)" : "var(--color-neutral-700)",
                    }}
                  >
                    {week}
                  </span>
                ))}
              </div>
            </div>
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
