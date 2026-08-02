// SC-005 sweep: exercise every endpoint, capture every response body, header,
// and server log line — the espn_s2 value and the unmasked SWID core must
// never appear anywhere after entry.

import { describe, expect, it, vi } from "vitest";
import { api, makeEnv, MY_S2, MY_SWID, signIn } from "../helpers/app";
import { makeEspnStub } from "../helpers/espnStub";
import { redact } from "../../src/api/logging";
import ppr from "../fixtures/espn/settings-team.json";

const SWID_CORE = "11111111-2222-3333-4444-555555555555";

describe("secret hygiene (SC-005)", () => {
  it("no endpoint or log line leaks espn_s2 or the unmasked SWID", async () => {
    const stub = makeEspnStub({ "1001": ppr });
    const env = makeEnv(stub);
    const captured: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      captured.push(args.map(String).join(" "));
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
      captured.push(args.map(String).join(" "));
    });

    const record = async (res: Response) => {
      captured.push(await res.clone().text());
      res.headers.forEach((v, k) => {
        if (k.toLowerCase() !== "set-cookie") captured.push(`${k}: ${v}`);
      });
      return res;
    };

    try {
      const cookie = await signIn(env, "sweep@b.co");
      await record(await api(env, cookie, "PUT", "/api/credentials", { espn_s2: MY_S2, swid: MY_SWID }));
      await record(await api(env, cookie, "GET", "/api/credentials"));
      const connect = await record(await api(env, cookie, "POST", "/api/leagues", { league_ref: "1001" }));
      const league = (await connect.json()) as { id: string };
      await record(await api(env, cookie, "GET", "/api/leagues"));
      await record(await api(env, cookie, "GET", `/api/leagues/${league.id}`));
      await record(await api(env, cookie, "POST", `/api/leagues/${league.id}/sync`));
      // Failure paths log too — exercise a 401 sync.
      stub.leagues["1001"] = 401;
      await record(await api(env, cookie, "POST", `/api/leagues/${league.id}/sync`));
      await record(await api(env, cookie, "DELETE", `/api/leagues/${league.id}`));
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }

    const everything = captured.join("\n");
    expect(everything).not.toContain(MY_S2);
    expect(everything).not.toContain(SWID_CORE);
  });

  it("the log redactor strips secrets even from careless messages", () => {
    expect(redact(`failed with espn_s2=${MY_S2} oops`)).not.toContain(MY_S2);
    expect(redact(`swid was ${MY_SWID}`)).not.toContain(SWID_CORE);
  });
});
