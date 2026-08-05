import { useState } from "react";
import { classify, isDraftChannel } from "../../../tap/classify";
import { decodeInitFrame, filledPicks } from "../../../tap/decode";
import { assertTransmittable, filterLedgerPick, filterPickFields, type PickPayload } from "../../../tap/filter";

// 010 T046 — replay a capture through the real decode/filter path, in the
// browser, with no draft running.
//
// This is a product deliverable, not a test: when ESPN changes the protocol the
// first question is "what does the tap now see?", and answering it should not
// require waiting for a draft or reading a stack trace.

interface Frame { data?: string; event?: string; url?: string; at?: string }

interface Result {
  frames: number;
  picks: PickPayload[];
  ledgerPicks: PickPayload[];
  unrecognised: { verb: string; count: number }[];
  skippedOtherChannel: number;
  leaked: string[];
}

function replay(lines: string[]): Result {
  const picks: PickPayload[] = [];
  let ledgerPicks: PickPayload[] = [];
  const unknown = new Map<string, number>();
  const leaked: string[] = [];
  let skipped = 0;
  let frames = 0;

  for (const line of lines) {
    let f: Frame;
    try { f = JSON.parse(line) as Frame; } catch { continue; }
    if (!f.data || f.event !== "message") continue;
    frames++;
    if (f.url && !isDraftChannel(f.url)) { skipped++; continue; }
    const c = classify(f.data);
    if (c.kind === "pick") {
      const p = filterPickFields(c.fields);
      if (p) {
        try { assertTransmittable(p); } catch (e) { leaked.push((e as Error).message); }
        picks.push(p);
      }
    } else if (c.kind === "ledger") {
      try {
        const l = decodeInitFrame(f.data, window.atob.bind(window));
        if (l) ledgerPicks = filledPicks(l).map(filterLedgerPick);
      } catch (e) {
        unknown.set(`ledger decode failed: ${(e as Error).message}`, 1);
      }
    } else if (c.kind === "unrecognised") {
      unknown.set(c.verb, (unknown.get(c.verb) ?? 0) + 1);
    }
  }
  return {
    frames,
    picks,
    ledgerPicks,
    unrecognised: [...unknown].map(([verb, count]) => ({ verb, count })),
    skippedOtherChannel: skipped,
    leaked,
  };
}

export default function TapSelfTest() {
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onFile(file: File) {
    setError(null);
    try {
      setResult(replay((await file.text()).trim().split("\n")));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div>
      <h1 className="page">Draft tap self-test</h1>
      <div className="card">
        <p>
          Replays a captured draft through exactly the code the tap runs — decode, then the privacy filter —
          and shows what would have been relayed. Use it when ESPN changes something: it answers &ldquo;what
          does the tap see now?&rdquo; without waiting for a draft.
        </p>
        <input
          type="file"
          accept=".jsonl,.json,.txt"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onFile(f);
          }}
        />
      </div>

      {error && <div className="card"><p>Could not read that file: {error}</p></div>}

      {result && (
        <>
          <div className="card">
            <h2>Summary</h2>
            <ul className="plain">
              <li>{result.frames} frames on the draft channel</li>
              <li>{result.picks.length} picks relayed from the incremental stream</li>
              <li>{result.ledgerPicks.length} picks in the most recent ledger</li>
              <li>{result.skippedOtherChannel} frames ignored (not the draft socket)</li>
              <li>
                {result.unrecognised.length === 0
                  ? "no unrecognised messages"
                  : `${result.unrecognised.length} unrecognised message type(s) — the protocol may have changed`}
              </li>
              <li>
                {result.leaked.length === 0
                  ? "nothing would have leaked"
                  : `${result.leaked.length} payload(s) BLOCKED by the privacy check`}
              </li>
            </ul>
          </div>

          {result.unrecognised.length > 0 && (
            <div className="card">
              <h2>Unrecognised</h2>
              <ul className="plain">
                {result.unrecognised.map((u) => (
                  <li key={u.verb}>
                    <code>{u.verb}</code> × {u.count}
                  </li>
                ))}
              </ul>
              <p className="muted small">
                ESPN silently ignores messages it does not know. The tap deliberately does not — anything here
                is a signal that the tap needs updating before draft day.
              </p>
            </div>
          )}

          <div className="card">
            <h2>Picks ({result.picks.length})</h2>
            <table className="table">
              <thead>
                <tr><th>#</th><th>team</th><th>player</th><th>field 3</th></tr>
              </thead>
              <tbody>
                {result.picks.map((p, i) => (
                  <tr key={`${p.playerId}-${i}`}>
                    <td>{i + 1}</td>
                    <td>{p.teamId}</td>
                    <td>{p.playerId}</td>
                    <td>{p.slot3}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted small">
              Field 3 is carried but deliberately not interpreted — its meaning is unresolved and nothing
              depends on it. Negative player ids are D/ST and are expected.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
