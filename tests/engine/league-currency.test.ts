// 006 T028 — SC-004 and Constitution III.
//
// "Score in the league's currency" is the principle most easily satisfied on
// paper and broken in practice: an engine that reads league-scored points and
// then ranks by a league-agnostic baseline passes every unit test and gives
// every league the same answer.
//
// So the test is a DIFFERENTIAL one. Same players, same roster, same team
// count — only the scoring differs. If the output does not move, the league's
// currency is not reaching the ranking.

import { describe, expect, it } from "vitest";
import { recommend } from "../../src/engine/recommend";
import { computeBaselines } from "../../src/engine/value";
import { makeBoard, makeBundle, makeState, ROSTER, TEAM_COUNT } from "./helpers";

/** The identical player pool, scored two ways. `receptionBoost` is PPR. */
function twoLeagues(boost: number) {
  const players = makeBoard({ receptionBoost: boost });
  const bundle = makeBundle({ players });
  return { bundle, state: makeState(bundle, { picksMade: 0 }) };
}

describe("SC-004 — two scorings, two answers", () => {
  it("produces a demonstrably different ranking under PPR", () => {
    const standard = twoLeagues(0);
    const ppr = twoLeagues(60);
    const a = recommend(standard.bundle, standard.state).entries.slice(0, 25).map((e) => e.playerId);
    const b = recommend(ppr.bundle, ppr.state).entries.slice(0, 25).map((e) => e.playerId);
    expect(a).not.toEqual(b);
  });

  it("moves receivers UP under PPR — the difference is the right one", () => {
    // Not just "different": different in the direction the scoring implies.
    // A ranking that changed randomly would satisfy the test above.
    const countReceivers = (boost: number): number => {
      const { bundle, state } = twoLeagues(boost);
      return recommend(bundle, state)
        .entries.slice(0, 24)
        .filter((e) => e.position === "WR" || e.position === "TE").length;
    };
    expect(countReceivers(60)).toBeGreaterThan(countReceivers(0));
  });

  it("moves the REPLACEMENT BASELINES, not just the raw points", () => {
    // The deeper property. Raw points obviously change with scoring; the test
    // that matters is whether the boundary between starter and replacement
    // moves too, because that is what makes positions comparable.
    const standard = computeBaselines(makeBoard({ receptionBoost: 0 }), ROSTER, TEAM_COUNT);
    const ppr = computeBaselines(makeBoard({ receptionBoost: 60 }), ROSTER, TEAM_COUNT);
    expect(ppr.boundary.get("WR")).not.toBe(standard.boundary.get("WR"));
  });

  it("never falls back to a league-agnostic ranking when scoring is unusual", () => {
    // A league that scores receptions at 3 points. Nothing in the engine should
    // recognise this as "unusual" and reach for a default.
    const wild = twoLeagues(180);
    const normal = twoLeagues(0);
    const wildTop = recommend(wild.bundle, wild.state).entries[0]!;
    const normalTop = recommend(normal.bundle, normal.state).entries[0]!;
    expect(wildTop.playerId === normalTop.playerId && wildTop.finalValue === normalTop.finalValue).toBe(
      false,
    );
  });
});

describe("the currency is consistent all the way through", () => {
  it("expresses ROUND_VALUE in the same units as the values", () => {
    const { bundle, state } = twoLeagues(0);
    const board = recommend(bundle, state);
    const top = board.entries[0]!.rawValue;
    // A round should cost a meaningful but not absurd fraction of the best
    // player's value. If these were in different units the ratio would be wild.
    expect(board.roundValue).toBeGreaterThan(0);
    expect(board.roundValue).toBeLessThan(Math.abs(top) * 2 + 1);
  });

  it("scales every adjustment with the league, not with a constant", () => {
    // Doubling the scale of the league's points should scale ROUND_VALUE — and
    // therefore every adjustment — with it. A flat point constant would not
    // move, which is exactly the Constitution II failure this design avoids.
    const small = makeBundle({ players: makeBoard() });
    const bigPlayers = makeBoard().map((p) => ({
      ...p,
      projected_points: p.projected_points === null ? null : p.projected_points * 10,
    }));
    const big = makeBundle({ players: bigPlayers });
    big.proTeamByPlayer = small.proTeamByPlayer;

    const smallBoard = recommend(small, makeState(small, { picksMade: 0 }));
    const bigBoard = recommend(big, makeState(big, { picksMade: 0 }));
    expect(bigBoard.roundValue).toBeGreaterThan(smallBoard.roundValue * 5);

    const magnitudeOf = (b: typeof smallBoard): number =>
      b.shortlist[0]!.explanation.adjustments.reduce((s, a) => s + Math.abs(a.magnitude), 0);
    // Adjustments scale with the league too — they are fractions of a round.
    expect(magnitudeOf(bigBoard)).toBeGreaterThan(magnitudeOf(smallBoard));
  });
});
