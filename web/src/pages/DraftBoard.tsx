// Design reference for the draft-day screen (feature 006), ported faithfully
// from the Claude Design artifact "Draft Genie Draft Screen.dc.html"
// (project 3fc40045). Renders the design's mock data — the live draft feed,
// recommendations, and roster state arrive with features 004/005/006.
import { CSSProperties } from "react";
import { Link } from "react-router-dom";

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
const MINE = 3;
const MINE_RING = "inset 0 0 0 1px var(--color-accent-700)";

const names = ["Marcus", "Sarah", "Dev", "You", "Priya", "Tom", "Kenji", "Lena", "Raj", "Ana", "Will", "Zoe"];
const needs = ["WR RB", "RB TE", "WR QB", "RB QB", "WR WR", "RB WR", "TE RB", "WR RB", "RB WR", "QB WR", "WR TE", "RB WR"];

type Pick = [string, string, string];
const r1: Pick[] = [
  ["Chase", "CIN", "WR"], ["Jefferson", "MIN", "WR"], ["Barkley", "PHI", "RB"], ["Lamb", "DAL", "WR"],
  ["Gibbs", "DET", "RB"], ["Nabers", "NYG", "WR"], ["St. Brown", "DET", "WR"], ["Collins", "HOU", "WR"],
  ["McCaffrey", "SF", "RB"], ["Jeanty", "LV", "RB"], ["Thomas", "JAX", "WR"], ["Henry", "BAL", "RB"],
];
const r2: Pick[] = [
  ["Harrison", "ARI", "WR"], ["McBride", "ARI", "TE"], ["G. Wilson", "NYJ", "WR"], ["Higgins", "CIN", "WR"],
  ["C. Brown", "CIN", "RB"], ["A. Brown", "PHI", "WR"], ["K. Williams", "LAR", "RB"], ["McConkey", "LAC", "WR"],
  ["Jacobs", "GB", "RB"], ["Bowers", "LV", "TE"], ["Irving", "TB", "RB"], ["London", "ATL", "WR"],
];
const r3: Pick[] = [["Allen", "BUF", "QB"], ["L. Jackson", "BAL", "QB"], ["Cook", "BUF", "RB"]];

interface Cell {
  name: string; meta: string; bg: string; ring: string; fg: string; sub: string; anim: string;
}

function cell(p: Pick | null, teamIndex: number, pickLabel: string, current: boolean): Cell {
  const mine = teamIndex === MINE;
  const ring = mine ? MINE_RING : "none";
  if (current) {
    return {
      name: "Your pick", meta: pickLabel, bg: "var(--color-accent-700)", ring: "none",
      fg: "var(--color-accent-100)", sub: "var(--color-accent-200)", anim: "dg-blink 1.6s infinite",
    };
  }
  if (!p) {
    return {
      name: "", meta: pickLabel, bg: mine ? "var(--color-accent-100)" : "var(--color-neutral-200)",
      ring, fg: "var(--color-neutral-700)", sub: "var(--color-neutral-700)", anim: "none",
    };
  }
  return {
    name: p[0], meta: `${p[1]} · ${p[2]}`, bg: TINT[p[2]]!, ring,
    fg: "var(--color-text)", sub: INK[p[2]]!, anim: "none",
  };
}

function buildRows() {
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  const rows: { label: string; cells: Cell[] }[] = [];
  for (let r = 1; r <= 15; r++) {
    const cells: Cell[] = [];
    for (let t = 0; t < 12; t++) {
      const slot = r % 2 === 1 ? t + 1 : 12 - t;
      const label = `${r}.${pad(slot)}`;
      let player: Pick | null = null;
      if (r === 1) player = r1[t]!;
      else if (r === 2) player = r2[t]!;
      else if (r === 3 && t < 3) player = r3[t]!;
      const current = r === 3 && t === MINE;
      cells.push(cell(player, t, label, current));
    }
    rows.push({ label: `R${r}`, cells });
  }
  return rows;
}

const kicker: CSSProperties = {
  fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase",
  color: "var(--color-neutral-700)",
};
const posPill = (bg: string, fg: string): CSSProperties => ({
  display: "grid", placeItems: "center", height: 20, minWidth: 30, borderRadius: 999,
  background: bg, color: fg, fontWeight: 700, fontSize: 10,
});
const queueRow: CSSProperties = {
  display: "grid", gridTemplateColumns: "14px 30px minmax(0,1fr) auto", alignItems: "center",
  gap: "var(--space-2)",
};

const QUEUE: { n: number; pos: string; name: string; note: string; vbd: string }[] = [
  { n: 2, pos: "RB", name: "Achane ★", note: "MIA · preferred", vbd: "+9.7" },
  { n: 3, pos: "WR", name: "Nacua", note: "LAR · SoS 8th", vbd: "+14.2" },
  { n: 4, pos: "WR", name: "Olave", note: "NO · OL 21", vbd: "+8.4" },
  { n: 5, pos: "RB", name: "Hall", note: "NYJ · bye 9", vbd: "+6.1" },
  { n: 6, pos: "TE", name: "LaPorta", note: "DET · top-5 off", vbd: "+5.8" },
  { n: 7, pos: "WR", name: "Egbuka", note: "TB · rookie", vbd: "+3.2" },
];

const NEEDS: { pos: string; filled: number; total: number; urgent?: boolean }[] = [
  { pos: "RB", filled: 1, total: 2 },
  { pos: "WR", filled: 2, total: 3 },
  { pos: "QB", filled: 0, total: 1, urgent: true },
  { pos: "TE", filled: 0, total: 1 },
  { pos: "FLEX", filled: 0, total: 1 },
];

const BYES = [
  { week: 7, style: { background: "var(--color-neutral-200)", color: "var(--color-neutral-700)" } },
  { week: 9, style: { background: "var(--color-accent-2-300)", fontWeight: 700 } },
  { week: 10, style: { background: "var(--color-accent-300)", fontWeight: 700 } },
  { week: 11, style: { background: "var(--color-accent-700)", color: "var(--color-accent-100)", fontWeight: 700 } },
  { week: 12, style: { background: "var(--color-neutral-200)", color: "var(--color-neutral-700)" } },
  { week: 14, style: { background: "var(--color-neutral-200)", color: "var(--color-neutral-700)" } },
];

export default function DraftBoard() {
  const rows = buildRows();
  const teams = names.map((n, i) => ({
    name: n,
    need: needs[i]!,
    bg: i === MINE ? "var(--color-accent-700)" : "var(--color-neutral-200)",
    fg: i === MINE ? "var(--color-accent-100)" : "var(--color-text)",
    sub: i === MINE ? "var(--color-accent-200)" : "var(--color-neutral-600)",
  }));

  return (
    <div style={{ minHeight: "100vh", background: "var(--color-neutral-300)", padding: "var(--space-3)", fontFamily: "var(--font-body)" }}>
      <div className="banner warn" style={{ maxWidth: 1440, margin: "0 auto var(--space-3)" }}>
        Design preview (feature 006) — mock data from the ratified Claude Design artifact. The live
        draft feed and recommendations arrive with the draft monitor and engine.{" "}
        <Link to="/">Back to dashboard</Link>
      </div>
      <div
        style={{
          maxWidth: 1440, margin: "0 auto", minHeight: 860, background: "var(--color-bg)",
          color: "var(--color-text)", borderRadius: "var(--radius-lg)", boxShadow: "var(--shadow-lg)",
          overflow: "hidden", display: "grid", gridTemplateRows: "auto minmax(0,1fr)",
          gap: "var(--space-3)", padding: "var(--space-4)",
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-4)", padding: "0 var(--space-2)", flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
            <div style={{ width: 30, height: 30, borderRadius: 999, background: "var(--color-accent)", display: "grid", placeItems: "center", color: "var(--color-neutral-100)", fontFamily: "var(--font-heading)", fontSize: 15, lineHeight: 1 }}>
              G
            </div>
            <strong style={{ fontSize: 16 }}>Gladiator</strong>
            <span style={{ fontSize: 13, color: "var(--color-neutral-700)", fontVariantNumeric: "tabular-nums" }}>
              12 teams · PPR · snake · round 3 of 15
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--color-accent-2-700)", fontWeight: 700 }}>
              <span style={{ width: 8, height: 8, borderRadius: 999, background: "var(--color-accent-2-600)" }} />
              Live · 1.2s lag
            </span>
            <button className="secondary" style={{ minHeight: 38, fontSize: 14 }}>Preferred list</button>
            <Link to="/"><button className="secondary" style={{ minHeight: 38, fontSize: 14 }}>Leagues</button></Link>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 318px", gap: "var(--space-3)", minHeight: 0 }}>
          {/* Draft board */}
          <div style={{ display: "grid", gridTemplateRows: "auto auto minmax(0,1fr)", gap: "var(--space-2)", minHeight: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", padding: "0 var(--space-1)" }}>
              <strong style={{ fontSize: 15 }}>Draft board</strong>
              <div style={{ marginLeft: "auto", display: "flex", gap: "var(--space-2)", fontSize: 11, alignItems: "center" }}>
                <span style={{ padding: "3px 9px", borderRadius: 999, background: "var(--color-accent-500)", color: "var(--color-accent-900)", fontWeight: 700 }}>QB</span>
                <span style={{ padding: "3px 9px", borderRadius: 999, background: "var(--color-accent-2-300)", color: "var(--color-accent-2-800)", fontWeight: 700 }}>RB</span>
                <span style={{ padding: "3px 9px", borderRadius: 999, background: "var(--color-accent-300)", color: "var(--color-accent-800)", fontWeight: 700 }}>WR</span>
                <span style={{ padding: "3px 9px", borderRadius: 999, background: "var(--color-accent-2-500)", color: "var(--color-accent-2-900)", fontWeight: 700 }}>TE</span>
                <span style={{ padding: "3px 9px", borderRadius: 999, background: "var(--color-neutral-300)", color: "var(--color-neutral-800)", fontWeight: 700 }}>K / DST</span>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "28px repeat(12,minmax(0,1fr))", gap: 3 }}>
              <span />
              {teams.map((t) => (
                <span key={t.name} style={{ display: "grid", gap: 1, padding: "5px 7px", borderRadius: "var(--radius-sm) var(--radius-sm) 0 0", background: t.bg, minWidth: 0 }}>
                  <strong style={{ fontSize: 12, lineHeight: 1.15, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: t.fg }}>{t.name}</strong>
                  <span style={{ fontSize: 9.5, letterSpacing: "0.06em", textTransform: "uppercase", color: t.sub, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.need}</span>
                </span>
              ))}
            </div>

            <div style={{ display: "grid", gridAutoRows: "1fr", gap: 3, minHeight: 0 }}>
              {rows.map((row) => (
                <div key={row.label} style={{ display: "grid", gridTemplateColumns: "28px repeat(12,minmax(0,1fr))", gap: 3, minHeight: 0 }}>
                  <span style={{ display: "grid", placeItems: "center", fontSize: 11, fontWeight: 700, fontVariantNumeric: "tabular-nums", color: "var(--color-neutral-600)" }}>{row.label}</span>
                  {row.cells.map((c, i) => (
                    <div key={i} style={{ borderRadius: "var(--radius-sm)", background: c.bg, boxShadow: c.ring, padding: "3px 8px", display: "grid", alignContent: "center", gap: 1, minWidth: 0, overflow: "hidden", animation: c.anim }}>
                      <strong style={{ fontSize: 12, lineHeight: 1.1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: c.fg }}>{c.name}</strong>
                      <span style={{ fontSize: 9.5, letterSpacing: "0.03em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: c.sub, fontVariantNumeric: "tabular-nums" }}>{c.meta}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>

          {/* Right rail */}
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)", minHeight: 0 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-3)", padding: "var(--space-2) var(--space-4)", borderRadius: 999, background: "var(--color-accent-700)", color: "var(--color-accent-100)", animation: "dg-pulse 2s infinite" }}>
              <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase" }}>Your pick · 3.04</span>
              <span style={{ fontSize: 22, fontWeight: 700, fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>0:47</span>
            </div>

            <div style={{ borderRadius: "var(--radius-lg)", background: "var(--color-surface)", boxShadow: "var(--shadow-md)", padding: "var(--space-3) var(--space-4)", display: "grid", gap: "var(--space-2)" }}>
              <span style={{ ...kicker, color: "var(--color-accent-700)", letterSpacing: "0.14em" }}>Best pick now</span>
              <div style={{ display: "flex", alignItems: "baseline", gap: "var(--space-2)" }}>
                <span style={{ ...posPill("var(--color-accent-2-700)", "var(--color-accent-2-100)"), minWidth: 36, height: 22, fontSize: 11 }}>RB</span>
                <span style={{ fontFamily: "var(--font-heading)", fontSize: 25, lineHeight: 1.05 }}>Bijan Robinson</span>
              </div>
              <span style={{ fontSize: 12.5, color: "var(--color-neutral-700)", fontVariantNumeric: "tabular-nums" }}>
                ATL · Proj 268.4 · <strong style={{ color: "var(--color-accent-2-700)" }}>+18.3 VBD</strong> · Bye 12
              </span>
              <div style={{ display: "flex", gap: 4 }}>
                {[1, 2, 3, 4].map((i) => (
                  <span key={i} style={{ flex: 1, height: 6, borderRadius: 999, background: "var(--color-accent-2-600)" }} />
                ))}
                <span style={{ flex: 1, height: 6, borderRadius: 999, background: "var(--color-neutral-300)" }} />
              </div>
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.4, color: "var(--color-neutral-800)" }}>
                A full tier ahead of the next back — and 17 picks before your turn returns.
              </p>
            </div>

            <div style={{ borderRadius: "var(--radius-lg)", background: "var(--color-surface)", padding: "var(--space-3) var(--space-4)", display: "grid", gap: "var(--space-2)" }}>
              <span style={kicker}>Then, in order</span>
              {QUEUE.map((q) => (
                <div key={q.n} style={queueRow}>
                  <span style={{ fontSize: 11, color: "var(--color-neutral-600)", fontVariantNumeric: "tabular-nums" }}>{q.n}</span>
                  <span style={posPill(TINT[q.pos]!, INK[q.pos]!)}>{q.pos}</span>
                  <span style={{ display: "flex", alignItems: "baseline", gap: 5, minWidth: 0 }}>
                    <strong style={{ fontSize: 13.5, whiteSpace: "nowrap" }}>{q.name}</strong>
                    <span style={{ fontSize: 11, color: "var(--color-neutral-700)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{q.note}</span>
                  </span>
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--color-accent-2-700)", fontVariantNumeric: "tabular-nums" }}>{q.vbd}</span>
                </div>
              ))}
            </div>

            <div style={{ marginTop: "auto", display: "grid", gap: "var(--space-3)" }}>
              <div style={{ borderRadius: "var(--radius-lg)", background: "var(--color-surface)", padding: "var(--space-3) var(--space-4)", display: "grid", gap: "var(--space-2)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <span style={kicker}>Roster needs</span>
                  <span style={{ fontSize: 11, color: "var(--color-accent-700)", fontVariantNumeric: "tabular-nums" }}>next 4.09 · in 17</span>
                </div>
                {NEEDS.map((n) => (
                  <div key={n.pos} style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                    <span style={{ width: 34, fontSize: 12, fontWeight: 700, color: n.urgent ? "var(--color-accent-700)" : "var(--color-neutral-700)" }}>{n.pos}</span>
                    <span style={{ flex: 1, display: "flex", gap: 4 }}>
                      {Array.from({ length: n.total }, (_, i) => (
                        <i
                          key={i}
                          style={{
                            flex: 1, height: 11, borderRadius: 999,
                            background: i < n.filled ? "var(--color-accent-2-600)" : n.urgent ? "var(--color-accent-200)" : "var(--color-neutral-300)",
                            outline: n.urgent && i >= n.filled ? "1px dashed var(--color-accent-400)" : "none",
                          }}
                        />
                      ))}
                    </span>
                    <span style={{ fontSize: 12, color: n.urgent ? "var(--color-accent-700)" : "var(--color-neutral-700)", fontVariantNumeric: "tabular-nums" }}>
                      {n.filled}/{n.total}
                    </span>
                  </div>
                ))}
              </div>

              <div style={{ borderRadius: "var(--radius-lg)", background: "var(--color-surface)", padding: "var(--space-3) var(--space-4)", display: "grid", gap: "var(--space-2)" }}>
                <span style={kicker}>Byes</span>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(6,minmax(0,1fr))", gap: 4 }}>
                  {BYES.map((b) => (
                    <span key={b.week} style={{ aspectRatio: "1", borderRadius: "var(--radius-sm)", display: "grid", placeItems: "center", fontSize: 11, fontVariantNumeric: "tabular-nums", ...b.style }}>
                      {b.week}
                    </span>
                  ))}
                </div>
                <span style={{ fontSize: 12, color: "var(--color-accent-700)", lineHeight: 1.35 }}>
                  3 starters out in week 11 — already discounted.
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
