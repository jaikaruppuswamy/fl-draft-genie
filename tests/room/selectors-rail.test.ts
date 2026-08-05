// 007 T024/T025 — the rail, and the headline rule.
//
// The ratified design's rail is 318px and holds about one line per player.
// 006 emits up to eight signed adjustments with named reasons, plus missing
// inputs and alternatives. That does not fit — so the rail shows ONE reason and
// the rest opens in a panel.
//
// Which one? THE BIGGEST MOVER. That is a `reduce` over 006's own output rather
// than a judgement of ours, and it is the reason an owner would ask about first.
//
// The property that makes Constitution VII true at a glance: the headline is
// NEVER EMPTY. An empty headline is a bare name.

import { describe, expect, it } from "vitest";
import { headlineFor, railEntries } from "../../web/src/lib/draftRoomSelectors";
import { armed, board } from "./helpers";

function entry(over: Record<string, unknown> = {}) {
  return {
    playerId: 1,
    name: "Ash Rivers",
    position: "RB",
    team: "SF",
    rank: 1,
    finalValue: 42.5,
    preferred: false,
    ...over,
  };
}

const adj = (rule: string, magnitude: number, reason: string) => ({
  rule,
  magnitude,
  direction: magnitude >= 0 ? "up" : "down",
  reason,
});

describe("the headline rule", () => {
  it("is the adjustment with the LARGEST ABSOLUTE magnitude", () => {
    const e = entry({
      explanation: {
        adjustments: [
          adj("offense", 2.9, "top-5 offense"),
          adj("survival", 7.1, "very unlikely to last your next 12 picks"),
          adj("bye", -1.6, "bye week 9 clashes with your RB"),
        ],
      },
    });
    expect(headlineFor(e)).toBe("very unlikely to last your next 12 picks");
  });

  it("counts a large NEGATIVE adjustment as the biggest mover", () => {
    // A player dragged down hard deserves that reason on the surface just as
    // much as one lifted — arguably more, since it explains a low rank.
    const e = entry({
      explanation: {
        adjustments: [adj("offense", 2.9, "top-5 offense"), adj("bye", -9.4, "bye week 9 clashes with 2 of your RBs")],
      },
    });
    expect(headlineFor(e)).toBe("bye week 9 clashes with 2 of your RBs");
  });

  it("uses 006's own phrasing verbatim, not a rewrite", () => {
    // Reworded copy would drift from the engine's vocabulary the day 006's
    // wording changed, and the two would quietly disagree.
    const reason = "a run on RB — 67% of the last 12 picks";
    expect(headlineFor(entry({ explanation: { adjustments: [adj("scarcity", 3, reason)] } }))).toBe(reason);
  });

  it("FORCED overrides every adjustment", () => {
    // FR-025's forced pick is the one case where the engine is not choosing.
    // "K still unfilled, 1 pick left" outranks any reason a rule could give.
    const e = entry({
      explanation: {
        forcedBy: "every remaining pick is forced — K still unfilled",
        adjustments: [adj("survival", 99, "very unlikely to last")],
      },
    });
    expect(headlineFor(e)).toBe("every remaining pick is forced — K still unfilled");
  });

  it("says so plainly when NO rule fired (FR-008)", () => {
    expect(headlineFor(entry({ explanation: { adjustments: [] } }))).toBe(
      "no rule applied — ranked on value alone",
    );
  });

  it("is never empty, even with no explanation at all", () => {
    // The assertion that makes "no bare names" true at a glance rather than
    // after a tap.
    expect(headlineFor(entry()).length).toBeGreaterThan(0);
    expect(headlineFor(entry({ explanation: undefined })).length).toBeGreaterThan(0);
  });

  it("breaks ties deterministically, so the rail does not reshuffle", () => {
    const e = entry({
      explanation: {
        adjustments: [adj("survival", 5, "survival reason"), adj("offense", 5, "offense reason")],
      },
    });
    expect(headlineFor(e)).toBe("offense reason"); // "offense" < "survival"
    expect(headlineFor(e)).toBe(headlineFor(e));
  });
});

describe("railEntries", () => {
  it("maps 006's shortlist into rail rows", () => {
    const state = armed({
      recommendation: board(0, {
        shortlist: [entry({ explanation: { adjustments: [adj("offense", 3, "top-5 offense")] } })],
      }),
    });
    const rows = railEntries(state);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("Ash Rivers");
    expect(rows[0]!.headline).toBe("top-5 offense");
    expect(rows[0]!.finalValue).toBe(42.5);
  });

  it("carries the preferred flag AND what the preference contributed (FR-007)", () => {
    // 006 emits both as first-class fields precisely so this screen can badge
    // the player and show what the preference was worth, without recomputing.
    const state = armed({
      recommendation: board(0, {
        shortlist: [
          entry({
            preferred: true,
            explanation: { adjustments: [adj("preferred", 9.6, "on your preferred list")] },
          }),
        ],
      }),
    });
    const row = railEntries(state)[0]!;
    expect(row.preferred).toBe(true);
    expect(row.preferredValue).toBe(9.6);
  });

  it("reports no preferred value for a player who is not preferred", () => {
    const state = armed({ recommendation: board(0, { shortlist: [entry()] }) });
    expect(railEntries(state)[0]!.preferredValue).toBeNull();
  });

  it("flags a forced pick", () => {
    const state = armed({
      recommendation: board(0, {
        shortlist: [entry({ explanation: { forcedBy: "forced — DST unfilled" } })],
      }),
    });
    expect(railEntries(state)[0]!.forced).toBe(true);
  });

  it("is EMPTY when the board is withheld — no advice against bad data", () => {
    const state = armed({
      recommendation: board(0, {
        withheld: { reason: "not_receiving", detail: "no heartbeat" },
        shortlist: [entry()],
      }),
    });
    expect(railEntries(state)).toEqual([]);
  });

  it("is empty before any board has arrived", () => {
    expect(railEntries(armed())).toEqual([]);
  });

  it("gives every row a non-empty headline, whatever 006 sent", () => {
    const state = armed({
      recommendation: board(0, {
        shortlist: [entry({ playerId: 1 }), entry({ playerId: 2, explanation: { adjustments: [] } })],
      }),
    });
    for (const row of railEntries(state)) {
      expect(row.headline.length).toBeGreaterThan(0);
    }
  });
});
